// Click through the welcome → template path on the live deploy and capture
// screenshots from angles that show the lens floor cutout.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const URL = 'https://electricrv.ca/casemaker/';
const OUT = './triage-live-qa-out';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

console.log('▸ load', URL);
await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(2000);

// Click the ELP camera template button — exact path the user takes.
const tplBtn = page.locator('[data-testid="welcome-template-elp-camera-enclosure"]').first();
const tplBtnVisible = await tplBtn.isVisible().catch(() => false);
console.log('▸ ELP template button visible on welcome:', tplBtnVisible);
if (!tplBtnVisible) {
  // Fall back to a label-based locator
  const byLabel = page.locator('button:has-text("ELP AR0234")').first();
  if (await byLabel.isVisible().catch(() => false)) await byLabel.click();
} else {
  await tplBtn.click();
}
await page.waitForTimeout(3500);

// State sanity check
const state = await page.evaluate(() => {
  const proj = window.__caseMaker?.getProject();
  const stats = window.__caseMaker?.getMeshStats('shell');
  return {
    boardId: proj?.board?.id,
    standoff: proj?.board?.defaultStandoffHeight,
    cutouts: proj?.case?.customCutouts ?? [],
    bbox: stats?.bbox,
    tris: stats?.triangleCount,
    err: window.__caseMaker?.getJobError?.(),
  };
});
console.log('▸ board:', state.boardId, '| standoff:', state.standoff);
console.log('▸ customCutouts:', JSON.stringify(state.cutouts));
console.log('▸ shell bbox:', state.bbox, 'tris:', state.tris);
if (state.err) console.log('▸ ERROR:', state.err);

await page.screenshot({ path: join(OUT, 'tpl-01-after-template.png') });

// EXPLODED + PERSPECTIVE — separates the lid; case interior visible from above
const persp = page.locator('[data-testid="viewport-camera-perspective"]').first();
if (await persp.isVisible().catch(() => false)) await persp.click();
const exploded = page.locator('[data-testid="viewport-view-exploded"]').first();
if (await exploded.isVisible().catch(() => false)) await exploded.click();
await page.waitForTimeout(1500);
await page.screenshot({ path: join(OUT, 'tpl-02-exploded.png') });

// R3F stores its three.js state on the canvas DOM node under `__r3f`. We
// can reach the camera and reposition it directly to look UP at the case
// from below (camera.position.z < 0).
await page.evaluate(() => {
  const canvas = document.querySelector('canvas');
  if (!canvas) return;
  const r3f = canvas.__r3f || canvas['__r3f'];
  // R3F exposes state on canvas via `useThree`; walk a fiber root if needed.
  // Easier: dispatch via global THREE if exposed. Fall back: dispatch a
  // sequence of pointermove events with proper modifiers.
});
const canvas = page.locator('canvas').first();
const box = await canvas.boundingBox();
if (box) {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  // OrbitControls listens for `pointerdown`/`pointermove`/`pointerup`.
  // Use real pointer events with proper button=0 (left).
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: 'left' });
  // Drag UPWARD by 700 px to rotate camera below the model (vertical
  // mouse-up = polar angle decreases past zero, then continues over the top).
  for (let i = 0; i < 70; i++) {
    await page.mouse.move(cx, cy - 10 * (i + 1), { steps: 2 });
  }
  await page.mouse.up({ button: 'left' });
  await page.waitForTimeout(800);
}
await page.screenshot({ path: join(OUT, 'tpl-03-rotated-up.png') });

// Now also reset to BASE-ONLY (lid hidden) + this rotation
const base = page.locator('[data-testid="viewport-view-base-only"]').first();
if (await base.isVisible().catch(() => false)) await base.click();
await page.waitForTimeout(800);
await page.screenshot({ path: join(OUT, 'tpl-04-base-rotated.png') });

// Definitive cutout verification: toggle the lens cutout off vs on, compare
// shell triangle count + bbox. A round cutout subtracted from a 2mm-thick
// floor adds ~64 triangles (cyl wall + rim).
const triComparison = await page.evaluate(async () => {
  const api = window.__caseMaker;
  const before = api.getMeshStats('shell').triangleCount;
  // Disable the cutout
  const proj1 = api.getProject();
  proj1.case.customCutouts = (proj1.case.customCutouts ?? []).map((c) => ({ ...c, enabled: false }));
  await api.setProject(proj1);
  await api.waitForIdle();
  const offTris = api.getMeshStats('shell').triangleCount;
  // Re-enable
  const proj2 = api.getProject();
  proj2.case.customCutouts = (proj2.case.customCutouts ?? []).map((c) => ({ ...c, enabled: true }));
  await api.setProject(proj2);
  await api.waitForIdle();
  const onTris = api.getMeshStats('shell').triangleCount;
  return { before, offTris, onTris, delta: onTris - offTris };
});
console.log('▸ shell tris (cutout disabled):', triComparison.offTris);
console.log('▸ shell tris (cutout enabled):', triComparison.onTris);
console.log('▸ Δ (with vs without cutout):', triComparison.delta);
await page.screenshot({ path: join(OUT, 'tpl-05-cutout-on.png') });

console.log(`▸ console errors: ${errors.length}`);
for (const e of errors.slice(0, 5)) console.log('  -', e);

await browser.close();
console.log(`\nWrote screenshots to ${OUT}/tpl-*`);
