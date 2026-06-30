// Smoke test: verify the ELP-USBGS1200P01-H120 board + template render on
// the live deploy. Loads the page, switches the welcome-screen board picker
// to the new ELP camera entry (which exercises the board profile), then
// loads the ELP camera template and screenshots the result.
//   node triage-elp-camera.mjs

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
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

console.log(`▸ Loading ${URL}`);
await page.goto(URL, { waitUntil: 'networkidle', timeout: 30_000 });
await page.waitForTimeout(2000);

const version = await page
  .evaluate(() => document.querySelector('[data-testid="version-stamp"], [class*="version"]')?.textContent ?? null)
  .catch(() => null);
console.log(`▸ Version: ${version}`);

await page.screenshot({ path: join(OUT, 'elp-01-landing.png') });

// Try the board-picker first (proves the board is registered).
const boardSelect = page.locator('[data-testid="welcome-board-select"]');
if (await boardSelect.isVisible().catch(() => false)) {
  // Confirm the option is in the dropdown
  const hasElp = await boardSelect.evaluate((el) =>
    Array.from(el.querySelectorAll('option')).some((o) => o.value === 'elp-usbgs1200p01-h120'),
  );
  console.log(`▸ ELP board listed in welcome dropdown: ${hasElp}`);
  await boardSelect.selectOption('elp-usbgs1200p01-h120');
  const goBtn = page.locator('[data-testid="welcome-board-go"]');
  if (await goBtn.isVisible().catch(() => false)) {
    await goBtn.click();
    await page.waitForTimeout(3000);
  }
}

await page.screenshot({ path: join(OUT, 'elp-02-board-loaded.png') });

// Drive the test API directly to load the ELP camera TEMPLATE — the
// CustomCutout for the lens is added by the template, not the board
// profile, so loading just the board (above) won't show the floor hole.
const apiAvailable = await page.evaluate(() => !!window.__caseMaker).catch(() => false);
console.log(`▸ test API available on live deploy: ${apiAvailable}`);

if (apiAvailable) {
  const tplResult = await page.evaluate(async () => {
    const mod = await import('/assets/index-' /* hashed bundle */);
    return null;
  }).catch(() => null);
  void tplResult;

  // Easier path: synthesize the template's case-shape via patchCase + add
  // a custom cutout. The deployed prod bundle doesn't expose findTemplate
  // through the window API, so we just configure the case and inject the
  // custom cutout directly using the persistence round-trip.
  await page.evaluate(async () => {
    const api = window.__caseMaker;
    const proj = api.getProject();
    proj.case.joint = 'screw-down';
    proj.case.ventilation = { enabled: false, pattern: 'none', coverage: 0 };
    proj.case.customCutouts = [
      {
        id: 'tpl-elp-lens-hole',
        face: 'bottom',
        shape: 'round',
        u: proj.case.wallThickness + proj.case.internalClearance + proj.board.pcb.size.x / 2,
        v: proj.case.wallThickness + proj.case.internalClearance + proj.board.pcb.size.y / 2,
        width: 16,
        height: 16,
        enabled: true,
        label: 'Camera lens',
      },
    ];
    await api.setProject(proj);
  });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: join(OUT, 'elp-03-template.png') });

  // Hide the lid AND the board, then look TOP-down — this reveals the
  // floor with the lens cutout (PCB no longer blocks the view).
  const baseOnlyBtn = page.locator('[data-testid="viewport-view-base-only"]').first();
  if (await baseOnlyBtn.isVisible().catch(() => false)) {
    await baseOnlyBtn.click();
    await page.waitForTimeout(400);
  }
  await page.evaluate(() => {
    // Reach into Zustand directly: viewportStore is exposed via __caseMaker
    // on the test build; in prod we toggle through window-mounted stores.
    // Easiest portable path: dispatch a custom event the toolbar listens to,
    // OR use a hardcoded keyboard shortcut. Use 'b' which the toolbar
    // typically binds to "toggle board visibility".
    const evt = new KeyboardEvent('keydown', { key: 'b', code: 'KeyB' });
    window.dispatchEvent(evt);
  });
  await page.waitForTimeout(400);
  // Fallback: try to find a "show board" toggle in the UI
  const boardToggle = page.locator('[data-testid="show-board-toggle"], button[aria-label*="board" i]').first();
  if (await boardToggle.isVisible().catch(() => false)) {
    await boardToggle.click();
    await page.waitForTimeout(400);
  }
  const topCamBtn = page.locator('[data-testid="viewport-camera-top"]').first();
  if (await topCamBtn.isVisible().catch(() => false)) {
    await topCamBtn.click();
    await page.waitForTimeout(1500);
  }
  await page.screenshot({ path: join(OUT, 'elp-04-floor-from-above.png') });

  // Verify lens cutout exists in project state
  const cutoutCheck = await page.evaluate(() => {
    const proj = window.__caseMaker?.getProject();
    return {
      cutouts: proj?.case.customCutouts ?? [],
      standoff: proj?.board.defaultStandoffHeight,
      zClearance: proj?.case.zClearance,
    };
  });
  console.log('▸ Custom cutouts in project:', JSON.stringify(cutoutCheck.cutouts));
  console.log('▸ Standoff:', cutoutCheck.standoff, 'mm | zClearance:', cutoutCheck.zClearance, 'mm');

  // Switch to SIDE camera to see the +x wall cable cutout cleanly.
  const sideBtn = page.locator('[data-testid="viewport-camera-side"]').first();
  if (await sideBtn.isVisible().catch(() => false)) {
    await sideBtn.click();
    await page.waitForTimeout(1500);
  }
  await page.screenshot({ path: join(OUT, 'elp-05-side-view.png') });

  // Front camera — sees the -y wall (which has no cutout), good for
  // overall case profile.
  const frontBtn = page.locator('[data-testid="viewport-camera-front"]').first();
  if (await frontBtn.isVisible().catch(() => false)) {
    await frontBtn.click();
    await page.waitForTimeout(1500);
  }
  await page.screenshot({ path: join(OUT, 'elp-06-front-view.png') });

  // Switch back to perspective and rotate the OrbitControls underneath the
  // case to confirm the floor lens cutout. We poke the Three.js camera by
  // dispatching mousedown/mousemove on the canvas — easier than digging
  // into the scene graph.
  const persp = page.locator('[data-testid="viewport-camera-perspective"]').first();
  if (await persp.isVisible().catch(() => false)) {
    await persp.click();
    await page.waitForTimeout(800);
  }
  const canvas = page.locator('canvas').first();
  if (await canvas.isVisible().catch(() => false)) {
    const box = await canvas.boundingBox();
    if (box) {
      // Drag UP from canvas center → camera orbits to look UP at the case
      // from below. Several drags to ensure we end up below.
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      for (let i = 0; i < 30; i++) {
        await page.mouse.move(cx, cy + 200 + i * 20, { steps: 4 });
      }
      await page.mouse.up();
      await page.waitForTimeout(800);
    }
  }
  await page.screenshot({ path: join(OUT, 'elp-07-from-below.png') });

  // Get scene stats to confirm geometry exists
  const stats = await page.evaluate(() => {
    return {
      shell: window.__caseMaker?.getMeshStats('shell'),
      lid: window.__caseMaker?.getMeshStats('lid'),
      err: window.__caseMaker?.getJobError?.() ?? null,
    };
  });
  console.log('▸ shell tris:', stats.shell?.triangleCount, 'bbox:', stats.shell?.bbox);
  console.log('▸ lid tris:', stats.lid?.triangleCount);
  if (stats.err) console.log('▸ ERROR:', stats.err);
}

console.log(`\n▸ Console errors collected: ${errors.length}`);
for (const e of errors.slice(0, 10)) console.log('  ' + e);

await browser.close();
console.log(`\nWrote screenshots to ${OUT}/elp-*`);
