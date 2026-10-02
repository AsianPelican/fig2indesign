import {expect, test} from "bun:test";
import {jsxToHtml} from "./paper2html";

test("Paper dimensions use CSS pixels while unitless values stay unitless", () => {
  const html = jsxToHtml('<div style={{ left: 12, top: -4.5, width: 80, fontWeight: 400, lineHeight: 1.2, opacity: 0.5 }}>Synthetic text</div>');
  expect(html).toContain('left: 12px; top: -4.5px; width: 80px');
  expect(html).toContain('font-weight: 400; line-height: 1.2; opacity: 0.5');
});

test("Paper void elements do not create duplicate line breaks", () => {
  const html = jsxToHtml('<div className="synthetic">First<br />Second<img src="synthetic.png" /></div>');
  expect(html).toContain('class="synthetic"');
  expect(html).toContain('<br >');
  expect(html).not.toContain('</br>');
  expect(html).not.toContain('</img>');
});

test("Paper SVG attributes retain CSS spellings", () => {
  expect(jsxToHtml('<path fillRule="evenodd" strokeWidth="2" />')).toContain('fill-rule="evenodd" stroke-width="2"');
});
