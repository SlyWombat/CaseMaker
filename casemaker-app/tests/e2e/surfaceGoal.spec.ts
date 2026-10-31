// #535 end to end, in a real browser — a goal mesh is an OPERATION: import an STL through the
// picker, pick its cutter, Generate, and read back the facts the UI states on its own:
//
//   1. the goal row's report — the roughing layers the CAM ran and the grid its heightfield was
//      sampled on;
//   2. the run's check as ONE tick — the FLAT column sweep checked it, rather than the 2.5D
//      oracle's vacuous 0/0. The sentence behind that tick (the 0.1 mm dexel grid) is stated by
//      the Cut release screen, asserted below, and belongs to the simulation panel (#691) on the
//      Design side.
//
// The run is real: the worker, the surfacing CAM, the FLAT column sweep and the run store all
// run. The fixture is the 20 × 20 × 6 mm chamfered block in `fixtures/` (its provenance is the
// sibling README). The web build ships only the two built-in flat cutters, so the goal runs with
// a flat one — a valid Surface a mesh configuration; the finish is faceted and the row says so.
//
// The Simulate panel presents only sessions it started itself (#506), so the grid a Cut run was
// swept on is stated on Cut's release line, not in that panel.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect, openCutterGroup } from './fixtures/caseMaker';

const STL = fileURLToPath(new URL('./fixtures/chamfered-block.stl', import.meta.url));

/** A status line with the monitor fields the state popover reads, for the machine observation. */
const STATUS = '<Idle|MPos:0,0,0|WPos:0,0,0|S:0.0,10000.0,100.0,0,25.8,24.0,0,0,0,0>';

/** Put a machine on screen without one — the observation a probe would have written. */
async function rememberMachine(page: import('@playwright/test').Page): Promise<void> {
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

// The surfacing CAM and the column sweep run in the worker; under swiftshader the whole run
// takes tens of seconds, so these get well past Playwright's 30 s default.
test.setTimeout(240_000);

// #731 — the LAN rig's own origin, reproduced: plain http is NOT a secure context, so the browser
// hides `crypto.subtle` and every picked .stl/.3mf/PNG failed to hash ("unicorn.stl could not be
// hashed"). The e2e suite runs on localhost, a secure context, which is why it never saw it. The
// init script deletes the member before any app code runs; the pick then exercises the pure-TS
// SHA-256, and the row's hash is compared with Node's digest of the same fixture — the same hex the
// browser digest would have produced, or the job's stored hashes would not survive the origin.
test('#731 — on plain http (no crypto.subtle) an STL still loads, with the same SHA', async ({ cm, page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Crypto.prototype, 'subtle', { configurable: true, get: () => undefined });
  });
  await cm.ready();

  // The origin under test really has no digest: the fallback is what runs.
  expect(await page.evaluate(() => (crypto as Crypto).subtle)).toBeUndefined();

  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await expect(page.getByTestId('engrave-panel')).toBeVisible();

  // An empty job, so Surface a mesh is offered (the shipped job starts with three demo labels).
  const labels = page.getByTestId(/^engrave-label-row-/);
  await expect(labels).toHaveCount(3);
  for (let i = 0; i < 3; i++) {
    await page.getByTestId('engrave-label-remove-0').click();
    await expect(labels).toHaveCount(2 - i);
  }

  await page.getByTestId('engrave-add-summary').click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('engrave-add-surface').click();
  await (await chooser).setFiles(STL);

  // The pick succeeds — no "could not be hashed" — and the row states the file's SHA, which is
  // Node's digest of the same bytes.
  // #799 — the object is an item row of its own (no fold and no count line any more).
  await expect(page.getByTestId('engrave-target-row-0')).toBeVisible();
  await expect(page.getByTestId('engrave-target-error')).toHaveCount(0);
  const sha = createHash('sha256').update(readFileSync(STL)).digest('hex');
  await expect(page.getByTestId('engrave-target-row-0')).toContainText(`embedded in the job (${sha.slice(0, 12)}…)`);
});

test('a goal STL from the picker generates, and the UI states its own check and grid', async ({ cm, page }) => {
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await expect(page.getByTestId('engrave-panel')).toBeVisible();

  // Surface a mesh is offered on an EMPTY job; the shipped job starts with the three demo
  // labels, so remove them the way an operator would.
  const labels = page.getByTestId(/^engrave-label-row-/);
  await expect(labels).toHaveCount(3);
  for (let i = 0; i < 3; i++) {
    await page.getByTestId('engrave-label-remove-0').click();
    await expect(labels).toHaveCount(2 - i);
  }

  // The cutter: a built-in flat end mill (the web build has no catalogue).
  await openCutterGroup(page);
  await page.getByTestId('engrave-tool').selectOption('flat-1.0');

  // Import the goal through the operation picker — the one entry point (#662). The pick opens the
  // panel's file input, so the chooser is the assertion that the picker drives the import.
  await page.getByTestId('engrave-add-summary').click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('engrave-add-surface').click();
  await (await chooser).setFiles(STL);

  // The mesh is the job's one operation, and its row says what it is. #686 keeps the target
  // object's rows behind a closed one-line row, so the count is read first and the row opened.
  // #799 — the object is an item row of its own (no fold and no count line any more).
  await expect(page.getByTestId('engrave-target-row-0')).toBeVisible();
  await expect(page.getByTestId('engrave-target-type-0')).toHaveText('Surface a mesh');
  await expect(page.getByTestId('engrave-target-error')).toHaveCount(0);

  await page.getByTestId('engrave-generate').click();

  // The run's four rows tick; the oracle row is the goal program's own check.
  await expect(page.getByTestId('engrave-run-toolpath')).toHaveAttribute('data-state', 'tick', { timeout: 180_000 });
  await expect(page.getByTestId('engrave-run-simulated')).toHaveAttribute('data-state', 'tick', { timeout: 180_000 });
  await expect(page.getByTestId('engrave-run-oracle')).toHaveAttribute('data-state', 'tick', { timeout: 180_000 });

  // #688 — the Design footer states the check as ONE tick, not a paragraph. The long sentence
  // (which dexel grid checked the surface program) moved to the simulation's own panel (#691);
  // Cut's release line still states it, asserted further down.
  const oracleRow = page.getByTestId('engrave-run-oracle');
  await expect(oracleRow).toContainText('matches the design');
  await expect(oracleRow).not.toContainText('0.0000');

  // The goal row's own facts, after a Generate: the passes' layers and the sampled grid. The
  // import opens the row; the Technical fold is one more press.
  if ((await page.getByTestId('engrave-target-technical-0').count()) === 0) {
    await page.getByTestId('engrave-target-expand-0').click();
  }
  await expect(page.getByTestId('engrave-target-technical-0')).toBeVisible();
  await page.getByTestId('engrave-target-technical-0').locator('summary').click();
  const report = page.getByTestId('engrave-target-surface-report-0');
  await expect(report).toBeVisible();
  await expect(report).toContainText('roughing layer');
  await expect(report).toContainText('mm step-down');
  await expect(report).toContainText('mm step-over');
  await expect(report).toContainText('Sampled on a');
  await expect(report).toContainText('mm grid');

  // #535 — THE GOAL PROGRAM IS A RELEASE SOURCE. Cut freezes it, the one screen offers the press,
  // and its check line is the surface sweep rather than a 2.5D comparison. E2E has no controller,
  // so the machine is the observation a probe would have written — and the press is NOT pressed.
  await rememberMachine(page);
  await page.getByTestId('cnc-mode-cut').click();
  await expect(page.getByTestId('engrave-cut-surface')).toBeVisible();
  // #689 — the clearance tick is step 1's; the one screen sits in the Run line.
  const ack = page.getByTestId('engrave-ack');
  if ((await ack.count()) > 0) await ack.check();
  await page.getByTestId('engrave-cut-step-4-summary').click();
  await expect(page.getByTestId('engrave-cut-confirm')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('engrave-cut-confirm-oracle')).toContainText(
    'No 2.5D check for a surface program — checked on the',
  );
  const go = page.getByTestId('engrave-cut-go');
  await expect(go).toBeDisabled();
  await page.getByTestId('engrave-cut-statement').check();
  await expect(go).toBeEnabled();
});
