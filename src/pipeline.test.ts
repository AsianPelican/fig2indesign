import {expect, test} from "bun:test";
import {scaleScenePage, summarizeContainerGeometry, summarizeTextGeometry} from "./pipeline";

test("line fidelity uses the worst source-axis displacement", () => {
  const summary = summarizeTextGeometry([
    {page: 1, node: "a", line: 1, expectedX: 10, expectedBaseline: 20, actualX: 10.5, actualBaseline: 20.25, measurable: true},
    {page: 1, node: "b", line: 1, expectedX: 30, expectedBaseline: 40, actualX: 31.25, actualBaseline: 40, measurable: true},
    {page: 1, node: "c", line: 1, expectedX: 0, expectedBaseline: 0, actualX: 0, actualBaseline: 0, measurable: false, reason: "rotated"},
  ]);
  expect(summary.totalLines).toBe(3);
  expect(summary.measurableLines).toBe(2);
  expect(summary.within1px).toBe(1);
  expect(summary.worstLinePx).toBe(1.25);
  expect(summary.worstLine?.node).toBe("b");
});

test("container fidelity checks every edge against the source", () => {
  const summary = summarizeContainerGeometry([
    {page: 1, node: "shape-a", sourceType: "RECTANGLE", expectedBounds: [10, 20, 30, 40], actualBounds: [10.25, 20, 30, 40.5], measurable: true},
    {page: 1, node: "shape-b", sourceType: "FRAME", expectedBounds: [0, 0, 100, 100], actualBounds: [0, 0, 101.5, 100], measurable: true},
  ]);
  expect(summary.totalContainers).toBe(2);
  expect(summary.within1px).toBe(1);
  expect(summary.worstContainerPx).toBe(1.5);
  expect(summary.worstContainer?.node).toBe("shape-b");
});

test("page scaling includes guides and source containers", () => {
  const page: any = {
    name: "Synthetic", widthPx: 850, heightPx: 1100, background: null, warnings: [],
    pageGuides: {top: 40, bottom: 40, left: 50, right: 50, columns: 6, columnGutter: 20},
    nodes: [{kind: "container", id: "source", name: "Source", sourceId: "1:2", sourceType: "FRAME", sourceDepth: 1, clipsContent: true, x: 50, y: 40, width: 750, height: 1020, opacity: 1, rotationDeg: 0}],
  };
  scaleScenePage(page, 0.72);
  expect(page.widthPx).toBeCloseTo(612, 8);
  expect(page.heightPx).toBeCloseTo(792, 8);
  expect(page.nodes[0].x).toBeCloseTo(36, 8);
  expect(page.nodes[0].y).toBeCloseTo(28.8, 8);
  expect(page.nodes[0].width).toBeCloseTo(540, 8);
  expect(page.nodes[0].height).toBeCloseTo(734.4, 8);
  expect(page.pageGuides.top).toBeCloseTo(28.8, 8);
  expect(page.pageGuides.left).toBeCloseTo(36, 8);
  expect(page.pageGuides.columns).toBe(6);
  expect(page.pageGuides.columnGutter).toBeCloseTo(14.4, 8);
});
