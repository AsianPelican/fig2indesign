# fig2indesign

`fig2indesign` converts selected Figma frames into editable Adobe InDesign documents on your own Mac. Conversion runs locally and deterministically.

The converter creates native text frames, linked artwork, `.indd` and `.idml` documents, PNG proofs, pixel diffs, and a machine-readable per-line fidelity report. Fonts are referenced from your Mac and are never embedded.

Common US Letter Figma canvases (850×1100 at 100 px/in and 816×1056 at 96 px/in, including landscape orientation) are converted to an exact 612×792pt physical page. Source layout-grid margins and columns are transferred when Figma defines them. Every visible source frame, group, rectangle, image frame, and text container is also represented by a named, non-printing editable item on the `SOURCE CONTAINERS` layer so its bounds can be audited without changing the rendered artwork.

## Requirements

- macOS
- Bun
- Google Chrome in `/Applications`
- Adobe InDesign 2026 or 2025 in `/Applications`, launched and signed in once
- The fonts used by the Figma file installed locally
- A Figma personal access token with permission to read the source file

## Setup

Clone the repository and run one command:

```sh
bun setup.ts
```

The setup installs pinned dependencies and builds the Figma development plugin. The Figma reader and line-geometry implementation come from `AsianPelican/figma2pptx`, pinned to an exact commit in `package.json` so they do not drift.

## Use the Figma plugin

1. Set your Figma token in the terminal and start the localhost bridge:

   ```sh
   FIGMA_TOKEN=your-token bun run bridge
   ```

2. In Figma Desktop, choose **Plugins → Development → Import plugin from manifest** and select `plugin/manifest.json`.
3. Select one or more top-level frames and run **Figma to InDesign**.
4. Download the INDD, IDML, or fidelity report when the build finishes.

The bridge listens only on `127.0.0.1:41416`. The token stays in the bridge process environment; it is never sent by the plugin, written to output, placed in a URL, or logged.

## Command line

```sh
FIGMA_TOKEN=your-token bun bridge.ts figma FILE_KEY 1:2 1:3 --name export --out out --cache cache
```

Use `--no-indesign` to build the scene without launching InDesign.

## Paper and HTML input

The same converter accepts ordered HTML artboards exported from Paper. Convert inline-style JSX, then build the document:

```sh
bun src/paper2html.ts input.jsx input.html
bun bridge.ts html input.html --name export --out out
```

Library callers can use `jsxToHtml`, `buildFromHtml`, and `buildFromScene`. `BuildOptions.printPreset` configures physical facing pages and optional print bleed; edge images use mirrored pixels outside trim at the original design scale. Image padding requires ImageMagick (`magick`).

## Output

- `export.indd` and `export.idml`
- `Links/` for placed artwork
- `proof-N.png`, `diff-N.png`, and source reference renders
- `fidelity-report.json` with total lines, measurable lines, lines within 1px, and the worst line displacement
- per-container edge measurements, overset count, source canvas size, and physical page scale in the same report

## Font policy

The runtime has no font-embedding path. InDesign resolves installed font families and styles, and the report records substitutions. IDML output contains font references but no font binary parts.

## License

MIT
