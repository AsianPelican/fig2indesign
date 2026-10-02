import { describe, expect, test } from "bun:test";
import { semanticFontStyle } from "./fontdb";

describe("semanticFontStyle", () => {
  test("normalizes vendor face codes without changing the intended weight", () => {
    expect(semanticFontStyle("45 Light")).toBe("Light");
    expect(semanticFontStyle("55 Regular")).toBe("Regular");
    expect(semanticFontStyle("55 Italic")).toBe("Regular Italic");
    expect(semanticFontStyle("65 Bd")).toBe("Bold");
    expect(semanticFontStyle("65 Bd Italic")).toBe("Bold Italic");
    expect(semanticFontStyle("85 XBlack")).toBe("ExtraBlack");
  });

  test("preserves width qualifiers so condensed faces are not silent substitutes", () => {
    expect(semanticFontStyle("Narrow Regular")).toBe("Narrow Regular");
    expect(semanticFontStyle("47 Cd Light Italic")).toBe("Condensed Light Italic");
  });

  test("normalizes common joined and abbreviated style names", () => {
    expect(semanticFontStyle("ExtraBold")).toBe("ExtraBold");
    expect(semanticFontStyle("SemiBold Italic")).toBe("SemiBold Italic");
  });
});
