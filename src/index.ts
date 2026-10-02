export {buildFromFigma, type BuildFromFigmaOptions} from "./figma/build";
export {inferPhysicalScale, pageGuidesFromFigma, sceneFromFigma, sourceContainers, type FigmaSceneOptions, type FigmaSceneResult} from "./figma/scene";
export {buildFromHtml, type BuildOptions, type PrintPreset, buildFromScene, scaleScenePage, summarizeContainerGeometry, summarizeTextGeometry, type BuildReport, type ContainerFidelitySummary, type TextFidelitySummary} from "./pipeline";
export {startLocalBridge} from "./local/server";
export {jsxToHtml} from "./paper2html";
