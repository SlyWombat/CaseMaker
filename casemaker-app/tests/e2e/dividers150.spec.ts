// Issue #150 — the floor socket grid and its drop-in dividers, end to end
// through the Features panel: turn the grid on (the floor thickens, the panel
// says so), take the offered bay beside the board, add one divider each way,
// see both build as their own parts, and export the parts laid on their side.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/caseMaker';
import { parseBinaryStl, downloadToBuffer } from './fixtures/parsers';

const SHOTS = path.resolve(process.cwd(), '..', 'docs', 'bench', 'img', '2026-11-01-dividers');

test('add a floor grid and two dividers in the Features panel, then export the parts', async ({ cm, page }) => {
  test.setTimeout(150_000);
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    await window.__caseMaker!.waitForIdle();
  });

  await page.getByTestId('sidebar-button-features').click();
  const section = page.getByTestId('floor-grid-section');
  await section.scrollIntoViewIfNeeded();

  // --- The grid: the 2 mm floor is thickened, and that is stated ------------
  await page.getByTestId('floor-grid-enabled').check();
  await expect(page.getByTestId('floor-grid-thickened')).toContainText('Floor thickened from 2 mm to 3.2 mm');
  let project = await page.evaluate(() => window.__caseMaker!.getProject());
  expect(project.case.floorThickness).toBeCloseTo(3.2, 6);
  expect(project.case.floorGrid).toEqual({ enabled: true, pitch: 12, socket: 5, depth: 2 });

  // A stock Pi case is sized to the board: no socket fits, and the panel
  // offers the one side with no ports.
  await expect(section).toContainText('No socket fits');
  const widen = page.getByTestId('floor-grid-widen');
  await expect(widen).toContainText('Widen the back (+Y) side by');
  await page.screenshot({ path: path.join(SHOTS, '01-grid-no-room.png') });
  await widen.click();
  project = await page.evaluate(() => window.__caseMaker!.getProject());
  expect(project.case.clearanceTweaks?.yMax).toBeGreaterThan(0);
  await expect(page.getByTestId('floor-grid-facts')).toContainText('tenons 4.7 mm square, 0.3 mm clearance (Tight, the case fit)');
  await expect(page.getByTestId('floor-grid-widen')).toHaveCount(0);

  // --- Two dividers, one each way ------------------------------------------
  // Across the bay first, then along it: a new divider is placed on the
  // longest clean run, so the second one stops short of the first.
  await page.getByTestId('add-divider-y').click();
  await page.getByTestId('add-divider-x').click();
  project = await page.evaluate(() => window.__caseMaker!.getProject());
  expect(project.case.dividers).toHaveLength(2);
  expect(project.case.dividers!.map((d) => d.axis)).toEqual(['y', 'x']);
  // Both placed clean: nothing to state.
  await expect(page.locator('[data-testid^="divider-clash-"]')).toHaveCount(0);
  await expect(page.getByTestId('divider-facts-1')).toContainText('tall');

  // A divider pushed onto the board is stated, with an offer to move it.
  await page.getByTestId('divider-line-2').fill('1');
  await expect(page.getByTestId('divider-clash-2').first()).toContainText('Divider 2: it runs into the board');
  await page.getByTestId('divider-move-2').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(SHOTS, '02-divider-clash.png') });
  await page.getByTestId('divider-move-2').click();
  await expect(page.locator('[data-testid^="divider-clash-"]')).toHaveCount(0);

  const ids = (await page.evaluate(() => window.__caseMaker!.getProject())).case.dividers!.map(
    (d) => `case-divider-${d.axis}-${d.id}`,
  );
  await expect
    .poll(
      async () =>
        page.evaluate(async (want) => {
          await window.__caseMaker!.waitForIdle();
          const have = window.__caseMaker!.getSceneGraph().map((n) => n.id);
          return want.every((id) => have.includes(id));
        }, ids),
      { timeout: 60_000 },
    )
    .toBe(true);
  const graph = await page.evaluate(() => window.__caseMaker!.getSceneGraph());
  for (const id of ids) {
    const n = graph.find((g) => g.id === id)!;
    expect(n.componentCount ?? 1, `${id} is one part`).toBe(1);
  }
  // Looking down into the base with the lid off: the bay, its sockets and the
  // two dividers standing in them.
  await page.getByTestId('viewport-view-base-only').click();
  await page.getByTestId('viewport-camera-top').click();
  await page.getByTestId('viewport-fit').click();
  await section.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SHOTS, '03-two-dividers.png') });

  // --- Export: each divider is its own part, laid on its side ---------------
  await page.getByTestId('sidebar-button-export').click();
  await page.getByTestId('export-open').click();
  for (const [id, axis] of [
    [ids[0]!, 'Y'],
    [ids[1]!, 'X'],
  ] as const) {
    const row = page.getByTestId(`export-row-${id}`);
    await expect(row).toBeVisible();
    await expect(row).toContainText(`Divider (along ${axis})`);
    await expect(row).toContainText('SIDE');
  }
  await page.screenshot({ path: path.join(SHOTS, '04-export-modal.png') });

  await page.getByTestId('export-modal-format').selectOption('stl-binary');
  for (const id of ids) {
    const [download] = await Promise.all([
      page.waitForEvent('download', { predicate: (d) => d.suggestedFilename().endsWith('.stl') }),
      page.getByTestId(`export-save-${id}`).click(),
    ]);
    expect(download.suggestedFilename()).toContain(id);
    const stl = parseBinaryStl(await downloadToBuffer(await download.createReadStream()));
    expect(stl.triCount).toBeGreaterThan(20);
    // On its side the part is as tall as its 4.7 mm tenon, and lies on the bed.
    expect(stl.bbox.max[2]! - stl.bbox.min[2]!, `${id} lies flat`).toBeCloseTo(4.7, 1);
    expect(stl.bbox.min[2]!).toBeCloseTo(0, 2);
  }
});

// Placement order: in the two-row bay, adding the divider ALONG the bay first
// used to take the whole row and leave no clean line across it. Now the first
// one leaves room, so both seat whichever is added first.
test('in a two-row bay, a divider along X first still leaves room for one along Y', async ({ cm, page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    await window.__caseMaker!.waitForIdle();
  });
  await page.getByTestId('sidebar-button-features').click();
  await page.getByTestId('floor-grid-section').scrollIntoViewIfNeeded();
  await page.getByTestId('floor-grid-enabled').check();
  await page.getByTestId('floor-grid-widen').click();
  await page.getByTestId('add-divider-x').click();
  await page.getByTestId('add-divider-y').click();
  const project = await page.evaluate(() => window.__caseMaker!.getProject());
  expect(project.case.dividers!.map((d) => d.axis)).toEqual(['x', 'y']);
  await expect(page.locator('[data-testid^="divider-clash-"]')).toHaveCount(0);
  await expect(page.locator('[data-testid^="divider-make-room-"]')).toHaveCount(0);
});
