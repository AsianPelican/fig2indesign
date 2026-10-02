#!/usr/bin/env bun
import {buildFromFigma} from "./src/figma/build";

function usage(): never {
  console.error("Usage:\n  bun bridge.ts serve\n  bun bridge.ts figma <file-key-or-url> <frame-id...> [--name name] [--out out] [--cache cache] [--no-indesign]");
  process.exit(1);
}

const args = process.argv.slice(2);
if (args[0] === "serve") {
  const {startLocalBridge} = await import("./src/local/server");
  startLocalBridge();
} else if (args[0] === "figma") {
  const target = args[1];
  if (!target) usage();
  const frames: string[] = [];
  let docName: string | undefined;
  let outDir = "out";
  let cacheDir = "cache";
  let runInDesign = true;
  for (let index = 2; index < args.length; index++) {
    const value = args[index];
    if (value === "--name") docName = args[++index];
    else if (value === "--out") outDir = args[++index];
    else if (value === "--cache") cacheDir = args[++index];
    else if (value === "--no-indesign") runInDesign = false;
    else if (value.startsWith("--")) usage();
    else frames.push(value);
  }
  const report = await buildFromFigma({target, frames, docName, outDir, cacheDir, runInDesign});
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
} else usage();
