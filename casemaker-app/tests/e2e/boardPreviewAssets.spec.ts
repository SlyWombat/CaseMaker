import os from 'node:os';
import path from 'node:path';
import { test, expect } from './fixtures/caseMaker';

/**
 * #130 — the board picker's visual-asset path, end to end: a community board
 * imported with a photo shows that photo, its licence and its source in the
 * detail rail, and a board that carries an asset without a licence is refused
 * by the same schema gate CI runs.
 *
 * The photo is a 1×1 PNG data URL, so the test needs no network and no
 * vendored (licensed) asset.
 */

const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function boardJson(visualAssets: Record<string, string>, id = 'e2e-photo-board') {
  return JSON.stringify({
    id,
    name: 'E2E Photo Board',
    manufacturer: 'Playwright Labs',
    pcb: { size: { x: 42, y: 28, z: 1.6 } },
    mountingHoles: [{ id: 'h1', x: 3, y: 3, diameter: 2.5 }],
    components: [],
    defaultStandoffHeight: 3,
    recommendedZClearance: 12,
    // #128 — a community board's per-board version, shown in the rail.
    version: 3,
    visualAssets,
  });
}

async function importBoard(page: import('@playwright/test').Page, json: string) {
  await page.setInputFiles('[data-testid="welcome-import-input"]', {
    name: 'board.json',
    mimeType: 'application/json',
    buffer: Buffer.from(json),
  });
}

test('imported board with a photo shows it, with licence and source, in the rail', async ({
  cm,
  page,
}) => {
  await cm.ready();
  await expect(page.getByTestId('welcome-overlay')).toBeVisible();

  await importBoard(
    page,
    boardJson({
      topImage: TINY_PNG,
      license: 'CC0-1.0',
      sourceUrl: 'https://example.org/boards/e2e-photo-board',
    }),
  );

  const card = page.getByTestId('welcome-board-e2e-photo-board');
  await expect(card).toBeVisible();
  await card.click();

  const detail = page.getByTestId('welcome-detail');
  await expect(detail).toBeVisible();
  const preview = detail.getByTestId('board-preview-image');
  await expect(preview).toBeVisible();
  await expect(preview.locator('img')).toHaveAttribute('src', TINY_PNG);
  const credit = detail.getByTestId('board-preview-credit');
  await expect(credit).toContainText('CC0-1.0');
  await expect(credit).toContainText('https://example.org/boards/e2e-photo-board');

  // #128 — the community board's version shows in the rail's provenance.
  await expect(detail.getByTestId('welcome-board-version')).toContainText('Profile version 3');

  // Visual record for the session (written to the temp dir, not the repo).
  await detail.screenshot({ path: path.join(os.tmpdir(), 'slot5-board-photo-rail.png') });
});

test('a board carrying an asset without a licence is refused', async ({ cm, page }) => {
  await cm.ready();
  await expect(page.getByTestId('welcome-overlay')).toBeVisible();

  await importBoard(page, boardJson({ topImage: TINY_PNG }, 'e2e-unlicensed-board'));
  await expect(page.getByTestId('welcome-board-e2e-unlicensed-board')).toHaveCount(0);
});
