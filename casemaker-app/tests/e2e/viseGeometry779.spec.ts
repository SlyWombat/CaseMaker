// #779 — the Z1 low-profile vise drawn as it really is and where it really sits.
//
// The eyeball half: two captures a person has to LOOK at, as the issue asks — the Machines card's
// bed scene at the vise's measured place on a bare bed, and the engrave preview's default view,
// where the stock sits IN the vise (a short blank leaves most of the base empty toward +X).
// Compared by eye with the manual's figures (`wiki.makera.com/z1-lpv_-1_(3).png`, 1.5–1.6, and
// `_ (6).png`, 2.4): the base spanning the bed with its rails along X, the fixed jaw at the far
// left, the moving jaw and carrier on the rails, the clamping screw along X.
//
// The numbers themselves are pinned in `tests/unit/drawnVise.spec.ts`, `bedScene.spec.ts`,
// `bedPlate.spec.ts` and `cncFixture.spec.ts`. The captures land in Playwright's gitignored output
// dir (`test-results/`).
//
// Run (WSL, this checkout):
//   CASEMAKER_PORT=5401 npx playwright test tests/e2e/viseGeometry779.spec.ts

import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures/caseMaker';
import { locationDocument, locationView, serveHouse } from './fixtures/fakeHouse';

test.use({ viewport: { width: 1440, height: 900 } });
test.setTimeout(240_000);

const NOW = '2026-10-24T15:23:00.000Z';

/**
 * The house as the bench left it after the 2026-10-24 registration: the vise on a BARE bed
 * (Makera's install removes the wasteboard), its fixed jaw face measured at machine X −181.2 and
 * the bar's start at Y −203.5, the jaw top measured at −56.82 — the numbers in
 * `docs/bench/2026-10-24-datum-path-bench.md` and the committed location fixture, with the
 * surface changed from the migrated wasteboard to the bare bed the vise actually needs.
 */
async function fakeHouse(page: Page): Promise<void> {
  const raw = locationDocument();
  const machine = raw.machines[0]!;
  machine.bedProfiles = [
    {
      id: 'bp-vise-measured',
      name: 'Vise on the pins, bare bed',
      createdAt: NOW,
      basedOn: null,
      surface: {
        kind: 'bare-bed',
        material: null,
        length: null,
        width: null,
        thickness: null,
        position: null,
        provenance: {},
        scars: [],
        lastResurfacedAt: null,
      },
      datums: {
        surfaceTopZ: null,
        viseJawTopZ: { value: -56.82, measuredAt: '2026-10-23T00:00:00.000Z', by: 'wired-probe', at: null },
        bracketSeatZ: null,
        rotaryAxis: null,
      },
      placements: [
        {
          id: 'pl-vise',
          fixture: 'fx-vise-1',
          where: { kind: 'pins', pins: 'vise', anchor: null },
          count: null,
          frame: { fixedJawFaceX: -181.2, jawStartY: -203.5 },
          provenance: { fixedJawFaceX: 'measured:2026-10-23T00:00:00.000Z', jawStartY: 'typed' },
        },
      ],
      preferredMounting: [],
      consumables: null,
      history: [{ at: NOW, what: 'the vise was placed by the registration' }],
    },
  ];
  machine.activeBedProfileId = 'bp-vise-measured';
  raw.accessories = raw.accessories.filter((a) => a.id === 'fx-vise-1' || a.id === 'fx-probe-1');

  await serveHouse(page, {
    location: locationView(raw, { defaults: true }),
    fromSharedDocument: true,
  });
}

const shot = (testInfo: TestInfo, name: string): string => testInfo.outputPath(name);

test('#779 the bed scene draws the vise at its measured place on the bare bed', async ({ cm, page }, testInfo) => {
  await fakeHouse(page);
  await cm.ready();
  // Manage › Machines — the Bed block carries `BedScene`, the machine-frame picture.
  await page.evaluate(() => window.__caseMaker!.openManage('machines'));
  await expect(page.getByTestId('manage-bed')).toBeVisible({ timeout: 30_000 });
  // The measured placement is what the card states…
  await expect(page.getByTestId('manage-bed-summary')).toContainText('Vise on the pins', { timeout: 30_000 });
  // …and the canvas needs its first frame (the scene is a self-contained <Canvas>).
  await page.waitForTimeout(2500);
  await page.screenshot({ path: shot(testInfo, '779-bed-scene.png'), fullPage: true });
});

test('#779 the engrave preview draws the stock sitting IN the vise', async ({ cm, page }, testInfo) => {
  await fakeHouse(page);
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
  });
  const btn = page.getByTestId('sidebar-button-cnc-engrave');
  if ((await btn.getAttribute('aria-pressed')) !== 'true') await btn.click();
  await expect(page.getByTestId('engrave-preview-legend')).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: shot(testInfo, '779-engrave-preview.png'), fullPage: true });
});
