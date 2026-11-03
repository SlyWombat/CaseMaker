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

/**
 * The fixture's location as committed: its measured vise ON THE PINS and its bed. The vise mounts
 * need the vise fitted; a bed-bracket view (nothing on the pins) would disable every one of them.
 */
function locationView(): unknown {
  return {
    kind: DOC.kind,
    schemaVersion: DOC.schemaVersion,
    id: DOC.id,
    name: DOC.name,
    createdAt: DOC.createdAt,
    migratedFrom: DOC.migratedFrom ?? null,
    machines: DOC.machines,
    accessories: DOC.accessories,
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
  await fakeHouse(page, locationView());
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
  await fakeHouse(page, locationView());
  await cm.ready();
  await toDefaultJob(page);
  await generateTicks(page);
  // #934 removes the entries that could reach a hold collision geometrically (the bed/bracket/tape
  // mounts are hidden; facing on a proud blank is refused), so the run's error is seeded through
  // the store module the dev server serves — the same seam `cutSurface.spec.tsx` uses. `findingFix`
  // maps `tool-into-fixture` to Holding independently of the mount, so the press under test is the
  // real one; D's unit seam pins the same mapping.
  await page.evaluate(async () => {
    const moduleUrl = '/src/store/engraveRunStore.ts';
    const mod = (await import(/* @vite-ignore */ moduleUrl)) as {
      useEngraveRunStore: { setState: (s: Record<string, unknown>) => void };
    };
    mod.useEngraveRunStore.setState({
      simStatus: 'ready',
      simDiagnostics: [
        {
          source: 'sweep',
          severity: 'error',
          code: 'tool-into-fixture',
          checkpoint: 0,
          message:
            "the facing pass (flat-1.0): checkpoint 0: the cutter drives 0.477 mm³ into the fixture 'Vise moving jaw (right)' (vise-moving-jaw)",
        },
      ],
      oracle: null,
      phase: 'blocked',
      staleSince: null,
      simStopped: false,
    });
  });
  await expect(page.getByTestId('engrave-run-errors')).toContainText('into the vise', { timeout: 30_000 });
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
  await fakeHouse(page, locationView());
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

// #934 — A MEASURED TILT WAITS FOR THE OPERATOR. The automatic re-post no longer fires on a tilt
// verdict: step 2 offers the re-seat first, and "Follow the tilt" is the operator's choice that runs
// the withheld re-post. The registration is seeded through the store module (the console fake models
// one flat topZ, so a sloped reading set is a fixture change and a #934 follow-up); this is the same
// seam D's `cutSurface.spec.tsx` uses for the re-seat unit case.
test('#934 — a measured tilt offers the re-seat first, and Follow the tilt runs the re-post', async ({ cm, page }) => {
  await fakeHouse(page, locationView());
  await cm.ready();
  await toDefaultJob(page);
  await generateTicks(page);
  // FREEZE THE FLAT PACKAGE FIRST: the re-post block compares the package against the measured
  // surface, and the preflight refuses a green step 1 once a tilt is recorded against a flat
  // program — by design — so the freeze has to happen before the registration exists.
  await openCut(page);
  await expect(page.getByTestId('engrave-package')).toHaveAttribute('data-state', 'current');

  // Then a live observation at the fixture's address (Cut asks the registration store for THIS
  // machine; a null target shows no registration at all) and the tilt: the machine's measured
  // surface plus the fitted plane, the same seam `cutSurface.spec.tsx` uses.
  await page.evaluate(() => {
    const status = '<Idle|MPos:0,0,0|WPos:0,0,0|S:0.0,10000.0,100.0,0,25.8,24.0,0,0,0,0>';
    window.__caseMaker!.setMachine(
      {
        name: 'QA Z1',
        host: '192.0.2.10',
        port: 2222,
        busy: false,
        ip: null,
        mac: null,
        status,
        profileId: 'Z1',
        observedAt: '2026-10-25T00:00:00.000Z',
        notes: [],
      },
      status,
    );
  });
  await page.evaluate(async () => {
    const regUrl = '/src/store/engraveRegistrationStore.ts';
    const jobUrl = '/src/store/engraveJobStore.ts';
    const reg = (await import(/* @vite-ignore */ regUrl)) as {
      useEngraveRegistrationStore: {
        getState: () => {
          measureSurface: (...args: unknown[]) => void;
          record: (...args: unknown[]) => void;
        };
      };
    };
    const jb = (await import(/* @vite-ignore */ jobUrl)) as {
      useEngraveJobStore: { getState: () => { job: { id: string } } };
    };
    const job = jb.useEngraveJobStore.getState().job;
    const target = { host: '192.0.2.10', port: 2222 };
    reg.useEngraveRegistrationStore.getState().measureSurface(job.id, target, {
      verdict: 'tilt',
      tilt: { xMm: 0.12, yMm: 0 },
      recommendation: null,
    });
    reg.useEngraveRegistrationStore.getState().record(job.id, target, { found: null }, { offset: { x: 0, y: 0 }, rotationDeg: null }, {
      plane: { offset: 0, slopeX: 0.01, slopeY: 0 },
      z0: 0,
    });
  });

  // The surface re-renders against the seeded machine and registration: step 2 offers the re-seat.
  await expect(page.getByTestId('engrave-cut-reseat')).toContainText(
    'Re-seat the blank (press down on the low side) and register again — or follow the tilt',
  );
  await expect(page.getByTestId('engrave-cut-reseat-register')).toHaveText('Register again');
  await expect(page.getByTestId('engrave-cut-reseat-follow')).toHaveText('Follow the tilt…');
  // The chain withheld the re-post: the package is still the flat one, so nothing is "re-made" yet.
  await expect(page.getByTestId('engrave-cut-repost-done')).toHaveCount(0);
  // The surface-frame error keeps step 1 open, so Register is folded — unfold it to press the offer.
  const step2 = page.getByTestId('engrave-cut-step-2');
  if (!(await step2.evaluate((el) => (el as HTMLDetailsElement).open))) {
    await page.getByTestId('engrave-cut-step-2-summary').click();
  }
  // The operator's choice runs it: the package is re-made against the measured plane.
  await page.getByTestId('engrave-cut-reseat-follow').click();
  await expect(page.getByTestId('engrave-cut-repost-done')).toContainText('Re-made for the measured tilt', {
    timeout: 120_000,
  });
});
