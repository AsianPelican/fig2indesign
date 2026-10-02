// Runs a generated .jsx inside InDesign via AppleScript and returns the build log.

import { spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import path from "path";
import type { ContainerGeometryRecord, TextGeometryRecord } from "./pipeline";

const CANDIDATES = [
  "Adobe InDesign 2026",
  "Adobe InDesign 2025",
];

export function findInDesign(): string {
  for (const name of CANDIDATES) {
    if (existsSync(`/Applications/${name}/${name}.app`)) return name;
  }
  throw new Error("No InDesign installation found in /Applications");
}

export interface RunResult {
  log: string[];
  textGeometry: TextGeometryRecord[];
  containerGeometry: ContainerGeometryRecord[];
  ok: boolean;
}

export function runJsx(jsxPath: string, outDir: string, appName = findInDesign()): RunResult {
  const script = `with timeout of 3600 seconds
tell application "${appName}"
  do script (POSIX file "${path.resolve(jsxPath)}") language javascript
end tell
end timeout`;
  const configuredTimeout = Number(process.env.INDESIGN_BRIDGE_OSASCRIPT_TIMEOUT_MS || 600_000);
  const timeout = Number.isFinite(configuredTimeout) && configuredTimeout >= 5_000 ? configuredTimeout : 600_000;
  const res = spawnSync("osascript", ["-e", script], { encoding: "utf8", timeout });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`osascript failed (${res.status}): ${res.stderr.trim()}`);
  }
  const resultFile = path.join(outDir, "build-result.json");
  if (!existsSync(resultFile)) {
    throw new Error("InDesign script produced no build-result.json — check InDesign for dialogs.");
  }
  const parsed = JSON.parse(readFileSync(resultFile, "utf8"));
  const log: string[] = parsed.log.filter((l: string) => l.length > 0);
  const ok = log.includes("DONE") && !log.some((l) => l.startsWith("FATAL"));
  return {
    log,
    textGeometry: Array.isArray(parsed.textGeometry) ? parsed.textGeometry : [],
    containerGeometry: Array.isArray(parsed.containerGeometry) ? parsed.containerGeometry : [],
    ok,
  };
}
