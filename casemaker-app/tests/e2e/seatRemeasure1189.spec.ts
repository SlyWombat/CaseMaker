// #1189 bench blocker, on the PRODUCTION bundle against the fake machine — THE SEAT RE-MEASURE
// PRESS, START TO FINISH: press → the tap's prompt drawn ON THE CARD → Continue → the reading,
// stated with the change from the datum on file → the card re-plans the registration by itself.
//
// The bench (2026-11-10, build 2e9c5989) pressed "Measure the bracket seat" and nothing happened:
// useMountTap waited on its fit-probe prompt and the Register card never rendered it. This walk is
// the gate the units missed.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { lanServerPort } from '../../scripts/e2ePort';
import { test, expect, openSomethingElse } from './fixtures/caseMaker';
import { locationDocument, serveHouse } from './fixtures/fakeHouse';
import { installFakeConsole } from './fixtures/fakeConsole';

test.use({ baseURL: `http://127.0.0.1:${lanServerPort()}` });
test.setTimeout(240_000);

const SEAT = -85.788;
const NEW_SEAT = -84.64; // the seat as the refitted probe finds it (the bench's hypothesis)

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

test('#1189 — the seat re-measure draws its prompt on the card, takes the reading, and re-plans', async ({ cm, page }) => {
  const house = await serveHouse(page, {
    location: benchLocation(),
    defaults: DOC.defaults,
    // The tap's datum write must land, and the ETag must move so the card reads the new record.
    writes: 'applied',
    movingEtag: true,
  });
  const fake = await installFakeConsole(page);
  // The wasteboard beside the bracket: the seat the refitted probe finds, at the datum's own point.
  fake.setFeature({ kind: 'boss', radiusMm: 400, centre: { x: -175, y: -35 }, topZ: NEW_SEAT });
  await cm.ready();
  await rememberMachine(page);
  await typePlate(page, [100, 60, 25]);
  // The wizard's holding step hands over to the CNC workspace.
  await expect(page.getByTestId('engrave-setup-mount-bed-bracket')).toBeChecked();
  await page.getByTestId('engrave-setup-next').click();
  await expect(page.getByTestId('start-wizard')).toHaveCount(0);

  await page.getByTestId('cnc-mode-cut').click();
  await expect(page.getByTestId('engrave-cut-surface')).toBeVisible();
  const step2 = page.getByTestId('engrave-cut-step-2');
  if (!(await step2.evaluate((el) => (el as HTMLDetailsElement).open))) {
    await page.getByTestId('engrave-cut-step-2-summary').click();
  }

  // The card offers the RE-MEASURE, at the datum's own point, before the press.
  await expect(page.getByTestId('engrave-registration-proposal-line')).toContainText('the bracket seat again', {
    timeout: 60_000,
  });
  await expect(page.getByTestId('engrave-registration-proposal-line')).toContainText('machine X -175, Y -35');

  // Step 1 is NOT ticked: the press asks for the probe, and the question is ON THE CARD.
  await page.getByTestId('engrave-registration-approve-start').click();
  const prompt = page.getByTestId('engrave-registration-seat-prompt');
  await expect(prompt).toBeVisible({ timeout: 30_000 });
  await expect(prompt).toContainText('probe');
  await page.getByTestId('engrave-mount-tap-continue').click();

  // The reading is stated with the change from the datum on file, and the datum the house now
  // holds carries the probe's reference.
  const reading = page.getByTestId('engrave-registration-seat-reading');
  await expect(reading).toContainText('was -85.788', { timeout: 90_000 });
  await expect(reading).toContainText(`${NEW_SEAT}`);
  await expect
    .poll(() => {
      const seat = (house.machine().bedProfiles ?? [])[0]?.datums as { bracketSeatZ?: { probeRefZ?: number } } | undefined;
      return seat?.bracketSeatZ?.probeRefZ ?? null;
    }, { timeout: 30_000 })
    .toBe(-80);

  // THE CARD RE-PLANS BY ITSELF: the seat press is gone and the registration plan is proposed.
  await expect(page.getByTestId('engrave-registration-proposal-line')).toContainText('then the top', {
    timeout: 60_000,
  });
});
