// The standing picture set's SVG → PNG rasteriser (#972). Run under plain node:
//   node scripts/bench-svg2png.mjs <in.svg> <out.png>
//
// It needs Playwright and its chromium. When either is missing this fails with a sentence that
// NAMES the missing piece — never a bare module error — because the renderer runs the set on
// machines that may not have the app's dev dependencies installed.
import { readFileSync } from 'node:fs';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error(
    'bench-svg2png: Playwright is not installed in this checkout — the standing picture set needs ' +
      'the `playwright` package to rasterise its SVGs (run `npm ci` in casemaker-app).',
  );
  process.exit(2);
}

const [svg, png] = process.argv.slice(2);
if (svg === undefined || png === undefined) {
  console.error('usage: node scripts/bench-svg2png.mjs <in.svg> <out.png>');
  process.exit(2);
}
const markup = readFileSync(svg, 'utf8');
let browser;
try {
  browser = await chromium.launch();
} catch (e) {
  console.error(
    'bench-svg2png: Playwright could not launch chromium — its browser download is missing or ' +
      `unusable (run \`npx playwright install chromium\`): ${e instanceof Error ? e.message : String(e)}`,
  );
  process.exit(2);
}
const page = await browser.newPage({ viewport: { width: 1100, height: 450 } });
await page.setContent(`<html><body style="margin:0;background:#e8e4dc">${markup}</body></html>`, { waitUntil: 'load', timeout: 20000 });
await page.locator('svg').screenshot({ path: png, timeout: 20000 });
await browser.close();
console.log('png written');
