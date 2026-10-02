#!/usr/bin/env bun
import {existsSync} from "node:fs";
import path from "node:path";

const root = import.meta.dir;
const requiredApps = [
  "/Applications/Google Chrome.app",
  "/Applications/Adobe InDesign 2026/Adobe InDesign 2026.app",
  "/Applications/Adobe InDesign 2025/Adobe InDesign 2025.app",
];
if (!existsSync(requiredApps[0])) throw new Error("Google Chrome is required in /Applications");
if (!requiredApps.slice(1).some(existsSync)) throw new Error("Adobe InDesign 2026 or 2025 is required in /Applications");
for (const command of [["bun", "install"], ["bun", "run", "plugin:build"]]) {
  const child = Bun.spawn(command, {cwd: root, stdout: "inherit", stderr: "inherit", stdin: "inherit"});
  if (await child.exited !== 0) throw new Error(`${command.join(" ")} failed`);
}
console.log(`Setup complete. Import ${path.join(root, "plugin", "manifest.json")} as a Figma development plugin, then start with FIGMA_TOKEN set: bun run bridge`);
