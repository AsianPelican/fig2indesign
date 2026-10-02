import {expect, test} from "bun:test";
import {spawnSync} from "node:child_process";
import path from "node:path";
import * as api from "./index";

test("public API exposes Figma and shared scene paths", () => {
  expect(typeof api.buildFromFigma).toBe("function");
  expect(typeof api.sceneFromFigma).toBe("function");
  expect(typeof api.buildFromScene).toBe("function");
  expect(typeof api.startLocalBridge).toBe("function");
  expect(Object.keys(api)).not.toContain("buildFromHtml");
  expect(Object.keys(api)).not.toContain("jsxToHtml");
});

test("CLI rejects removed HTML input before contacting the source service", () => {
  const result = spawnSync(process.execPath, ["bridge.ts", "html", "synthetic.html"], {cwd: path.resolve(import.meta.dir, ".."), encoding: "utf8"});
  expect(result.status).toBe(1);
  expect(result.stderr).not.toContain("artboard.html");
  expect(result.stderr).toContain("frame-id");
});
