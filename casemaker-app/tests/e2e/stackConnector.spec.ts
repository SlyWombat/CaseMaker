// Stacking connector — the panel end to end: sockets on two walls, the
// statement for the one that lands on a port and its offer to move, a key in
// the export as a flat part, and the export itself.
//
// The geometry (profile, fit at every rung, detent, unchanged plans) is pinned
// by `tests/unit/stackConnector*.spec.ts` against the real Manifold evaluator;
// this is the wiring from control to compiler to export list.

import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { test, expect } from './fixtures/caseMaker';
import { parseBinaryStl, downloadToBuffer } from './fixtures/parsers';

const OUT = path.join(path.resolve(process.cwd(), '..'), 'docs', 'bench', 'img', '2026-11-01-connector');

test('sockets on two walls and a key, the clash offer, and the export', async ({ cm, page }) => {
  mkdirSync(OUT, { recursive: true });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
  });
  const before = await page.evaluate(() => window.__caseMaker!.getMeshStats('shell')!);

  await page.getByTestId('sidebar-button-features').click();
  const section = page.getByTestId('stack-connector-section');
  await section.scrollIntoViewIfNeeded();
  await expect(section).toBeVisible();

  // Back wall: clear. Left wall: the rpi-4b has a port there, so the socket is
  // cut as placed and the statement offers the move.
  await page.getByTestId('stack-socket-+y').check();
  await page.getByTestId('stack-socket--x').check();
  await page.evaluate(() => window.__caseMaker!.waitForIdle());

  const clash = page.getByTestId('stack-note-clash--x');
  await expect(clash).toBeVisible();
  await expect(clash).toContainText('runs into a port cutout');
  await expect(page.getByTestId('stack-note-clash-+y')).toHaveCount(0);
  await section.screenshot({ path: path.join(OUT, 'panel-clash-stated.png') });

  // Take the offer: the statement goes, the socket moves.
  await page.getByTestId('stack-move--x').click();
  await page.evaluate(() => window.__caseMaker!.waitForIdle());
  await expect(page.getByTestId('stack-note-clash--x')).toHaveCount(0);

  // #854 — the storage mode is a quiet fact in the section, never a statement:
  // a 28 mm case parks the key half-proud, and saying that as a note fired on
  // nearly every case.
  await expect(page.getByTestId('stack-key-storage')).toBeVisible();
  await expect(page.getByTestId('stack-key-storage')).toContainText('half-proud');
  await expect(page.locator('[data-testid^="stack-note-not-flush"]')).toHaveCount(0);

  // #854 item 2 — registration is its own option, apart from keys: a ridge on
  // the lid and a groove in the floor, and the case still compiles.
  await page.getByTestId('stack-register').check();
  await page.evaluate(() => window.__caseMaker!.waitForIdle());
  await expect(page.getByTestId('stack-register')).toBeChecked();
  await section.screenshot({ path: path.join(OUT, 'registration-on.png') });

  // #854 item 4 — the same shift on every wall, and a base plate on the
  // export list carrying the same sockets.
  await page.getByTestId('stack-match-shifts').check();
  await page.getByTestId('stack-base-plate').check();
  await page.evaluate(async () => {
    await window.__caseMaker!.waitForIdle();
  });
  await expect(page.getByTestId('stack-base-plate')).toBeChecked();

  // One key, long variant, loose fit.
  await page.getByTestId('stack-key-count').fill('1');
  await page.getByTestId('stack-key-variant').selectOption('long');
  await page.getByTestId('stack-key-fit').selectOption('loose');
  await page.evaluate(() => window.__caseMaker!.waitForIdle());
  await expect(page.getByTestId('stack-key-summary')).toContainText('40 mm long');
  await expect(page.getByTestId('stack-key-summary')).toContainText('loose relief');

  const connector = await page.evaluate(() => window.__caseMaker!.getProject().case.stackConnector);
  expect(connector?.sockets.map((s) => s.face).sort()).toEqual(['+y', '-x']);
  expect(connector?.sockets.find((s) => s.face === '-x')!.offset).not.toBe(0);
  expect(connector?.keys).toBe(1);
  expect(connector?.key).toBe('long');
  expect(connector?.fit).toBe('loose');

  await section.screenshot({ path: path.join(OUT, 'panel-two-sockets-one-key.png') });
  // The case as it prints: lid on, solid, from above (the dovetails read in
  // plan) and in perspective.
  await page.getByTestId('viewport-view-complete').click();
  const render = page.getByTestId('viewport-render-toggle');
  if ((await render.getAttribute('aria-pressed')) !== 'true') await render.click();
  const canvas = page.getByTestId('viewport-canvas');
  await page.getByTestId('viewport-camera-top').click();
  await page.getByTestId('viewport-fit').click();
  await page.waitForTimeout(600);
  await canvas.screenshot({ path: path.join(OUT, 'viewport-top.png') });
  await page.getByTestId('viewport-camera-perspective').click();
  await page.getByTestId('viewport-fit').click();
  await page.waitForTimeout(600);
  await canvas.screenshot({ path: path.join(OUT, 'viewport-perspective.png') });

  // The shell grew on exactly the two socketed walls (+Y and −X).
  const after = await page.evaluate(() => window.__caseMaker!.getMeshStats('shell')!);
  expect(after.bbox.max[1] - before.bbox.max[1]).toBeGreaterThan(4);
  expect(before.bbox.min[0] - after.bbox.min[0]).toBeGreaterThan(4);
  expect(after.bbox.min[1]).toBeCloseTo(before.bbox.min[1], 3);
  expect(after.bbox.max[0]).toBeCloseTo(before.bbox.max[0], 3);

  // The key is an export part that prints flat.
  await page.getByTestId('export-default').click();
  const row = page.getByTestId('export-row-stack-key-1');
  await expect(row).toBeVisible();
  await expect(row).toContainText('Stacking key 1');
  await expect(row).toContainText('lying flat');
  await row.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(OUT, 'export-key-part.png') });
  await page.getByTestId('export-modal-close').click();

  // And the export carries it: the binary STL has every triangle in the scene.
  const all = await page.evaluate(() => window.__caseMaker!.getMeshStats('all')!);
  const [download] = await Promise.all([
    page.waitForEvent('download', { predicate: (d) => d.suggestedFilename().endsWith('.stl') }),
    page.evaluate(() => window.__caseMaker!.triggerExport('stl-binary')),
  ]);
  const parsed = parseBinaryStl(await downloadToBuffer(await download.createReadStream()));
  expect(parsed.triCount).toBe(all.triangleCount);
});

// The protective case's brim and ribbing run along every wall, so no position
// clears them: the statement offers a pad cut-out through them instead of
// "no position", and taking it notches them and leaves the shell one body.
test('the protective case: a pad cut-out through the brim, offered and taken', async ({ cm, page }) => {
  test.setTimeout(150_000);
  mkdirSync(OUT, { recursive: true });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await cm.ready();
  await page.getByTestId('welcome-template-protective-case').click();
  await page.evaluate(() => window.__caseMaker!.waitForIdle());

  await page.getByTestId('sidebar-button-features').click();
  const section = page.getByTestId('stack-connector-section');
  await section.scrollIntoViewIfNeeded();
  await page.getByTestId('stack-socket--y').check();
  await page.evaluate(() => window.__caseMaker!.waitForIdle());

  const clash = page.getByTestId('stack-note-clash--y');
  await expect(clash).toContainText('Every position along this wall runs into the alignment brim');
  await expect(clash).toContainText('pad cut-out');
  await expect(clash).not.toContainText('No position');
  await section.screenshot({ path: path.join(OUT, 'panel-pad-cutout-offer.png') });

  await page.getByTestId('stack-pad-cutout--y').click();
  await page.evaluate(() => window.__caseMaker!.waitForIdle());
  await expect(page.getByTestId('stack-note-clash--y')).toHaveCount(0);
  await expect(page.getByTestId('stack-note-pad-cutout--y')).toContainText('has a pad cut-out');
  const sock = await page.evaluate(() => window.__caseMaker!.getProject().case.stackConnector!.sockets[0]!);
  expect(sock.cutThrough).toBe(true);
  await section.screenshot({ path: path.join(OUT, 'panel-pad-cutout-taken.png') });

  await expect
    .poll(async () =>
      page.evaluate(async () => {
        await window.__caseMaker!.waitForIdle();
        return window.__caseMaker!.getSceneGraph().find((n) => n.id === 'shell')?.componentCount ?? 0;
      }),
    { timeout: 60_000 })
    .toBe(1);
});
