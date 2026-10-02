export interface SelectionNode {
  id: string;
  name: string;
  type: string;
  parent?: {type?: string} | null;
}

export interface SelectionRequest {
  fileKey: string;
  frameIds: string[];
  frameNames: string[];
}

export function selectionRequest(fileKey: string | null | undefined, selection: readonly SelectionNode[]): SelectionRequest {
  const frames = selection.filter(node => node.type === "FRAME" && (node.parent?.type === "PAGE" || node.parent?.type === "SECTION"));
  return {
    fileKey: fileKey || "",
    frameIds: frames.map(frame => frame.id),
    frameNames: frames.map(frame => frame.name),
  };
}
