// Shared build flow: scene -> ExtendScript -> InDesign -> pixel diff.

import { mkdir, writeFile } from "fs/promises";
import { readFileSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { PNG } from "pngjs";
import path from "path";
import { emitJsx } from "./emit";
import { runJsx } from "./indesign";
import { comparePngs } from "./compare";
import { fontHintsFor } from "./fontdb";
import { padBleedImages } from "./bleed-pad";
import type { Scene } from "./types";

export interface PageReport {
  name: string;
  widthPx: number;
  heightPx: number;
  sourceWidthPx?: number;
  sourceHeightPx?: number;
  sourceScaleToPt?: number;
  nodeCount: number;
  warnings: string[];
  diffPct?: number;
  // Blur-insensitive comparison: photo resampling/bleed-zoom texture noise
  // vanishes, layout and typography errors remain.
  structDiffPct?: number;
}

export interface BuildReport {
  ok: boolean;
  inddPath?: string;
  idmlPath?: string;
  pages: PageReport[];
  fonts: string[];
  log: string[];
  worstDiffPct?: number;
  seconds?: number;
  textFidelity?: TextFidelitySummary;
  containerFidelity?: ContainerFidelitySummary;
  oversetTextFrames?: number;
  error?: string;
}

export interface TextGeometryRecord {
  page: number;
  node: string;
  line: number;
  expectedX: number;
  expectedBaseline: number;
  actualX: number;
  actualBaseline: number;
  measurable: boolean;
  reason?: string;
}

export interface TextFidelitySummary {
  totalLines: number;
  measurableLines: number;
  within1px: number;
  worstLinePx: number;
  worstLine?: {page: number; node: string; line: number; deltaPx: number};
  lines: (TextGeometryRecord & {deltaPx?: number})[];
}

export interface ContainerGeometryRecord {
  page: number;
  node: string;
  sourceType: string;
  expectedBounds: [number, number, number, number];
  actualBounds: [number, number, number, number];
  measurable: boolean;
  reason?: string;
}

export interface ContainerFidelitySummary {
  totalContainers: number;
  measurableContainers: number;
  within1px: number;
  worstContainerPx: number;
  worstContainer?: {page: number; node: string; sourceType: string; deltaPx: number};
  containers: (ContainerGeometryRecord & {deltaPx?: number})[];
}

export interface PrintPreset {
  pageWidth: number; // pt
  pageHeight: number;
  bleed: number;
  margins: { top: number; bottom: number; left: number; right: number; columns: number };
  coverFirst: boolean; // first board's RIGHT half becomes single page 1
  backLast: boolean; // last board's LEFT half becomes a single final page
}

export interface BuildOptions {
  docName: string;
  outDir: string;
  hardLineBreaks?: boolean;
  runInDesign?: boolean;
  // When set, boards are treated as 2-page print spreads: facing-pages doc,
  // scaled so board width == 2 * pageWidth, split across left/right pages.
  printPreset?: PrintPreset;
  // Per-board pagination override, aligned with the html file order.
  // undefined = auto-classify; "left"/"right" = single page from that half.
  pageRoles?: (("left" | "right" | "spread") | undefined)[];
  /** Internal source-adapter start time so reports include capture/fetch/measurement. */
  startedAtMs?: number;
}

export function scaleScenePage(p: import("./types").ScenePage, s: number) {
    p.widthPx *= s;
    p.heightPx *= s;
    for (const n of p.nodes) {
      n.x *= s; n.y *= s; n.width *= s; n.height *= s;
      if (n.rotOrigin) { n.rotOrigin.x *= s; n.rotOrigin.y *= s; }
      if (n.kind === "rect" || n.kind === "image") {
        if ((n as any).cornerRadius) (n as any).cornerRadius = (n as any).cornerRadius.map((v: number) => v * s);
      }
      if (n.kind === "image" && (n as any).clip) {
        const c = (n as any).clip;
        c.x *= s; c.y *= s; c.width *= s; c.height *= s;
      }
      if (n.kind === "image" && (n as any).bgPos) {
        const bp = (n as any).bgPos;
        if (bp.xUnit === "px") bp.x *= s;
        if (bp.yUnit === "px") bp.y *= s;
      }
      if (n.kind === "rect") {
        n.strokeWeightPx *= s;
        if (n.shadow) { n.shadow.x *= s; n.shadow.y *= s; n.shadow.blur *= s; n.shadow.spread *= s; }
      }
      if (n.kind === "text") {
        n.firstBaselineY *= s;
        for (const r of n.runs) {
          r.fontSizePx *= s; r.letterSpacingPx *= s; r.lineHeightPx *= s;
          for (const l of r.lines) { l.x *= s; l.baselineY *= s; l.width *= s; l.top *= s; l.height *= s; }
        }
        for (const vl of n.visualLines) { vl.top *= s; vl.baselineY *= s; vl.x *= s; }
      }
    }
    if (p.pageGuides) {
      p.pageGuides.top *= s;
      p.pageGuides.bottom *= s;
      p.pageGuides.left *= s;
      p.pageGuides.right *= s;
      p.pageGuides.columnGutter *= s;
    }
}

function scaleScene(scene: import("./types").Scene, s: number) {
  for (const p of scene.pages) {
    scaleScenePage(p, s);
  }
}

export function summarizeTextGeometry(lines: TextGeometryRecord[]): TextFidelitySummary {
  const withDelta = lines.map(line => line.measurable && Number.isFinite(line.actualX) && Number.isFinite(line.actualBaseline)
    ? {...line, deltaPx: Math.max(Math.abs(line.actualX - line.expectedX), Math.abs(line.actualBaseline - line.expectedBaseline))}
    : line);
  const measured = withDelta.filter((line): line is TextGeometryRecord & {deltaPx: number} => "deltaPx" in line);
  const worst = measured.slice().sort((a, b) => b.deltaPx - a.deltaPx)[0];
  return {
    totalLines: lines.length,
    measurableLines: measured.length,
    within1px: measured.filter(line => line.deltaPx <= 1).length,
    worstLinePx: worst?.deltaPx ?? 0,
    ...(worst ? {worstLine: {page: worst.page, node: worst.node, line: worst.line, deltaPx: worst.deltaPx}} : {}),
    lines: withDelta,
  };
}

export function summarizeContainerGeometry(containers: ContainerGeometryRecord[]): ContainerFidelitySummary {
  const withDelta = containers.map(container => {
    if (!container.measurable || container.expectedBounds.length !== 4 || container.actualBounds.length !== 4) return container;
    const deltaPx = Math.max(...container.expectedBounds.map((value, index) => Math.abs(value - container.actualBounds[index])));
    return {...container, deltaPx};
  });
  const measured = withDelta.filter((container): container is ContainerGeometryRecord & {deltaPx: number} => "deltaPx" in container);
  const worst = measured.slice().sort((a, b) => b.deltaPx - a.deltaPx)[0];
  return {
    totalContainers: containers.length,
    measurableContainers: measured.length,
    within1px: measured.filter(container => container.deltaPx <= 1).length,
    worstContainerPx: worst?.deltaPx ?? 0,
    ...(worst ? {worstContainer: {page: worst.page, node: worst.node, sourceType: worst.sourceType, deltaPx: worst.deltaPx}} : {}),
    containers: withDelta,
  };
}

export async function buildFromScene(scene: Scene, screenshots: string[], opts: BuildOptions): Promise<BuildReport> {
  const started = opts.startedAtMs ?? performance.now();
  const outDir = path.resolve(opts.outDir);
  await mkdir(outDir, { recursive: true });
  scene.fontHints ??= fontHintsFor(scene.fonts.map((f) => f.families));
  let bleedLog: string[] = [];

  if (opts.printPreset) {
    // Cover, don't undershoot: board ratios rarely match the trim exactly
    // and a width-based scale can leave gaps at the bottom edge.
    // Scale by the larger factor and
    // let the sub-point overflow run into bleed / the fold crop.
    const s = Math.max(
      (2 * opts.printPreset.pageWidth) / scene.pages[0].widthPx,
      opts.printPreset.pageHeight / scene.pages[0].heightPx,
    );
    scaleScene(scene, s);
    (scene as any).printPreset = opts.printPreset;
    // Fill the print bleed at design scale (mirrored edge pixels), so the
    // trimmed page stays 1:1 with the source.
    bleedLog = padBleedImages(scene, outDir, opts.printPreset.bleed);

    // Classify each board: full spread, or a single page designed on one half
    // of the spread-wide canvas (empty other half). Background-sized rects are
    // ignored; whichever half holds the real content decides.
    for (const p of scene.pages) {
      const half = p.widthPx / 2;
      const halfArea = half * p.heightPx;
      let tL = 0, tR = 0, iL = 0, iR = 0;
      // Is the given region hidden under an opaque rect painted after index i?
      const covered = (i: number, x0: number, x1: number, y0: number, y1: number) => {
        if (x1 - x0 <= 0) return true;
        for (let nj = i + 1; nj < p.nodes.length; nj++) {
          const r = p.nodes[nj];
          if (r.kind !== "rect" || !(r as any).fill || r.opacity < 0.95) continue;
          if (r.x <= x0 + 2 && r.y <= y0 + 2 && r.x + r.width >= x1 - 2 && r.y + r.height >= y1 - 2) return true;
        }
        return false;
      };
      for (let ni = 0; ni < p.nodes.length; ni++) {
        const n = p.nodes[ni];
        if (n.kind === "rect") continue; // fills/bands are decor, not content
        const y0 = n.y, y1 = n.y + n.height;
        let lw = Math.max(0, Math.min(n.x + n.width, half) - Math.max(n.x, 0));
        let rw = Math.max(0, Math.min(n.x + n.width, p.widthPx) - Math.max(n.x, half));
        // A half-portion hidden under a later opaque panel is not content there.
        if (lw > 0 && covered(ni, Math.max(n.x, 0), Math.min(n.x + n.width, half), y0, y1)) lw = 0;
        if (rw > 0 && covered(ni, Math.max(n.x, half), Math.min(n.x + n.width, p.widthPx), y0, y1)) rw = 0;
        if (n.kind === "text") { tL += lw * n.height; tR += rw * n.height; }
        else { iL += lw * n.height; iR += rw * n.height; }
      }
      const contentL = tL + iL, contentR = tR + iR;
      if (contentR < 0.06 * Math.max(contentL, 1) && iR < 0.15 * halfArea) p.spreadRole = "left";
      else if (contentL < 0.06 * Math.max(contentR, 1) && iL < 0.15 * halfArea) p.spreadRole = "right";
      else p.spreadRole = "spread";
    }
    // Semantic layer hints that never violate paint order: text overlapped by
    // LATER artwork must stay below it, so it rides the GRAPHIC layer.
    for (const p of scene.pages) {
      for (let i = 0; i < p.nodes.length; i++) {
        const n = p.nodes[i];
        if (n.kind === "rect" && n.width * n.height >= 0.5 * p.widthPx * p.heightPx) {
          // Only true backgrounds sink: a big panel painted OVER earlier
          // content must keep its place in the stack.
          let coversEarlier = false;
          for (let j = 0; j < i && !coversEarlier; j++) {
            const m = p.nodes[j];
            const ix = Math.min(n.x + n.width, m.x + m.width) - Math.max(n.x, m.x);
            const iy = Math.min(n.y + n.height, m.y + m.height) - Math.max(n.y, m.y);
            if (ix > 2 && iy > 2) coversEarlier = true;
          }
          n.layerHint = coversEarlier ? "GFX" : "BG";
          continue;
        }
        if (n.kind !== "text") {
          n.layerHint = "GFX";
          continue;
        }
        let overlappedLater = false;
        for (let j = i + 1; j < p.nodes.length && !overlappedLater; j++) {
          const m = p.nodes[j];
          if (m.kind === "text") continue;
          const ix = Math.min(n.x + n.width, m.x + m.width) - Math.max(n.x, m.x);
          const iy = Math.min(n.y + n.height, m.y + m.height) - Math.max(n.y, m.y);
          if (ix > 2 && iy > 2) overlappedLater = true;
        }
        n.layerHint = overlappedLater ? "GFX" : "TEXT";
      }
    }

    // Semantic item names for a readable Layers panel (only when the export
    // gave us a generic tag name).
    const hex = (c: { r: number; g: number; b: number }) =>
      "#" + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();
    for (const p of scene.pages) {
      for (const n of p.nodes) {
        if (!/^(div|span|p|section|article|main|header|footer)$/i.test(n.name)) continue;
        if (n.kind === "text") {
          const t = (n.visualLines?.[0]?.segments?.map((s) => s.text).join("") || "").trim();
          n.name = t ? t.slice(0, 28) : "Text";
        } else if (n.kind === "image") {
          n.name = "Image " + ((n as any).src || "").replace(/@2x\.png$/, "").slice(0, 12);
        } else if (n.kind === "svg") {
          n.name = "Vector";
        } else if (n.kind === "rect") {
          const r = n as import("./types").RectNode;
          n.name = r.fill ? "Fill " + hex(r.fill) : "Frame";
        }
      }
    }

    // Explicit designer overrides win over classification.
    if (opts.pageRoles) {
      for (let i = 0; i < scene.pages.length; i++) {
        if (opts.pageRoles[i]) scene.pages[i].spreadRole = opts.pageRoles[i];
      }
    }
  }
  const pages: PageReport[] = scene.pages.map((p) => ({
    name: p.name, widthPx: p.widthPx, heightPx: p.heightPx,
    sourceWidthPx: p.sourceWidthPx, sourceHeightPx: p.sourceHeightPx, sourceScaleToPt: p.sourceScaleToPt,
    nodeCount: p.nodes.length, warnings: p.warnings,
  }));
  const fonts = scene.fonts.map((f) => `${f.families[0]} ${f.style}`);

  await writeFile(path.join(outDir, "scene.json"), JSON.stringify(scene, null, 2));
  const jsxPath = path.join(outDir, "build.jsx");
  await writeFile(jsxPath, emitJsx(scene, { outDir, hardLineBreaks: opts.hardLineBreaks !== false }));

  if (opts.runInDesign === false) {
    return { ok: true, pages, fonts, log: ["measure-only"], seconds: (performance.now() - started) / 1000 };
  }

  const result = runJsx(jsxPath, outDir);
  if (!result.ok) {
    return { ok: false, pages, fonts, log: result.log, error: "InDesign build failed", seconds: (performance.now() - started) / 1000 };
  }

  let worst = 0;
  if (opts.printPreset) {
    // Boards were split into facing pages: slice each board reference into
    // page-sized halves and compare per proof page.
    const P = opts.printPreset;
    // Proofs are exported at 144dpi, so slice refs at 2x point dimensions.
    const spreadW = Math.round(4 * P.pageWidth);
    const pageH = Math.round(2 * P.pageHeight);
    let cursor = 1;
    for (let i = 0; i < scene.pages.length; i++) {
      const role = scene.pages[i].spreadRole || "spread";
      if (role === "spread" && cursor % 2 === 1) cursor++; // blank page keeps spreads verso-first
      const resized = path.join(outDir, `ref-scaled-${i + 1}.png`);
      spawnSync("sips", ["-z", String(pageH), String(spreadW), screenshots[i], "--out", resized], { stdio: "ignore" });
      const img = PNG.sync.read(readFileSync(resized));
      const halfW = Math.floor(img.width / 2);
      const halves: { half: "L" | "R"; pageNo: number }[] = role === "right"
        ? [{ half: "R", pageNo: cursor }]
        : role === "left"
          ? [{ half: "L", pageNo: cursor }]
          : [{ half: "L", pageNo: cursor }, { half: "R", pageNo: cursor + 1 }];
      let boardWorst = 0;
      let boardStructWorst = 0;
      for (const h of halves) {
        const crop = new PNG({ width: halfW, height: img.height });
        PNG.bitblt(img, crop, h.half === "L" ? 0 : img.width - halfW, 0, halfW, img.height, 0, 0);
        const refPage = path.join(outDir, `refpage-${h.pageNo}.png`);
        writeFileSync(refPage, PNG.sync.write(crop));
        const proofPage = path.join(outDir, `proof-${h.pageNo}.png`);
        const diff = comparePngs(refPage, proofPage, path.join(outDir, `diff-${h.pageNo}.png`));
        boardWorst = Math.max(boardWorst, diff.diffPct);
        // Structure score: compare at quarter resolution so sub-point texture
        // drift disappears while misplaced/missing elements still register.
        const sW = Math.round(halfW / 4), sH = Math.round(img.height / 4);
        const refS = refPage + ".s.png", proofS = proofPage + ".s.png";
        spawnSync("sips", ["-z", String(sH), String(sW), refPage, "--out", refS], { stdio: "ignore" });
        spawnSync("sips", ["-z", String(sH), String(sW), proofPage, "--out", proofS], { stdio: "ignore" });
        try {
          const sd = comparePngs(refS, proofS, path.join(outDir, `sdiff-${h.pageNo}.png`));
          boardStructWorst = Math.max(boardStructWorst, sd.diffPct);
        } catch {}
      }
      pages[i].diffPct = Math.round(boardWorst * 100) / 100;
      pages[i].structDiffPct = Math.round(boardStructWorst * 100) / 100;
      worst = Math.max(worst, boardWorst);
      cursor += halves.length;
    }
  } else {
    for (let i = 0; i < scene.pages.length; i++) {
      const proof = path.join(outDir, `proof-${i + 1}.png`);
      const proofImage = PNG.sync.read(readFileSync(proof));
      let reference = screenshots[i];
      const referenceImage = PNG.sync.read(readFileSync(reference));
      if (referenceImage.width !== proofImage.width || referenceImage.height !== proofImage.height) {
        reference = path.join(outDir, `reference-${i + 1}.png`);
        const resized = spawnSync("sips", ["-z", String(proofImage.height), String(proofImage.width), screenshots[i], "--out", reference], {encoding: "utf8"});
        if (resized.status !== 0) throw new Error(`could not normalize source reference ${i + 1}: ${resized.stderr}`);
      }
      const diff = comparePngs(reference, proof, path.join(outDir, `diff-${i + 1}.png`));
      pages[i].diffPct = Math.round(diff.diffPct * 100) / 100;
      worst = Math.max(worst, diff.diffPct);
    }
  }

  const textFidelity = summarizeTextGeometry(result.textGeometry || []);
  const containerFidelity = summarizeContainerGeometry(result.containerGeometry || []);
  const oversetTextFrames = result.log.filter(line => line.startsWith("OVERSET TEXT:")).length;
  const report: BuildReport = {
    ok: true,
    inddPath: path.join(outDir, opts.docName + ".indd"),
    idmlPath: path.join(outDir, opts.docName + ".idml"),
    pages, fonts, log: [...bleedLog, ...result.log.filter((l) => l !== "DONE")],
    worstDiffPct: Math.round(worst * 100) / 100,
    seconds: (performance.now() - started) / 1000,
    textFidelity,
    containerFidelity,
    oversetTextFrames,
  };
  await writeFile(path.join(outDir, "fidelity-report.json"), JSON.stringify({
    document: scene.docName,
    pages: pages.length,
    seconds: report.seconds,
    linesWithin1px: textFidelity.within1px,
    measurableLines: textFidelity.measurableLines,
    totalLines: textFidelity.totalLines,
    worstLinePx: textFidelity.worstLinePx,
    worstLine: textFidelity.worstLine,
    containerFidelity,
    oversetTextFrames,
    pagesReport: pages,
    lines: textFidelity.lines,
  }, null, 2) + "\n");
  return report;
}
