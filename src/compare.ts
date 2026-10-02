// Pixel-diff a Chrome reference screenshot against an InDesign PNG proof.

import { readFileSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

// InDesign sometimes writes trailing bytes after IEND, which pngjs rejects.
// Fall back to re-encoding through sips.
function readPng(file: string): PNG {
  try {
    return PNG.sync.read(readFileSync(file));
  } catch {
    const tmp = file + ".norm.png";
    const res = spawnSync("sips", ["-s", "format", "png", file, "--out", tmp], { encoding: "utf8" });
    if (res.status !== 0) throw new Error(`sips normalization failed for ${file}: ${res.stderr}`);
    return PNG.sync.read(readFileSync(tmp));
  }
}

export interface DiffResult {
  width: number;
  height: number;
  diffPixels: number;
  diffPct: number;
  diffPath: string;
}

export function comparePngs(refPath: string, proofPath: string, diffPath: string): DiffResult {
  const a = readPng(refPath);
  const b = readPng(proofPath);
  const width = Math.min(a.width, b.width);
  const height = Math.min(a.height, b.height);

  const crop = (img: PNG): PNG => {
    if (img.width === width && img.height === height) return img;
    const out = new PNG({ width, height });
    PNG.bitblt(img, out, 0, 0, width, height, 0, 0);
    return out;
  };

  const ca = crop(a);
  const cb = crop(b);
  const diff = new PNG({ width, height });
  const diffPixels = pixelmatch(ca.data, cb.data, diff.data, width, height, {
    threshold: 0.12,
    includeAA: true,
  });
  writeFileSync(diffPath, PNG.sync.write(diff));
  return { width, height, diffPixels, diffPct: (diffPixels / (width * height)) * 100, diffPath };
}
