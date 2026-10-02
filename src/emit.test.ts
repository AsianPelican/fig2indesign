import {expect, test} from "bun:test";
import {runInNewContext} from "node:vm";
import {emitJsx} from "./emit";
import {scaleScenePage} from "./pipeline";
import type {Scene, ScenePage} from "./types";

const scene: Scene = {docName: "Synthetic document", pages: [], fonts: []};
const jsx = emitJsx(scene, {outDir: "/synthetic/output", hardLineBreaks: true});
const prelude = jsx.slice(0, jsx.lastIndexOf("\ntry {\n  main();"));

function fit(box: number[], contain: boolean, bgPos?: unknown, pad?: unknown) {
  const graphic = {geometricBounds: [0, 0, 100, 200]};
  const frame = {allGraphics: [graphic], geometricBounds: [0, 0, 20, 20], fit: () => {}};
  const context = {frame, box, contain, bgPos, pad, FitOptions: {PROPORTIONALLY: 1}};
  runInNewContext(prelude + "\nplaceCssFit(frame, box, contain, bgPos, pad);", context);
  return graphic.geometricBounds;
}

test("cover fitting uses the full source box instead of the clipped frame", () => {
  expect(fit([10, 20, 110, 120], false)).toEqual([10, -30, 110, 170]);
});

test("contain fitting and percent position preserve source geometry", () => {
  expect(fit([10, 20, 110, 120], true)).toEqual([35, 20, 85, 120]);
  expect(fit([10, 20, 110, 120], false, {x: 0, xUnit: "%", y: 100, yUnit: "%"})).toEqual([10, 20, 110, 220]);
});

test("pixel position and mirrored padding do not move the trim crop", () => {
  expect(fit([10, 20, 110, 120], false, {x: 7, xUnit: "px", y: 3, yUnit: "px"})).toEqual([13, 27, 113, 227]);
  expect(fit([10, 20, 110, 120], false, undefined, {natW: 200, natH: 100, t: 4, r: 6, b: 8, l: 2})).toEqual([6, -32, 118, 176]);
});

test("uniform text alpha affects text content without changing frame transparency", () => {
  const start = jsx.indexOf("var textAlpha = 1, mixedAlpha = false;");
  const end = jsx.indexOf("// Exact vertical placement", start);
  const tf = {contentTransparencySettings: {blendingSettings: {opacity: 100}}, frameOpacity: 100};
  const context = {tf, ranges: [{run: {opacity: 0.4}}, {run: {opacity: 0.4}}], n: {name: "Synthetic text"}, log: () => {}, setOpacity: () => {throw new Error("unexpected frame fallback");}};
  runInNewContext(jsx.slice(start, end), context);
  expect(tf.contentTransparencySettings.blendingSettings.opacity).toBe(40);
  expect(tf.frameOpacity).toBe(100);
});

test("mixed text alpha is reported instead of silently hidden", () => {
  const start = jsx.indexOf("var textAlpha = 1, mixedAlpha = false;");
  const end = jsx.indexOf("// Exact vertical placement", start);
  const messages: string[] = [];
  const tf = {contentTransparencySettings: {blendingSettings: {opacity: 100}}};
  runInNewContext(jsx.slice(start, end), {tf, ranges: [{run: {opacity: 0.4}}, {run: {opacity: 0.8}}], n: {name: "Synthetic text"}, log: (value: string) => messages.push(value), setOpacity: () => {}});
  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain("TEXT ALPHA MIXED");
});

test("ancestor clipping intersects the frame without moving graphic contents", () => {
  const start = jsx.indexOf("if (n.clip) {");
  const end = jsx.indexOf('\n          } else {\n            log("MISSING LINK:', start);
  const graphic = {geometricBounds: [-10, -20, 150, 180]};
  const frame = {geometricBounds: [0, 0, 120, 120], allGraphics: [graphic]};
  runInNewContext(jsx.slice(start, end), {frame, n: {name: "Synthetic image", clip: {x: 15, y: 20, width: 60, height: 70}}, log: () => {}});
  expect(frame.geometricBounds).toEqual([20, 15, 90, 75]);
  expect(graphic.geometricBounds).toEqual([-10, -20, 150, 180]);
});

test("physical-page scaling scales crop coordinates and absolute background offsets", () => {
  const page = {widthPx: 200, heightPx: 300, nodes: [{kind: "image", x: 10, y: 20, width: 100, height: 120, clip: {x: 30, y: 40, width: 50, height: 60}, bgPos: {x: 8, xUnit: "px", y: 25, yUnit: "%"}}]} as unknown as ScenePage;
  scaleScenePage(page, 0.5);
  expect(page.nodes[0]).toMatchObject({x: 5, y: 10, width: 50, height: 60, clip: {x: 15, y: 20, width: 25, height: 30}, bgPos: {x: 4, y: 25}});
});

test("generated script stays ASCII and sets the document profile without overriding image profiles", () => {
  expect(jsx).not.toMatch(/[^\x00-\x7f]/);
  expect(jsx).toContain('doc.rgbProfile = "sRGB IEC61966-2.1"');
  expect(jsx).not.toContain('gph0.profile =');
});
