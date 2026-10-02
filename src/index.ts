export {buildFromFigma, type BuildFromFigmaOptions} from "./figma/build";
export {inferPhysicalScale, pageGuidesFromFigma, sceneFromFigma, sourceContainers, type FigmaSceneOptions, type FigmaSceneResult} from "./figma/scene";
export {startLocalBridge} from "./local/server";
export {buildFromScene, scaleScenePage, summarizeContainerGeometry, summarizeTextGeometry, type BuildOptions, type PrintPreset, type BuildReport, type ContainerFidelitySummary, type TextFidelitySummary} from "./pipeline";
export type {Scene, ScenePage} from "./types";
