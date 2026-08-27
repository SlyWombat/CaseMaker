// Pre-print check: pull the structural parts from PRODUCTION as binary STL and
// verify each is watertight and correctly sized before anything hits the bed.
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const URL = 'https://electricrv.ca/casemaker/';
const OUT = './qa-print-out';
mkdirSync(OUT, { recursive: true });
const PARTS = ['rack-bottom', 'rack-top', 'rack-side-left', 'rack-side-right'];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 }, acceptDownloads: true });
await ctx.addInitScript(() => { delete window.showSaveFilePicker; });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));

await page.goto(URL, { waitUntil: 'networkidle', timeout: 60_000 });
await page.locator('[data-testid="welcome-template-mini-rack-10in"]').click();
await page.waitForTimeout(15000);
await page.locator('[data-testid="sidebar-button-export"]').click();
await page.waitForTimeout(600);
await page.locator('[data-testid="export-open"]').click();
await page.waitForTimeout(2500);
const fmt = page.locator('[data-testid="export-modal-format"]');
const opts = await fmt.locator('option').allTextContents();
const bin = opts.findIndex((o) => /binary/i.test(o));
if (bin >= 0) { await fmt.selectOption({ index: bin }); await page.waitForTimeout(3000); }

function analyse(buf) {
  const n = buf.readUInt32LE(80);
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  const edges = new Map();
  const key = (x, y, z) => `${Math.round(x * 1000)},${Math.round(y * 1000)},${Math.round(z * 1000)}`;
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50 + 12;
    const v = [];
    for (let k = 0; k < 3; k++) {
      const x = buf.readFloatLE(o + k * 12), y = buf.readFloatLE(o + k * 12 + 4), z = buf.readFloatLE(o + k * 12 + 8);
      for (let a = 0; a < 3; a++) { const c = [x, y, z][a]; if (c < mn[a]) mn[a] = c; if (c > mx[a]) mx[a] = c; }
      v.push(key(x, y, z));
    }
    for (let k = 0; k < 3; k++) {
      const a = v[k], b = v[(k + 1) % 3];
      const e = a < b ? `${a}|${b}` : `${b}|${a}`;
      edges.set(e, (edges.get(e) ?? 0) + 1);
    }
  }
  let bad = 0;
  for (const c of edges.values()) if (c !== 2) bad++;
  return { tris: n, size: mx.map((m, i) => +(m - mn[i]).toFixed(2)), badEdges: bad };
}

for (const id of PARTS) {
  const btn = page.locator(`[data-testid="export-save-${id}"]`);
  if (!(await btn.count())) { console.log(`  ${id}: NOT FOUND`); continue; }
  const dl = page.waitForEvent('download', { timeout: 90_000 });
  await btn.click();
  const d = await dl;
  const p = join(OUT, d.suggestedFilename());
  await d.saveAs(p);
  const r = analyse(readFileSync(p));
  const ok = r.badEdges === 0;
  console.log(`  ${id.padEnd(16)} ${String(r.tris).padStart(6)} tris  ${r.size.join(' x ').padEnd(24)} ${ok ? 'watertight OK' : `*** ${r.badEdges} NON-MANIFOLD EDGES ***`}`);
  await page.waitForTimeout(500);
}
console.log(`\npage errors: ${errs.length ? errs.join(' | ') : '(none)'}`);
await browser.close();
