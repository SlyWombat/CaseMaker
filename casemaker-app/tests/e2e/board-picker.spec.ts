import { test, expect } from './fixtures/caseMaker';

/**
 * Welcome-screen board picker: search, select, detail rail, create actions,
 * and the local-library import/remove round trip.
 */

const SAMPLE_BOARD = {
  id: 'e2e-imported-board',
  name: 'E2E Imported Board',
  manufacturer: 'Playwright Labs',
  pcb: { size: { x: 42, y: 28, z: 1.6 } },
  mountingHoles: [{ id: 'h1', x: 3, y: 3, diameter: 2.5 }],
  components: [
    {
      id: 'usb',
      kind: 'usb-c',
      position: { x: 15, y: -1, z: 1.6 },
      size: { x: 9, y: 7.5, z: 3.2 },
      facing: '-y',
    },
  ],
  defaultStandoffHeight: 3,
  recommendedZClearance: 12,
};

test('picker: search narrows the grid, card selection fills the detail rail', async ({ cm, page }) => {
  await cm.ready();
  await expect(page.getByTestId('welcome-overlay')).toBeVisible();

  // Full catalog visible up front (29 builtins).
  const grid = page.locator('[data-testid^="welcome-board-"]');
  expect(await grid.count()).toBeGreaterThanOrEqual(29);

  await page.getByTestId('welcome-search').fill('sht31');
  await expect(grid).toHaveCount(1);

  await page.getByTestId('welcome-board-adafruit-sht31d').click();
  const detail = page.getByTestId('welcome-detail');
  await expect(detail).toBeVisible();
  await expect(detail).toContainText('Adafruit SHT31-D');
  await expect(detail).toContainText('25.4 × 17.78');
  // SHT31-D has a curated quickstart → both actions offered.
  await expect(page.getByTestId('welcome-generate')).toContainText('quickstart');
  await expect(page.getByTestId('welcome-generate-blank')).toBeVisible();
});

test('picker: create-from-quickstart applies the curated template', async ({ cm, page }) => {
  await cm.ready();
  await page.getByTestId('welcome-search').fill('sht31');
  await page.getByTestId('welcome-board-adafruit-sht31d').click();
  await page.getByTestId('welcome-generate').click();
  await expect(page.getByTestId('welcome-overlay')).toHaveCount(0);
  const name = await page.evaluate(() => window.__caseMaker!.getProject().name);
  expect(name).toBe('SHT31-D sensor pod');
});

test('picker: quickstart filter shows only boards with templates', async ({ cm, page }) => {
  await cm.ready();
  await page.getByTestId('welcome-filter-quickstart').click();
  const grid = page.locator('[data-testid^="welcome-board-"]');
  const count = await grid.count();
  expect(count).toBeGreaterThanOrEqual(5);
  expect(count).toBeLessThan(29);
});

test('picker: import → LOCAL badge → generate shell → remove round trip', async ({ cm, page }) => {
  await cm.ready();

  await page.getByTestId('welcome-import-input').setInputFiles({
    name: 'e2e-board.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(SAMPLE_BOARD)),
  });

  await expect(page.getByTestId('welcome-import-notice')).toContainText('Imported');
  const card = page.getByTestId('welcome-board-e2e-imported-board');
  await expect(card).toBeVisible();
  await expect(card).toContainText('LOCAL');

  // Imported board is auto-selected; no quickstart → single generate action.
  await page.getByTestId('welcome-generate').click();
  await expect(page.getByTestId('welcome-overlay')).toHaveCount(0);
  const name = await page.evaluate(() => window.__caseMaker!.getProject().name);
  expect(name).toContain('E2E Imported Board');

  // Reload → welcome shows again; the local board must survive via
  // localStorage, then round-trip out through remove.
  await cm.ready();
  await page.getByTestId('welcome-filter-local').click();
  await page.getByTestId('welcome-board-e2e-imported-board').click();
  await page.getByTestId('welcome-remove-board').click();
  await expect(page.getByTestId('welcome-board-e2e-imported-board')).toHaveCount(0);
});

test('picker: invalid JSON import surfaces an error, imports nothing', async ({ cm, page }) => {
  await cm.ready();
  await page.getByTestId('welcome-import-input').setInputFiles({
    name: 'broken.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"id": "nope"}'),
  });
  await expect(page.getByTestId('welcome-import-notice')).toContainText('Not a valid board profile');
  await expect(page.getByTestId('welcome-board-nope')).toHaveCount(0);
});

test('picker: sources panel lists builtin + local tiers', async ({ cm, page }) => {
  await cm.ready();
  await page.getByTestId('welcome-sources-toggle').click();
  const panel = page.getByTestId('welcome-sources-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('Built-in');
  await expect(panel).toContainText('My library');
  await expect(page.getByTestId('welcome-source-add')).toBeDisabled();
});
