import {existsSync} from "node:fs";
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

export interface SharedFigmaRuntime {
  FigmaClient: new (token: string, fetchImpl?: typeof fetch) => {
    get(path: string): Promise<any>;
    download(url: string): Promise<Uint8Array>;
  };
  FigmaFile: {
    open(fileKey: string, root: string, client: any): Promise<any>;
  };
  resolveFrames(meta: any, selectors: string[], opts: {page?: string; nodeId?: string}): string[];
  parseTarget(value: string): {fileKey: string; nodeId?: string};
  readToken(env?: Record<string, string | undefined>): string;
  text: {
    collectSegs(element: any, matrix: unknown, warn: (message: string) => void): {segs: any[]; rotTm: unknown | null};
    groupLines(segments: any[]): any[][];
    alignLines(lines: any[][], node: any, nodeId: string, warn: (message: string) => void): any[];
  };
  geom: {
    I: unknown;
    mul(a: unknown, b: unknown): unknown;
    parseTransform(value: string | null): unknown;
  };
  root: string;
}

function candidates(explicit?: string): string[] {
  let installed: string | undefined;
  try {
    installed = path.resolve(fileURLToPath(import.meta.resolve("figma2pptx")), "..", "..");
  } catch {}
  return [
    explicit,
    process.env.FIGMA2PPTX_ROOT,
    installed,
    path.resolve(import.meta.dir, "..", "..", "..", "figma2pptx"),
  ].filter((value): value is string => Boolean(value));
}

/**
 * Loads figma2pptx directly from its adjacent checkout. This is intentionally
 * a source dependency: the REST cache and exact SVG-tspan geometry stay owned
 * by one repository instead of drifting in a copied adapter here.
 */
export async function loadSharedFigmaRuntime(explicitRoot?: string): Promise<SharedFigmaRuntime> {
  const root = candidates(explicitRoot).find(candidate => existsSync(path.join(candidate, "src", "index.ts")));
  if (!root) {
    throw new Error("figma2pptx source dependency not found; run setup or set FIGMA2PPTX_ROOT");
  }
  const load = (relative: string) => import(pathToFileURL(path.join(root, relative)).href);
  const [api, source, text, geom] = await Promise.all([
    load("src/figma/api.ts"),
    load("src/figma/source.ts"),
    load("src/convert/text.ts"),
    load("src/convert/geom.ts"),
  ]);
  for (const [name, value] of Object.entries({
    FigmaClient: api.FigmaClient,
    FigmaFile: source.FigmaFile,
    resolveFrames: source.resolveFrames,
    parseTarget: api.parseTarget,
    readToken: api.readToken,
    collectSegs: text.collectSegs,
    groupLines: text.groupLines,
    alignLines: text.alignLines,
    I: geom.I,
    mul: geom.mul,
    parseTransform: geom.parseTransform,
  })) {
    if (value === undefined) throw new Error(`incompatible figma2pptx checkout: missing export ${name}`);
  }
  return {
    FigmaClient: api.FigmaClient,
    FigmaFile: source.FigmaFile,
    resolveFrames: source.resolveFrames,
    parseTarget: api.parseTarget,
    readToken: api.readToken,
    text,
    geom,
    root,
  } as SharedFigmaRuntime;
}
