// Scene graph — the engine-agnostic intermediate representation.
// All geometry is in CSS pixels, absolute to the artboard's top-left.
// Downstream (InDesign emit) maps 1px = 1pt.

export interface RGB {
  r: number; // 0-255
  g: number;
  b: number;
}

export interface TextLine {
  text: string;
  x: number; // absolute left of this line's inline box
  baselineY: number; // absolute y of this line's baseline
  width: number;
  top: number; // absolute top of the inline box
  height: number; // inline box height
}

export interface TextRun {
  text: string;
  fontFamily: string;
  fontFamilies: string[]; // full candidate stack from CSS, generics removed
  textTransform?: string; // uppercase -> InDesign ALL_CAPS (content keeps case)
  fontStyle: string; // InDesign style name: "Regular", "Bold", "Italic", "Bold Italic", "Medium", ...
  fontSizePx: number;
  letterSpacingPx: number; // 0 when normal
  lineHeightPx: number;
  color: RGB;
  opacity: number;
  lines: TextLine[];
}

export interface BaseNode {
  id: string;
  name: string; // semantic layer name
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number; // 0-1, cumulative with parents already applied
  rotationDeg: number;
  rotGroup?: string; // id of the rotated container this node belongs to
  rotOrigin?: { x: number; y: number }; // CSS transform-origin, element-relative px
  layerHint?: "BG" | "GFX" | "TEXT" | "CONTAINERS"; // semantic layer, paint-order safe
}

export interface VisualLine {
  top: number;
  baselineY: number; // dominant baseline (largest fragment on the line)
  x: number; // absolute left of the line's first fragment (staggered indents)
  segments: { runIndex: number; text: string }[];
}

export interface TextNode extends BaseNode {
  kind: "text";
  align: "left" | "center" | "right" | "justify";
  runs: TextRun[];
  firstBaselineY: number; // absolute y of the first line's baseline
  visualLines: VisualLine[]; // browser lines in visual order, cross-run
}

export interface DropShadow {
  x: number;
  y: number;
  blur: number;
  spread: number;
  color: RGB;
  alpha: number; // 0-1
}

export interface RectNode extends BaseNode {
  kind: "rect";
  fill: RGB | null;
  cornerRadius: [number, number, number, number]; // TL TR BR BL
  strokeColor: RGB | null;
  strokeWeightPx: number;
  shadow?: DropShadow;
}

export interface ImageNode extends BaseNode {
  kind: "image";
  src: string; // path relative to the Links dir, filled in after asset staging
  fit: "cover" | "contain" | "fill";
  cornerRadius: [number, number, number, number];
  // Raw source captured during measurement (data: URI, http(s) URL, or file path)
  rawSrc: string;
  // Rotated-container capture: standalone HTML rendered to a transparent PNG
  captureHtml?: string;
  captureInner?: { left: number; top: number; width: number; height: number };
  // CSS background-position (cover/contain crops): % maps to (frame - drawn) * p, px is direct.
  bgPos?: { x: number; xUnit: "%" | "px"; y: number; yUnit: "%" | "px" };
  // Print bleed: source pixels mirrored onto each side of `src` so the image
  // fills the bleed at its design scale. natW/natH are the unpadded source size.
  /** Crop from an overflow-clipping ancestor (root coords); the image frame's bounds. */
  clip?: { x: number; y: number; width: number; height: number };
  bleedPad?: { t: number; r: number; b: number; l: number; natW: number; natH: number };
}

export interface SvgNode extends BaseNode {
  kind: "svg";
  src: string; // path relative to the Links dir
  markup: string; // serialized SVG, staged to a file later
  fallbackPng?: string; // @3x raster used if InDesign cannot place the SVG
  preferRaster?: boolean; // gradients/opacity/filters: raster for visual parity
}

export interface ContainerNode extends BaseNode {
  kind: "container";
  sourceId: string;
  sourceType: "FRAME" | "GROUP" | "RECTANGLE" | "IMAGE_FRAME" | "INSTANCE" | "COMPONENT" | "COMPONENT_SET" | "TEXT";
  sourceParentId?: string;
  sourceDepth: number;
  clipsContent: boolean;
}

export type SceneNode = TextNode | RectNode | ImageNode | SvgNode | ContainerNode;

export interface PageGuides {
  top: number;
  bottom: number;
  left: number;
  right: number;
  columns: number;
  columnGutter: number;
}

export interface ScenePage {
  name: string;
  widthPx: number;
  heightPx: number;
  background: RGB | null;
  nodes: SceneNode[]; // painting order: first = backmost
  warnings: string[];
  sourceWidthPx?: number;
  sourceHeightPx?: number;
  sourceScaleToPt?: number;
  pageGuides?: PageGuides;
  // Rotated containers: members (nodes tagged rotGroup=id, built unrotated)
  // are grouped in InDesign and rotated around the group center.
  rotGroups?: { id: string; deg: number }[];
  // Print mode: where this board's content lives on the spread-wide canvas.
  spreadRole?: "left" | "right" | "spread";
}

export interface Scene {
  docName: string;
  pages: ScenePage[];
  fonts: { families: string[]; style: string }[]; // unique fonts used
  // PostScript/full-name -> installed face, parsed locally from font files
  fontHints?: Record<string, { family: string; style: string }>;
  // When present, boards are 2-page print spreads (see pipeline PrintPreset)
  printPreset?: import("./pipeline").PrintPreset;
}
