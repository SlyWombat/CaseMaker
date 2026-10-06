// Board origin labelling (#128), in a real browser.
//
// The maintainer dropped the "verified" tier and asked the picker to state a
// board's ORIGIN instead — built-in versus added by you. The unit spec proves
// the three chips render; this proves they survive the real picker (29
// built-ins, a real import through the file input) and that no "verified"
// claim is left anywhere on the page a user actually sees.

import { test, expect } from './fixtures/caseMaker';

const SAMPLE_BOARD = {
  id: 'e2e-origin-board',
  name: 'E2E Origin Board',
  manufacturer: 'Playwright Labs',
  pcb: { size: { x: 42, y: 28, z: 1.6 } },
  mountingHoles: [{ id: 'h1', x: 3, y: 3, diameter: 2.5 }],
  components: [],
  defaultStandoffHeight: 3,
  recommendedZClearance: 12,
};

test('every card states its origin, and no "verified" claim survives', async ({ cm, page }) => {
  await cm.ready();
  await expect(page.getByTestId('welcome-overlay')).toBeVisible();

  // A bundled board says so, on the card and in the rail.
  const builtinChip = page.getByTestId('welcome-origin-rpi-4b');
  await expect(builtinChip).toHaveAttribute('data-origin', 'builtin');
  await expect(builtinChip).toHaveText('BUILT-IN');

  await page.getByTestId('welcome-board-rpi-4b').click();
  await expect(page.getByTestId('welcome-detail-origin')).toHaveAttribute('data-origin', 'builtin');
  await expect(page.getByTestId('welcome-detail-origin')).toContainText('built in');

  // A board the user adds is marked LOCAL, and it is the only origin the
  // grid grows — the chip is on the card, not inferred from a missing one.
  await page.getByTestId('welcome-import-input').setInputFiles({
    name: 'origin-board.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(SAMPLE_BOARD)),
  });
  const localChip = page.getByTestId('welcome-origin-e2e-origin-board');
  await expect(localChip).toHaveAttribute('data-origin', 'local');
  await expect(localChip).toHaveText('LOCAL');

  await page.getByTestId('welcome-board-e2e-origin-board').click();
  await expect(page.getByTestId('welcome-detail-origin')).toHaveAttribute('data-origin', 'local');
  await expect(page.getByTestId('welcome-detail-origin')).toContainText('your library');

  // The retired tier is gone from the rendered page, not just from the source.
  await expect(page.getByText('✓ printed')).toHaveCount(0);
  const bodyText = (await page.locator('body').innerText()).toLowerCase();
  expect(bodyText).not.toContain('physically verified');
  expect(bodyText).not.toContain('verified to fit');

  await page.screenshot({ path: test.info().outputPath('board-origin.png'), fullPage: true });
});
