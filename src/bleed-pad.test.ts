import {expect, test} from "bun:test";
import {bleedPadding, coverRect} from "./bleed-pad";
import type {ImageNode} from "./types";

const image = (x: number, y: number, width: number, height: number): ImageNode => ({
  kind: "image", id: "synthetic-image", name: "Synthetic image", x, y, width, height,
  opacity: 1, rotationDeg: 0, src: "synthetic.jpg", rawSrc: "", fit: "cover", cornerRadius: [0, 0, 0, 0],
});

test("cover geometry preserves center and fills the tall box", () => {
  const [x0, y0, x1, y1] = coverRect(image(0, 0, 180, 260), 320, 240);
  expect(y0).toBe(0);
  expect(y1).toBeCloseTo(260);
  expect(x1 - x0).toBeCloseTo(260 * 4 / 3);
  expect((x0 + x1) / 2).toBeCloseTo(90);
});

test("bleed padding mirrors only edges without spare source pixels", () => {
  const pad = bleedPadding(image(0, 0, 200, 260), 320, 240, 200, 260, 6);
  const sourceScale = 260 / 240;
  expect(pad).toEqual({t: Math.ceil(6 / sourceScale) + 2, b: Math.ceil(6 / sourceScale) + 2, l: 0, r: 0});
});

test("interior artwork requires no synthetic border", () => {
  expect(bleedPadding(image(40, 50, 80, 90), 320, 240, 200, 260, 6)).toEqual({t: 0, r: 0, b: 0, l: 0});
});

test("pixel background positions retain the CSS offset", () => {
  const node = {...image(30, 40, 120, 120), bgPos: {x: 12, xUnit: "px", y: -8, yUnit: "px"}} as ImageNode;
  expect(coverRect(node, 320, 160)).toEqual([42, 32, 282, 152]);
});
