// Local font database: scans installed font files and parses their name
// tables to map PostScript names -> { family, style } exactly as InDesign
// will see them. No InDesign round-trips.

import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";
import os from "os";

export interface FontFace {
  family: string;
  style: string;
}

const WIDTH_TOKENS: Record<string, string> = {
  narrow: "Narrow",
  condensed: "Condensed",
  cd: "Condensed",
  extended: "Extended",
  expanded: "Extended",
};

const WEIGHT_TOKENS: Record<string, string> = {
  thin: "Thin",
  ultralight: "ExtraLight",
  extralight: "ExtraLight",
  light: "Light",
  book: "Regular",
  regular: "Regular",
  roman: "Regular",
  normal: "Regular",
  medium: "Medium",
  semibold: "SemiBold",
  demibold: "SemiBold",
  demi: "SemiBold",
  bold: "Bold",
  bd: "Bold",
  extrabold: "ExtraBold",
  heavy: "ExtraBold",
  black: "Black",
  xblack: "ExtraBlack",
};

/**
 * Reduce vendor style labels to the semantic style requested by design APIs.
 * Numeric face codes are metadata (for example, "65 Bd" means Bold), while
 * width qualifiers remain significant so Narrow Regular never aliases Regular.
 */
export function semanticFontStyle(style: string): string {
  const compact = style.replace(/([a-z])([A-Z])/g, "$1 $2");
  const tokens = compact.split(/[\s_-]+/).filter(Boolean);
  const squashed = compact.toLowerCase().replace(/[^a-z0-9]+/g, "");
  let width = "";
  let weight = "Regular";
  let italic = false;
  for (const raw of tokens) {
    const token = raw.toLowerCase();
    if (/^\d+$/.test(token)) continue;
    if (WIDTH_TOKENS[token]) width = WIDTH_TOKENS[token];
    if (WEIGHT_TOKENS[token]) weight = WEIGHT_TOKENS[token];
    if (token === "italic" || token === "oblique" || token === "it") italic = true;
  }
  if (squashed.includes("extralight") || squashed.includes("ultralight")) weight = "ExtraLight";
  if (squashed.includes("semibold") || squashed.includes("demibold")) weight = "SemiBold";
  if (squashed.includes("extrabold")) weight = "ExtraBold";
  return [width, weight, italic ? "Italic" : ""].filter(Boolean).join(" ");
}

const FONT_DIRS = [
  path.join(os.homedir(), "Library/Fonts"),
  "/Library/Fonts",
  "/System/Library/Fonts",
  "/System/Library/Fonts/Supplemental",
  // Adobe Fonts activations (hidden dotfiles, extensionless-looking .otf)
  path.join(os.homedir(), "Library/Application Support/Adobe/CoreSync/plugins/livetype/.w"),
  path.join(os.homedir(), "Library/Application Support/Adobe/CoreSync/plugins/livetype/.r"),
];

function readU16(b: Buffer, o: number) { return b.readUInt16BE(o); }
function readU32(b: Buffer, o: number) { return b.readUInt32BE(o); }

interface NameRecords { [nameId: number]: string }

function parseNameTable(buf: Buffer, tableOffset: number): NameRecords {
  const out: NameRecords = {};
  const count = readU16(buf, tableOffset + 2);
  const stringOffset = tableOffset + readU16(buf, tableOffset + 4);
  const scores: { [id: number]: number } = {};
  for (let i = 0; i < count; i++) {
    const rec = tableOffset + 6 + i * 12;
    const platformID = readU16(buf, rec);
    const languageID = readU16(buf, rec + 4);
    const nameID = readU16(buf, rec + 6);
    const length = readU16(buf, rec + 8);
    const offset = readU16(buf, rec + 10);
    if (![1, 2, 4, 6, 16, 17].includes(nameID)) continue;
    // Prefer Windows/Unicode en-US, then any Windows, then Mac Roman.
    let score = 0;
    if (platformID === 3 && languageID === 0x409) score = 3;
    else if (platformID === 3) score = 2;
    else if (platformID === 1 && languageID === 0) score = 1;
    else if (platformID === 0) score = 2;
    else continue;
    if ((scores[nameID] || 0) >= score) continue;
    const start = stringOffset + offset;
    if (start + length > buf.length) continue;
    const raw = buf.subarray(start, start + length);
    let decoded = "";
    if (platformID === 1) decoded = raw.toString("latin1");
    else {
      // sfnt strings are UTF-16BE
      for (let j = 0; j + 1 < raw.length; j += 2) decoded += String.fromCharCode((raw[j] << 8) | raw[j + 1]);
    }
    out[nameID] = decoded;
    scores[nameID] = score;
  }
  return out;
}

function* sfntOffsets(buf: Buffer): Generator<number> {
  const tag = buf.toString("latin1", 0, 4);
  if (tag === "ttcf") {
    const numFonts = readU32(buf, 8);
    for (let i = 0; i < numFonts && i < 32; i++) yield readU32(buf, 12 + i * 4);
  } else {
    yield 0;
  }
}

function parseFontFile(file: string, map: Map<string, FontFace>) {
  const buf = readFileSync(file);
  for (const base of sfntOffsets(buf)) {
    if (base + 12 > buf.length) continue;
    const numTables = readU16(buf, base + 4);
    let nameOffset = -1;
    for (let i = 0; i < numTables; i++) {
      const rec = base + 12 + i * 16;
      if (rec + 16 > buf.length) break;
      if (buf.toString("latin1", rec, rec + 4) === "name") {
        nameOffset = readU32(buf, rec + 8);
        break;
      }
    }
    if (nameOffset < 0 || nameOffset + 6 > buf.length) continue;
    const names = parseNameTable(buf, nameOffset);
    const ps = names[6];
    const family = names[16] || names[1];
    const style = names[17] || names[2] || "Regular";
    if (ps && family && !map.has(ps.toLowerCase())) {
      map.set(ps.toLowerCase(), { family, style });
    }
    // Full name (nameID 4) is another alias designers reference.
    if (names[4] && family && !map.has(names[4].toLowerCase())) {
      map.set(names[4].toLowerCase(), { family, style });
    }
  }
}

let cached: Map<string, FontFace> | null = null;

/** Map of lowercase PostScript/full names -> installed face. Built once. */
export function fontDb(): Map<string, FontFace> {
  if (cached) return cached;
  const map = new Map<string, FontFace>();
  for (const dir of FONT_DIRS) {
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const e of entries) {
      if (!/\.(otf|ttf|ttc|otc)$/i.test(e)) continue;
      const p = path.join(dir, e);
      try {
        if (statSync(p).size > 100 * 1024 * 1024) continue;
        parseFontFile(p, map);
      } catch {}
    }
  }
  cached = map;
  return map;
}

/** Resolve font hints for every dash-style candidate family in a scene. */
export function fontHintsFor(familyStacks: string[][]): Record<string, FontFace> {
  const db = fontDb();
  const hints: Record<string, FontFace> = {};
  const requestedFamilies = new Set(familyStacks.flat().map((name) => name.toLowerCase()));
  const semanticFaces = new Map<string, FontFace | null>();
  const seenFaces = new Set<string>();

  for (const face of db.values()) {
    const faceKey = `${face.family}\t${face.style}`.toLowerCase();
    if (seenFaces.has(faceKey) || !requestedFamilies.has(face.family.toLowerCase())) continue;
    seenFaces.add(faceKey);
    const key = `${face.family.toLowerCase()}\t${semanticFontStyle(face.style).toLowerCase()}`;
    const prior = semanticFaces.get(key);
    if (prior && (prior.family !== face.family || prior.style !== face.style)) semanticFaces.set(key, null);
    else if (prior === undefined) semanticFaces.set(key, face);
  }

  for (const stack of familyStacks) {
    for (const name of stack) {
      const hit = db.get(name.toLowerCase());
      if (hit) hints[name] = hit;
      for (const [key, face] of semanticFaces) {
        if (face && key.startsWith(`${name.toLowerCase()}\t`)) {
          const semanticStyle = key.slice(key.indexOf("\t") + 1);
          hints[`${name}\t${semanticStyle}`] = face;
        }
      }
    }
  }
  return hints;
}
