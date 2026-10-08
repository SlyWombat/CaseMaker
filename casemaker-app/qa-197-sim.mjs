// Issue #197 — load a small program through the Simulate panel and LOOK at the viewport:
// the stock, the cyan cuts, the dashed rapids and the tool must actually be drawn.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

mkdirSync('./qa-197-out', { recursive: true });
const NC = [
  'G90 G21',
  'M3 S12000',
  'G0 X10 Y10 Z5',
  'G1 Z-1 F200',
  'G1 X90 F500',
  'G1 Y20',
  'G1 X10',
  'G0 Z5',
  'G0 X10 Y30',
  'G1 Z-1 F200',
  'G1 X90 F500',
  'G0 Z5',
  'M5',
  'M02',
].join('\n');

const b = await chromium.launch();
const page = await (await b.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 2 })).newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });

await page.goto(process.env.QA_URL ?? 'http://localhost:5199/', { waitUntil: 'networkidle', timeout: 60000 });
const tpl = page.locator('[data-testid^="welcome-template-"]').first();
if (await tpl.count()) { await tpl.click(); await page.waitForTimeout(9000); }

await page.locator('[data-testid="sidebar-button-cnc-sim"]').click();
await page.waitForTimeout(1200);

// Build the DataTransfer and the DragEvent INSIDE the page: passing a dataTransfer handle
// across the Playwright boundary is unreliable, and the React handler needs e.dataTransfer.files.
await page.evaluate((text) => {
  const el = document.querySelector('[data-testid="sim-panel"]');
  const t = new DataTransfer();
  t.items.add(new File([text], 'qa-197.nc', { type: 'text/plain' }));
  el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: t }));
}, NC);
await page.waitForFunction(
  () => document.querySelector('[data-testid="sim-file-name"]')?.textContent !== 'No file open',
  { timeout: 5000 },
);
console.log('file:', await page.locator('[data-testid="sim-file-name"]').textContent());
await page.locator('[data-testid="sim-tool"]').selectOption('flat-3.175x12-metal');
await page.waitForTimeout(300);
await page.locator('[data-testid="sim-simulate"]').click();
await page.waitForTimeout(12000);
console.log('status text:', (await page.locator('[data-testid="sim-panel"]').innerText()).split('\n').slice(0, 6).join(' / '));

// What is actually in the R3F scene: names on the meshes + line objects.
const scene = await page.evaluate(() => {
  const out = { meshes: [], lines: [], geometries: null };
  const walk = (o) => {
    if (!o) return;
    if (o.isMesh) out.meshes.push(o.name || '(unnamed)');
    if (o.isLineSegments || o.isLine) out.lines.push(o.name || '(unnamed)');
    for (const c of o.children ?? []) walk(c);
  };
  // R3F hangs the scene off the canvas' __r3f store.
  const canvas = document.querySelector('[data-testid="viewport-canvas"] canvas');
  const root = canvas?.__r3f?.root?.getState?.() ?? canvas?.parentElement?.__r3f?.root?.getState?.();
  if (root) {
    walk(root.scene);
    out.geometries = root.gl?.info?.memory?.geometries ?? null;
  }
  return out;
});
console.log('scene meshes:', scene.meshes.join(', ') || '(none found)');
console.log('scene lines:', scene.lines.join(', ') || '(none found)');
console.log('geometries:', scene.geometries);
await page.screenshot({ path: './qa-197-out/sim-loaded.png' });

// Toggling the "Removed" layer must change the picture — the ghost bug (#162) hides in here.
const canvas = page.locator('[data-testid="viewport-canvas"] canvas');
const before = await canvas.screenshot();
await page.locator('[data-testid="viewport-layer-removed"]').click();
await page.waitForTimeout(600);
const after = await canvas.screenshot();
console.log('removed toggle changed the canvas:', !before.equals(after));
await page.screenshot({ path: './qa-197-out/sim-removed-off.png' });
// Blown up, so a 1 px cyan cut line can actually be seen.
await page.screenshot({ path: './qa-197-out/zoom-cuts.png', clip: { x: 380, y: 390, width: 380, height: 200 } });

console.log(`page errors: ${errs.length ? errs.join(' | ') : '(none)'}`);
await b.close();
