// Measurement engine: renders an HTML file in headless Chrome and extracts
// a scene graph with exact geometry, per-line text fragments, and baselines.

import puppeteer, { type Browser } from "puppeteer-core";
import { createHash } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import { readFileSync, existsSync } from "fs";
import path from "path";
import type { Scene, ScenePage, SceneNode, ImageNode } from "./types";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// Runs inside the page. Returns { widthPx, heightPx, background, nodes, warnings }.
const PROBE = String.raw`
(() => {
  const warnings = [];
  const nodes = [];
  const rotGroups = [];
  const containerStack = [];
  let idCounter = 0;

  const root = document.body.firstElementChild || document.body;
  const rootRect = root.getBoundingClientRect();
  const originX = rootRect.left, originY = rootRect.top;

  function parseColor(str) {
    if (!str) return null;
    const m = str.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
    if (!m) return null;
    const a = m[4] === undefined ? 1 : parseFloat(m[4]);
    if (a === 0) return null;
    return { r: Math.round(+m[1]), g: Math.round(+m[2]), b: Math.round(+m[3]), a };
  }

  const WEIGHT_NAMES = { 100:"Thin",200:"ExtraLight",300:"Light",400:"Regular",500:"Medium",600:"SemiBold",700:"Bold",800:"ExtraBold",900:"Black" };
  function styleName(cs) {
    const fontMap = JSON.parse(document.getElementById('paper-font-map')?.textContent || '{}');
    const family = cs.fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, '');
    const exact = (fontMap[family] || []).find(f => f.weight === Number(cs.fontWeight) && f.isItalic === (cs.fontStyle === 'italic'));
    if (exact) return exact.style;
    const w = Math.round(parseInt(cs.fontWeight, 10) / 100) * 100;
    let name = WEIGHT_NAMES[w] || "Regular";
    const italic = cs.fontStyle.includes("italic") || cs.fontStyle.includes("oblique");
    if (italic) name = name === "Regular" ? "Italic" : name + " Italic";
    return name;
  }

  const GENERIC_FAMILIES = ["sans-serif","serif","monospace","cursive","fantasy","ui-sans-serif","ui-serif","ui-monospace"];
  const SYSTEM_FAMILIES = ["system-ui","-apple-system","BlinkMacSystemFont"];
  function familyList(cs) {
    const raw = cs.fontFamily.split(",").map(f => f.trim().replace(/^["']|["']$/g, ""));
    const named = raw.filter(f => GENERIC_FAMILIES.indexOf(f) === -1 && SYSTEM_FAMILIES.indexOf(f) === -1);
    // Chrome renders system-ui as SF Pro; give InDesign the same chain.
    if (raw.some(f => SYSTEM_FAMILIES.indexOf(f) !== -1)) {
      named.push("SF Pro Text", "SF Pro Display", "Helvetica Neue");
    }
    return named;
  }

  const metricsCanvas = document.createElement("canvas");
  const mctx = metricsCanvas.getContext("2d");
  function fontMetrics(cs) {
    mctx.font = cs.fontStyle + " " + cs.fontWeight + " " + cs.fontSize + " " + cs.fontFamily;
    const m = mctx.measureText("Hgjy");
    return { ascent: m.fontBoundingBoxAscent, descent: m.fontBoundingBoxDescent };
  }

  function cumulativeOpacity(el) {
    let o = 1;
    let n = el;
    while (n && n !== document.body) {
      const v = parseFloat(getComputedStyle(n).opacity);
      if (!isNaN(v)) o *= v;
      n = n.parentElement;
    }
    return o;
  }

  function rotationOf(cs) {
    // Standalone CSS rotate property (what Paper emits) takes precedence.
    if (cs.rotate && cs.rotate !== "none") {
      const rm = cs.rotate.match(/(-?[\d.]+)deg/);
      if (rm) {
        const a = parseFloat(rm[1]);
        if (Math.abs(a) >= 0.01) return a;
      }
    }
    const t = cs.transform;
    if (!t || t === "none") return 0;
    const m = t.match(/matrix\(([-\d.e]+),\s*([-\d.e]+)/);
    if (!m) return 0;
    const angle = Math.atan2(parseFloat(m[2]), parseFloat(m[1])) * 180 / Math.PI;
    return Math.abs(angle) < 0.01 ? 0 : angle;
  }

  function corners(cs, w, h) {
    const cap = Math.min(w, h) / 2;
    const p = (v) => Math.min(parseFloat(v) || 0, cap);
    return [p(cs.borderTopLeftRadius), p(cs.borderTopRightRadius), p(cs.borderBottomRightRadius), p(cs.borderBottomLeftRadius)];
  }

  // Corner radius for an image-like element: its own, or inherited from a
  // clipping ancestor (overflow hidden + border-radius) that tightly wraps it.
  function effectiveCorners(el, cs, rect) {
    let own = corners(cs, rect.width, rect.height);
    if (own.some(v => v > 0.01)) return own;
    let a = el.parentElement;
    while (a && a !== document.body) {
      const acs = getComputedStyle(a);
      const ar = a.getBoundingClientRect();
      const tight = Math.abs(ar.left - rect.left) < 2 && Math.abs(ar.top - rect.top) < 2 &&
        Math.abs(ar.width - rect.width) < 4 && Math.abs(ar.height - rect.height) < 4;
      if (acs.overflow !== "visible" && tight) {
        const ac = corners(acs, ar.width, ar.height);
        if (ac.some(v => v > 0.01)) return ac;
      }
      if (acs.overflow !== "visible") break;
      a = a.parentElement;
    }
    return own;
  }

  // Intersection of every overflow-clipping ancestor below the artboard, in
  // root coordinates, or undefined when nothing actually crops the element.
  // Paper crops a photo by wrapping it in a frame with overflow: clip and
  // offsetting the oversized image inside; InDesign needs that frame as the
  // image frame's bounds. Ancestors as tall as the root are the artboard,
  // whose overflow is handled by page/bleed logic instead.
  function clipBoxOf(el, rect) {
    let x0 = -Infinity, y0 = -Infinity, x1 = Infinity, y1 = Infinity;
    let a = el.parentElement;
    while (a && a !== root && a !== document.body) {
      const acs = getComputedStyle(a);
      const ar = a.getBoundingClientRect();
      if (ar.height >= rootRect.height - 1) break;
      if (acs.overflowX !== "visible" || acs.overflowY !== "visible") {
        x0 = Math.max(x0, ar.left); y0 = Math.max(y0, ar.top);
        x1 = Math.min(x1, ar.right); y1 = Math.min(y1, ar.bottom);
      }
      a = a.parentElement;
    }
    if (x0 === -Infinity) return undefined;
    const crops = rect.left < x0 - 0.5 || rect.top < y0 - 0.5 || rect.right > x1 + 0.5 || rect.bottom > y1 + 0.5;
    if (!crops) return undefined;
    return { x: x0 - originX, y: y0 - originY, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
  }

  function isInlineLevel(el) {
    const d = getComputedStyle(el).display;
    return d.startsWith("inline") || d === "contents";
  }

  function hasOwnText(el) {
    for (const c of el.childNodes) {
      if (c.nodeType === 3 && c.textContent.trim()) return true;
    }
    return false;
  }

  function isTextBlock(el) {
    if (!el.textContent || !el.textContent.trim()) return false;
    if (hasOwnText(el)) return true;
    // All element children inline and at least one carries text
    const kids = Array.from(el.children);
    if (kids.length === 0) return false;
    if (!(kids.every(k => isInlineLevel(k)) && kids.some(k => k.textContent.trim()))) return false;
    // Side-by-side multi-line columns (label/value spec tables) must NOT merge
    // into one text run - each column wraps independently.
    const fs = parseFloat(getComputedStyle(el).fontSize) || 12;
    const rects = kids.map(k => k.getBoundingClientRect());
    for (let a = 0; a < rects.length; a++) {
      for (let b = 0; b < rects.length; b++) {
        if (a === b) continue;
        const disjointX = rects[a].right <= rects[b].left + 2 || rects[b].right <= rects[a].left + 2;
        const overlapY = Math.min(rects[a].bottom, rects[b].bottom) - Math.max(rects[a].top, rects[b].top) > 2;
        const multiline = rects[a].height > 1.9 * fs || rects[b].height > 1.9 * fs;
        if (disjointX && overlapY && multiline) return false;
      }
    }
    return true;
  }

  // Extract per-line fragments for all text inside el (which contains only inline content).
  function extractText(el, baseName) {
    const cs = getComputedStyle(el);
    const runs = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let tn;
    let lastTop = null;       // visual line top of the last emitted char, across nodes
    let pendingSpace = false; // whitespace seen since the last emitted char
    while ((tn = walker.nextNode())) {
      const raw = tn.textContent;
      if (!raw.trim()) { pendingSpace = true; continue; }
      const pcs = getComputedStyle(tn.parentElement);
      const met = fontMetrics(pcs);
      // Anchor ascent to the actual fragment height rather than raw canvas
      // values - display/brush fonts report font boxes that diverge from the
      // inline box Chrome lays out.
      const ascentFrac = (met.ascent + met.descent) > 0 ? met.ascent / (met.ascent + met.descent) : 0.8;
      const fontSize = parseFloat(pcs.fontSize);
      let lineHeight = parseFloat(pcs.lineHeight);
      if (isNaN(lineHeight)) lineHeight = (met.ascent + met.descent) || fontSize * 1.2;
      const ls = pcs.letterSpacing === "normal" ? 0 : parseFloat(pcs.letterSpacing);
      const color = parseColor(pcs.color) || { r: 0, g: 0, b: 0, a: 1 };

      // Walk characters, group into visual lines by fragment top.
      const range = document.createRange();
      const lines = [];
      let cur = null;
      for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];
        if (/\s/.test(ch)) {
          // Whitespace never starts a line, never extends bounds, and collapses.
          // Trailing spaces are trimmed per line, so also remember it for the
          // next styled node continuing this visual line.
          if (cur && !/\s$/.test(cur.text)) cur.text += " ";
          pendingSpace = true;
          continue;
        }
        range.setStart(tn, i);
        range.setEnd(tn, i + 1);
        const r = range.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        const top = Math.round(r.top * 2) / 2;
        if (!cur || Math.abs(top - cur.top) > 1) {
          // Continuing the same visual line from a previous styled node with
          // collapsed whitespace between them: keep the word space.
          const sameVisualLine = lastTop !== null && Math.abs(top - lastTop) <= 1;
          cur = { top, h: r.height, left: r.left, right: r.right, text: (sameVisualLine && pendingSpace ? " " : "") + ch };
          lines.push(cur);
        } else {
          cur.text += ch;
          cur.left = Math.min(cur.left, r.left);
          cur.right = Math.max(cur.right, r.right);
        }
        lastTop = top;
        pendingSpace = false;
      }
      if (lines.length === 0) continue;
      const fams = familyList(pcs);
      runs.push({
        textTransform: pcs.textTransform !== "none" ? pcs.textTransform : undefined,
        text: lines.map(l => l.text).join("\n"),
        fontFamily: fams[0] || "Helvetica",
        fontFamilies: fams.length ? fams : ["Helvetica"],
        fontStyle: styleName(pcs),
        fontSizePx: fontSize,
        letterSpacingPx: ls,
        lineHeightPx: lineHeight,
        color: { r: color.r, g: color.g, b: color.b },
        opacity: color.a,
        lines: lines.map(l => {
          const h = l.h || (met.ascent + met.descent);
          return {
            text: l.text.replace(/\s+$/,""),
            x: l.left - originX,
            baselineY: l.top - originY + h * ascentFrac,
            width: l.right - l.left,
            top: l.top - originY,
            height: h,
          };
        }),
      });
    }
    if (runs.length === 0) return null;

    // Group all run fragments into visual lines (vertical-overlap based, so
    // flex-centered mixed-size text on one line stays one line).
    const frags = [];
    runs.forEach((run, ri) => run.lines.forEach(l => frags.push({ ...l, runIndex: ri })));
    const groups = [];
    for (const f of frags) {
      let g = null;
      for (const cand of groups) {
        const ovl = Math.min(cand.bottom, f.top + f.height) - Math.max(cand.gtop, f.top);
        if (ovl > 0.5 * Math.min(cand.bottom - cand.gtop, f.height)) { g = cand; break; }
      }
      if (!g) {
        g = { gtop: f.top, bottom: f.top + f.height, frags: [] };
        groups.push(g);
      } else {
        g.gtop = Math.min(g.gtop, f.top);
        g.bottom = Math.max(g.bottom, f.top + f.height);
      }
      g.frags.push(f);
    }
    groups.sort((a, b) => a.gtop - b.gtop);
    const visualLines = groups.map(g => {
      let dominant = g.frags[0];
      let minX = g.frags[0].x;
      for (const f of g.frags) {
        if (f.height > dominant.height) dominant = f;
        if (f.x < minX) minX = f.x;
      }
      return {
        top: g.gtop,
        baselineY: dominant.baselineY,
        x: minX,
        segments: g.frags.map(f => ({ runIndex: f.runIndex, text: f.text })),
      };
    });

    const rect = el.getBoundingClientRect();
    const align = { start: "left", end: "right" }[cs.textAlign] || cs.textAlign;
    // Text flows in the CONTENT box; the frame must match it, not the border box.
    const padL = parseFloat(cs.paddingLeft) || 0, padR = parseFloat(cs.paddingRight) || 0;
    const padT = parseFloat(cs.paddingTop) || 0, padB = parseFloat(cs.paddingBottom) || 0;
    const bL = parseFloat(cs.borderLeftWidth) || 0, bR = parseFloat(cs.borderRightWidth) || 0;
    const bT = parseFloat(cs.borderTopWidth) || 0, bB = parseFloat(cs.borderBottomWidth) || 0;
    return {
      kind: "text",
      id: "n" + (++idCounter),
      name: baseName,
      x: rect.left - originX + padL + bL, y: rect.top - originY + padT + bT,
      width: Math.max(1, rect.width - padL - padR - bL - bR),
      height: Math.max(1, rect.height - padT - padB - bT - bB),
      opacity: cumulativeOpacity(el),
      rotationDeg: rotationOf(cs),
      align: ["left","center","right","justify"].includes(align) ? align : "left",
      runs,
      firstBaselineY: visualLines[0].baselineY,
      visualLines,
    };
  }

  function nameOf(el) {
    return el.getAttribute("layer-name") || el.getAttribute("data-name") || el.id || el.tagName.toLowerCase();
  }

  function bgImageUrl(cs) {
    const m = cs.backgroundImage.match(/url\("?([^")]+)"?\)/);
    return m ? m[1] : null;
  }

  function visit(el) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return;
    const rotation = rotationOf(cs);
    let savedTransform = null, savedRotate = null, rotOrigin = null;
    if (rotation !== 0) {
      const om = cs.transformOrigin.match(/(-?[\d.]+)px\s+(-?[\d.]+)px/);
      if (om) rotOrigin = { x: parseFloat(om[1]), y: parseFloat(om[2]) };
      // Measure the UNROTATED layout box (and text fragments) - InDesign gets
      // the pre-rotation frame plus a center rotation, matching CSS defaults.
      savedTransform = el.style.transform;
      savedRotate = el.style.rotate;
      el.style.transform = "none";
      el.style.rotate = "none";
    }
    try {
    const rect = el.getBoundingClientRect();
    if (rect.width < 0.5 || rect.height < 0.5) {
      // Zero-size wrappers still paint overflowing children.
      if (cs.overflow === "visible") for (const child of el.children) visit(child);
      return;
    }
    const tag = el.tagName.toLowerCase();
    const isRotContainer = rotation !== 0 && el.children.length > 0 && !isTextBlock(el) && tag !== "svg" && tag !== "img";
    const base = {
      id: "n" + (++idCounter),
      name: nameOf(el),
      x: rect.left - originX, y: rect.top - originY,
      width: rect.width, height: rect.height,
      opacity: cumulativeOpacity(el),
      rotationDeg: isRotContainer ? 0 : rotation,
      rotOrigin: rotOrigin || undefined,
      groupPath: containerStack.length ? containerStack[containerStack.length - 1] : undefined,
    };
    if (isRotContainer) {
      // Rasterize the whole rotated container exactly as Chrome paints it:
      // grouping + rotating native items can't reproduce overflow clipping.
      el.style.transform = savedTransform; el.style.rotate = savedRotate;
      const aabb = el.getBoundingClientRect();
      el.style.transform = "none"; el.style.rotate = "none";
      const un = el.getBoundingClientRect();
      const clone = el.cloneNode(true);
      clone.style.position = "absolute";
      clone.style.left = "0"; clone.style.top = "0"; clone.style.margin = "0";
      clone.style.width = un.width + "px"; clone.style.height = un.height + "px";
      // The element's inline rotation was disabled for measuring - the clone
      // must render WITH it, or the capture comes out unrotated.
      clone.style.transform = savedTransform || "";
      clone.style.rotate = savedRotate || "";
      nodes.push({
        ...base, kind: "image", src: "", rawSrc: "",
        x: aabb.left - originX, y: aabb.top - originY,
        width: aabb.width, height: aabb.height,
        rotationDeg: 0, fit: "fill", cornerRadius: [0, 0, 0, 0],
        captureHtml: clone.outerHTML,
        captureInner: { left: un.left - aabb.left, top: un.top - aabb.top, width: un.width, height: un.height },
      });
      return;
    }
    const groupStartIdx = nodes.length;

    if (tag === "svg") {
      var clone = el.cloneNode(true);
      clone.style.position = "static";
      clone.style.left = "0"; clone.style.top = "0"; clone.style.margin = "0";
      const markup = new XMLSerializer().serializeToString(clone);
      // InDesign's SVG rendering of gradients/opacity/filters diverges from
      // Chrome - place those as high-res raster for visual parity.
      const preferRaster = /gradient|opacity|filter|mask|mix-blend/i.test(markup);
      nodes.push({ ...base, kind: "svg", src: "", markup, preferRaster });
      return;
    }

    if (tag === "img") {
      const fitMap = { cover: "cover", contain: "contain" };
      nodes.push({ ...base, kind: "image", src: "", rawSrc: el.currentSrc || el.src,
        fit: fitMap[cs.objectFit] || "fill", cornerRadius: effectiveCorners(el, cs, rect) });
      return;
    }

    const bg = parseColor(cs.backgroundColor);
    const bgImg = bgImageUrl(cs);
    const borderColor = parseColor(cs.borderTopColor);
    const borderW = parseFloat(cs.borderTopWidth) || 0;
    const hasStroke = borderW > 0 && cs.borderTopStyle !== "none" && borderColor;
    if (cs.backgroundImage.includes("gradient")) {
      warnings.push("Gradient on '" + base.name + "' not yet supported — using solid fallback.");
    }

    // First outer box-shadow -> InDesign drop shadow. Split on commas outside parens.
    let shadow = null;
    if (cs.boxShadow && cs.boxShadow !== "none") {
      const segs = [];
      let depth = 0, curSeg = "";
      for (const c of cs.boxShadow) {
        if (c === "(") depth++;
        if (c === ")") depth--;
        if (c === "," && depth === 0) { segs.push(curSeg); curSeg = ""; } else curSeg += c;
      }
      segs.push(curSeg);
      for (const seg of segs) {
        if (/\binset\b/.test(seg)) continue;
        const cm = parseColor(seg.match(/rgba?\([^)]*\)/)?.[0] || "");
        const nums = (seg.replace(/rgba?\([^)]*\)/, "").match(/-?[\d.]+px/g) || []).map(v => parseFloat(v));
        if (cm && nums.length >= 2) {
          shadow = { x: nums[0], y: nums[1], blur: nums[2] || 0, spread: nums[3] || 0,
            color: { r: cm.r, g: cm.g, b: cm.b }, alpha: cm.a };
          break;
        }
      }
      if (!shadow) warnings.push("Box shadow on '" + base.name + "' skipped (inset or unparsed).");
    }

    if (bg || hasStroke) {
      nodes.push({ ...base, kind: "rect",
        fill: bg ? { r: bg.r, g: bg.g, b: bg.b } : null,
        cornerRadius: corners(cs, rect.width, rect.height),
        strokeColor: hasStroke ? { r: borderColor.r, g: borderColor.g, b: borderColor.b } : null,
        strokeWeightPx: hasStroke ? borderW : 0,
        opacity: base.opacity * (bg ? bg.a : 1),
        shadow: shadow || undefined });
    }

    if (bgImg && !bgImg.startsWith("data:image/svg")) {
      // background-position: honored by emit for cover/contain (CSS semantics:
      // % maps to (frame - drawn) * p; px is a direct offset).
      var bgPos = null;
      var bpm = (cs.backgroundPosition || "").match(/(-?[\d.]+)(%|px)\s+(-?[\d.]+)(%|px)/);
      if (bpm) bgPos = { x: parseFloat(bpm[1]), xUnit: bpm[2], y: parseFloat(bpm[3]), yUnit: bpm[4] };
      nodes.push({ ...base, id: "n" + (++idCounter), kind: "image", src: "", rawSrc: bgImg,
        fit: cs.backgroundSize === "cover" ? "cover" : cs.backgroundSize === "contain" ? "contain" : "fill",
        bgPos: bgPos || undefined,
        clip: clipBoxOf(el, rect),
        cornerRadius: corners(cs, rect.width, rect.height) });
    }

    if (isTextBlock(el)) {
      const t = extractText(el, base.name);
      if (t) {
        t.rotationDeg = rotation;
        t.rotOrigin = rotOrigin || undefined;
        t.groupPath = base.groupPath;
        nodes.push(t);
      }
      return; // do not descend into inline children
    }

    const isGroupContainer = el.children.length >= 2 && tag !== "svg" && tag !== "img" && !isTextBlock(el);
    if (isGroupContainer) containerStack.push(base.id);
    for (const child of el.children) visit(child);
    if (isGroupContainer) containerStack.pop();

    if (isRotContainer) {
      // Ensure the container itself pins the group bounds (invisible if bare),
      // then tag every node created for this subtree as a group member.
      let hasSelf = false;
      for (let gi = groupStartIdx; gi < nodes.length; gi++) if (nodes[gi].id === base.id) hasSelf = true;
      if (!hasSelf) {
        nodes.splice(groupStartIdx, 0, { ...base, kind: "rect", fill: null,
          cornerRadius: [0, 0, 0, 0], strokeColor: null, strokeWeightPx: 0 });
      }
      for (let gi = groupStartIdx; gi < nodes.length; gi++) {
        if (!nodes[gi].rotGroup) nodes[gi].rotGroup = base.id;
      }
    }
    } finally {
      if (savedTransform !== null) el.style.transform = savedTransform;
      if (savedRotate !== null) el.style.rotate = savedRotate;
    }
  }

  // The root itself provides the page background; visit children.
  const rootCs = getComputedStyle(root);
  const rootBg = parseColor(rootCs.backgroundColor);
  for (const child of root.children) visit(child);

  return {
    widthPx: rootRect.width,
    heightPx: rootRect.height,
    background: rootBg ? { r: rootBg.r, g: rootBg.g, b: rootBg.b } : null,
    nodes,
    warnings,
    rotGroups,
  };
})()
`;

async function launch(): Promise<Browser> {
  return puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--force-device-scale-factor=1", "--hide-scrollbars", "--disable-lcd-text"],
  });
}

function hashName(data: Buffer | string, ext: string): string {
  return createHash("sha1").update(data).digest("hex").slice(0, 12) + ext;
}

function extFromMime(mime: string): string {
  const map: Record<string, string> = {
    "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp",
    "image/gif": ".gif", "image/svg+xml": ".svg", "image/avif": ".avif",
  };
  return map[mime] || ".png";
}

/** Stage an image source (data URI, http(s), file path) into linksDir. Returns filename. */
async function stageImage(rawSrc: string, htmlDir: string, linksDir: string): Promise<string> {
  if (rawSrc.startsWith("data:")) {
    const m = rawSrc.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
    if (!m) throw new Error("Unparseable data URI");
    const mime = m[1] || "application/octet-stream";
    const data = m[2] ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3]), "utf8");
    const name = hashName(data, extFromMime(mime));
    await writeFile(path.join(linksDir, name), data);
    return name;
  }
  if (rawSrc.startsWith("http://") || rawSrc.startsWith("https://")) {
    const res = await fetch(rawSrc);
    if (!res.ok) throw new Error(`Fetch failed ${res.status}: ${rawSrc}`);
    const data = Buffer.from(await res.arrayBuffer());
    const name = hashName(data, extFromMime(res.headers.get("content-type")?.split(";")[0] || ""));
    await writeFile(path.join(linksDir, name), data);
    return name;
  }
  // file:// or relative to the HTML file
  const p = rawSrc.startsWith("file://") ? new URL(rawSrc).pathname : path.resolve(htmlDir, decodeURIComponent(rawSrc));
  if (!existsSync(p)) throw new Error(`Image not found: ${p}`);
  const data = readFileSync(p);
  const name = hashName(data, path.extname(p) || ".png");
  await writeFile(path.join(linksDir, name), data);
  return name;
}

export interface MeasureResult {
  scene: Scene;
  screenshots: string[]; // paths to per-page reference screenshots
}

/** Measure one or more HTML files (one page each) into a Scene, staging assets into outDir/Links. */
export async function measure(htmlFiles: string[], outDir: string, docName: string): Promise<MeasureResult> {
  const linksDir = path.join(outDir, "Links");
  await mkdir(linksDir, { recursive: true });
  const browser = await launch();
  const pages: ScenePage[] = [];
  const screenshots: string[] = [];
  const fontSet = new Map<string, { families: string[]; style: string }>();

  try {
    for (const file of htmlFiles) {
      const page = await browser.newPage();
      await page.setViewport({ width: 1400, height: 1000, deviceScaleFactor: 1 });
      await page.goto("file://" + path.resolve(file), { waitUntil: "networkidle0" });
      await page.evaluate("document.fonts.ready.then(() => {})");
      // get_jsx pretty-printing injects "\n<indent>" INSIDE text nodes; under
      // white-space:pre-wrap that renders as literal breaks/indents. Strip the
      // pretty-print artifacts (deep-indent newlines) but keep designer breaks.
      await page.evaluate(`(() => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let t; const targets = [];
        while ((t = walker.nextNode())) targets.push(t);
        for (const tn of targets) {
          const ws = getComputedStyle(tn.parentElement).whiteSpace;
          if (ws === "pre-wrap" || ws === "pre" || ws === "pre-line" || ws === "break-spaces") {
            tn.textContent = tn.textContent
              .replace(/^[\\r\\n]+\\s*/, "").replace(/[\\r\\n]+\\s*$/, "")
              .replace(/[\\r\\n]\\s{8,}/g, " ");
          }
        }
      })()`);
      await new Promise((r) => setTimeout(r, 150));

      const raw = (await page.evaluate(PROBE)) as any;
      const w = Math.round(raw.widthPx);
      const h = Math.round(raw.heightPx);
      await page.setViewport({ width: Math.max(w, 10), height: Math.max(h, 10), deviceScaleFactor: 1 });

      // Stage assets
      const htmlDir = path.dirname(path.resolve(file));
      const nodes: SceneNode[] = [];
      for (const n of raw.nodes as SceneNode[]) {
        if (n.kind === "image" && (n as ImageNode).captureHtml) {
          // Render the rotated-container capture standalone at 2x, transparent.
          const img = n as ImageNode;
          const w = Math.max(1, Math.ceil(img.width));
          const h = Math.max(1, Math.ceil(img.height));
          const inner = img.captureInner!;
          const capPage = await browser.newPage();
          await capPage.setViewport({ width: w, height: h, deviceScaleFactor: 2 });
          await capPage.setContent(
            `<!doctype html><style>* { margin: 0; padding: 0; box-sizing: border-box; }</style>` +
            `<div style="width: ${w}px; height: ${h}px; position: relative; overflow: hidden;">` +
            `<div style="position: absolute; left: ${inner.left}px; top: ${inner.top}px; width: ${inner.width}px; height: ${inner.height}px;">${img.captureHtml}</div></div>`,
            { waitUntil: "load" });
          await capPage.evaluate("document.fonts.ready.then(() => {})");
          await new Promise((r) => setTimeout(r, 100));
          const buf = await capPage.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: w, height: h } }) as Buffer;
          await capPage.close();
          const name = hashName(Buffer.from(buf), "@2x.png");
          await writeFile(path.join(linksDir, name), buf);
          img.src = name;
          delete (img as any).captureHtml;
          delete (img as any).captureInner;
        } else if (n.kind === "image") {
          try {
            n.src = await stageImage((n as ImageNode).rawSrc, htmlDir, linksDir);
          } catch (e: any) {
            raw.warnings.push(`Image '${n.name}' could not be staged: ${e.message}`);
            continue;
          }
        } else if (n.kind === "svg") {
          const name = hashName(n.markup, ".svg");
          await writeFile(path.join(linksDir, name), n.markup);
          n.src = name;
          // Raster fallback at 3x in case InDesign refuses the SVG
          const w = Math.max(1, Math.ceil(n.width));
          const h = Math.max(1, Math.ceil(n.height));
          const svgPage = await browser.newPage();
          await svgPage.setViewport({ width: w, height: h, deviceScaleFactor: 3 });
          await svgPage.setContent(`<!doctype html><style>*{margin:0;padding:0}</style>${n.markup}`, { waitUntil: "load" });
          const pngName = name.replace(/\.svg$/, "@3x.png");
          await svgPage.screenshot({ path: path.join(linksDir, pngName) as `${string}.png`, omitBackground: true, clip: { x: 0, y: 0, width: w, height: h } });
          await svgPage.close();
          n.fallbackPng = pngName;
        } else if (n.kind === "text") {
          for (const run of n.runs) {
            const key = run.fontFamilies.join("|") + "\t" + run.fontStyle;
            fontSet.set(key, { families: run.fontFamilies, style: run.fontStyle });
          }
        }
        nodes.push(n);
      }

      const pageName = path.basename(file, path.extname(file));
      const shot = path.join(outDir, `ref-${pages.length + 1}-${pageName}.png`);
      await page.screenshot({ path: shot as `${string}.png`, clip: { x: 0, y: 0, width: w, height: h } });
      screenshots.push(shot);

      pages.push({ name: pageName, widthPx: w, heightPx: h, background: raw.background, nodes, warnings: raw.warnings, rotGroups: raw.rotGroups || [] });
      await page.close();
    }
  } finally {
    await browser.close();
  }

  return { scene: { docName, pages, fonts: [...fontSet.values()] }, screenshots };
}
