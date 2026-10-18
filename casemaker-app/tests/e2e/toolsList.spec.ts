// Issue #500, in a real browser: the owned row's second line is bounded and ellipsized, and no row
// text paints into the Shape/Tip/Shank columns — at every viewport the app supports.
//
// The dev server has no house service, so this spec answers it with `page.route` exactly as the
// #489 cutter-profile spec does. The row's content is the committed shape of a real label item:
// a long Makera name, two codes, and the import note that used to be printed verbatim.
//
// WHY GEOMETRY, NOT JUST TEXT. The e2e suite already reads testids and text; the defect this issue
// filed was invisible to those — the cells' boxes did not overlap, the glyphs did. So the assertion
// is the rendered box: the second line's right edge must end inside its own cell (and before the
// next cell), its computed overflow must clip, and the text must actually be ellipsized. That is
// the layout half of the issue, checked at all three walkthrough viewports plus the suite's own
// 1024-wide desktop.

import { test, expect } from './fixtures/caseMaker';

const NOTE =
  'Case: yellow. Makera C1-BIT-BALL-NOSE-1-4. Label CN: 球头刀 (ball-nose cutter). ' +
  'Metal line (-M-). Two physical variants under one code (#381): 2× yellow with collar. ' +
  'Back in its box (swapped out of the spindle 2026-10-12).';

const LONG_NAME = 'Two Flute Ball Nose Bit for Metal - 1/8" Shank 3.175mm * 10mm';

const ITEM = {
  id: 'long-note',
  tool: {
    number: null,
    id: null,
    name: LONG_NAME,
    typeText: 'Ball End',
    shape: 'ball',
    handleDiameter: 3.175,
    tipDiameter: 1,
    diameter: 3.175,
    cornerRadius: 0.5,
    angle: null,
    halfAngle: null,
    fluteLength: 10,
    shoulderLength: null,
    stickout: null,
    centreCutting: null,
  },
  origin: null,
  quantity: 1,
  codes: [
    { symbology: 'qr', value: 'C1-BIT-BALL-NOSE-M-3.175-10' },
    { symbology: 'cn', value: 'C1-BIT-BALL-NOSE-M-3.175-10-CN' },
  ],
  addedAt: '2026-10-12T00:00:00.000Z',
  notes: NOTE,
  copies: [
    {
      id: 'c-1',
      condition: 'new',
      whereabouts: { kind: 'box', case: { colour: 'yellow', label: 'yellow base, clear tube' } },
      runtimeWarnMinutes: null,
      notes: null,
      runtimeMinutes: null,
    },
  ],
  colletFits: null,
};

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

/** The four viewports #500 names: the walkthrough's desktop, the suite's desktop, tablet, phone. */
const VIEWPORTS = [
  { name: 'desktop 1500×850', width: 1500, height: 850 },
  { name: 'desktop 1024×768', width: 1024, height: 768 },
  { name: 'tablet 768×1024', width: 768, height: 1024 },
  { name: 'phone 390×844', width: 390, height: 844 },
];

test('#500 — the owned row stays inside its Name cell at every viewport', async ({ cm, page }) => {
  await page.route('**/api/v1/health**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(HEALTH) }),
  );
  await page.route('**/api/v1/tools**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  await page.route('**/api/v1/feeds**', (route) => route.fulfill({ status: 404, body: '' }));
  await page.route('**/api/v1/inventory**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([ITEM]) }),
  );

  await cm.ready();
  await page.evaluate(() => window.__caseMaker!.openManage('tools'));

  const row = page.getByTestId('manage-tools-row-inv:long-note');
  await expect(row).toBeVisible();

  // The row is the cutter: its code, never the import's note (and never an issue number).
  await expect(row).toContainText('C1-BIT-BALL-NOSE-M-3.175-10');
  await expect(row).not.toContainText('Case: yellow');
  await expect(row).not.toContainText('Label CN');
  await expect(row).not.toContainText('Metal line');
  await expect(row).not.toContainText('#381');
  await expect(row).not.toContainText('Back in its box');

  for (const vp of VIEWPORTS) {
    await test.step(vp.name, async () => {
      await page.setViewportSize({ width: vp.width, height: vp.height });

      const detail = row.locator('.nm small');
      await expect(detail).toHaveAttribute(
        'title',
        'QR C1-BIT-BALL-NOSE-M-3.175-10 · CN C1-BIT-BALL-NOSE-M-3.175-10-CN',
      );

      const box = await detail.evaluate((el) => {
        const small = el as HTMLElement;
        const cell = small.closest('td') as HTMLElement;
        const rowEl = small.closest('tr') as HTMLElement;
        const cells = Array.from(rowEl.children) as HTMLElement[];
        const next = cells[cells.indexOf(cell) + 1]!.getBoundingClientRect();
        const cellBox = cell.getBoundingClientRect();
        const smallBox = small.getBoundingClientRect();
        const cs = getComputedStyle(small);
        return {
          textOverflow: cs.textOverflow,
          overflowX: cs.overflowX,
          whiteSpace: cs.whiteSpace,
          smallRight: smallBox.right,
          smallWidth: smallBox.width,
          cellRight: cellBox.right,
          nextLeft: next.left,
          scrollWidth: small.scrollWidth,
          clientWidth: small.clientWidth,
        };
      });

      // It is a single bounded line that clips, not a nowrap run painted across the table.
      expect(box.textOverflow).toBe('ellipsis');
      expect(box.overflowX).toBe('hidden');
      expect(box.whiteSpace).toBe('nowrap');
      expect(box.smallWidth).toBeLessThanOrEqual(301);
      expect(box.smallRight).toBeLessThanOrEqual(box.cellRight + 0.5);
      // And the glyph box cannot reach the column after the Name cell.
      expect(box.smallRight).toBeLessThanOrEqual(box.nextLeft + 0.5);
      // The codes are long enough that this really is the ellipsis path, not a short line.
      expect(box.scrollWidth).toBeGreaterThan(box.clientWidth);
    });
  }
});

test('#500 — the notes live in the possession detail, not the list', async ({ cm, page }) => {
  await page.route('**/api/v1/health**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(HEALTH) }),
  );
  await page.route('**/api/v1/tools**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  await page.route('**/api/v1/feeds**', (route) => route.fulfill({ status: 404, body: '' }));
  await page.route('**/api/v1/inventory**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([ITEM]) }),
  );

  await cm.ready();
  await page.evaluate(() => window.__caseMaker!.openManage('tools'));

  await page.getByTestId('manage-tools-row-inv:long-note').click();
  // The operator's own sentence is here, in the record they edit — where it always belonged.
  await expect(page.getByTestId('manage-item-notes')).toHaveValue(NOTE);

  await page.setViewportSize({ width: 1500, height: 850 });
  await expect(page.getByTestId('manage-tools-table')).toHaveScreenshot('tools-list-codes.png');
});
