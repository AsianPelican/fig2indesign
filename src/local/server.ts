import {createHash, randomUUID} from "node:crypto";
import {existsSync, mkdirSync, readFileSync} from "node:fs";
import path from "node:path";
import {buildFromFigma} from "../figma/build";
import {LOCAL_HOST, LOCAL_PORT, parseFigmaJob, type ArtifactKind, type DownloadArtifact, type JobEvent} from "./protocol";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Private-Network": "true",
  "Cache-Control": "no-store",
};
const json = (value: unknown, status = 200) => Response.json(value, {status, headers});
const safeName = (value: string) => value.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "figma-export";

function artifact(file: string, jobId: string, kind: ArtifactKind): DownloadArtifact {
  const bytes = readFileSync(file);
  return {name: path.basename(file), downloadPath: `/v1/jobs/${jobId}/files/${kind}`, size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex")};
}

export function createLocalHandler(runtimeRoot: string): (request: Request) => Promise<Response> {
  const jobs = new Map<string, JobEvent>();
  const files = new Map<string, Record<ArtifactKind, string>>();
  let active = false;
  return async request => {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, {status: 204, headers});
    if (url.pathname === "/v1/health" && request.method === "GET") return json({ok: true, busy: active});
    const status = /^\/v1\/jobs\/([a-f0-9-]{36})$/.exec(url.pathname);
    if (status && request.method === "GET") return jobs.has(status[1]) ? json(jobs.get(status[1])) : json({error: "Job not found."}, 404);
    const download = /^\/v1\/jobs\/([a-f0-9-]{36})\/files\/(indd|idml|report)$/.exec(url.pathname);
    if (download && request.method === "GET") {
      const file = files.get(download[1])?.[download[2] as ArtifactKind];
      if (!file || !existsSync(file)) return json({error: "Artifact not found."}, 404);
      return new Response(Bun.file(file), {headers: {...headers, "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`}});
    }
    if (url.pathname !== "/v1/jobs" || request.method !== "POST") return json({error: "Not found."}, 404);
    if (active) return json({error: "Another export is running."}, 409);
    let body;
    try { body = parseFigmaJob(await request.json()); }
    catch (error) { return json({error: error instanceof Error ? error.message : String(error)}, 400); }

    const jobId = randomUUID();
    const started = Date.now();
    const elapsed = () => +((Date.now() - started) / 1000).toFixed(1);
    const jobDir = path.join(runtimeRoot, "jobs", jobId);
    const cacheDir = path.join(runtimeRoot, "cache");
    mkdirSync(jobDir, {recursive: true, mode: 0o700});
    mkdirSync(cacheDir, {recursive: true, mode: 0o700});
    jobs.set(jobId, {type: "accepted", jobId, stage: "Queued locally", elapsed: 0});
    active = true;
    void (async () => {
      try {
        jobs.set(jobId, {type: "running", jobId, stage: "Building in InDesign", elapsed: elapsed()});
        const docName = safeName(body.frameNames[0]);
        const report = await buildFromFigma({target: body.fileKey, frames: body.frameIds, docName, outDir: jobDir, cacheDir, runInDesign: true});
        if (!report.ok || !report.inddPath || !report.idmlPath) throw new Error(report.error || "InDesign build failed");
        const reportPath = path.join(jobDir, "fidelity-report.json");
        files.set(jobId, {indd: report.inddPath, idml: report.idmlPath, report: reportPath});
        const tf = report.textFidelity;
        jobs.set(jobId, {
          type: "done", jobId, elapsed: elapsed(), pages: report.pages.length,
          artifacts: {indd: artifact(report.inddPath, jobId, "indd"), idml: artifact(report.idmlPath, jobId, "idml"), report: artifact(reportPath, jobId, "report")},
          summary: {linesWithin1px: tf?.within1px || 0, measurableLines: tf?.measurableLines || 0, worstLinePx: tf?.worstLinePx || 0},
        });
      } catch (error) {
        jobs.set(jobId, {type: "error", jobId, elapsed: elapsed(), error: error instanceof Error ? error.message : String(error)});
      } finally { active = false; }
    })();
    return json(jobs.get(jobId), 202);
  };
}

export function startLocalBridge(): ReturnType<typeof Bun.serve> {
  if (!process.env.FIGMA_TOKEN?.trim()) throw new Error("FIGMA_TOKEN is required");
  const runtimeRoot = path.resolve(process.env.FIG2INDESIGN_RUNTIME || "runtime");
  mkdirSync(runtimeRoot, {recursive: true, mode: 0o700});
  const server = Bun.serve({hostname: LOCAL_HOST, port: LOCAL_PORT, fetch: createLocalHandler(runtimeRoot)});
  console.log(`fig2indesign listening on http://${LOCAL_HOST}:${server.port}`);
  return server;
}
