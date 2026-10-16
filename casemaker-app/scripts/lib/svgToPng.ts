// Render an SVG string to a PNG with headless chromium — the same route `render-images.mjs` takes
// for the app's own artwork, and the reason playwright is a devDependency.
//
// The browser is closed in a `finally`, on every path. A harness that throws before its cleanup
// leaves a live browser process on the maintainer's desktop, and this one is called from a script
// that writes files for a person to look at — so the failure mode is exactly the one that has to be
// impossible here.

import { chromium } from 'playwright';

/** `svg` → PNG bytes, at the SVG's own `width`/`height`. */
export async function svgToPng(svg: string, { scale = 2 }: { scale?: number } = {}): Promise<Buffer> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: scale });
    // A data URL, not a file: nothing is written to disk that the caller did not ask for, and the
    // SVG is standalone (no external references, no fonts it has to fetch).
    await page.setContent(
      `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#fff}</style>${svg}`,
      { waitUntil: 'load' },
    );
    const el = await page.$('svg');
    if (el === null) throw new Error('the SVG did not render: no <svg> element in the page');
    return await el.screenshot({ type: 'png' });
  } finally {
    await browser.close();
  }
}
