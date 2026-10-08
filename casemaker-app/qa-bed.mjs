// Download the fused frame from the app and measure its FIRST LAYER area.
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
mkdirSync('./qa-bed-out', { recursive: true });
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });
await ctx.addInitScript(() => { delete window.showSaveFilePicker; });
const page = await ctx.newPage();
await page.goto(process.env.QA_URL ?? 'http://localhost:4186/', { waitUntil: 'networkidle', timeout: 60000 });
await page.locator('[data-testid="welcome-template-mini-rack-10in"]').click();
await page.waitForTimeout(15000);
await page.locator('[data-testid="sidebar-button-rack"]').click();
await page.waitForTimeout(800);
const cb = page.locator('[data-testid="rack-assembled-export"]');
await cb.scrollIntoViewIfNeeded(); await cb.check();
await page.waitForTimeout(14000);
await page.locator('[data-testid="sidebar-button-export"]').click();
await page.waitForTimeout(600);
await page.locator('[data-testid="export-open"]').click();
await page.waitForTimeout(3000);
const fmt = page.locator('[data-testid="export-modal-format"]');
const opts = await fmt.locator('option').allTextContents();
const bin = opts.findIndex((o) => /binary/i.test(o));
if (bin >= 0) { await fmt.selectOption({ index: bin }); await page.waitForTimeout(4000); }
const dl = page.waitForEvent('download', { timeout: 120000 });
await page.locator('[data-testid="export-save-rack-assembled-frame"]').click();
const d = await dl;
const p = './qa-bed-out/' + d.suggestedFilename();
await d.saveAs(p);
const buf = readFileSync(p);
const n = buf.readUInt32LE(80);
let minZ = Infinity, maxZ = -Infinity;
const tris = [];
for (let i = 0; i < n; i++) {
  const o = 84 + i * 50 + 12;
  const z = [0,1,2].map((k) => buf.readFloatLE(o + k * 12 + 8));
  const xs = [0,1,2].map((k) => buf.readFloatLE(o + k * 12));
  const ys = [0,1,2].map((k) => buf.readFloatLE(o + k * 12 + 4));
  minZ = Math.min(minZ, ...z); maxZ = Math.max(maxZ, ...z);
  tris.push({ z, xs, ys });
}
// Area of triangles lying within 0.3 mm of the lowest z (the bed contact).
let area = 0;
for (const t of tris) {
  if (Math.max(...t.z) - minZ > 0.3) continue;
  const a = Math.abs((t.xs[1]-t.xs[0])*(t.ys[2]-t.ys[0]) - (t.xs[2]-t.xs[0])*(t.ys[1]-t.ys[0])) / 2;
  area += a;
}
console.log(`${d.suggestedFilename()}  ${(buf.length/1048576).toFixed(2)} MB`);
console.log(`z range ${minZ.toFixed(1)} .. ${maxZ.toFixed(1)}`);
console.log(`bed-contact area at the lowest layer: ${(area/100).toFixed(1)} cm2 (${(area/(252*250)*100).toFixed(1)}% of a 252x250 footprint)`);
await b.close();
