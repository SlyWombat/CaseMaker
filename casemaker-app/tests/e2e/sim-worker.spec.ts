// #193 — the first time this code runs in a real `Worker`. `session.ts` has only ever run
// in-process (in Node, via `simSession.spec.ts`); this drives `sim.worker.ts` through Comlink
// and the store, in a browser, so the thin shell is proven and not just the logic under it.
//
// One capsule: a G1 from X10 to X30 at Z-1 with a ⌀3.175 flat end mill, in a 40 x 20 x 5 slab.
// Closed form: capsuleArea(20, 1.5875, segmentsForRadius(1.5875)) * 1 = 71.385 mm³.
//
// `flatEndMill()` states no shoulder length, so the sweep also raises ONE warning
// (`holder-unproven`) — hence the assertion on error count, never on an empty diagnostics list.

import { test, expect } from './fixtures/caseMaker';

const REMOVED_CLOSED_FORM_MM3 = 71.385;

const PROGRAM = `G90 G21
T1 M6
S12000 M3
G0 X10 Y10 Z5
G1 Z-1 F200
G1 X30 F500
G0 Z5
M5
M02`;

test('sim worker: a real Worker loads, sweeps and reports through the store', async ({ cm, page }) => {
  await cm.ready();
  const r = await page.evaluate((gcode) => window.__caseMaker!.simSmoke(gcode), PROGRAM);
  expect(r.status).toBe('ready');
  expect(r.count).toBe(1);
  expect(r.errors).toBe(0);
  expect(Math.abs(r.removedVolume - REMOVED_CLOSED_FORM_MM3)).toBeLessThan(
    REMOVED_CLOSED_FORM_MM3 * 0.02,
  );
});
