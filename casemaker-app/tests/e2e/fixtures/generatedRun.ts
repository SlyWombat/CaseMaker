/**
 * #1180 S2 — A GENERATED RUN, ONCE.
 *
 * The e2e walk that reaches the run panel is long and expensive: load a board, remember a machine,
 * open Design, pick a cutter, Generate (four ticks — up to three minutes), open Cut, give the one
 * statement, open step 3, and prepare the run entry through the store seam an upload ends on
 * (`machineRunPrepare`). `runStates.spec.ts` and `pauseResume.spec.ts` each carried an identical
 * copy of it; this is the one copy.
 *
 * `generateOnce` is the same walk stopped at the green gate — for a spec that needs a generated
 * program (the ticks, the plan, the program list) but not a run entry. `prepareFakeRun` is the
 * full walk and asserts the run entry exists.
 *
 * The entry is PREPARED, not uploaded: a spec that installs the fake console (`fakeConsole.ts`)
 * wants the run states, and the upload's own file protocol is a different subject.
 */
import type { Page } from '@playwright/test';
import { expect, openCutterGroup } from './caseMaker';
import { rememberMachine } from './rememberMachine';

/** A status line with the monitor fields the state popover reads, for the machine observation. */
export const RUN_STATUS = '<Idle|MPos:0,0,0|WPos:0,0,0|S:0.0,10000.0,100.0,0,25.8,24.0,0,0,0,0>';

/** The built-in board, a remembered machine, Design open, and Generate green. */
export async function generateOnce(page: Page, opts: { tool?: string } = {}): Promise<void> {
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await rememberMachine(page, RUN_STATUS);
  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await expect(page.getByTestId('engrave-panel')).toBeVisible();

  if (opts.tool !== undefined) {
    await openCutterGroup(page);
    await page.getByTestId('engrave-tool').selectOption(opts.tool);
  }
  await page.getByTestId('engrave-generate').click();
  await expect(page.getByTestId('engrave-run-oracle')).toHaveAttribute('data-state', 'tick', { timeout: 180_000 });
}

/**
 * The job both run specs share: a generated program, Cut open with its ONE statement given
 * (#797), the cutters settled, and the release's files marked ON THE CARD — the state the card's
 * ONE Start (#1123 item 8) needs. The START is the caller's: it presses `engrave-cut-card-start`.
 *
 * The files are marked uploaded because the fake console deliberately serves no upload protocol;
 * the START's bytes are the release action's, which the specs then observe on the wire.
 */
export async function prepareFakeRun(page: Page): Promise<void> {
  await generateOnce(page, { tool: 'flat-1.0' });
  await page.getByTestId('cnc-mode-cut').click();
  await expect(page.getByTestId('engrave-cut-surface')).toBeVisible();

  // The statement is step 1's; open the step only if it arrives folded.
  const step1 = page.getByTestId('engrave-cut-step-1');
  if (!(await step1.evaluate((el) => (el as HTMLDetailsElement).open))) {
    await page.getByTestId('engrave-cut-step-1-summary').click();
  }
  await page.getByTestId('engrave-ack').check();
  const step3 = page.getByTestId('engrave-cut-step-3');
  if (!(await step3.evaluate((el) => (el as HTMLDetailsElement).open))) {
    await page.getByTestId('engrave-cut-step-3-summary').click();
  }
  await expect(page.getByTestId('engrave-cut-confirm')).toBeVisible({ timeout: 30_000 });

  // #1286 — nothing is uploaded or played for a job with no registration. These specs are about the
  // run's states, not Register, so the job is registered through the store seam; the gate itself is
  // walked with real presses in registrationGate1286.spec.ts.
  await registerCurrentJob(page);

  // #1127 — a program is not uploaded until every cutter row is settled; the card's Start carries
  // the same gate the one-screen press did. The rows' UI is exercised by cutConfirm.spec; here the
  // entries are written through the job's own action (the same write a tick makes), because a UI
  // tick rewrites the job and a re-freeze in flight can replace the package under the checklist.
  await expect(page.getByTestId('engrave-cutter-row').first()).toBeVisible({ timeout: 60_000 });
  await page.evaluate(async () => {
    const s = (await import('/src/store/engraveJobStore.ts' as string)) as {
      useEngraveJobStore: {
        getState: () => {
          job: { package?: { hash: string; programs: { toolKey: string }[] } };
          setCutterChecklistEntry: (hash: string, key: string, entry: { state: 'located'; at: string }) => void;
        };
      };
    };
    const job = s.useEngraveJobStore.getState().job;
    const pkg = job.package;
    if (pkg === undefined) return;
    for (const key of [...new Set(pkg.programs.map((p) => p.toolKey))]) {
      s.useEngraveJobStore.getState().setCutterChecklistEntry(pkg.hash, key, { state: 'located', at: new Date().toISOString() });
    }
  });
  // The card plans the release; its Start is enabled once the plan is in hand. Mark every file
  // uploaded (and the release ready) so the press goes straight to the SAME release action.
  await expect(page.getByTestId('engrave-cut-card-start')).toBeEnabled({ timeout: 60_000 });
  await page.evaluate(async () => {
    const m = await import('/src/store/engraveReleaseStore.ts' as string);
    const state = m.useEngraveReleaseStore.getState();
    const key = '192.0.2.10:2222';
    const rec = state.records[key];
    if (rec === undefined) return;
    // These specs are about a program's run states, not the cleaning pass or the air walk: the
    // release is given no walks, so the run ends where the specs look for it to end.
    const walk = (_w: unknown) => null;
    m.useEngraveReleaseStore.setState({
      records: {
        ...state.records,
        [key]: {
          ...rec,
          phase: rec.phase === 'idle' ? 'ready' : rec.phase,
          files: rec.files.map((f: { upload: string }) => ({ ...f, upload: 'uploaded' as const })),
          walks: { airwalk: walk(rec.walks.airwalk), clean: walk(rec.walks.clean) },
        },
      },
    } as never);
  });
  // The patch itself re-renders the card; the caller's next press must land on an enabled Start.
  await expect(page.getByTestId('engrave-cut-card-start')).toBeEnabled({ timeout: 30_000 });
}


/** #1286 — a usable registration on record for the open job, on the remembered machine. Seam, not a walk. */
export async function registerCurrentJob(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const reg = (await import('/src/store/engraveRegistrationStore.ts' as string)) as any;
    const jobs = (await import('/src/store/engraveJobStore.ts' as string)) as any;
    const plan = (await import('/src/engine/cnc/registration/plan.ts' as string)) as any;
    const settings = (await import('/src/engine/cnc/registration/settings.ts' as string)) as any;
    const job = jobs.useEngraveJobStore.getState().job;
    const outcome = { edges: [], offset: { x: 0, y: 0 }, measured: { x: true, y: true }, centre: { x: 19.05, y: 38.1 }, rotationDeg: null, rotationShiftMm: null, withinMargin: true, margin: 0.2, surfaceZ: -56.172, probeRefZ: -80, seekFromMachineZ: -3, currentG54: { x: -181.55, y: -184.8 }, correctedG54: { x: -181.55, y: -184.8 }, xyChecked: true, usable: true, problems: [], notes: [] };
    const planned = plan.planRegistration(
      { stock: { xMin: 0, yMin: 0, xMax: 38.1, yMax: 76.2, cornerRadius: 3 }, mount: 'vise', expectedSurface: { machineZ: outcome.surfaceZ, from: 'e2e' }, seekFromMachineZ: -3, fixtureBelowSurfaceMm: 0.72, cutCentre: { x: 24, y: 43 } },
      settings.registrationSettings(null).settings,
    );
    if (!planned.ok) throw new Error(planned.reason);
    const target = { host: '192.0.2.10', port: 2222 };
    const stamp = { blankId: null, holdKey: reg.holdKeyOf(job) };
    // Later setups first, then setup 1 and the job-keyed entry LAST: only the latest origin written on a
    // machine counts, and the run these specs press is setup 1's.
    for (const setup of [...(job.setups ?? [])].slice(1).reverse()) reg.useEngraveRegistrationStore.getState().record(job.id, target, planned.plan, outcome, null, setup.id, stamp);
    reg.useEngraveRegistrationStore.getState().record(job.id, target, planned.plan, outcome, null, job.setups?.[0]?.id ?? null, stamp);
  });
}
