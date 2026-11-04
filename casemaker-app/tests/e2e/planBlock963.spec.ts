// #963 end to end — THE PLAN THE ENGINE MADE, ON SCREEN. The CAM run is seeded through the window
// test API (`seedPlan`) so the spec states exactly what the rebuilt engine would: what it
// recognised, the costed sequence, the linking facts, what it could not cut, and the progress
// line while it works — on the Design panel, and the per-program list on the Cut card.
import { test, expect } from './fixtures/caseMaker';

/** A tray-class plan in the shape `cam/model/plan.ts` publishes (`SetupPlan`). */
function planOf(overrides: Record<string, unknown> = {}): Record<string, unknown> & { sequence: Record<string, unknown>[] } {
  const ring = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const pocket = (id: string) => ({
    id,
    floorZ: -6,
    mouthZ: 0,
    open: false,
    region: [ring],
    islands: [],
    children: [],
    remainder: [],
    narrowest: 3,
  });
  const cost = (totalSeconds: number) => ({
    terms: { movesSeconds: totalSeconds - 5, entrySeconds: 5, spinUpSeconds: 0, totalSeconds },
    toolChangeSeconds: 0,
    totalSeconds,
  });
  return {
    setupIndex: 0,
    features: {
      frame: { up: [0, 0, 1], stockTop: 0, partTop: 0, partBottom: -6 },
      levels: [-6],
      contour: { outline: [ring], zTo: -6, frees: true, shoulders: [] },
      pockets: Array.from({ length: 6 }, (_, i) => pocket(`p${i}`)),
      rims: [],
      remainder: [{ id: 'r1', footprint: [ring], zTop: 0, zBottom: -6, triangles: new Uint32Array(), slopeDeg: [0, 70], in: 'top' }],
      unreachable: [],
      report: { source: 'mesh', patches: 12, planarArea: 90, remainderArea: 10, tolerances: { planarityMm: 0.005, clusterAngleDeg: 0.5, deflectionMm: 0.01 }, notes: [] },
    },
    clGrid: [],
    ops: [
      { kind: 'pocket', outcome: { cutter: 'flat-6' } },
      { kind: 'contour', outcome: { cutter: 'flat-6' } },
      { kind: 'finish', outcome: { cutter: 'ball-6' } },
    ],
    sequence: [
      { cutterKey: 'flat-6', cost: cost(18 * 60), pinned: false, house: true },
      { cutterKey: 'flat-3.175', cost: cost(11 * 60), pinned: false, house: true },
      { cutterKey: 'ball-6', cost: cost(15 * 60), pinned: false, house: true },
      { cutterKey: 'v-90', cost: cost(3 * 60), pinned: false, house: true },
    ],
    linking: { rapidsCount: 384, hopsCount: 12, airFractionPct: 3.2 },
    programs: [],
    totalCostSeconds: 47 * 60 + 30,
    ...overrides,
  };
}

test.setTimeout(120_000);

test('#963 the Design panel states the plan: features, the costed sequence, linking, what it could not cut', async ({ cm, page }) => {
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await expect(page.getByTestId('engrave-panel')).toBeVisible();

  await page.evaluate(
    (plan) => window.__caseMaker!.seedPlan(plan),
    planOf({ unplanned: [{ kind: 'pocket', cutterKey: 'flat-6', regionIds: ['p2'], reason: 'planned nothing' }], freeing: null }),
  );

  const block = page.getByTestId('engrave-run-plan');
  await expect(block).toBeVisible();
  await expect(block).toContainText('Recognised: 6 pockets, 1 outer contour, 1 curved region.');
  await expect(block).toContainText(
    'Cutters: flat-6 (18 min) → flat-3.175 (11 min) → ball-6 (15 min) → v-90 (3 min) — about 47 min 30 s.',
  );
  await expect(block).toContainText('Linking: 384 rapids, 12 hops, 3.2 % of the cycle in air.');
  // #963 — what the plan could not cut, and the part not freed: never silent.
  await expect(block).toContainText('p2: not cut — planning failed (planned nothing)');
  await expect(block).toContainText('The part is not freed — no freeing cut is posted.');

  // The progress line speaks the plan's own stage while it works.
  await page.evaluate((plan) => {
    window.__caseMaker!.seedPlan(plan, { planProgress: { setupIndex: 0, op: 'finish', fraction: 0.8 } });
  }, planOf());
  await expect(page.getByTestId('engrave-generate-progress')).toContainText('Finishing — 80 %');

  // And the Cut card lists the programs the plan priced, one row each.
  await page.getByTestId('cnc-mode-cut').click();
  const list = page.getByTestId('engrave-cut-plan-programs');
  await expect(list).toBeVisible();
  await expect(page.getByTestId('engrave-cut-plan-program-0')).toContainText('flat-6 — pockets, the outline · 18 min');
  await expect(page.getByTestId('engrave-cut-plan-program-2')).toContainText('ball-6 — finishing · 15 min');
  await expect(page.getByTestId('engrave-cut-plan-total')).toContainText('About 47 min 30 s in total');
});

test('#963 a two-setup part lists both sides with their depth and cutters', async ({ cm, page }) => {
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await expect(page.getByTestId('engrave-panel')).toBeVisible();

  await page.evaluate((top) => {
    const bottom = { ...top, setupIndex: 1, sequence: [top.sequence[2]] };
    window.__caseMaker!.seedPlan(top, { plans: [top, bottom] });
  }, planOf());

  await expect(page.getByTestId('engrave-run-plan-setup-0')).toContainText('Setup 1 (top): 6 mm deep, cut by flat-6 (owned)');
  await expect(page.getByTestId('engrave-run-plan-setup-1')).toContainText('Setup 2 (top): 6 mm deep, cut by ball-6 (owned).');
});
