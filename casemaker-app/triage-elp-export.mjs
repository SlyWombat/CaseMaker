// Reproduce the export path the user took. Click the welcome template,
// trigger an STL export, intercept the download bytes, and verify the
// lens hole is present (vertices on a 16mm-dia circle near the case
// center).
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const URL = 'https://electricrv.ca/casemaker/';
const OUT = './triage-live-qa-out';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1400, height: 900 },
  acceptDownloads: true,
});
const page = await ctx.newPage();

console.log('▸ load', URL);
await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(2000);

// Welcome → BOARD dropdown (NOT template) — reproduce user's likely path
const useBoard = process.env.PATH_BOARD === '1';
if (useBoard) {
  const sel = page.locator('[data-testid="welcome-board-select"]');
  await sel.selectOption('elp-usbgs1200p01-h120');
  await page.locator('[data-testid="welcome-board-go"]').click();
} else {
  const tplBtn = page.locator('[data-testid="welcome-template-elp-camera-enclosure"]').first();
  await tplBtn.waitFor({ timeout: 10000 });
  await tplBtn.click();
}
await page.waitForTimeout(3500);

const state = await page.evaluate(() => {
  const proj = window.__caseMaker?.getProject();
  return {
    boardId: proj?.board?.id,
    cutouts: proj?.case?.customCutouts ?? [],
    shellTris: window.__caseMaker?.getMeshStats('shell')?.triangleCount,
    err: window.__caseMaker?.getJobError?.(),
  };
});
console.log('▸ board:', state.boardId);
console.log('▸ customCutouts:', JSON.stringify(state.cutouts));
console.log('▸ shell tris (live render):', state.shellTris);

// Force anchor-download path (showSaveFilePicker hangs in headless).
await page.evaluate(() => {
  delete window.showSaveFilePicker;
});
const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
await page.evaluate(async () => {
  await window.__caseMaker.triggerExport('stl-ascii');
});
const dl = await downloadPromise;
const stlPath = join(OUT, 'live-elp-export.ascii.stl');
await dl.saveAs(stlPath);
console.log('▸ saved STL to', stlPath);

// Quick check: does the STL contain a 32-vertex circle around (23, 23)
// in the bottom-zone (z<3)?
const fs = await import('node:fs');
const text = fs.readFileSync(stlPath, 'utf8');
const re = /vertex\s+([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)/g;
const verts = [];
let m;
while ((m = re.exec(text)) !== null) {
  verts.push([parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])]);
}
console.log('▸ STL total vertices:', verts.length);

// Look for a circle: vertices in floor zone forming a ring of radius 8.
// In print-ready layout the shell may be at x∈[0,46] OR offset; scan
// candidate centers along x at y≈23.
const floorVerts = verts.filter((v) => v[2] < 3);
const candidates = [];
for (let cx = 0; cx <= 100; cx++) {
  let count = 0;
  for (const v of floorVerts) {
    const d = Math.hypot(v[0] - cx, v[1] - 23);
    if (Math.abs(d - 8) < 0.4) count++;
  }
  if (count >= 16) candidates.push({ cx, count });
}
console.log('▸ candidate circle centers (cx, ring-vert count):', candidates.length ? candidates : 'NONE — no 16mm circle in floor zone');

await browser.close();
