// #795 — CUT STEP 1'S TWO CHANGES, seen in the shipped bundle: the clearance statement is the
// step's FIRST line (above the gate's fold), and leaving Cut is a `‹ Design` link beside the
// Design/Cut switch instead of a full-width button at the foot of the gate's page.
//
// A REAL screenshot is committed under `docs/bench/img/2026-10-31-cut-step1/`.
//
// The job is the deterministic default one; Generate is the ordinary path's own button (the ack
// only exists once a program has been asked about), and the machine observation is put on the
// store the way a probe would write it — the Cut screen is gated on a connected machine.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/caseMaker';

test.setTimeout(240_000);

const OUT = path.join(path.resolve(process.cwd(), '..'), 'docs', 'bench', 'img', '2026-10-31-cut-step1');

/**
 * #788 — the app's location, as this spec needs it: the canonical fixture location with the
 * Makera 3D probe checked out to its machine (the fixture checks the wired V2 out by default).
 * The Cut statement draws the head diagram for that probe, and the screenshot is the 3D probe's
 * case — Makera's "unplug the wired probe… connect the 3D probe cable" line belongs to it.
 */
function locationWith3dProbe(): unknown {
  const doc = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'tests', 'unit', 'fixtures', 'location-doc.json'), 'utf8'),
  ) as { machines: { id: string }[]; accessories: { id: string; whereabouts: unknown }[] };
  const machineId = doc.machines[0]!.id;
  for (const a of doc.accessories) {
    if (a.id === 'fx-probe-3d') a.whereabouts = { kind: 'machine', machineId, since: '2026-10-23T00:00:00.000Z' };
    if (a.id === 'fx-probe-1') a.whereabouts = { kind: 'box' };
  }
  return doc;
}

/** The house the web build asks for: the lists it reads, and the location with the 3D probe. */
async function fakeHouse(page: Page): Promise<void> {
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^.*\/api\/v1/, '');
    const json = (body: unknown): Promise<void> =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { etag: '"e1"' },
        body: JSON.stringify(body),
      });
    const doc = locationWith3dProbe() as { inventory?: unknown; stock?: unknown; defaults?: unknown };
    if (path === '/health') {
      return json({
        ok: true,
        schemaVersion: 1,
        build: 'e2e',
        hasCatalogue: false,
        feedRows: 0,
        materialSpecRows: 0,
        catalogueSyncedAt: null,
        lastSync: null,
        problems: [],
        warnings: [],
      });
    }
    if (path === '/tools') return json([]);
    if (path === '/inventory') return json(doc.inventory ?? []);
    if (path === '/stock') return json(doc.stock ?? []);
    if (path === '/defaults') return json(doc.defaults ?? {});
    if (path === '/location') return json(locationWith3dProbe());
    return route.fulfill({ status: 404, body: '' });
  });
}

/** A status line with the monitor fields the state popover reads, for the machine observation. */
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

test('#795 — the statement leads step 1, and ‹ Design sits beside the switch', async ({ cm, page }) => {
  await fakeHouse(page);
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await rememberMachine(page);
  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await expect(page.getByTestId('engrave-panel')).toBeVisible();

  // Generate a real program: the clearance statement belongs to a job that has one.
  await page.getByTestId('engrave-generate').click();
  await expect(page.getByTestId('engrave-run-oracle')).toHaveAttribute('data-state', 'tick', { timeout: 180_000 });

  // On Design there is no way back to Design.
  await expect(page.getByTestId('engrave-back-to-design')).toHaveCount(0);

  await page.getByTestId('cnc-mode-cut').click();
  await expect(page.getByTestId('engrave-preflight')).toBeVisible();

  // The link lives INSIDE the switch row, and it is a text link, not the old full-width button.
  const inSwitch = await page.evaluate(() => {
    const row = document.querySelector('[data-testid="cnc-mode-switch"]');
    const link = document.querySelector('[data-testid="engrave-back-to-design"]');
    return row !== null && link !== null && row.contains(link);
  });
  expect(inSwitch, '‹ Design is beside the Design/Cut switch').toBe(true);
  await expect(page.getByTestId('engrave-back-to-design')).toHaveText('‹ Design');

  // The clearance statement leads the step: it is above the gate's fold in the document.
  await expect(page.getByTestId('engrave-cut-ack')).toBeVisible();
  // #788 — the statement asks for the probe to be fitted, so the head diagram stands with it:
  // the probe connector to use, and the 3-pin ionizer port marked as not that one. The screenshot
  // below is the drawing's visual evidence.
  const probeDiagram = page.getByTestId('engrave-cut-ack').getByTestId('probe-fit-diagram');
  await expect(probeDiagram).toBeVisible();
  await expect(probeDiagram).toContainText('Unplug the wired probe connector and connect the 3D probe cable.');
  await expect(probeDiagram).toContainText('3-pin ionizer port');
  await expect(probeDiagram).toContainText('not this one');
  await expect(probeDiagram).toContainText('probe connector');
  const ackLeads = await page.evaluate(() => {
    const ack = document.querySelector('[data-testid="engrave-cut-ack"]');
    const fold = document.querySelector('[data-testid="engrave-cut-details"]');
    if (ack === null || fold === null) return false;
    return Boolean(ack.compareDocumentPosition(fold) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(ackLeads, 'the statement is step 1’s first line, above the details fold').toBe(true);

  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, 'cut-step1.png') });

  // The link still leaves Cut and lands on the stack.
  await page.getByTestId('engrave-back-to-design').click();
  await expect(page.getByTestId('cnc-mode-design')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('engrave-stock-line')).toBeVisible();
});
