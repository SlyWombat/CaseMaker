// #931 — CUT STEP 1 TELLS THE TRUTH ABOUT THE SIMULATION.
//
// Before #931 step 1 said "Program checked · matches the design" from the frozen package alone —
// the program merely still describing the job — so a program never simulated read as passed, and a
// failed sweep read as "the check found nothing blocking". D's change derives the states from the
// same run fields Design's four ticks read. This spec drives each state the way the app reaches it
// and asserts the point of the issue: Design's row and Cut's sentence are the same words.
//
//   passed        — the wizard's default job, generated to four ticks, clearance acknowledged.
//   did not pass  — the #725 bracket walk: a tray under a clamp. Generate refuses in the verifier's
//                   sentence, its fix opens Holding, and Register stays folded.
//   stopped       — the #830 heavy job, its worker killed inside the sweep.
//   not simulated — a generated program whose run fields are cleared (the state a reload leaves):
//                   reached through the store module the dev server serves, the same seam D's
//                   `cutSurface.spec.tsx` seeds. A job BEFORE Generate has no program at all and
//                   reads `no-program` — no verdict block — so it cannot stand in for this state.
//
// The location is faked from the committed fixture (the measured vise or the bracket bed) exactly
// as bedDefects725.spec.ts fakes it; `/tools` answers [] for the reason #930's walk records.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { Page } from '@playwright/test';

import { test, expect, openCutterGroup } from './fixtures/caseMaker';

test.setTimeout(300_000);

type Json = Record<string, unknown>;
type Doc = {
  kind: string;
  schemaVersion: number;
  id: string;
  name: string;
  createdAt: string;
  migratedFrom?: string | null;
  machines: Array<Json & { bedProfiles?: Json[] }>;
  accessories: Json[];
  stock?: Json;
  inventory?: Json;
  defaults?: Json;
};

const DOC = JSON.parse(
  readFileSync(fileURLToPath(new URL('../unit/fixtures/location-doc.json', import.meta.url)), 'utf8'),
) as Doc;

const HEALTH = {
  ok: true,
  schemaVersion: 1,
  hasCatalogue: false,
  feedRows: 0,
  materialSpecRows: 0,
  catalogueSyncedAt: null,
  lastSync: null,
  problems: [],
};

const BOARDS_AND_TAPE = {
  tape: { widthMm: 20, thicknessMm: 0.2, provenance: 'typed' },
  boards: [{ material: 'MDF', size: [100, 100, 2], count: 4 }],
};

/**
 * The fixture's machine, with nothing on the pins, its bed measured, the bracket at anchor 1 when
 * `anchor` — the same view bedDefects725.spec.ts serves for the #725 walks.
 */
function locationView(opts: { anchor: boolean }): unknown {
  const doc = JSON.parse(JSON.stringify(DOC)) as Doc;
  const profile = doc.machines[0]!.bedProfiles![0]!;
  profile.placements = ((profile.placements as unknown[]) ?? []).filter(
    (pl) => ((pl as { where?: { kind?: string } }).where?.kind ?? '') !== 'pins',
  );
  if (opts.anchor) {
    (profile.placements as unknown[]).push({
      id: 'pl-bracket',
      fixture: 'fx-bracket-thin',
      where: { kind: 'anchor', anchor: 1, pins: null },
      count: null,
      frame: null,
      provenance: {},
    });
  }
  profile.surface = { ...(profile.surface as object), length: 300, width: 200, position: { frontLeft: [20, 30], frame: 'machine' } };
  profile.consumables = BOARDS_AND_TAPE;
  return {
    kind: doc.kind,
    schemaVersion: doc.schemaVersion,
    id: doc.id,
    name: doc.name,
    createdAt: doc.createdAt,
    migratedFrom: doc.migratedFrom ?? null,
    machines: doc.machines,
    accessories: doc.accessories,
  };
}

/** The fake house: health, the catalogue lists, the defaults and `view` as the location. */
async function fakeHouse(page: Page, view: unknown): Promise<void> {
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace(/^.*\/api\/v1/, '');
    const json = (body: unknown): Promise<void> =>
      route.fulfill({ status: 200, contentType: 'application/json', headers: { etag: '"e1"' }, body: JSON.stringify(body) });
    if (path === '/health') return json(HEALTH);
    if (path === '/tools') return json([]);
    if (path === '/inventory') return json(DOC.inventory ?? []);
    if (path === '/stock') return json(DOC.stock ?? []);
    if (path === '/defaults') return json(DOC.defaults ?? {});
    if (path === '/location' && req.method() === 'GET') return json(view);
    if (req.method() !== 'GET') return json({ ok: true });
    return route.fulfill({ status: 404, body: '' });
  });
}

const TICKS = ['engrave-run-toolpath', 'engrave-run-verified', 'engrave-run-simulated', 'engrave-run-oracle'];

/** A testid's text, one line. */
async function text(page: Page, testid: string): Promise<string> {
  return (await page.getByTestId(testid).innerText()).replace(/\s+/g, ' ').trim();
}

/** Is a `<details>` step unfolded? */
function unfolded(page: Page, testid: string): Promise<boolean> {
  return page.getByTestId(testid).evaluate((el) => (el as HTMLDetailsElement).open);
}

/** Door → wizard (engrave text) → the Engrave panel, on the house's stick. */
async function toDefaultJob(page: Page): Promise<void> {
  await page.getByTestId('welcome-start-cnc').click();
  await expect(page.getByTestId('start-wizard')).toBeVisible();
  await page.getByTestId('start-wizard-next').click();
  await page.getByTestId('engrave-setup-what-engrave').click();
  await page.getByTestId('start-wizard-op-text').fill('Zoomba');
  await page.getByTestId('start-wizard-operation-next').click();
  await page.getByTestId('start-wizard-stock-next').click();
  await page.getByTestId('engrave-setup-next').click();
  await expect(page.getByTestId('engrave-panel')).toBeVisible();
}

async function generateTicks(page: Page): Promise<void> {
  await expect(page.getByTestId('engrave-generate')).toBeEnabled();
  await page.getByTestId('engrave-generate').click();
  for (const id of TICKS) {
    await expect(page.getByTestId(id), id).toHaveAttribute('data-state', 'tick', { timeout: 180_000 });
  }
  await expect(page.getByTestId('engrave-generate')).toHaveText('Cut…');
}

/** Open Cut, tick the one clearance statement if it is offered, and wait for the frozen package. */
async function openCut(page: Page): Promise<void> {
  await page.getByTestId('cnc-mode-cut').click();
  await expect(page.getByTestId('engrave-cut-surface')).toBeVisible();
  const ack = page.getByTestId('engrave-ack');
  if ((await ack.count()) > 0) await ack.check();
}

test('#931 — a passed run: Cut says "matches the design", and Register unfolds', async ({ cm, page }) => {
  await fakeHouse(page, locationView({ anchor: false }));
  await cm.ready();
  await toDefaultJob(page);
  await generateTicks(page);
  await expect(page.getByTestId('engrave-run-oracle')).toContainText('matches the design');

  await openCut(page);
  await expect(page.getByTestId('engrave-package')).toHaveAttribute('data-state', 'current');
  // A passed run earns no verdict block; step 1's one line is the oracle's word, and Design agrees.
  await expect(page.getByTestId('engrave-cut-verdict')).toHaveCount(0);
  const summary = await text(page, 'engrave-cut-step-1-summary');
  expect(summary, 'Cut and Design agree: the oracle passed').toContain('matches the design');
  // Step 1 is done only here, so Register is the current step and its body is unfolded.
  expect(await unfolded(page, 'engrave-cut-step-2'), 'Register is current after a passed run').toBe(true);
});

test('#931 — a run that did not pass: the sentence, the fix that opens Holding, Register folded', async ({ cm, page }) => {
  await fakeHouse(page, locationView({ anchor: true }));
  await cm.ready();
  // #725's walk: a pocket plate on the bracket bed, with a 70 × 30 tray whose far edge runs under
  // the back clamps' noses — the verifier names the clamp and the run never posts a program.
  await page.getByTestId('welcome-start-cnc').click();
  await page.getByTestId('start-wizard-next').click();
  await page.getByTestId('engrave-setup-what-pocket').click();
  await page.getByTestId('start-wizard-operation-next').click();
  await page.getByTestId('start-wizard-form-plate').click();
  await page.getByTestId('start-wizard-make-length').fill('100');
  await page.getByTestId('start-wizard-make-width').fill('60');
  await page.getByTestId('start-wizard-make-thickness').fill('6');
  await page.getByTestId('start-wizard-stock-next').click();
  await expect(page.getByTestId('engrave-setup-mount-bed-bracket')).toBeChecked();
  await page.getByTestId('engrave-setup-next').click();
  await expect(page.getByTestId('engrave-panel')).toBeVisible();
  await page.getByTestId('engrave-shape-name-0').fill('Tray');
  await page.getByTestId('engrave-shape-width-0').fill('70');
  await page.getByTestId('engrave-shape-height-0').fill('30');
  await page.getByTestId('engrave-shape-x-0').fill('50');
  await page.getByTestId('engrave-shape-y-0').fill('40');
  await page.getByTestId('engrave-shape-depth-0').fill('2');
  await page.waitForTimeout(1500);

  await page.getByTestId('engrave-generate').click();
  const design = page.getByTestId('engrave-run-errors');
  await expect(design).toContainText('runs under the clamp', { timeout: 240_000 });
  const designText = await text(page, 'engrave-run-errors');

  await openCut(page);
  await expect(page.getByTestId('engrave-cut-verdict')).toHaveAttribute('data-state', 'failed');
  await expect(page.getByTestId('engrave-cut-verdict-line')).toHaveText('The simulation did not pass.');
  // THE POINT OF #931: Cut's sentence is Design's own run error, not a second wording of it.
  const sentence = await text(page, 'engrave-cut-verdict-sentence');
  expect(designText, 'Design prints the sentence Cut shows').toContain(sentence);
  // The hold is the fix, and the press opens the wizard at Holding.
  await expect(page.getByTestId('engrave-cut-verdict-fix')).toHaveText('Open the Holding step');
  expect(await unfolded(page, 'engrave-cut-step-2'), 'Register stays folded when step 1 did not pass').toBe(false);
  await page.getByTestId('engrave-cut-verdict-fix').click();
  await expect(page.getByTestId('start-wizard')).toBeVisible();
  await expect(page.getByTestId('start-wizard-progress')).toHaveText('Step 4 of 4 · Holding');
});

test('#931 — a program never simulated: Cut says so in Design’s words', async ({ cm, page }) => {
  await fakeHouse(page, locationView({ anchor: false }));
  await cm.ready();
  await toDefaultJob(page);
  // A real run first, then the run fields cleared as a reload would leave them: the program (and
  // its frozen package) exist, the simulation says nothing. This is the state #931 fixes — it used
  // to read "matches the design".
  await generateTicks(page);
  await page.evaluate(async () => {
    const moduleUrl = '/src/store/engraveRunStore.ts';
    const mod = (await import(/* @vite-ignore */ moduleUrl)) as {
      useEngraveRunStore: { setState: (s: Record<string, unknown>) => void };
    };
    mod.useEngraveRunStore.setState({
      simStatus: null,
      simStopped: false,
      simDiagnostics: [],
      simPrograms: [],
      oracle: null,
      oraclePrograms: [],
      phase: 'idle',
      staleSince: null,
    });
  });

  // Read Design BEFORE the mode switch — the Design panel unmounts on Cut. The seeded run has no
  // simulation, so the row says so (or draws nothing at all, which is the same claim).
  const designRow = (await page.getByTestId('engrave-run-simulated').count()) > 0 ? await text(page, 'engrave-run-simulated') : null;
  if (designRow !== null) {
    expect(designRow.toLowerCase(), 'Design and Cut agree: nothing simulated').toContain('not simulated');
  }
  await openCut(page);
  await expect(page.getByTestId('engrave-cut-verdict')).toHaveAttribute('data-state', 'not-simulated');
  await expect(page.getByTestId('engrave-cut-verdict-line')).toHaveText('The program has not been simulated.');
  await expect(page.getByTestId('engrave-cut-step-1-summary')).toContainText('not simulated');
  await expect(page.getByTestId('engrave-cut-step-1-summary')).not.toContainText('matches the design');
  expect(await unfolded(page, 'engrave-cut-step-2'), 'Register stays folded before a verdict').toBe(false);
});

test('#931 — a stopped sweep: Cut and Design both say it stopped before it finished', async ({ cm, page }) => {
  await cm.ready();
  // The #830 spec's heavy job: a 3× mesh on a 0.1 mm grid, so the sweep runs long enough to kill.
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await expect(page.getByTestId('engrave-panel')).toBeVisible();
  const labels = page.getByTestId(/^engrave-label-row-/);
  for (let i = 0; i < 3; i++) {
    await page.getByTestId('engrave-label-remove-0').click();
    await expect(labels).toHaveCount(2 - i);
  }
  await openCutterGroup(page);
  await page.getByTestId('engrave-tool').selectOption('flat-1.0');
  await page.getByTestId('engrave-add-summary').click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('engrave-add-surface').click();
  await (await chooser).setFiles(fileURLToPath(new URL('./fixtures/chamfered-block.stl', import.meta.url)));
  await expect(page.getByTestId('engrave-target-row-0')).toBeVisible();
  await page.getByTestId('engrave-target-scale-0').fill('300');
  await page.getByTestId('engrave-target-technical-0').click();
  await page.getByTestId('engrave-target-surface-gridPitchMm-0').fill('0.1');

  // Kill the worker inside the sweep: one settle tick after the stage text is painted (the gate
  // generateProgress830.spec.ts uses; a round trip can land in the oracle instead).
  const killed = page.evaluate(async () => {
    const moduleUrl = '/src/engine/jobs/simClient.ts';
    const client = (await import(/* @vite-ignore */ moduleUrl)) as { killSimWorkerForTest: (m: string) => void };
    await new Promise<void>((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error('the sweep stage was never reported'));
      }, 120_000);
      const fire = (): void => {
        const t = document.querySelector('[data-testid="engrave-generate-progress"]')?.textContent ?? '';
        if (done || !/simulating program \d+ of \d+/i.test(t)) return;
        done = true;
        observer.disconnect();
        clearTimeout(timer);
        setTimeout(() => {
          client.killSimWorkerForTest('the simulation worker was killed by the test');
          resolve();
        }, 750);
      };
      const observer = new MutationObserver(fire);
      observer.observe(document.body, { subtree: true, childList: true, characterData: true });
      fire();
    });
  });
  await page.getByTestId('engrave-generate').click();
  await expect(page.getByTestId('engrave-generate-progress')).toContainText(/simulating program \d+ of \d+/i, {
    timeout: 120_000,
  });
  await killed;
  await expect(page.getByTestId('engrave-run-simulated')).toContainText('the simulation stopped before it finished', {
    timeout: 30_000,
  });
  // Read Design before the switch: the Design panel unmounts on Cut.
  const designStopped = await text(page, 'engrave-run-simulated');

  await openCut(page);
  await expect(page.getByTestId('engrave-cut-verdict')).toHaveAttribute('data-state', 'stopped');
  await expect(page.getByTestId('engrave-cut-verdict-line')).toHaveText('The simulation stopped before it finished.');
  // The same fact, in both surfaces' words.
  expect((await text(page, 'engrave-cut-verdict-line')).toLowerCase()).toContain('stopped before it finished');
  expect(designStopped.toLowerCase()).toContain('stopped before it finished');
  await expect(page.getByTestId('engrave-cut-step-1-summary')).toContainText('the simulation stopped before it finished');
});
