import puppeteer from "puppeteer-core";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** Render Figma's textless SVG artwork when it contains embedded bitmap data.
 * InDesign omits data-URI <image> elements when it imports SVG directly.
 */
export async function rasterizeSvg(
  markup: string,
  width: number,
  height: number,
  target: string,
  scale = 3,
): Promise<void> {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--force-device-scale-factor=1", "--hide-scrollbars", "--disable-lcd-text"],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({
      width: Math.max(1, Math.ceil(width)),
      height: Math.max(1, Math.ceil(height)),
      deviceScaleFactor: scale,
    });
    await page.setContent(
      `<!doctype html><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}svg{display:block}</style>${markup}`,
      {waitUntil: "load"},
    );
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.screenshot({
      path: target as `${string}.png`,
      omitBackground: true,
      clip: {x: 0, y: 0, width, height},
    });
    await page.close();
  } finally {
    await browser.close();
  }
}
