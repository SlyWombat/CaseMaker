// QA the new U7 Pro Outdoor slider bench stand end-to-end in the real app:
// click the welcome template, confirm the slider stand compiles to ONE fused
// part (no floaters banner), screenshot it, export the ASCII STL into
// samples/, and independently re-verify shell count + bbox from the STL text.
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const URL = process.env.APP_URL ?? 'http://localhost:5199/';
const OUT = './triage-u7-stand-out';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1400, height: 900 },
  acceptDownloads: true,
});
const page = await ctx.newPage();
const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(String(e)));

console.log('▸ load', URL);
await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(1500);

const tplBtn = page.locator('[data-testid="welcome-template-u7-pro-outdoor-desk-stand"]').first();
await tplBtn.waitFor({ timeout: 15000 });
await tplBtn.click();
await page.waitForTimeout(4000);

const state = await page.evaluate(async () => {
  await window.__caseMaker?.waitForIdle?.();
  const proj = window.__caseMaker?.getProject();
  const scene = window.__caseMaker?.getSceneGraph?.();
  return {
    boardId: proj?.board?.id,
    mount: proj?.case?.stand?.mount,
    standEnabled: proj?.case?.stand?.enabled,
    sliderChannel: proj?.board?.enclosure?.sliderChannel,
    scene,
    stats: window.__caseMaker?.getMeshStats?.('all'),
    err: window.__caseMaker?.getJobError?.(),
  };
});
console.log('▸ board:', state.boardId, ' stand.mount:', state.mount, ' enabled:', state.standEnabled);
console.log('▸ sliderChannel:', JSON.stringify(state.sliderChannel));
console.log('▸ scene:', JSON.stringify(state.scene));
console.log('▸ mesh stats:', JSON.stringify(state.stats));
console.log('▸ job error:', state.err ?? 'none');

const floaters = await page.locator('[data-testid="floaters-banner"]').count();
console.log('▸ floaters banner:', floaters === 0 ? 'ABSENT (good)' : 'PRESENT — LOOSE PIECES');

await page.screenshot({ path: join(OUT, 'u7-stand-default.png') });
// Side view says the most about a tilted column + bracket.
for (const label of ['FRONT', 'SIDE', 'TOP']) {
  const btn = page.getByRole('button', { name: label, exact: true }).first();
  if (await btn.count()) {
    await btn.click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(OUT, `u7-stand-${label.toLowerCase()}.png`) });
  }
}

// Export the STL through the real app path.
await page.evaluate(() => {
  delete window.showSaveFilePicker;
});
const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
await page.evaluate(async () => {
  await window.__caseMaker.triggerExport('stl-ascii');
});
const dl = await downloadPromise;
const stlPath = join('..', 'samples', 'u7-pro-outdoor-bench-stand.ascii.stl');
await dl.saveAs(stlPath);
console.log('▸ saved STL to', stlPath, '(app filename:', dl.suggestedFilename(), ')');

// ---- Independent STL verification: shell count + bbox --------------------
const text = readFileSync(stlPath, 'utf8');
const re = /vertex\s+([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)/g;
const key2id = new Map();
const tris = [];
let cur = [];
let m;
const bbox = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
while ((m = re.exec(text)) !== null) {
  const v = [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])];
  for (let i = 0; i < 3; i++) {
    bbox.min[i] = Math.min(bbox.min[i], v[i]);
    bbox.max[i] = Math.max(bbox.max[i], v[i]);
  }
  const k = v.map((c) => Math.round(c * 1e4) / 1e4).join(',');
  let id = key2id.get(k);
  if (id === undefined) {
    id = key2id.size;
    key2id.set(k, id);
  }
  cur.push(id);
  if (cur.length === 3) {
    tris.push(cur);
    cur = [];
  }
}
const parent = new Array(key2id.size).fill(0).map((_, i) => i);
const find = (a) => {
  while (parent[a] !== a) {
    parent[a] = parent[parent[a]];
    a = parent[a];
  }
  return a;
};
for (const [a, b, c] of tris) {
  parent[find(b)] = find(a);
  parent[find(c)] = find(a);
}
const shells = new Set();
for (let i = 0; i < parent.length; i++) shells.add(find(i));
console.log('▸ STL:', tris.length, 'triangles,', key2id.size, 'unique vertices');
console.log('▸ STL shells (connected components):', shells.size, shells.size === 1 ? '(single fused part — good)' : '— LOOSE PIECES!');
console.log(
  '▸ STL bbox:',
  bbox.min.map((v) => v.toFixed(1)).join(','),
  '→',
  bbox.max.map((v) => v.toFixed(1)).join(','),
);
console.log('▸ console errors:', consoleErrors.length ? consoleErrors : 'none');

await browser.close();
