export const LOCAL_HOST = "127.0.0.1";
export const LOCAL_PORT = 41416;

export interface FigmaJobRequest {
  kind: "figma";
  fileKey: string;
  frameIds: string[];
  frameNames: string[];
}

export type ArtifactKind = "indd" | "idml" | "report";
export interface DownloadArtifact {
  name: string;
  downloadPath: string;
  size: number;
  sha256: string;
}
export type JobEvent =
  | {type: "accepted" | "running"; jobId: string; stage: string; elapsed: number}
  | {type: "done"; jobId: string; elapsed: number; pages: number; artifacts: Record<ArtifactKind, DownloadArtifact>; summary: {linesWithin1px: number; measurableLines: number; worstLinePx: number}}
  | {type: "error"; jobId: string; elapsed: number; error: string};

export function parseFigmaJob(value: unknown): FigmaJobRequest {
  if (!value || typeof value !== "object") throw new Error("request body must be an object");
  const body = value as Record<string, unknown>;
  if (body.embedFonts !== undefined) throw new Error("font embedding is not supported");
  if (body.kind !== "figma") throw new Error("kind must be figma");
  if (typeof body.fileKey !== "string" || !/^[A-Za-z0-9]{10,128}$/.test(body.fileKey)) throw new Error("fileKey is invalid");
  if (!Array.isArray(body.frameIds) || body.frameIds.length < 1 || body.frameIds.length > 200 || body.frameIds.some(id => typeof id !== "string" || !/^\d+[:-]\d+$/.test(id))) throw new Error("frameIds must contain 1-200 Figma node ids");
  if (!Array.isArray(body.frameNames) || body.frameNames.length !== body.frameIds.length || body.frameNames.some(name => typeof name !== "string" || !name.trim() || name.length > 300)) throw new Error("frameNames must match frameIds");
  return {kind: "figma", fileKey: body.fileKey, frameIds: [...body.frameIds] as string[], frameNames: [...body.frameNames] as string[]};
}
