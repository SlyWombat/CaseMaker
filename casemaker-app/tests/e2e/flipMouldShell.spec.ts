// #723 P2-3 / #754 — THE ONE-JOB, TWO-SIDE ACCEPTANCE WALK, in a real browser.
//
// The unit acceptance (tests/unit/flipMouldShell.acceptance.spec.ts) proves the generator, the
// pins' datum and the app's carry transform on the closed form. This walk proves the SHIPPED ROUTE:
// a two-side .cutjob.json is opened through File ▾ → Open job… (there is no test API to load a
// job), Generate posts one job as TWO programs, and the app's own run walk sweeps side 2 ON THE
// STOCK SIDE 1 LEFT — the carried field crosses the worker and seeds the column engine.
//
// THE PART IS THE REAL MOUSE SHELL (#754, "real resolution"): the demo job
// `docs/bench/2026-10-28-z1-real-jobs/jobs/j27-mouse-shell-side1.json` carries the 1.2 MB,
// 18,432-triangle STL. The inside goal is that same mesh lowered by the 2.5 mm wall and clamped at
// the rim — the real mesh's resolution, not a smoothed test surface. The cutter is the demo long
// ball (a 12 mm-flute cutter cannot reach this 26 mm shell), supplied through the shipped house
// service endpoints the way the #744 spec supplies its facing cutter.
//
// The wall time from Generate to a swept two-program run is REPORTED (console + test annotation).

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { flatEndMill } from '@/engine/cnc/tool';
import { test, expect } from './fixtures/caseMaker';

const DEMO_JOB = fileURLToPath(
  new URL('../../../docs/bench/2026-10-28-z1-real-jobs/jobs/j27-mouse-shell-side1.json', import.meta.url),
);

/** The designed wall between the shell's outside and the inside form, mm. */
const WALL = 2.5;

/** The demo long ball: a ⌀3.175 ball with a 30 mm flute — the only cutter that reaches this shell. */
const LONG_BALL_KEY = 'user:723-demo-ball';
const LONG_BALL = {
  key: LONG_BALL_KEY,
  provenance: 'Makera demo ball, 30 mm flute (the #754 mouse shell needs a long ball)',
  tool: flatEndMill(3.175, {
    name: 'Two Flute Ball Nose Bit - 1/8" Shank 2mm * 30mm',
    typeText: 'Ball Nose',
    shape: 'ball',
    handleDiameter: 3.175,
    tipDiameter: 2,
    cornerRadius: 1,
    fluteLength: 30,
  }),
};

/** Everything `HouseHealthSchema` requires; nothing has been imported on this fake machine. */
const HEALTH = {
  ok: true,
  schemaVersion: 1,
  hasCatalogue: false,
  feedRows: 0,
  materialSpecRows: 0,
  catalogueSyncedAt: null,
  lastSync: null,
  problems: [],
  warnings: [],
};

/**
 * The inside form as an STL: every vertex of the real outside mesh lowered by the wall, clamped
 * at the rim plane (z = 0). Normals are recomputed from the moved vertices; the hash is of the
 * bytes the job embeds, so the mesh cache and the document agree.
 */
function insideMesh(base64: string): { data: string; sha256: string; size: { x: number; y: number; z: number } } {
  const raw = Buffer.from(base64, 'base64');
  const out = Buffer.from(raw);
  const triangles = out.readUInt32LE(80);
  let maxZ = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < triangles; i++) {
    const facet = 84 + i * 50;
    for (let v = 0; v < 3; v++) {
      const p = facet + 12 + v * 12;
      const z = raw.readFloatLE(p + 8);
      out.writeFloatLE(Math.max(0, z - WALL), p + 8);
      const x = raw.readFloatLE(p);
      const y = raw.readFloatLE(p + 4);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      maxZ = Math.max(maxZ, Math.max(0, z - WALL));
    }
    const ax = out.readFloatLE(facet + 12);
    const ay = out.readFloatLE(facet + 16);
    const az = out.readFloatLE(facet + 20);
    const bx = out.readFloatLE(facet + 24);
    const by = out.readFloatLE(facet + 28);
    const bz = out.readFloatLE(facet + 32);
    const cx = out.readFloatLE(facet + 36);
    const cy = out.readFloatLE(facet + 40);
    const cz = out.readFloatLE(facet + 44);
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    out.writeFloatLE(nx, facet);
    out.writeFloatLE(ny, facet + 4);
    out.writeFloatLE(nz, facet + 8);
  }
  return {
    data: out.toString('base64'),
    sha256: createHash('sha256').update(out).digest('hex'),
    size: { x: maxX - minX, y: maxY - minY, z: maxZ },
  };
}

const TOP_UP = { top: 'top', bottom: 'bottom', left: 'left', right: 'right', front: 'front', back: 'back' } as const;
/** Bottom up in the vise: the setups engine's 180° turn about X, the flip line y = 25. */
const BOTTOM_UP = { top: 'bottom', bottom: 'top', left: 'left', right: 'right', front: 'back', back: 'front' } as const;

/** The two-side document: the demo job's outside on setup 1, the derived inside (a mold) on setup 2. */
function twoSideJob(): Record<string, unknown> {
  const source = JSON.parse(readFileSync(DEMO_JOB, 'utf8')) as Record<string, unknown> & {
    targetObject: Record<string, unknown>;
  };
  const { targetObject: outside, ...rest } = source;
  const inside = insideMesh(outside.data as string);
  return {
    ...rest,
    name: 'mouse-shell-two-sides',
    toolKey: LONG_BALL_KEY,
    // The document states the cutter was CHOSEN, not computed: the panel's recommender leaves a
    // user's pick alone (a 12 mm-flute built-in cannot reach this shell), as it must on any saved
    // job. Without this the panel would replace it with `flat-1.0 · recommended`.
    sources: { tool: 'user' },
    setups: [
      { id: 'setup-1', orientation: TOP_UP, mount: { kind: 'vise', viseOpeningMm: 100 }, itemIds: [], tools: [LONG_BALL_KEY] },
      {
        id: 'setup-2',
        orientation: BOTTOM_UP,
        mount: { kind: 'vise', viseOpeningMm: 100 },
        itemIds: [],
        tools: [LONG_BALL_KEY],
        // The turn, and the datum it is made against: (4, 25) and (75, 25), on the flip line.
        remount: { instruction: ['Turn the stock over about the two pins, so the face that was up is down.'], confirm: null },
        pins: { at: [{ x: 4, y: 25 }, { x: 75, y: 25 }] },
      },
    ],
    targetObjects: [
      { ...outside, id: 'shell-out', setupId: 'setup-1' },
      {
        ...outside,
        id: 'shell-in',
        name: 'mouse-shell-inside.stl',
        setupId: 'setup-2',
        goalMode: 'mold',
        data: inside.data,
        sha256: inside.sha256,
        size: inside.size,
        surface: { finishStepOverMm: 0.3 },
      },
    ],
  };
}

test.setTimeout(1_200_000);

test('#754/#723 — a two-side mouse shell opens, generates two programs, and side 2 sweeps the carried stock', async ({
  cm,
  page,
}, testInfo) => {
  // A real house service is not running in this web build; answer it as the app's own schemas read
  // it, with the demo long ball on the bench (#744's spec does the same for its facing cutter).
  await page.route('**/api/v1/health**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(HEALTH) }),
  );
  await page.route('**/api/v1/tools**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { etag: '"tools-723"' },
      body: JSON.stringify([LONG_BALL]),
    }),
  );
  await page.route('**/api/v1/feeds**', (route) => route.fulfill({ status: 404, body: '' }));
  await page.route('**/api/v1/inventory**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );

  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await expect(page.getByTestId('engrave-panel')).toBeVisible();

  const jobPath = testInfo.outputPath('mouse-shell-two-sides.cutjob.json');
  writeFileSync(jobPath, JSON.stringify(twoSideJob()));

  // File ▾ → Open job… — the shipped route, not a test API.
  const menu = page.getByTestId('engrave-file-menu');
  if (!(await menu.isVisible())) await page.getByTestId('engrave-file-menu-toggle').click();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('engrave-job-open').click()]);
  await chooser.setFiles(jobPath);
  await expect(page.getByTestId('engrave-job-notice')).toContainText('Opened mouse-shell-two-sides.cutjob.json.');
  await expect(page.getByTestId('engrave-job-file-name')).toContainText('mouse-shell-two-sides');

  // The document is the SIDES form: setup 1's goal is the outside, setup 2's the inside mold.
  // The sides list lives in the folded Hold group (#799); the chosen cutter is above the fold.
  await expect(page.getByTestId('engrave-cutter-line')).toContainText(/ball/);
  await expect(page.getByTestId('engrave-cutter-line')).toContainText('chosen by you');
  const hold = page.getByTestId('engrave-group-hold');
  if ((await hold.getAttribute('open')) === null) await page.getByTestId('engrave-group-hold-summary').click();
  await expect(page.getByTestId('engrave-setups')).toBeVisible();
  await expect(page.getByTestId('engrave-side-goal-0')).toContainText('mouse-shell.stl');
  await expect(page.getByTestId('engrave-side-goal-1')).toContainText('mouse-shell-inside.stl');

  // GENERATE — one job, two programs. The wall clock is the acceptance's own number.
  const started = Date.now();
  await expect(page.getByTestId('engrave-generate')).toBeEnabled({ timeout: 60_000 });
  await page.getByTestId('engrave-generate').click();
  await expect(page.getByTestId('engrave-run-simulated')).toHaveAttribute('data-state', 'tick', { timeout: 1_100_000 });
  const wallSeconds = (Date.now() - started) / 1000;
  testInfo.annotations.push({ type: 'wall-time', description: `${wallSeconds.toFixed(1)} s` });
  console.log(`#754 walk: ${wallSeconds.toFixed(1)} s from Generate to a swept two-program run`);

  const state = await page.evaluate(() => window.__caseMaker!.getEngraveRunState());
  expect(state.programs).toBe(2);
  expect(state.simStatus).toBe('ready');
  expect(state.stage).toBe('done');

  // SIDE 2'S CARRIED SWEEP, as the app states it: both programs were checked in cut order on the
  // stock the earlier one left, and NOTHING was re-swept from the blank. The Simulate panel reads
  // the run store's own per-program summaries; its Technical fold holds the sentence that would
  // name a from-blank program if the carry had declined.
  await page.getByTestId('sidebar-button-cnc-sim').click();
  await expect(page.getByTestId('sim-panel')).toBeVisible();
  const checked = page.getByTestId('sim-job-checked');
  await expect(checked).toContainText('all 2 programs');
  await expect(checked).toContainText('program 2');
  await expect(checked).not.toContainText('Swept from the blank');
  const technical = page.getByTestId('sim-job-technical');
  if ((await technical.count()) > 0) {
    if ((await technical.getAttribute('open')) === null) await technical.locator('summary').click();
    await expect(page.getByTestId('sim-job-coverage')).toBeVisible();
    await expect(page.getByTestId('sim-job-coverage')).not.toContainText('Swept from the blank');
  }
});
