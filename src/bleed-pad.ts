// Print bleed for cover-fitted images, without changing the design's crop.
//
// A `background-size: cover` image that touches the board edge is drawn
// exactly to that edge, so along its fitted axis there are no spare pixels to
// fill the bleed. Zooming to the bleed box fixes the bleed but moves every
// pixel inside the trim. Instead, this mirrors the image's own edge pixels
// outward by just enough to cover the bleed, and records the padding so the
// emitter places the padded file at the original design scale. The trimmed
// page is unchanged; only the strip the printer cuts away is synthesised.

import { spawnSync } from "child_process";
import path from "path";
import type { ImageNode, Scene } from "./types";

const EDGE = 0.75; // pt, same tolerance as the emitter's extendBleed
const SAFETY = 2;  // source px beyond the bleed, against resampling at the edge

function imageSize(file: string): [number, number] {
  const r = spawnSync("magick", ["identify", "-format", "%w %h", `${file}[0]`], { encoding: "utf8" });
  const [w, h] = r.stdout.trim().split(/\s+/).map(Number);
  if (!w || !h) throw new Error(`could not read image size: ${file}`);
  return [w, h];
}

/** Cover-fit drawn rect [x0, y0, x1, y1] for an image of natW x natH in the node's box. */
export function coverRect(n: ImageNode, natW: number, natH: number): [number, number, number, number] {
  const aspect = natW / natH;
  const widthLed = n.width / n.height > aspect;
  const dw = widthLed ? n.width : n.height * aspect;
  const dh = widthLed ? n.width / aspect : n.height;
  const bp = n.bgPos ?? { x: 50, xUnit: "%", y: 50, yUnit: "%" };
  const x0 = n.x + (bp.xUnit === "%" ? (n.width - dw) * bp.x / 100 : bp.x);
  const y0 = n.y + (bp.yUnit === "%" ? (n.height - dh) * bp.y / 100 : bp.y);
  return [x0, y0, x0 + dw, y0 + dh];
}

/** Source pixels needed on each side so the drawn image reaches the bleed. */
export function bleedPadding(
  n: ImageNode, natW: number, natH: number, boardW: number, boardH: number, bleed: number,
): { t: number; r: number; b: number; l: number } {
  const [x0, y0, x1, y1] = coverRect(n, natW, natH);
  const s = (x1 - x0) / natW; // pt per source px
  const px = (missingPt: number) => (missingPt > 0 ? Math.ceil(missingPt / s) + SAFETY : 0);
  return {
    t: n.y <= EDGE ? px(y0 + bleed) : 0,
    b: n.y + n.height >= boardH - EDGE ? px(boardH + bleed - y1) : 0,
    l: n.x <= EDGE ? px(x0 + bleed) : 0,
    r: n.x + n.width >= boardW - EDGE ? px(boardW + bleed - x1) : 0,
  };
}

export function padBleedImages(scene: Scene, outDir: string, bleed: number): string[] {
  const log: string[] = [];
  const links = path.join(outDir, "Links");
  for (const page of scene.pages) {
    for (const node of page.nodes) {
      if (node.kind !== "image") continue;
      const n = node as ImageNode;
      if (n.fit !== "cover" || Math.abs(n.rotationDeg) >= 0.01 || !n.src) continue;
      const file = path.join(links, n.src);
      const [natW, natH] = imageSize(file);
      const pad = bleedPadding(n, natW, natH, page.widthPx, page.heightPx, bleed);
      if (!pad.t && !pad.r && !pad.b && !pad.l) continue;

      const ext = path.extname(n.src);
      const name = `${path.basename(n.src, ext)}-bleed${ext}`;
      const W = natW + pad.l + pad.r, H = natH + pad.t + pad.b;
      const r = spawnSync("magick", [
        file, "-set", "option:distort:viewport", `${W}x${H}-${pad.l}-${pad.t}`,
        "-virtual-pixel", "Mirror", "-filter", "point", "-distort", "SRT", "0", "+repage",
        "-quality", "95", path.join(links, name),
      ], { encoding: "utf8" });
      if (r.status !== 0) throw new Error(`bleed pad failed for ${n.src}: ${r.stderr}`);

      n.src = name;
      n.bleedPad = { ...pad, natW, natH };
      log.push(`BLEEDPAD ${name} t${pad.t} r${pad.r} b${pad.b} l${pad.l} px`);
    }
  }
  return log;
}
