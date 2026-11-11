// #1201, on the PRODUCTION bundle against the fake machine — THE BRACKET SEAT IS BED SETUP.
//
// The bench's seat press (#1189) is what bent the probe (#1199): it ran in a JOB, beside a mounted
// blank, and its traverse crossed the blank. #1201 moves the seat out of the Register card and into
// Manage › the machine's Bed block, where the bed is CLEAR. This walk is that half's gate:
//
//   - the row states the BED-CLEAR fact as a TICK, and the point the touch will visit before it;
//   - the press does nothing until the tick, and the tick clears after every run;
//   - the one touch writes the ACTIVE bed profile's `bracketSeatZ` WITH the probe's own M491
//     reference (#1189), at the point that was shown;
//   - EVERY line the run sent replays through the shared safe-Z guard with no refusal. Bed setup
//     has no footprint rule (the stock's space belongs to a job), but the clearance/order rule is
//     the same one every probing session obeys.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { lanServerPort } from '../../scripts/e2ePort';
import { test, expect } from './fixtures/caseMaker';
import { locationDocument, serveHouse, type House } from './fixtures/fakeHouse';
import { installFakeConsole } from './fixtures/fakeConsole';
import { motionOrderGuard } from '@/engine/cnc/registration/motionOrder';

test.use({ baseURL: `http://127.0.0.1:${lanServerPort()}` });
test.setTimeout(240_000);

const SEAT = -85.788;
/** The e2e house's resolved machine travel height (tests/unit/fixtures/location-doc.json). */
const SEAT_CLEARANCE = -3;
/** The seat as the refitted probe finds it, at the datum's own verified point. */
const NEW_SEAT = -84.64;
/** The fake probe's own M491 reading: what the written datum must carry as its reference. */
const PROBE_REF = -80;

/** The bench's location: a LEGACY bracket seat at its own verified point (no probeRefZ yet), the
 *  bracket placed at anchor 1, and a write answer that applies — so the tap's datum write lands
 *  and the card re-reads the record it wrote. */
function benchLocation(): unknown {
  const doc = locationDocument();
  const machine = doc.machines[0] as {
    id: string;
    finishedPrograms?: string[];
    bedProfiles?: Array<{ placements?: Array<{ where?: { kind?: string } }>; datums: Record<string, unknown> }>;
  };
  machine.finishedPrograms = [];
  const profile = machine.bedProfiles![0]!;
  profile.datums['surfaceTopZ'] = null;
  profile.datums['bracketSeatZ'] = {
    value: SEAT,
    measuredAt: '2026-11-09T17:55:01.000Z',
    by: 'fx-probe-1',
    at: [-175, -35],
    restsOnStock: true,
  };
  profile.placements = (profile.placements ?? []).filter(
    (pl) => ((pl as { where?: { kind?: string } }).where?.kind ?? '') !== 'pins',
  );
  profile.placements.push({
    id: 'pl-bracket',
    fixture: 'fx-bracket-thin',
    where: { kind: 'anchor', anchor: 1, pins: null },
    count: null,
    frame: null,
    provenance: {},
  } as never);
  // The bracket itself, checked out to this machine: the Bed block offers the seat press only for
  // a bed profile that places one, and `accessoriesFor` reads the LOCATION's accessory record.
  const accessories = (doc.accessories as Array<Record<string, unknown>>).filter(
    (a) => a['id'] !== 'fx-bracket-thin',
  );
  accessories.push({
    id: 'fx-bracket-thin',
    kind: 'bracket',
    product: 'makera-z1-bracket-thin',
    variant: 'thin',
    constants: {},
    unit: {},
    provenance: {},
    whereabouts: { kind: 'machine', machineId: machine.id, since: '2026-11-09T17:55:01.000Z' },
    history: [],
  });
  return {
    kind: doc.kind,
    schemaVersion: doc.schemaVersion,
    id: doc.id,
    name: doc.name,
    createdAt: doc.createdAt,
    machines: doc.machines,
    accessories,
  };
}

const DOC = JSON.parse(
  readFileSync(fileURLToPath(new URL('../unit/fixtures/location-doc.json', import.meta.url)), 'utf8'),
) as { defaults?: Record<string, unknown> };

/** The datum as the house now holds it (the write the walk is about). */
function storedSeat(house: House): { value?: number; probeRefZ?: number; at?: number[] } | null {
  const profiles = house.machine().bedProfiles as
    | Array<{ datums: { bracketSeatZ?: { value?: number; probeRefZ?: number; at?: number[] } | null } }>
    | undefined;
  return profiles?.[0]?.datums.bracketSeatZ ?? null;
}

test('#1201 — the bed-clear tick, the shown point, the press, and the seat written with its probe reference', async ({
  cm,
  page,
}) => {
  const house = await serveHouse(page, {
    location: benchLocation(),
    defaults: DOC.defaults,
    // The datum write AND the seat's shop-default move must both land: the run's full success path.
    writes: 'applied',
    movingEtag: true,
  });
  const fake = await installFakeConsole(page);
  // The wasteboard beside the bracket's front arm: the seat the refitted probe finds, at the
  // datum's own verified point — the point the row must show before the press.
  fake.setFeature({ kind: 'boss', radiusMm: 400, centre: { x: -175, y: -35 }, topZ: NEW_SEAT });
  await cm.ready();

  // Manage › Machines — the machine card's Bed block, with the bed clear.
  await page.evaluate(() => window.__caseMaker!.openManage('machines'));
  await expect(page.getByTestId('manage-bed')).toBeVisible({ timeout: 30_000 });
  const measure = page.getByTestId('manage-bed-measure');
  if (!(await measure.evaluate((el) => (el as HTMLDetailsElement).open))) {
    await measure.locator('summary').click();
  }

  // THE STATEMENT AND THE POINT, both before the press. The bed-clear fact is a TICK — the one
  // thing the app cannot read from the machine — and the press stays dead until it is ticked.
  const clear = page.getByTestId('manage-bed-tap-seat-clear');
  await expect(clear).toContainText('The bed is clear — no blank, no clamps in the way');
  await expect(clear).toContainText('machine X -175, Y -35');
  const tick = page.getByTestId('manage-bed-tap-seat-clear-tick');
  const press = page.getByTestId('manage-bed-tap-seat-button');
  await expect(tick).not.toBeChecked();
  await expect(press).toBeDisabled();
  await tick.check();
  await expect(press).toBeEnabled();
  await press.click();

  // The probe ask is drawn where the press was made; Continue runs the one touch.
  const prompt = page.getByTestId('manage-bed-tap-seat-prompt');
  await expect(prompt).toBeVisible({ timeout: 30_000 });
  await expect(prompt).toContainText('probe');
  await page.getByTestId('engrave-mount-tap-continue').click();

  // THE DATUM IS WRITTEN WITH THE PROBE'S OWN REFERENCE (#1189): the reading is the seat, and the
  // M491 the touch ran under rides beside it so a later refit can correct it.
  await expect
    .poll(() => storedSeat(house)?.probeRefZ ?? null, { timeout: 90_000 })
    .toBe(PROBE_REF);
  const seat = storedSeat(house);
  expect(seat?.value).toBe(NEW_SEAT);
  expect(seat?.at).toEqual([-175, -35]);
  await expect(page.getByTestId('manage-bed-tap-seat-note')).toContainText('the bracket seat is recorded');
  // The tick is spent: a second press must re-affirm the bed is clear.
  await expect(tick).not.toBeChecked();
  await expect(press).toBeDisabled();

  // #1199/#1201 — EVERY LINE THE RUN SENT PASSES THE SAFE-Z GUARD: the XY move to the seat is
  // taken AT the machine's clearance, never at the band's descent height.
  const guard = motionOrderGuard(SEAT_CLEARANCE);
  const wire = fake.lines();
  for (const line of wire) {
    expect(guard.observe(line), `the sent line ${line}`).toBeNull();
  }
  const trimmed = wire.map((l) => l.replace(/\s+/g, ' ').trim());
  const seatXY = trimmed.indexOf('G53 G0 X-175 Y-35');
  expect(seatXY, 'the touch went to the shown point').toBeGreaterThan(-1);
  expect(trimmed.slice(0, seatXY).filter((l) => /^G53 G0 Z/.test(l)).at(-1)).toBe(
    `G53 G0 Z${SEAT_CLEARANCE}`,
  );
});
