// #1201, on the PRODUCTION bundle against the fake machine — A JOB MEASURES THE TOP ON THE BLANK.
//
// The bench's seat press (#1189) is what bent the probe (#1199). #1201 removes it from the
// Register card entirely: the seat is a BED-SETUP datum, and a job with a legacy (reference-less)
// seat measures the top ON THE BLANK at two guarded points inside the stock footprint. This walk
// is the card's half of the gate: the proposal says the top is measured on the blank, states the
// points before the press, says the old seat is not used, and offers NO control that touches off
// the stock. (The wire walk — Register, two touching descents inside the footprint, no seat point —
// lands with the executor's guarded-seek change on D's #1199 follow-up.)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { lanServerPort } from '../../scripts/e2ePort';
import { test, expect, openSomethingElse } from './fixtures/caseMaker';
import { locationDocument, serveHouse } from './fixtures/fakeHouse';
import { installFakeConsole } from './fixtures/fakeConsole';
import { motionOrderGuard } from '@/engine/cnc/registration/motionOrder';

test.use({ baseURL: `http://127.0.0.1:${lanServerPort()}` });
test.setTimeout(240_000);

const SEAT = -85.788;

/** The bench's location: a LEGACY bracket seat at its own verified point (no probeRefZ yet), the
 *  bracket placed at anchor 1, and a write answer that applies — so the tap's datum write lands
 *  and the card re-plans from it. */
function benchLocation(): unknown {
  const doc = locationDocument();
  const machine = doc.machines[0] as {
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

const DOC = JSON.parse(
  readFileSync(fileURLToPath(new URL('../unit/fixtures/location-doc.json', import.meta.url)), 'utf8'),
) as { defaults?: Record<string, unknown> };

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

async function typePlate(page: Page, dims: [number, number, number]): Promise<void> {
  await page.getByTestId('welcome-start-cnc').click();
  await page.getByTestId('start-wizard-next').click();
  await openSomethingElse(page);
  await page.getByTestId('engrave-setup-what-pocket').click();
  await page.getByTestId('start-wizard-operation-next').click();
  await page.getByTestId('start-wizard-form-plate').click();
  await page.getByTestId('start-wizard-make-length').fill(String(dims[0]));
  await page.getByTestId('start-wizard-make-width').fill(String(dims[1]));
  await page.getByTestId('start-wizard-make-thickness').fill(String(dims[2]));
  await page.getByTestId('start-wizard-stock-next').click();
  await expect(page.getByTestId('engrave-setup-step-holding')).toBeVisible();
}

test('#1201 — a bracket job with a legacy seat: the top is measured on the blank, and no seat press', async ({ cm, page }) => {
  await serveHouse(page, {
    location: benchLocation(),
    defaults: DOC.defaults,
    writes: 'applied',
    movingEtag: true,
  });
  await installFakeConsole(page);
  await cm.ready();
  await rememberMachine(page);
  await typePlate(page, [100, 60, 25]);
  await expect(page.getByTestId('engrave-setup-mount-bed-bracket')).toBeChecked();
  await page.getByTestId('engrave-setup-next').click();
  await expect(page.getByTestId('start-wizard')).toHaveCount(0);

  await page.getByTestId('cnc-mode-cut').click();
  await expect(page.getByTestId('engrave-cut-surface')).toBeVisible();
  const step2 = page.getByTestId('engrave-cut-step-2');
  if (!(await step2.evaluate((el) => (el as HTMLDetailsElement).open))) {
    await page.getByTestId('engrave-cut-step-2-summary').click();
  }

  // THE PROPOSAL: the top on the blank, both machine XY points stated BEFORE the press.
  const line = page.getByTestId('engrave-registration-proposal-line');
  await expect(line).toContainText('the top on the blank', { timeout: 60_000 });
  await expect(line).toContainText('machine X ');
  // The legacy seat is on file and is NOT used — in the issue's own sentence.
  await expect(page.getByTestId('engrave-registration-top-on-blank')).toContainText(
    'last measured before this probe was fitted and is not used',
  );
  // NO CONTROL THAT TOUCHES OFF THE STOCK: no seat press, no seat prompt, and the one press is Register.
  await expect(page.getByText(/Measure the bracket seat/)).toHaveCount(0);
  await expect(page.getByTestId('engrave-registration-seat-prompt')).toHaveCount(0);
  await expect(page.getByTestId('engrave-registration-approve-start')).toContainText('Register');
  // The stored seat's own point is never named on the card.
  await expect(page.getByTestId('engrave-registration')).not.toContainText('-175');
});

test('#1201 — Register runs the two top touches, writes the origin, and every line passes the guard', async ({ cm, page }) => {
  await serveHouse(page, {
    location: benchLocation(),
    defaults: DOC.defaults,
    writes: 'applied',
    movingEtag: true,
  });
  const fake = await installFakeConsole(page);
  // The blank's top at the bench's seat + 25 mm; a wide boss so both check points meet it.
  fake.setFeature({ kind: 'boss', radiusMm: 400, centre: { x: -140, y: -163 }, topZ: -60.788 });
  await cm.ready();
  await rememberMachine(page);
  await typePlate(page, [100, 60, 25]);
  await expect(page.getByTestId('engrave-setup-mount-bed-bracket')).toBeChecked();
  await page.getByTestId('engrave-setup-next').click();
  await expect(page.getByTestId('start-wizard')).toHaveCount(0);

  // A pocket at the stock's centre, then Generate: the statement (and so Register) needs a program.
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
  await expect(page.getByTestId('engrave-registration-proposal-line')).toContainText('the top on the blank', {
    timeout: 60_000,
  });
  await page.getByTestId('engrave-registration-approve-start').click();
  await page.getByTestId('engrave-registration-continue').click();

  // The two guarded touches prove the top; the record says so on the blank.
  await expect(page.getByTestId('engrave-registration-notes')).toContainText('the top on the blank', {
    timeout: 120_000,
  });
  const touches = fake.lines().filter((l) => l.startsWith('G38.3'));
  expect(touches.length, 'the two check points were touched').toBeGreaterThanOrEqual(2);

  // Write the origin, as the card's next press does.
  const step2b = page.getByTestId('engrave-cut-step-2');
  if (!(await step2b.evaluate((el) => (el as HTMLDetailsElement).open))) {
    await page.getByTestId('engrave-cut-step-2-summary').click();
  }
  await page.getByTestId('engrave-registration-write').click();
  await page.getByTestId('engrave-registration-continue').click();
  await expect.poll(() => fake.lines().find((l) => l.startsWith('G10 L2 P1')) ?? null, { timeout: 60_000 }).not.toBeNull();
  expect(fake.lines().find((l) => l.startsWith('G10 L2 P1'))).toContain('Z-60.788');

  // #1199/#1201 — EVERY LINE THE RUN SENT PASSES THE SAFE-Z GUARD, and the stored seat's point is
  // never visited by a job.
  const guard = motionOrderGuard(-3);
  for (const line of fake.lines()) {
    expect(guard.observe(line), `the sent line ${line}`).toBeNull();
  }
  expect(fake.lines().some((l) => l.includes('X-175') && l.includes('Y-35'))).toBe(false);
});
