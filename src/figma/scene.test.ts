import {afterEach, expect, test} from "bun:test";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {inferPhysicalScale, pageGuidesFromFigma, sceneFromFigma, sourceContainers} from "./scene";
import type {SharedFigmaRuntime} from "./shared";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true}); });

test("Figma scene reuses shared line geometry and removes live text from artwork", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "idbridge-figma-")); roots.push(root);
  let geometryCalls = 0;
  const frame = {
    id: "1:2", name: "Synthetic frame", type: "FRAME", absoluteBoundingBox: {x: 100, y: 200, width: 320, height: 180},
    children: [{id: "1:3", name: "Synthetic line", type: "TEXT", characters: "Synthetic line", absoluteBoundingBox: {x: 124, y: 250, width: 180, height: 30}, style: {fontFamily: "Helvetica", fontSize: 24, fontWeight: 400, lineHeightPx: 30, textAlignHorizontal: "LEFT"}}],
  };
  const svg = '<svg width="320" height="180" xmlns="http://www.w3.org/2000/svg"><rect width="320" height="180" fill="#eee"/><text data-node-id="1:3"><tspan x="24" y="72">Synthetic line</tspan></text></svg>';
  class Client {
    async get(request: string) { return {images: {"1:2": request.includes("format=svg") ? "synthetic:svg" : "synthetic:png"}}; }
    async download(url: string) { return new TextEncoder().encode(url.endsWith("svg") ? svg : "synthetic-png"); }
  }
  const runtime = {
    FigmaClient: Client,
    FigmaFile: {open: async () => ({
      meta: {name: "Synthetic deck", version: "1001"},
      fetchFrames: async () => {},
      document: () => frame,
    })},
    resolveFrames: () => ["1:2"],
    parseTarget: () => ({fileKey: "SyntheticDeck0001"}),
    readToken: () => "synthetic-token",
    text: {
      collectSegs: () => { geometryCalls++; return {segs: [{x: 24, y: 72, t: "Synthetic line", fill: ["112233", 1]}], rotTm: null}; },
      groupLines: (segments: any[]) => [segments],
      alignLines: () => [{x: 24, y: 72, hardBefore: false, runs: [{t: "Synthetic line", style: {fontFamily: "Helvetica", fontSize: 24, fontWeight: 400, lineHeightPx: 30, letterSpacing: 0}, fill: ["112233", 1]}]}],
    },
    geom: {I: [1, 0, 0, 1, 0, 0], mul: (a: unknown) => a, parseTransform: () => [1, 0, 0, 1, 0, 0]},
    root: "/synthetic/figma2pptx",
  } as unknown as SharedFigmaRuntime;
  const result = await sceneFromFigma({target: "SyntheticDeck0001", frames: ["1:2"], cacheDir: path.join(root, "cache"), outDir: path.join(root, "out"), runtime, fontHints: () => ({})});
  expect(geometryCalls).toBe(1);
  expect(result.scene.pages).toHaveLength(1);
  const page = result.scene.pages[0];
  expect(page.nodes.filter(node => node.kind === "text")).toHaveLength(1);
  const text = page.nodes.find(node => node.kind === "text")! as any;
  expect(text.firstBaselineY).toBe(72);
  expect(text.visualLines[0].x).toBe(24);
  const art = page.nodes.find(node => node.kind === "svg")! as any;
  const staged = await readFile(path.join(root, "out", "Links", art.src), "utf8");
  expect(staged).toContain("<rect");
  expect(staged).not.toContain("Synthetic line");
});

test("standard print canvases map to physical US Letter points", () => {
  expect(inferPhysicalScale(850, 1100)).toBeCloseTo(0.72, 8);
  expect(inferPhysicalScale(1100, 850)).toBeCloseTo(0.72, 8);
  expect(inferPhysicalScale(816, 1056)).toBeCloseTo(0.75, 8);
  expect(inferPhysicalScale(1920, 1080)).toBe(1);
});

test("source containers retain synthetic bounds, hierarchy, image roles, and clipping", () => {
  const frame = {
    id: "1:1", name: "Synthetic page", type: "FRAME", absoluteBoundingBox: {x: 100, y: 200, width: 850, height: 1100},
    layoutGrids: [{pattern: "COLUMNS", count: 6, gutterSize: 20, offset: 50}, {pattern: "ROWS", count: 10, gutterSize: 12, offset: 40}],
    children: [{
      id: "1:2", name: "Synthetic group", type: "FRAME", clipsContent: true, absoluteBoundingBox: {x: 150, y: 240, width: 700, height: 900},
      children: [
        {id: "1:3", name: "Synthetic photo", type: "RECTANGLE", fills: [{type: "IMAGE"}], absoluteBoundingBox: {x: 170, y: 260, width: 200, height: 120}},
        {id: "1:4", name: "Synthetic copy", type: "TEXT", absoluteBoundingBox: {x: 400, y: 280, width: 300, height: 60}},
        {id: "1:5", name: "Hidden", type: "RECTANGLE", visible: false, absoluteBoundingBox: {x: 0, y: 0, width: 10, height: 10}},
      ],
    }],
  };
  const containers = sourceContainers(frame);
  expect(containers).toHaveLength(3);
  expect(containers[0]).toMatchObject({sourceType: "FRAME", x: 50, y: 40, width: 700, height: 900, clipsContent: true});
  expect(containers[1]).toMatchObject({sourceType: "IMAGE_FRAME", sourceParentId: "1:2", x: 70, y: 60, width: 200, height: 120});
  expect(containers[2]).toMatchObject({sourceType: "TEXT", sourceParentId: "1:2", x: 300, y: 80, width: 300, height: 60});
  expect(pageGuidesFromFigma(frame)).toEqual({top: 40, bottom: 40, left: 50, right: 50, columns: 6, columnGutter: 20});
});
