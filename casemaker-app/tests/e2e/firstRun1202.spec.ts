// #1202 + #1199 item 3, on the fake machine — THE FIRST-RUN GUARD AND THE SHOWN LINE LIST.
//
// The 2026-11-10 accident had never moved this controller, nothing said so, and the sequence was
// never shown. This walk pins the three facts the analyst asked for, on the REGISTER card's own
// routine (#1201 retired the seat press from this card — the seat is a bed-setup datum now):
//   1. a routine this machine has never completed is MARKED before the press and needs its own
//      at-machine statement — even though Cut step 1's statement is already given;
//   2. a recorded completion (the machine record's completedRoutines, seeded here) unmarks it; a
//      DIFFERENT shape re-marks it;
//   3. the lines the card SHOWS are the lines the fake console RECEIVES, in order.
//
// The house and console are the shared fixtures; the location is the bench's own with the bracket
// on anchor 1 and no recorded seat, so the planner proposes the registration (the surface find,
// X and Y taken from the bracket).
import fs from 'node:fs';
import path from 'node:path';
import { lanServerPort } from '../../scripts/e2ePort';
import { test, expect, openSomethingElse, stockNext } from './fixtures/caseMaker';
import { installFakeConsole, type FakeConsole } from './fixtures/fakeConsole';
import { houseHealth, locationDocument, serveHouse, type Json } from './fixtures/fakeHouse';
import type { Page } from '@playwright/test';

test.use({ baseURL: `http://127.0.0.1:${lanServerPort()}` });
test.setTimeout(420_000);

const OUT = path.resolve(process.cwd(), '..', 'docs', 'bench', 'img', '2026-11-11-1202-first-run');

/** The bench's location with the bracket on anchor 1 and NO recorded seat: the Register card's case. */
function benchLocationWithoutSeat(): Json {
  const doc = locationDocument();
  const machine = doc.machines[0]!;
  const profile = (machine as { bedProfiles?: Json[] }).bedProfiles?.[0];
  if (profile === undefined) throw new Error('the location fixture has no bed profile');
  const datums = profile['datums'] as Json;
  delete datums['bracketSeatZ'];
  profile['placements'] = ((profile['placements'] as Json[] | undefined) ?? []).filter(
    (pl) => ((pl['where'] as { kind?: string } | undefined)?.kind ?? '') !== 'pins',
  );
  (profile['placements'] as Json[]).push({
    id: 'pl-bracket',
    fixture: 'fx-bracket-thin',
    where: { kind: 'anchor', anchor: 1, pins: null },
    count: null,
    frame: null,
    provenance: {},
  });
  return {
    kind: doc.kind,
    schemaVersion: doc.schemaVersion,
    id: doc.id,
    name: doc.name,
    createdAt: doc.createdAt,
    machines: doc.machines,
    accessories: doc.accessories,
  };
}

const STATUS = '<Idle|MPos:0,0,0|WPos:0,0,0|S:0.0,10000.0,100.0,0,25.8,24.0,0,0,0,0>';

async function rememberMachine(page: Page): Promise<void> {
  await page.evaluate((line) => {
    window.__caseMaker!.setMachine(
      {
        name: 'QA Z1',
        host: '192.0.2.10',
        port: 2222,
        busy: false,
        ip: null,
        mac: null,
        status: line,
        profileId: 'Z1',
        observedAt: '2026-10-25T00:00:00.000Z',
        notes: [],
      },
      line,
    );
  }, STATUS);
}

/** The wizard walk up to the Cut card's registration proposal (no generate needed: the plan comes
 *  from the machine's own record and the job's stock). */
async function openRegistrationProposal(page: Page): Promise<void> {
  await rememberMachine(page);
  await page.getByTestId('welcome-start-cnc').click();
  await page.getByTestId('start-wizard-next').click();
  await openSomethingElse(page);
  await page.getByTestId('engrave-setup-what-pocket').click();
  await page.getByTestId('start-wizard-operation-next').click();
  await page.getByTestId('start-wizard-form-plate').click();
  await page.getByTestId('start-wizard-make-length').fill('100');
  await page.getByTestId('start-wizard-make-width').fill('60');
  await page.getByTestId('start-wizard-make-thickness').fill('25');
  await stockNext(page);
  await expect(page.getByTestId('engrave-setup-step-holding')).toBeVisible();
  await expect(page.getByTestId('engrave-setup-mount-bed-bracket')).toBeChecked();
  await page.getByTestId('engrave-setup-next').click();
  await page.getByTestId('engrave-shape-name-0').fill('Tray');
  await page.getByTestId('engrave-shape-width-0').fill('40');
  await page.getByTestId('engrave-shape-height-0').fill('30');
  await page.getByTestId('engrave-shape-x-0').fill('50');
  await page.getByTestId('engrave-shape-y-0').fill('30');
  await page.getByTestId('engrave-shape-depth-0').fill('2');
  await page.waitForTimeout(1500);
  await page.getByTestId('engrave-generate').click();
  await expect(page.getByTestId('engrave-run-oracle')).toHaveAttribute('data-state', 'tick', { timeout: 300_000 });
  await page.getByTestId('cnc-mode-cut').click();
  await expect(page.getByTestId('engrave-cut-surface')).toBeVisible();
  const step1 = page.getByTestId('engrave-cut-step-1');
  if (!(await step1.evaluate((el) => (el as HTMLDetailsElement).open))) {
    await page.getByTestId('engrave-cut-step-1-summary').click();
  }
  await page.getByTestId('engrave-ack').check();
  const step2 = page.getByTestId('engrave-cut-step-2');
  if (!(await step2.evaluate((el) => (el as HTMLDetailsElement).open))) {
    await page.getByTestId('engrave-cut-step-2-summary').click();
  }
  // #1201 supersedes the seat press on this card: the seat is a bed-setup datum now and the
  // press is REGISTER ("never a seat press"). The later issue's wording wins; the card's guard
  // work from #1202 is unchanged.
  await expect(page.getByTestId('engrave-registration-approve-start')).toHaveText('Register');
}

/** After a reload the job is restored: the Cut card is reached without the wizard door. */
async function openCutRegistration(page: Page): Promise<void> {
  if ((await page.getByTestId('engrave-panel').count()) === 0) {
    await page.getByTestId('sidebar-button-cnc-engrave').click();
  }
  await expect(page.getByTestId('engrave-panel')).toBeVisible();
  await page.getByTestId('cnc-mode-cut').click();
  await expect(page.getByTestId('engrave-cut-surface')).toBeVisible();
  const step2 = page.getByTestId('engrave-cut-step-2');
  if (!(await step2.evaluate((el) => (el as HTMLDetailsElement).open))) {
    await page.getByTestId('engrave-cut-step-2-summary').click();
  }
}

/**
 * The preview's SETTLED identity: read until two consecutive reads agree. The card derives its plan
 * after the machine record arrives, and re-derives the dry list when the plan object changes; the
 * press records the identity of the list the card showed.
 */
async function settledShape(page: Page): Promise<string> {
  const routine = page.getByTestId('engrave-registration-routine');
  let previous: string | null = null;
  for (let i = 0; i < 120; i += 1) {
    const now = await routine.getAttribute('data-shape');
    if (now !== null && now === previous) return now;
    previous = now;
    await page.waitForTimeout(500);
  }
  throw new Error('the card’s preview never settled');
}

/** The preview's shown lines, in order, from the DOM. */
async function shownLines(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="engrave-registration-dry-line-"]')].map((el) => {
      const code = el.querySelector('code');
      return (code?.textContent ?? '').trim();
    }),
  );
}

/**
 * Seed the machine record's completedRoutines THROUGH THE FIXTURE'S OWN WRITE PATH — a PUT through
 * the page, so the served document changes AND its ETag moves: a bare document edit leaves the
 * ETag still, and the location store then keeps the record it already held (#1123-12's rule).
 */
async function seedCompletions(page: Page, entries: unknown[]): Promise<void> {
  if ((await page.getByTestId('welcome-overlay').count()) === 0 && (await page.getByTestId('app-shell-probe').count()) === 0) {
    // nothing — the page is whatever it is; the PUT below needs only the origin
  }
  await page.evaluate(async (completions) => {
    const location = await (await fetch('/api/v1/location')).json();
    const machine = location.machines[0];
    machine.completedRoutines = completions;
    const res = await fetch(`/api/v1/location/machines/${machine.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(machine),
    });
    if (!res.ok) throw new Error(`the machine PUT failed: ${res.status}`);
  }, entries);
}

test('#1202 — a routine that has never run here is marked, shown, and its shown lines are the sent ones', async ({
  cm,
  page,
}) => {
  const house = await serveHouse(page, {
    location: benchLocationWithoutSeat(),
    health: houseHealth(),
    defaults: locationDocument().defaults,
    movingEtag: true,
    writes: 'applied',
  });
  // The seat press also writes the shop default (`bracket.seatMachineZ`) — the desktop app's own
  // service does that; the fake answers the write and leaves the GET to the shared house.
  await page.route('**/api/v1/defaults/**', async (route) => {
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  const fake: FakeConsole = await installFakeConsole(page, { steps: 20 });
  await cm.ready();
  await openRegistrationProposal(page);

  // 1. THE MARK, before the press: the routine has never completed here, so the card says so and
  //    holds the press even though Cut step 1's statement is already given.
  const routine = page.getByTestId('engrave-registration-routine');
  await expect(routine).toBeVisible({ timeout: 60_000 });
  const shape = await settledShape(page);
  expect(shape, 'the routine identity is named on the card').toMatch(/^[0-9a-f]{8}$/);
  await expect(page.getByTestId('engrave-registration-first-run')).toContainText(
    'has not run on this machine before',
  );
  const approve = page.getByTestId('engrave-registration-approve-start');
  await expect(approve).toBeDisabled();
  // 2. THE SHOWN LIST: the coverage sentence, and the sequence itself (the traverse at the
  //    clearance comes before the move to the point — #1199's order).
  const lines = await shownLines(page);
  expect(lines.length).toBeGreaterThan(3);
  expect(await page.getByTestId('engrave-registration-dry-note').textContent()).toContain('previews');
  const firstXY = lines.findIndex((l) => /^G53 G0 X/.test(l));
  expect(firstXY).toBeGreaterThan(0);
  expect(lines.slice(0, firstXY).some((l) => /^G53 G0 Z/.test(l))).toBe(true);

  // The tick is the press's own statement; only then does it enable.
  await page.getByTestId('engrave-registration-first-run-tick').check();
  await expect(approve).toBeEnabled();
  fs.mkdirSync(OUT, { recursive: true });
  await routine.screenshot({ path: path.join(OUT, 'first-run-marked.png') });

  // 3. THE PRESS: the fake plays a boss at the surface point so the touch reads, and the run
  // completes. The probe's own descent: the LAST Z and XY moves before the G38.3 (the first ones
  // are the clearance traverse, which runs at the machine's clearance position, not at the point).
  // The same boss the #1179 registrations run against: the house fixture's own blank top, wide
  // enough to sit under BOTH of the plan's touches at machine (-158.3, -176.3) and (-140, -163).
  fake.setFeature({ kind: 'boss', radiusMm: 400, centre: { x: -140, y: -163 }, topZ: -60.788 });
  await approve.click();
  await page.getByTestId('engrave-registration-continue').click({ timeout: 60_000 });
  // THE CARD'S OWN COMPLETION STATEMENT: the run read the surface (X and Y are the bracket's,
  // taken on trust — this plan makes no confirming lateral touch).
  await expect(page.getByTestId('engrave-registration-verdict')).toContainText('surface was found', {
    timeout: 180_000,
  });

  // SHOWN == SENT (in order): every shown line appears in the console's received list, in sequence.
  const sent = fake.lines();
  let at = 0;
  for (const line of lines) {
    const found = sent.indexOf(line, at);
    expect(found, `shown line "${line}" was sent`).toBeGreaterThanOrEqual(0);
    at = found + 1;
  }

  // 4. THE RECORD: the completion lands on the machine (the registration's own identity) — written
  //    once the run finished without a stop, so the served document carries it as soon as the save
  //    answers.
  await expect
    .poll(
      () =>
        ((house.machine()['completedRoutines'] ?? []) as { routine?: string; shape?: string }[]).some(
          (e) => e.routine === 'registration' && e.shape === shape,
        ),
      { timeout: 15_000 },
    )
    .toBe(true);

});

// THE RELOAD HALF. Once the registration routine is recorded, a fresh card for the SAME routine is
// unmarked and its press available; a changed sequence (the same id, a different shape) is a NEW
// routine and re-marks it. This walk was parked while the write-through dropped `completedRoutines`
// on every status tick — the merge fix it now covers (#1202, `mergeMachine` spreads the served
// record field for field).
test('the same card is unmarked once its routine is recorded, and a changed shape re-marks it (#1202)', async ({
  cm,
  page,
}) => {
  await serveHouse(page, {
    location: benchLocationWithoutSeat(),
    health: houseHealth(),
    defaults: locationDocument().defaults,
    movingEtag: true,
    writes: 'applied',
  });
  await installFakeConsole(page, { steps: 20 });
  await page.route('**/api/v1/defaults/**', async (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }),
  );
  await cm.ready();
  await openRegistrationProposal(page);

  // The registration routine's identity, as the card shows it, and its first-run mark.
  const routine = page.getByTestId('engrave-registration-routine');
  await expect(routine).toHaveAttribute('data-routine', 'registration', { timeout: 60_000 });
  const shape = await settledShape(page);
  expect(shape).toMatch(/^[0-9a-f]{8}$/);
  await expect(page.getByTestId('engrave-registration-first-run')).toContainText('has not run on this machine before');

  // RECORD THAT SHAPE — through the fixture's own write path, from a settled page — and reload:
  // the same routine is unmarked, and the press (with Cut step 1's statement given) is available.
  await page.goto('/');
  await cm.ready();
  await seedCompletions(page, [
    { routine: 'registration', shape, at: new Date().toISOString(), build: { version: '1.0.0', commit: null } },
  ]);
  await page.goto('/');
  await cm.ready();
  await openCutRegistration(page);
  await expect(page.getByTestId('engrave-registration-routine')).toHaveAttribute('data-shape', shape!, { timeout: 120_000 });
  await expect(page.getByTestId('engrave-registration-first-run')).toHaveCount(0);

  // A CHANGED SEQUENCE — the same routine id under a different shape — is a new routine: re-marked.
  await page.goto('/');
  await cm.ready();
  await seedCompletions(page, [
    { routine: 'registration', shape: 'deadbeef', at: new Date().toISOString(), build: { version: '1.0.0', commit: null } },
  ]);
  await page.goto('/');
  await cm.ready();
  await openCutRegistration(page);
  await expect(page.getByTestId('engrave-registration-first-run')).toContainText('has not run on this machine before', {
    timeout: 60_000,
  });
});
