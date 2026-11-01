// Issue #152 — magnet pockets and the swappable nameplate, end to end through
// the Features panel: add a captured magnet pocket row to the case floor, add a
// nameplate to the front face, see both compile, and export the plate as its
// own part, laid flat.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/caseMaker';
import { parseBinaryStl, downloadToBuffer } from './fixtures/parsers';

const SHOTS = path.resolve(process.cwd(), '..', 'docs', 'bench', 'img', '2026-10-31-magnets');

test('add a magnet pocket and a nameplate in the Features panel, then export the plate', async ({ cm, page }) => {
  test.setTimeout(120_000);
  fs.mkdirSync(SHOTS, { recursive: true });
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    await window.__caseMaker!.waitForIdle();
  });

  await page.getByTestId('sidebar-button-features').click();

  // --- A magnet pocket row, captured in the case floor ---------------------
  await page.getByTestId('add-magnet-pocket').click();
  const row = page.locator('[data-testid^="magnet-pocket-face-"]').first();
  await expect(row).toBeVisible();
  const id = (await row.getAttribute('data-testid'))!.replace('magnet-pocket-face-', '');
  await row.selectOption('-z');
  await page.getByTestId(`magnet-pocket-retention-${id}`).selectOption('captured');
  await page.getByTestId(`magnet-pocket-count-${id}`).fill('2');
  await page.getByTestId(`magnet-pocket-u-${id}`).fill('40');
  await page.getByTestId(`magnet-pocket-v-${id}`).fill('30');

  let project = await page.evaluate(() => window.__caseMaker!.getProject());
  expect(project.case.magnetPockets).toEqual([
    expect.objectContaining({ face: '-z', retention: 'captured', count: 2, u: 40, v: 30, size: '6x2' }),
  ]);
  // The panel states the pause height for the captured pockets.
  await expect(page.getByTestId('magnet-notes')).toContainText('pause the case body print at Z 3.00 mm');

  // --- The nameplate --------------------------------------------------------
  await page.getByTestId('add-nameplate').click();
  await page.getByTestId('nameplate-text').fill('CASE');
  await page.getByTestId('nameplate-v').fill('18');
  project = await page.evaluate(() => window.__caseMaker!.getProject());
  expect(project.case.nameplate).toEqual(
    expect.objectContaining({ enabled: true, face: '-y', text: 'CASE', magnetSize: '6x2', magnetCount: 2, v: 18 }),
  );

  // The rebuild is debounced: wait for the plate to arrive rather than for idle.
  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          await window.__caseMaker!.waitForIdle();
          return window.__caseMaker!.getSceneGraph().some((n) => n.id === 'nameplate-front');
        }),
      { timeout: 30_000 },
    )
    .toBe(true);
  const graph = await page.evaluate(() => window.__caseMaker!.getSceneGraph());
  const plate = graph.find((n) => n.id === 'nameplate-front');
  expect(plate, 'the nameplate is its own part').toBeDefined();
  expect(plate!.componentCount ?? 1).toBe(1);
  // Assembled, it stands on the front face (y ≤ 0), 4 mm thick.
  expect(plate!.bbox.max[1]).toBeCloseTo(0, 1);
  expect(plate!.bbox.min[1]).toBeCloseTo(-4, 1);
  await expect(page.getByTestId('magnet-notes')).not.toContainText('runs into');
  await page.screenshot({ path: path.join(SHOTS, '01-features-panel.png') });
  await page.getByTestId('magnet-notes').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(SHOTS, '01b-magnet-notes.png') });

  // --- Export ---------------------------------------------------------------
  await page.getByTestId('sidebar-button-export').click();
  await page.getByTestId('export-open').click();
  const exportRow = page.getByTestId('export-row-nameplate-front');
  await expect(exportRow).toBeVisible();
  await expect(exportRow).toContainText('Nameplate (front face)');
  await expect(exportRow).toContainText('BACK DOWN');
  await expect(page.getByTestId('export-hardware-list')).toContainText('Disc magnets 6 × 2 mm');
  await page.screenshot({ path: path.join(SHOTS, '02-export-modal.png') });

  await page.getByTestId('export-modal-format').selectOption('stl-binary');
  const [download] = await Promise.all([
    page.waitForEvent('download', { predicate: (d) => d.suggestedFilename().endsWith('.stl') }),
    page.getByTestId('export-save-nameplate-front').click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/nameplate-front.*\.stl$/);
  const raw = await downloadToBuffer(await download.createReadStream());
  const stl = parseBinaryStl(raw);
  expect(stl.triCount).toBeGreaterThan(100);
  // Print-ready: laid back down, so its height on the bed is the 4 mm thickness
  // and its footprint the 50 × 16 mm outline.
  const size = [0, 1, 2].map((k) => stl.bbox.max[k]! - stl.bbox.min[k]!);
  expect(size[2]).toBeCloseTo(4, 1);
  expect(Math.max(size[0]!, size[1]!)).toBeCloseTo(50, 0);
  expect(Math.min(size[0]!, size[1]!)).toBeCloseTo(16, 0);
});

// A pocket whose boss lands on a board standoff is stated by the shared clash
// check, with the overlap and an offer to move; taking it clears the statement.
test('a magnet boss on a standoff is stated, and the move offer clears it', async ({ cm, page }) => {
  test.setTimeout(120_000);
  fs.mkdirSync(SHOTS, { recursive: true });
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    await window.__caseMaker!.patchCase({
      magnetPockets: [{ id: 'm1', face: '-z', u: 7.5, v: 7.5, size: '6x2', enabled: true }],
    });
    await window.__caseMaker!.waitForIdle();
  });
  await page.getByTestId('sidebar-button-features').click();
  const said = page.getByTestId('magnet-clash').first();
  await expect(said).toContainText('runs into a board standoff');
  await expect(said).toContainText('they overlap');
  await expect(said).toHaveAttribute('data-method', 'solid');
  await page.getByTestId('magnet-notes').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(SHOTS, '03-magnet-clash.png') });
  await page.getByTestId('magnet-clash-offer').click();
  await page.evaluate(() => window.__caseMaker!.waitForIdle());
  await expect(page.getByTestId('magnet-clash')).toHaveCount(0);
  const m = await page.evaluate(() => window.__caseMaker!.getProject().case.magnetPockets![0]!);
  expect(m.u !== 7.5 || m.v !== 7.5).toBe(true);
});
