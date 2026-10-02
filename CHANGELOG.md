# Changelog

## 0.3.0 - 2026-10-02

- Focus this package on Figma input, retaining the development plugin, localhost bridge, native writer, and fidelity reports.
- Move Paper JSX and HTML input to the independent paper2indesign package.
- Preserve the shared scene writer and all existing Figma conversion features.

## 0.2.0 - 2026-10-02

- Preserve full CSS image boxes through cover/contain positioning before page, fold, and crop-frame clipping.
- Use an sRGB document profile and preserve embedded image color profiles.
- Fill optional print bleed with mirrored image-edge pixels at the original design scale, including isolated cover spine edges.
- Apply uniform text color alpha as content transparency and report mixed-alpha limitations.
- Measure overflow crop frames and scale their bounds with physical page geometry.
- Expose generic Paper JSX and HTML conversion alongside the Figma converter.

## 0.1.3 - 2026-09-30

- Include the localhost bridge protocol and server source in the installed package.

## 0.1.2 - 2026-09-30

- Refresh the scrubbed standalone release while retaining physical page scaling, editable source containers, installed font resolution, and line/container fidelity reports.

## 0.1.1 - 2026-09-28

- Map standard print canvases to exact physical US Letter page dimensions.
- Transfer Figma layout-grid margins and columns to InDesign page guides.
- Add named, non-printing source containers and per-edge container fidelity reporting.
- Report failed text builds as unmeasurable lines instead of omitting them.
- Resolve vendor-numbered installed faces to the same semantic family/style without treating width variants as substitutes.
- Measure rotated text on the shared pre-rotation baseline axis.

## 0.1.0 - 2026-09-28

- Initial deterministic Figma-to-InDesign converter.
- Added a localhost bridge and selection-only Figma development plugin.
- Added native editable text, linked artwork, INDD/IDML output, PNG proofs, pixel diffs, and per-line geometry reports.
- Fonts remain external references and are never embedded.
