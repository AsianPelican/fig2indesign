// Converts Paper's get_jsx (inline-styles format) output into a self-contained
// HTML file the bridge can measure. Usage:
//   bun src/paper2html.ts input.jsx output.html

import { readFileSync, writeFileSync } from "fs";

function camelToCss(key: string): string {
  let k = key;
  if (/^Webkit/.test(k)) k = "-webkit" + k.slice(6);
  else if (/^Moz/.test(k)) k = "-moz" + k.slice(3);
  else if (/^ms/.test(k)) k = "-ms" + k.slice(2);
  return k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
}

/** Split object entries on top-level commas, respecting quotes. */
function splitEntries(body: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (const ch of body) {
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
    } else if (ch === ",") {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

function styleObjectToCss(body: string): string {
  const decls: string[] = [];
  for (const entry of splitEntries(body)) {
    const idx = entry.indexOf(":");
    if (idx === -1) continue;
    const key = entry.slice(0, idx).trim();
    let value = entry.slice(idx + 1).trim();
    // React assigns px to numeric dimensional properties, but CSS does not.
    const unitless = /^(animationIterationCount|aspectRatio|columnCount|fillOpacity|flex|flexGrow|flexShrink|fontWeight|lineHeight|opacity|order|scale|strokeOpacity|strokeWidth|tabSize|zIndex|zoom)$/;
    if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(value) && !unitless.test(key) && !key.startsWith('--')) value += 'px';
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
      value = value.slice(1, -1);
    }
    value = value.replace(/"/g, "&quot;");
    decls.push(`${camelToCss(key)}: ${value}`);
  }
  return decls.join("; ");
}

export function jsxToHtml(jsx: string): string {
  let s = jsx.trim();
  if (s.startsWith("(") && s.endsWith(")")) s = s.slice(1, -1).trim();

  // Replace style={{ ... }} with style="..."
  let out = "";
  let i = 0;
  while (i < s.length) {
    const start = s.indexOf("style={{", i);
    if (start === -1) {
      out += s.slice(i);
      break;
    }
    out += s.slice(i, start);
    const end = s.indexOf("}}", start + 8);
    if (end === -1) throw new Error("Unterminated style object");
    out += `style="${styleObjectToCss(s.slice(start + 8, end))}"`;
    i = end + 2;
  }

  // JSX whitespace expressions and self-closing tags
  out = out.replace(/\{["'] ["']\}/g, " ");
  // Void elements must NOT get a closing tag: HTML parses a stray </br> as a
  // second <br>, which doubles every explicit line break (phantom empty lines).
  const VOID = /^(area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr)$/i;
  out = out.replace(/<(\w+)((?:[^>"']|"[^"]*"|'[^']*')*?)\/>/g, (_m, tag: string, attrs: string) =>
    VOID.test(tag) ? `<${tag}${attrs}>` : `<${tag}${attrs}></${tag}>`,
  );
  // React attribute name fixups
  out = out.replace(/\bclassName=/g, "class=");
  for (const attr of ['fillRule', 'clipRule', 'strokeWidth', 'strokeLinecap', 'strokeLinejoin', 'strokeMiterlimit', 'strokeDasharray', 'strokeDashoffset', 'fillOpacity', 'strokeOpacity', 'clipPath']) {
    out = out.replace(new RegExp('\\b' + attr + '=', 'g'), camelToCss(attr) + '=');
  }
  return out;
}

if (import.meta.main) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error("Usage: bun src/paper2html.ts input.jsx output.html");
    process.exit(1);
  }
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>* { margin: 0; padding: 0; }</style></head>
<body>
${jsxToHtml(readFileSync(input, "utf8"))}
</body></html>
`;
  writeFileSync(output, html);
  console.log(`Wrote ${output}`);
}
