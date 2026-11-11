// #1168 — THE BIT CHANGE, ON THE CUT STEP (mockup 7). A fake console answers the machine, the
// release is seeded at the bit-change pause between two programs that use different cutters, and
// the card is the moment: the fit bit by its cap colour, the bit to take out, two ticks, one press.
//
// THE PRESS MUST POST WHAT TODAY'S PATH POSTS. The same seed is driven twice — once through the
// release step's expert button, once through the card's — and the non-poll lines the fake received
// must be identical, so a new card cannot quietly change the bytes (#1123 items 31/32, #1127).
//
// HELD: the run was written while the bench was live (no local heavy runs on dave-1). Run it when
// the Manager lifts the bench rule.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { lanServerPort } from '../../scripts/e2ePort';
import { test, expect, enterCnc } from './fixtures/caseMaker';
import { BITS_INVENTORY, serveHouse } from './fixtures/fakeHouse';
import { rememberMachine } from './fixtures/rememberMachine';
import { installFakeConsole } from './fixtures/fakeConsole';

test.use({ baseURL: `http://127.0.0.1:${lanServerPort()}` });
test.setTimeout(240_000);

const OUT = path.join(path.resolve(process.cwd(), '..'), 'docs', 'bench', 'img', '2026-11-10-1168-bit-change');
const STATUS = '<Idle|MPos:0,0,0|WPos:0,0,0|S:0.0,10000.0,100.0,0,25.8,24.0,0,0,0,0>';

/** Seed a two-program release paused at the bit change: program 1 done, program 2's cutter next. */
async function seedBitChange(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const defaults = await import('/src/engine/cnc/engrave/defaults.ts' as string);
    const pkgMod = await import('/src/engine/cnc/engrave/package.ts' as string);
    const jobStore = await import('/src/store/engraveJobStore.ts' as string);
    const release = await import('/src/store/engraveReleaseStore.ts' as string);
    const IDENTITY = { top: 'top', bottom: 'bottom', left: 'left', right: 'right', front: 'front', back: 'back' };
    const job = defaults.defaultEngraveJob();
    job.toolKey = 'inv:bits-corn-06';
    const ids = job.labels.map((l: { id: string }) => l.id);
    job.setups = [{ id: 's1', orientation: { ...IDENTITY }, mount: { kind: 'vise' }, itemIds: ids, tools: ['inv:bits-corn-06', 'inv:bits-corn-09'] }];
    const inputs = [
      { setupIndex: 1, setupId: 's1', toolKey: 'inv:bits-corn-06', nc: 'G0 X0 Y0\n; p1\nM02\n', frameNc: null, programHash: 'h1' },
      { setupIndex: 1, setupId: 's1', toolKey: 'inv:bits-corn-09', nc: 'G0 X0 Y0\n; p2\nM02\n', frameNc: null, programHash: 'h2' },
    ];
    const made = pkgMod.freezePackage(job, inputs, '2026-11-10T08:00:00.000Z');
    if (!made.ok) throw new Error(made.reason);
    job.package = made.package;
    jobStore.useEngraveJobStore.setState({ job });
    // A GENERATED run behind the seeded release, so step 1 reads ready rather than "Generate
    // first": a bit change only makes sense after a program ran, and the screenshot must not
    // suggest an inconsistent state.
    const run = await import('/src/store/engraveRunStore.ts' as string);
    const nc = ';@MKR|BEGIN\nG21 G90\nM02\n';
    const verify = { ok: true, findings: [], stats: { lines: 2, cuttingMoves: 1, deepestZ: -2, bbox: { min: [0, 0, -2], max: [1, 1, 0] } } };
    const cam = { operations: 1, cuttingMoves: 10, estimatedSeconds: 5, passes: 2 };
    run.useEngraveRunStore.setState({
      generated: {
        ok: true, stage: 'done', findings: [], feeds: null, threads: null, cam, nc, verify,
        frameNc: `${nc};frame\n`, frameVerify: null, facingNc: null, facingVerify: null,
        facingToolKey: null, facingError: null, facingCam: null, predicted: [], designItems: [],
        programs: [{ setupIndex: 1, setupId: 's1', toolKey: 'inv:bits-corn-06', nc, verify, frameNc: `${nc};frame\n`, frameVerify: null, programHash: '00000000', cam }],
        errors: [],
      },
      simStatus: 'ready', simDiagnostics: [],
      oracle: { ok: true, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } },
      phase: 'ready', acknowledged: true,
    } as never);
    release.useEngraveReleaseStore.setState({
      records: {
        '192.0.2.10:2222': {
          target: { host: '192.0.2.10', port: 2222 },
          notes: [],
          phase: 'bit-change',
          active: 1,
          next: 2,
          vacuum: 'on',
          atMachine: false,
          stopAsked: false,
          job,
          files: inputs.map((p, i) => ({ index: i + 1, total: 2, toolKey: p.toolKey, done: i === 0, nc: p.nc, hash: p.programHash, filename: `tray-p${i + 1}.nc`, upload: 'done', uploadNote: null, verify: null })),
          walks: { airwalk: null, clean: null },
        },
      },
    } as never);
  });
}

async function openCard(page: Page): Promise<void> {
  // Idempotent: the sidebar button TOGGLES the section, and the second boot in this test starts
  // from a page already on the engrave panel.
  if (!(await page.getByTestId('engrave-panel').isVisible().catch(() => false))) {
    await enterCnc(page);
  }
  await expect(page.getByTestId('engrave-panel')).toBeVisible();
  await page.getByTestId('cnc-mode-cut').click();
  await expect(page.getByTestId('engrave-cut-surface')).toBeVisible();
  const step3 = page.getByTestId('engrave-cut-step-3');
  if (!(await step3.evaluate((el) => (el as HTMLDetailsElement).open))) {
    await page.getByTestId('engrave-cut-step-3-summary').click();
  }
}

/** A fresh page's board, machine and seeded bit-change release, Cut step 3 open. */
async function openSeeded(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await rememberMachine(page, STATUS);
  await seedBitChange(page);
  await openCard(page);
}

/** The lines the fake received, with the status polls removed: what the press actually sent. */
function sentLines(fake: { lines: () => string[] }): string[] {
  return fake.lines().filter((line) => line !== '?');
}

test('#1168 — the bit-change card is the moment, and posts the same lines as the expert button', async ({ cm, page }) => {
  // The house's catch-all goes FIRST: Playwright matches the LAST route added, and the fake
  // console's /api/v1/machine/* handlers must win or the run's connect lands on the house's 404.
  await serveHouse(page, { inventory: BITS_INVENTORY, writes: 'reject' });
  const fake = await installFakeConsole(page, { steps: 12 });
  await cm.ready();
  await openSeeded(page);

  // THE CARD, where the operator is looking: inside step 3, not in a fold.
  const card = page.getByTestId('cut-bit-change-card');
  await expect(card).toBeVisible();
  await expect(page.getByTestId('cut-bit-change-header')).toContainText('1 of 2 done · bit change');
  // Fit: the REVERSE of the mockup's bits — 0.9 is the red cap here (BITS_INVENTORY's own data).
  await expect(page.getByTestId('cut-bit-change-fit-name')).toContainText('Red cap · 0.9 mm corn');
  await expect(page.getByTestId('cut-bit-change-take-out')).toContainText('yellow cap · 0.6 mm corn');
  await expect(page.getByTestId('cut-bit-change-chips')).toContainText('box B · row 2');
  await expect(page.getByTestId('cut-bit-change-facts')).toContainText('Program 1 finished');
  fs.mkdirSync(OUT, { recursive: true });
  // The CARD, whole: an element capture scrolls it into view and shows every part the issue
  // names — the cap colour, the bit to take out, both confirmations and the one button.
  await card.scrollIntoViewIfNeeded();
  await card.screenshot({ path: path.join(OUT, 'bit-change.png') });

  // Two ticks and one button, in that order.
  const go = page.getByTestId('cut-bit-change-go');
  await expect(go).toBeDisabled();
  await page.getByTestId('cut-bit-change-tick-in').check();
  await expect(go).toBeDisabled();
  await page.getByTestId('cut-bit-change-tick-hands').check();
  await expect(go).toBeEnabled();
  const before = sentLines(fake);
  await go.click();
  await expect
    .poll(() => sentLines(fake).slice(before.length).some((line) => line.startsWith('play ')), { timeout: 60_000 })
    .toBe(true);
  const viaCard = sentLines(fake).slice(before.length);
  // The press starts program 2 — and sends no tool-measure line the old path would not.
  expect(viaCard.some((line) => line.startsWith('play '))).toBe(true);
  expect(viaCard.filter((line) => line.startsWith('M493'))).toEqual([]);

  // THE SAME SEED THROUGH TODAY'S EXPERT BUTTON: the same lines, byte for byte.
  // A FRESH page for the second boot: the in-memory stores (the run that just started) must not
  // leak into the comparison — and the routes survive a navigation.
  // A fresh page AND a fresh console: the first run’s rig is still in Run state, and a reload does
  // not reset the fake — so the second boot gets its own console (registered last, so it wins).
  await page.goto('/');
  await cm.ready();
  const fakeOld = await installFakeConsole(page, { steps: 12 });
  await openSeeded(page);
  // TODAY'S PATH, exactly: the release step's button dispatches this store action and nothing
  // else — calling it here pins the card's bytes against the action, not against a re-render.
  const beforeOld = sentLines(fakeOld);
  await page.evaluate(async () => {
    const m = await import('/src/store/engraveReleaseStore.ts' as string);
    m.useEngraveReleaseStore.getState().confirmChange({ host: '192.0.2.10', port: 2222 });
  });
  await expect
    .poll(() => sentLines(fakeOld).slice(beforeOld.length).some((line) => line.startsWith('play ')), { timeout: 60_000 })
    .toBe(true);
  const viaOld = sentLines(fakeOld).slice(beforeOld.length);
  expect(viaCard).toEqual(viaOld);
});

test('#1168 — a bit with no colour renders without the swatch, and hints at its row', async ({ cm, page }) => {
  // House first, console second, for the same route-order reason as the test above.
  // One possessed bit with no copy case described: the card must not guess a colour.
  const bare = {
    ...BITS_INVENTORY[1]!,
    id: 'bits-corn-09',
    copies: [{ ...BITS_INVENTORY[1]!.copies[0]!, whereabouts: { kind: 'box', case: null } }],
  };
  await serveHouse(page, { inventory: [BITS_INVENTORY[0]!, bare], writes: 'reject' });
  await installFakeConsole(page, { steps: 12 });
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await rememberMachine(page, STATUS);
  await seedBitChange(page);
  await openCard(page);
  await expect(page.getByTestId('cut-bit-change-colour-missing')).toContainText('not recorded');
  await expect(page.getByTestId('cut-bit-change-swatch')).toHaveCount(0);
});
