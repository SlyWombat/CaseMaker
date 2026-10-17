// Issue #489, in a real browser: the cutter profile is the cutter's data, so editing a box in the
// Yours-row editor must move the drawing.
//
// The dev server serves the WEB target, which has no house service. The spec answers the service
// here with `page.route` — the app's own client, schemas and store read the fakes exactly as they
// read the real thing (#418's shelf spec does the same), so the Yours row is reached through the
// real Manage surface rather than a test-only shortcut.

import { test, expect } from './fixtures/caseMaker';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';

const V_BIT: ToolLibraryEntry = {
  key: 'user:489vbit',
  provenance: 'typed here for the #489 visual check',
  tool: {
    number: null,
    id: null,
    name: '30° engraving bit',
    typeText: 'Engraving',
    shape: 'engraving',
    handleDiameter: 3.175,
    tipDiameter: 0.3,
    diameter: 3.175,
    cornerRadius: null,
    angle: 30,
    halfAngle: 15,
    fluteLength: 6,
    shoulderLength: 12,
    stickout: null,
    centreCutting: null,
  },
};

/** Everything `HouseHealthSchema` requires; nothing has been imported on this fake machine. */
const HEALTH = {
  ok: true,
  schemaVersion: 1,
  hasCatalogue: false,
  feedRows: 0,
  materialSpecRows: 0,
  catalogueSyncedAt: null,
  lastSync: null,
  problems: [],
  warnings: [],
};

test('#489 — the editor’s profile follows its fields', async ({ cm, page }) => {
  await page.route('**/api/v1/health**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(HEALTH) }),
  );
  await page.route('**/api/v1/tools**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { etag: '"tools-1"' },
      body: JSON.stringify([V_BIT]),
    }),
  );
  // No catalogue on this machine: the store treats a 404 as "no feeds here", which is normal.
  await page.route('**/api/v1/feeds**', (route) => route.fulfill({ status: 404, body: '' }));
  await page.route('**/api/v1/inventory**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );

  await cm.ready();
  await page.evaluate(() => window.__caseMaker!.openManage('tools'));

  // The row the fake service supplied, in the Yours tier; opening it draws the definition.
  await page.getByTestId('manage-tools-row-user:489vbit').click();
  const profile = page.getByTestId('manage-def-profile');
  await expect(profile).toBeVisible();

  // DC is the V-bit's body (3.175), D1 its tip (0.3): the drawn dimension text is the data.
  const dc = profile.locator('[data-dimension="DC"]');
  const d1 = profile.locator('[data-dimension="D1"]');
  await expect(dc).toContainText('DC 3.175');
  await expect(d1).toContainText('D1 0.3');

  // Type a tip diameter: the tip dimension line changes with the box, and the body does not.
  await page.getByTestId('manage-def-tip').fill('0.5');
  await expect(d1).toContainText('D1 0.5');
  await expect(dc).toContainText('DC 3.175');

  // Clear the shoulder: there is no stated length left, so the neck edge is drawn dashed.
  await page.getByTestId('manage-def-shoulder').fill('');
  await expect(page.getByTestId('manage-def-shoulder')).toHaveValue('');
  // Both neck edges and both zero-length steps carry the attribute; the first is enough to prove it.
  await expect(profile.locator('[data-missing-field="shoulderLength"]').first()).toHaveAttribute('data-dashed', 'true');

  // The visual half: the dimensioned drawing at this editor state. Baselines are platform-specific
  // (`-win32.png`) like the repo's other screenshot spec.
  await expect(profile).toHaveScreenshot('cutter-profile-editor.png');
});
