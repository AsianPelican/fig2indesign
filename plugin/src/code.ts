import {selectionRequest} from "./selection";

figma.showUI(__html__, {width: 400, height: 470, themeColors: true});

async function publish(): Promise<void> {
  const activeJobId = await figma.clientStorage.getAsync("activeJob");
  figma.ui.postMessage({
    type: "state",
    request: selectionRequest(figma.fileKey, figma.currentPage.selection as unknown as any[]),
    activeJobId: typeof activeJobId === "string" ? activeJobId : "",
  });
}

figma.on("selectionchange", () => void publish());
figma.ui.onmessage = async message => {
  if (message?.type === "save-active-job") await figma.clientStorage.setAsync("activeJob", String(message.jobId || ""));
};
void publish();
