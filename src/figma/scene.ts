import {createHash} from "node:crypto";
import {existsSync} from "node:fs";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {DOMParser, XMLSerializer} from "@xmldom/xmldom";
import type {RGB, Scene, ScenePage, TextNode, TextRun, VisualLine} from "../types";
import {fontHintsFor} from "../fontdb";
import {scaleScenePage} from "../pipeline";
import type {ContainerNode, PageGuides} from "../types";
import {loadSharedFigmaRuntime, type SharedFigmaRuntime} from "./shared";
import {rasterizeSvg} from "./svg-raster";

export interface FigmaSceneOptions {
  target: string;
  frames: string[];
  page?: string;
  cacheDir: string;
  outDir: string;
  docName?: string;
  token?: string;
  sharedRoot?: string;
  runtime?: SharedFigmaRuntime;
  fetchImpl?: typeof fetch;
  fontHints?: typeof fontHintsFor;
}

export interface FigmaSceneResult {
  scene: Scene;
  references: string[];
  frameIds: string[];
  sourceVersion: string;
  warnings: string[];
}

const filename = (id: string) => id.replace(/:/g, "-").replace(/[^\w.-]/g, "_");

function styleName(style: any): string {
  const weight = Math.round(Number(style.fontWeight || 400) / 100) * 100;
  const names: Record<number, string> = {100: "Thin", 200: "ExtraLight", 300: "Light", 400: "Regular", 500: "Medium", 600: "SemiBold", 700: "Bold", 800: "ExtraBold", 900: "Black"};
  const base = names[weight] || "Regular";
  return style.italic ? (base === "Regular" ? "Italic" : `${base} Italic`) : base;
}

function rgb(fill: any): {color: RGB; opacity: number} {
  if (!fill) return {color: {r: 0, g: 0, b: 0}, opacity: 1};
  const raw = Array.isArray(fill) ? fill[0] : String(fill);
  const alpha = Array.isArray(fill) ? Number(fill[1] ?? 1) : 1;
  const hex = raw.replace(/^#/, "");
  const full = hex.length === 3 ? hex.split("").map((c: string) => c + c).join("") : hex.padEnd(6, "0").slice(0, 6);
  return {
    color: {r: parseInt(full.slice(0, 2), 16), g: parseInt(full.slice(2, 4), 16), b: parseInt(full.slice(4, 6), 16)},
    opacity: Number.isFinite(alpha) ? alpha : 1,
  };
}

function indexNodes(root: any): Map<string, any> {
  const nodes = new Map<string, any>();
  const visit = (node: any) => {
    if (node?.id) nodes.set(node.id, node);
    for (const child of node?.children || []) visit(child);
  };
  visit(root);
  return nodes;
}

function textNodes(
  doc: Document,
  frame: any,
  runtime: SharedFigmaRuntime,
  warnings: string[],
): TextNode[] {
  const byId = indexNodes(frame);
  const frameBox = frame.absoluteBoundingBox;
  const output: TextNode[] = [];
  const done = new Set<string>();
  const {I, mul, parseTransform} = runtime.geom;

  const visit = (element: any, matrix: unknown, owner: string | null, opacity: number) => {
    if (!element || element.nodeType !== 1 || ["defs", "clipPath", "mask", "pattern"].includes(element.tagName)) return;
    const id = element.getAttribute("data-node-id") || owner;
    const node = id ? byId.get(id) : undefined;
    const ownOpacity = element.getAttribute("opacity");
    const cumulativeOpacity = opacity * (ownOpacity == null || ownOpacity === "" ? 1 : Number(ownOpacity));
    if (node?.type === "TEXT") {
      if (done.has(id)) return;
      done.add(id);
      try {
        const collected = runtime.text.collectSegs(element, matrix, message => warnings.push(message));
        const lines = runtime.text.alignLines(runtime.text.groupLines(collected.segs), node, id, message => warnings.push(message));
        const box = node.absoluteBoundingBox || {x: frameBox.x, y: frameBox.y, width: 1, height: 1};
        const boxX = box.x - frameBox.x;
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
          const line = lines[lineIndex];
          const runs: TextRun[] = [];
          const segments: VisualLine["segments"] = [];
          let maxSize = Number(node.style?.fontSize || 12);
          for (const run of line.runs) {
            const style = run.style || node.style || {};
            const size = Number(style.fontSize || maxSize);
            maxSize = Math.max(maxSize, size);
            const paint = rgb(run.fill);
            const textRun: TextRun = {
              text: run.t,
              fontFamily: style.fontFamily || node.style?.fontFamily || "Helvetica",
              fontFamilies: [style.fontFamily || node.style?.fontFamily || "Helvetica"],
              fontStyle: styleName(style),
              fontSizePx: size,
              letterSpacingPx: Number(style.letterSpacing || 0),
              lineHeightPx: Number(style.lineHeightPx || node.style?.lineHeightPx || size * 1.2),
              color: paint.color,
              opacity: paint.opacity,
              lines: [{text: run.t, x: line.x, baselineY: line.y, width: Math.max(1, box.width), top: line.y - size, height: size * 1.2}],
            };
            segments.push({runIndex: runs.length, text: run.t});
            runs.push(textRun);
          }
          if (!runs.length) continue;
          const alignMap: Record<string, TextNode["align"]> = {LEFT: "left", CENTER: "center", RIGHT: "right", JUSTIFIED: "justify"};
          const align = alignMap[node.style?.textAlignHorizontal] || "left";
          const width = align === "center"
            ? Math.max(1, 2 * Math.abs(boxX + box.width / 2 - line.x))
            : Math.max(1, boxX + box.width - line.x);
          output.push({
            kind: "text",
            id: `${id}:line:${lineIndex + 1}`,
            name: `${node.name || "Text"} — line ${lineIndex + 1}`,
            x: line.x,
            y: line.y - maxSize,
            width,
            height: maxSize * 1.35,
            opacity: cumulativeOpacity,
            rotationDeg: collected.rotTm ? Math.atan2((collected.rotTm as any)[1], (collected.rotTm as any)[0]) * 180 / Math.PI : 0,
            align,
            runs,
            firstBaselineY: line.y,
            visualLines: [{top: line.y - maxSize, baselineY: line.y, x: line.x, segments}],
            layerHint: "TEXT",
          });
        }
      } catch (error) {
        warnings.push(`text ${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    const next = element.tagName === "g" ? mul(matrix, parseTransform(element.getAttribute("transform"))) : matrix;
    for (const child of Array.from(element.childNodes || []) as any[]) visit(child, next, id, cumulativeOpacity);
  };
  visit(doc.documentElement, I, null, 1);
  return output;
}

function removeLiveText(doc: Document, frame: any): void {
  const byId = indexNodes(frame);
  const remove: Node[] = [];
  const visit = (element: any, owner: string | null) => {
    if (!element || element.nodeType !== 1 || element.tagName === "defs") return;
    const id = element.getAttribute("data-node-id") || owner;
    if (id && byId.get(id)?.type === "TEXT") {
      remove.push(element);
      return;
    }
    for (const child of Array.from(element.childNodes || []) as any[]) visit(child, id);
  };
  visit(doc.documentElement, null);
  for (const node of remove) node.parentNode?.removeChild(node);
}

async function cachedRender(client: any, fileKey: string, id: string, dir: string, format: "svg" | "png", scale = 1): Promise<string> {
  await mkdir(dir, {recursive: true});
  const target = path.join(dir, `${filename(id)}${format === "png" ? `@${scale}` : ""}.${format}`);
  if (existsSync(target)) return target;
  const params = new URLSearchParams({ids: id, format});
  if (format === "svg") {
    params.set("svg_outline_text", "false");
    params.set("svg_include_node_id", "true");
    params.set("svg_simplify_stroke", "false");
  } else {
    params.set("scale", String(scale));
    params.set("use_absolute_bounds", "true");
  }
  const response = await client.get(`images/${fileKey}?${params}`);
  const url = response.images?.[id];
  if (!url) throw new Error(`Figma could not render frame ${id} as ${format}`);
  await writeFile(target, await client.download(url));
  return target;
}

const near = (value: number, target: number) => Math.abs(value - target) <= 0.25;

/** Map common print-canvas pixel conventions to physical points. */
export function inferPhysicalScale(width: number, height: number): number {
  const portrait = width < height;
  const short = portrait ? width : height;
  const long = portrait ? height : width;
  if (near(short, 850) && near(long, 1100)) return 72 / 100;
  if (near(short, 816) && near(long, 1056)) return 72 / 96;
  return 1;
}

export function pageGuidesFromFigma(frame: any): PageGuides {
  const guides: PageGuides = {top: 0, bottom: 0, left: 0, right: 0, columns: 1, columnGutter: 0};
  for (const grid of Array.isArray(frame.layoutGrids) ? frame.layoutGrids : []) {
    const offset = Number.isFinite(grid.offset) ? Math.max(0, grid.offset) : 0;
    if (grid.pattern === "COLUMNS") {
      guides.left = offset;
      guides.right = offset;
      guides.columns = Number.isFinite(grid.count) ? Math.max(1, Math.round(grid.count)) : 1;
      guides.columnGutter = Number.isFinite(grid.gutterSize) ? Math.max(0, grid.gutterSize) : 0;
    } else if (grid.pattern === "ROWS") {
      guides.top = offset;
      guides.bottom = offset;
    }
  }
  return guides;
}

const CONTAINER_TYPES = new Set(["FRAME", "GROUP", "RECTANGLE", "INSTANCE", "COMPONENT", "COMPONENT_SET", "TEXT"]);

export function sourceContainers(frame: any): ContainerNode[] {
  const root = frame.absoluteBoundingBox;
  if (!root) return [];
  const out: ContainerNode[] = [];
  const visit = (node: any, depth: number, parentVisible: boolean, sourceParentId?: string) => {
    const visible = parentVisible && node.visible !== false;
    if (!visible) return;
    let nextParent = sourceParentId;
    if (node !== frame && CONTAINER_TYPES.has(node.type)) {
      const box = node.absoluteBoundingBox;
      if (box && box.width > 0 && box.height > 0) {
        const imageFrame = Array.isArray(node.fills) && node.fills.some((fill: any) => fill?.visible !== false && fill?.type === "IMAGE");
        const sourceType = imageFrame ? "IMAGE_FRAME" : node.type;
        out.push({
          kind: "container",
          id: `${node.id}:source-container`,
          name: node.name || sourceType,
          sourceId: node.id,
          sourceType,
          ...(sourceParentId ? {sourceParentId} : {}),
          sourceDepth: depth,
          clipsContent: node.clipsContent === true,
          x: box.x - root.x,
          y: box.y - root.y,
          width: box.width,
          height: box.height,
          opacity: 1,
          rotationDeg: 0,
          layerHint: "CONTAINERS",
        } as ContainerNode);
        nextParent = node.id;
      }
    }
    for (const child of Array.isArray(node.children) ? node.children : []) visit(child, depth + 1, visible, nextParent);
  };
  visit(frame, 0, true);
  return out;
}

export async function sceneFromFigma(options: FigmaSceneOptions): Promise<FigmaSceneResult> {
  const runtime = options.runtime ?? await loadSharedFigmaRuntime(options.sharedRoot);
  const target = runtime.parseTarget(options.target);
  const token = options.token || runtime.readToken();
  const client = new runtime.FigmaClient(token, options.fetchImpl);
  const file = await runtime.FigmaFile.open(target.fileKey, options.cacheDir, client);
  const frameIds = runtime.resolveFrames(file.meta, options.frames, {page: options.page, nodeId: target.nodeId});
  if (!frameIds.length) throw new Error("Figma selection resolved to no frames");
  await file.fetchFrames(frameIds);

  const warnings: string[] = [];
  const pages: ScenePage[] = [];
  const references: string[] = [];
  const fonts = new Map<string, {families: string[]; style: string}>();
  const cache = path.join(options.cacheDir, target.fileKey, String(file.meta.version), "indesign");
  const links = path.join(options.outDir, "Links");
  await mkdir(links, {recursive: true});

  for (let index = 0; index < frameIds.length; index++) {
    const id = frameIds[index];
    const frame = file.document(id);
    const box = frame.absoluteBoundingBox;
    const svgPath = await cachedRender(client, target.fileKey, id, path.join(cache, "svg"), "svg");
    const physicalScale = inferPhysicalScale(box.width, box.height);
    const ref = await cachedRender(client, target.fileKey, id, path.join(cache, "reference"), "png", physicalScale);
    references.push(ref);
    const svg = await readFile(svgPath, "utf8");
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml") as unknown as Document;
    const pageWarnings: string[] = [];
    const texts = textNodes(doc, frame, runtime, pageWarnings);
    removeLiveText(doc, frame);
    const artwork = new XMLSerializer().serializeToString(doc as any);
    const digest = createHash("sha256").update(artwork).digest("hex").slice(0, 16);
    const artworkName = `figma-${filename(id)}-${digest}.svg`;
    await writeFile(path.join(links, artworkName), artwork);
    const hasEmbeddedImages = (Array.from(doc.getElementsByTagName("image")) as unknown as Element[])
      .some(image => (image.getAttribute("href") || image.getAttribute("xlink:href") || "").startsWith("data:"));
    let fallbackPng: string | undefined;
    if (hasEmbeddedImages) {
      fallbackPng = artworkName.replace(/\.svg$/, "@3x.png");
      await rasterizeSvg(artwork, box.width, box.height, path.join(links, fallbackPng), 3);
    }
    for (const node of texts) for (const run of node.runs) fonts.set(`${run.fontFamilies.join("|")}\t${run.fontStyle}`, {families: run.fontFamilies, style: run.fontStyle});
    const page = {
      name: frame.name || `Frame ${index + 1}`,
      widthPx: box.width,
      heightPx: box.height,
      sourceWidthPx: box.width,
      sourceHeightPx: box.height,
      sourceScaleToPt: physicalScale,
      pageGuides: pageGuidesFromFigma(frame),
      background: null,
      nodes: [{
        kind: "svg",
        id: `${id}:artwork`,
        name: `${frame.name || id} artwork`,
        x: 0,
        y: 0,
        width: box.width,
        height: box.height,
        opacity: 1,
        rotationDeg: 0,
        src: artworkName,
        markup: artwork,
        fallbackPng,
        preferRaster: hasEmbeddedImages,
        layerHint: "GFX",
      }, ...texts, ...sourceContainers(frame)],
      warnings: pageWarnings,
    } satisfies import("../types").ScenePage;
    if (physicalScale !== 1) scaleScenePage(page, physicalScale);
    pages.push(page);
    warnings.push(...pageWarnings.map(message => `${id}: ${message}`));
  }

  const scene: Scene = {docName: options.docName || file.meta.name || "Figma export", pages, fonts: [...fonts.values()]};
  scene.fontHints = (options.fontHints || fontHintsFor)(scene.fonts.map(font => font.families));
  return {scene, references, frameIds, sourceVersion: String(file.meta.version), warnings};
}
