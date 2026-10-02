import {writeFile} from "node:fs/promises";
import path from "node:path";
import {buildFromScene, type BuildReport} from "../pipeline";
import {sceneFromFigma, type FigmaSceneOptions} from "./scene";

export interface BuildFromFigmaOptions extends FigmaSceneOptions {
  runInDesign?: boolean;
}

export async function buildFromFigma(options: BuildFromFigmaOptions): Promise<BuildReport & {frameIds: string[]; sourceVersion: string}> {
  const started = performance.now();
  const source = await sceneFromFigma(options);
  const report = await buildFromScene(source.scene, source.references, {
    docName: source.scene.docName,
    outDir: options.outDir,
    hardLineBreaks: true,
    runInDesign: options.runInDesign,
    startedAtMs: started,
  });
  const combined = {...report, frameIds: source.frameIds, sourceVersion: source.sourceVersion};
  await writeFile(path.join(options.outDir, "figma-source-report.json"), JSON.stringify({
    source: "figma",
    file: options.target,
    version: source.sourceVersion,
    frameIds: source.frameIds,
    warnings: source.warnings,
    report,
  }, null, 2) + "\n");
  return combined;
}
