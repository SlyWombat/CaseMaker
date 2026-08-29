// Two fans, one per side, driven through the deployed app — the exact case
// reported as "the second one added did no cutouts and is a solid wall".
// Exports both side panels and counts bore-wall triangles in each STL, so a
// solid wall fails loudly instead of merely looking plausible in a render.
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const URL = process.env.QA_URL ?? 'https://electricrv.ca/casemaker/';
const OUT = process.env.QA_OUT ?? './qa-fans-out';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 }, acceptDownloads: true });
await ctx.addInitScript(() => { delete window.showSaveFilePicker; });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

await page.goto(URL, { waitUntil: 'networkidle', timeout: 60_000 });
const tpl = page.locator('[data-testid="welcome-template-mini-rack-10in"]');
await tpl.waitFor({ state: 'visible', timeout: 20_000 });
await tpl.click();
await page.waitForTimeout(15000);
await page.locator('[data-testid="sidebar-button-rack"]').click().catch(() => {});
await page.waitForTimeout(1000);

for (let i = 0; i < 2; i++) {
  await page.getByTestId('rack-add-fan').click();
  await page.waitForTimeout(1500);
}
const cards = page.locator('[data-testid^="rack-fan-"]');
console.log(`▸ fan cards: ${await cards.count()}`);
await cards.nth(1).locator('select').first().selectOption('right');
await page.waitForTimeout(6000);
await page.screenshot({ path: join(OUT, 'fans-config.png') });

// Look straight at a side panel, assembled — a fan hole is either there or
// it is not, and that is a question for eyes, not for a volume probe.
const click = async (label) => {
  const b = page.locator('.viewport-toolbar button, [data-testid="viewport-toolbar"] button')
    .filter({ hasText: new RegExp(`^${label}$`, 'i') }).first();
  if (await b.isVisible().catch(() => false)) { await b.click(); await page.waitForTimeout(3500); }
};
await click('COMPLETE');
await click('SIDE');
await page.screenshot({ path: join(OUT, 'fans-side.png') });

const pos = [];
for (let i = 0; i < (await cards.count()); i++) {
  const nums = cards.nth(i).locator('input[type=number]');
  pos.push({ y: Number(await nums.nth(0).inputValue()), z: Number(await nums.nth(1).inputValue()) });
}
console.log(`▸ fan positions: ${JSON.stringify(pos)}`);

// Open the export modal in binary STL, where the per-part save buttons live.
await page.locator('[data-testid="sidebar-button-export"]').click();
await page.waitForTimeout(800);
await page.locator('[data-testid="export-open"]').click();
await page.waitForTimeout(3000);
const fmt = page.locator('[data-testid="export-modal-format"]');
const opts = await fmt.locator('option').allTextContents().catch(() => []);
const bin = opts.findIndex((o) => /binary/i.test(o));
if (bin >= 0) { await fmt.selectOption({ index: bin }); await page.waitForTimeout(3000); }

let bad = 0;
for (const [i, id] of ['rack-side-left', 'rack-side-right'].entries()) {
  const btn = page.locator(`.export-modal [data-testid="export-save-${id}"]`);
  if (!(await btn.count())) { console.log(`  ${id}: NO EXPORT BUTTON`); bad++; continue; }
  const dl = page.waitForEvent('download', { timeout: 90_000 });
  await btn.click();
  const f = join(OUT, (await dl).suggestedFilename());
  await (await dl).saveAs(f);
  const buf = readFileSync(f);
  const tris = buf.readUInt32LE(80);
  const yC = pos[i].y;
  const zC = 5 + pos[i].z; // feet + configured height
  const R = 73 / 2; // 80 mm fan opening
  let ring = 0, zMin = 1e9, zMax = -1e9;
  for (let t = 0; t < tris; t++) {
    const o = 84 + t * 50 + 12;
    let on = 0;
    for (let v = 0; v < 3; v++) {
      const y = buf.readFloatLE(o + v * 12 + 4);
      const z = buf.readFloatLE(o + v * 12 + 8);
      if (z < zMin) zMin = z;
      if (z > zMax) zMax = z;
      if (Math.abs(Math.hypot(y - yC, z - zC) - R) < 1.2) on++;
    }
    if (on === 3) ring++;
  }
  const ok = ring > 40;
  if (!ok) bad++;
  console.log(`  ${id}: ${tris} tris, z ${zMin.toFixed(0)}..${zMax.toFixed(0)}mm — bore triangles at r=${R} around (${yC}, ${zC}): ${ring} ${ok ? '✓ OPEN' : '*** SOLID WALL ***'}`);
}
await page.screenshot({ path: join(OUT, 'fans-final.png') });
console.log(bad ? `!! ${bad} panel(s) failed` : '✓ both panels bored');
console.log(errs.length ? `!! errors: ${errs.slice(0, 4).join(' | ')}` : '✓ no console/page errors');
await browser.close();
