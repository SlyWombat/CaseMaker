// #1170 — THE FLIP, AND THE END OF THE JOB, in the real Cut screen, against a fake machine and a
// fake house.
//
// The job is SEEDED through the app's own engine (a two-sided bracket job with a frozen twenty-
// program package), so the walk measures the cards, not a twenty-minute generate. The fake
// console is the desktop bundle's `/api/v1/machine/**`; the fake house serves the location with the
// bench's measured bracket seat and the probe. NOTHING here touches a real machine or house.
//
// The four walks are the issue's acceptance:
//   1. after program 10 the flip card shows the JOB's axis and bores; the press is disabled until
//      the confirmation tick, then opens the Register step;
//   2. a one-sided job never shows the flip card;
//   3. after the last program the steps stay above the end card; "Cut the tabs again" plays ONLY
//      the release file; Keep adds one shelf blank;
//   4. a reload at the flip returns to the flip card, not step 1.
//
// Screenshot: docs/bench/img/2026-11-10-cut-flip-1170/.
import fs, { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { lanServerPort } from '../../scripts/e2ePort';
import { test, expect, enterCnc } from './fixtures/caseMaker';
import { installFakeConsole } from './fixtures/fakeConsole';

test.use({ baseURL: `http://127.0.0.1:${lanServerPort()}` });
test.setTimeout(300_000);

const OUT = path.join(path.resolve(process.cwd(), '..'), 'docs', 'bench', 'img', '2026-11-10-cut-flip-1170');
const MACHINE = '192.0.2.10:2222';
const SEAT_Z = -85.788;
// `dowelHold`'s line for a LEFT-RIGHT flip is the stock's right edge (x = L − 4 = 96), parallel
// to Y; the stored pins are side 2's frame, so they reflect to x = 4. These are the job's own two
// locating bores (#1073/#1088), not a symmetric guess.
const PIN_A = { x: 4, y: 18 };
const PIN_B = { x: 4, y: 42 };

type Doc = {
  kind: string;
  schemaVersion: number;
  id: string;
  name: string;
  createdAt: string;
  machines: Array<Record<string, unknown> & { finishedPrograms?: string[]; bedProfiles?: Array<Record<string, unknown>> }>;
  accessories: Array<Record<string, unknown>>;
  defaults?: Record<string, unknown>;
  stock?: unknown;
  inventory?: unknown;
};

const DOC = JSON.parse(
  readFileSync(fileURLToPath(new URL('../unit/fixtures/location-doc.json', import.meta.url)), 'utf8'),
) as Doc;

const HEALTH = {
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
};

/** The location, made the bench's: the measured bracket seat and the machine's finished programs. */
function locationView(finished: readonly string[]): unknown {
  const doc = JSON.parse(JSON.stringify(DOC)) as Doc;
  const machine = doc.machines[0]!;
  machine.finishedPrograms = [...finished];
  const profile = machine.bedProfiles![0]! as {
    placements?: Array<{ where?: { kind?: string } }>;
    datums: Record<string, unknown>;
  };
  profile.datums['bracketSeatZ'] = {
    value: SEAT_Z,
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
  // The flip card's stop rule quotes the SHOP's registration tolerance; 0.2 is the issue's number.
  doc.defaults = {
    ...(doc.defaults ?? {}),
    'registration.surfaceToleranceMm': { value: 0.2, source: 'chosen', setAt: null },
  };
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

/** The house the app reads, with a capture of every POST /stock (the shelf-blank proof). */
async function fakeHouse(page: Page, finished: readonly string[]): Promise<{ stockPosts: unknown[] }> {
  const stockPosts: unknown[] = [];
  let stock = ((DOC.stock as unknown[]) ?? []).slice();
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const p = url.pathname.replace(/^.*\/api\/v1/, '');
    const json = (body: unknown, status = 200): Promise<void> =>
      route.fulfill({
        status,
        contentType: 'application/json',
        headers: { etag: '"e1"' },
        body: JSON.stringify(body),
      });
    if (request.method() === 'POST' && p === '/stock') {
      const body = request.postDataJSON();
      stockPosts.push(body);
      stock = [...stock, body];
      return json({ ok: true, item: body });
    }
    if (request.method() !== 'GET') return json({ ok: true });
    if (p === '/health') return json(HEALTH);
    if (p === '/tools') return json([]);
    if (p === '/inventory') return json(DOC.inventory ?? []);
    if (p === '/stock') return json(stock);
    if (p === '/defaults')
      return json({
        ...((DOC.defaults as Record<string, unknown>) ?? {}),
        // The flip card's stop rule quotes this; the shop value is read, never typed into the copy.
        // A chosen value STATES when it was set — the schema refuses a chosen value with no date.
        'registration.surfaceToleranceMm': { value: 0.2, source: 'chosen', setAt: '2026-11-10T08:00:00.000Z' },
      });
    if (p === '/location') return json(locationView(finished));
    return route.fulfill({ status: 404, body: '' });
  });
  return { stockPosts };
}

/** The machine at its homed rest, so the flip card's arrival lights the work without a home move. */
const STATUS = '<Idle|MPos:-1,-1,-1|WPos:0,0,0|S:0.0,10000.0,100.0,0,25.8,24.0,0,0,0,0>';

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

/**
 * A binary STL of a box centred on the origin, base64 — the goal the flip's locating hold is
 * checked against. 12 triangles, little-endian, the shape `targetObjectMesh` parses.
 */
const BOX_STL_JS = `
  const box = (w, h, d) => {
    const x = w / 2, y = h / 2, z = d / 2;
    const v = [
      [-x,-y,-z],[ x,-y,-z],[ x, y,-z],[-x, y,-z],
      [-x,-y, z],[ x,-y, z],[ x, y, z],[-x, y, z],
    ];
    const faces = [
      [0,1,2],[0,2,3],  // bottom
      [4,6,5],[4,7,6],  // top
      [0,4,5],[0,5,1],  // front
      [1,5,6],[1,6,2],  // right
      [2,6,7],[2,7,3],  // back
      [3,7,4],[3,4,0],  // left
    ];
    const bytes = new Uint8Array(84 + faces.length * 50);
    const view = new DataView(bytes.buffer);
    view.setUint32(80, faces.length, true);
    let at = 84;
    for (const f of faces) {
      for (const idx of f) {
        view.setFloat32(at, v[idx][0], true); at += 4;
        view.setFloat32(at, v[idx][1], true); at += 4;
        view.setFloat32(at, v[idx][2], true); at += 4;
      }
      view.setUint16(at, 0, true); at += 2;
    }
    let bin = '';
    for (const byte of bytes) bin += String.fromCharCode(byte);
    return btoa(bin);
  };
`;

/**
 * Seed the two-sided bracket job and its frozen package. `sideOneDone` is 10 by default; the end
 * walk puts all twenty in. The release record is hand-built in the exact shape the release store
 * reads, so the replay can play its file without a twenty-file upload.
 */
async function seed(
  page: Page,
  opts: { allDone: boolean; releasePrograms: boolean; sideTwoRegistered: boolean },
): Promise<string[]> {
  return page.evaluate(async (o) => {
    const defaults = await import('/src/engine/cnc/engrave/defaults.ts' as string);
    const pkgMod = await import('/src/engine/cnc/engrave/package.ts' as string);
    const tools = await import('/src/engine/cnc/tool.ts' as string);
    const registry = await import('/src/engine/cnc/toolRegistry.ts' as string);
    const jobStore = await import('/src/store/engraveJobStore.ts' as string);
    const release = await import('/src/store/engraveReleaseStore.ts' as string);
    const run = await import('/src/store/machineRunStore.ts' as string);
    const reg = await import('/src/store/engraveRegistrationStore.ts' as string);
    const runStore = await import('/src/store/engraveRunStore.ts' as string);
    // A flat narrower than the ⌀6 locating bore, with its reach unstated (the #785 fallback).
    registry.setRegistry([
      { key: 'flat-1.0', tool: tools.flatEndMill(1.0, { name: '1 mm flat end' }), provenance: 'e2e' },
    ] as never);
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const box = new Function(`${o.boxStl} return box;`)() as (w: number, h: number, d: number) => string;
    const IDENTITY = { top: 'top', bottom: 'bottom', left: 'left', right: 'right', front: 'front', back: 'back' };
    const FLIPPED = { top: 'bottom', bottom: 'top', left: 'right', right: 'left', front: 'front', back: 'back' };
    const job = defaults.defaultEngraveJob();
    job.toolKey = 'flat-1.0';
    job.stock = { ...job.stock, length: 100, width: 60, thickness: 25, material: 'hardwood' };
    const ids = job.labels.map((l: { id: string }) => l.id);
    const goal = {
      id: 'goal-1170',
      name: 'tray.stl',
      format: 'stl' as const,
      sha256: 'a'.repeat(64),
      data: box(40, 30, 10),
      size: { x: 40, y: 30, z: 10 },
      position: { x: 50, y: 30, z: 0 },
      rotation: 0,
      enabled: true,
      role: 'goal' as const,
      setupId: 's1',
    };
    job.targetObjects = [goal] as never;
    job.setups = [
      { id: 's1', orientation: { ...IDENTITY }, mount: { kind: 'bracket' }, itemIds: ids, tools: ['flat-1.0'] },
      {
        id: 's2',
        orientation: { ...FLIPPED },
        mount: { kind: 'bracket' },
        itemIds: ids,
        tools: ['flat-1.0'],
        flip: { method: 'tabs-in-blank' as const, axis: 'left-right' as const },
        pins: { at: [o.pinA, o.pinB] as [{ x: number; y: number }, { x: number; y: number }] },
      },
    ];
    const inputs = Array.from({ length: 20 }, (_, i) => ({
      setupIndex: i < 10 ? 1 : 2,
      setupId: i < 10 ? 's1' : 's2',
      toolKey: 'flat-1.0',
      nc: `G0 X0 Y0\n; p${i + 1}\nM02\n`,
      frameNc: null,
      programHash: `h${i + 1}`,
    }));
    const made = pkgMod.freezePackage(job, inputs, '2026-11-10T08:00:00.000Z');
    if (!made.ok) throw new Error(made.reason);
    job.package = made.package;
    const finishedCount = o.allDone ? 20 : 10;
    // The document's run-log entry states the program's setup and cutter (the schema requires all
    // three beside the hash); a reload parses this payload, so it must be the real shape.
    job.runLog = Array.from({ length: finishedCount }, (_, i) => ({
      at: '2026-11-10T08:00:00.000Z',
      outcome: 'finished' as const,
      programHash: `h${i + 1}`,
      setupIndex: i < 10 ? 1 : 2,
      setupId: i < 10 ? 's1' : 's2',
      toolKey: 'flat-1.0',
    }));
    jobStore.useEngraveJobStore.setState({ job });
    // Persist what a reload reads. Written directly: this seeds a document, it does not edit one,
    // and the reload must parse exactly this payload.
    localStorage.setItem('casemaker.engraveJob.v3', JSON.stringify(job));
    jobStore.useEngraveJobStore.getState().setBlowWithVacuum(job.blowWithVacuum ?? true);

    // The generated result, so the end card can find the tab-release program by its own hash.
    const generatedPrograms = Array.from({ length: 20 }, (_, i) => ({
      programHash: `h${i + 1}`,
      setupIndex: i < 10 ? 1 : 2,
      setupId: i < 10 ? 's1' : 's2',
      toolKey: 'flat-1.0',
      nc: `G0 X0 Y0\n; p${i + 1}\nM02\n`,
      verify: null,
      frameNc: null,
      frameVerify: null,
      ...(i === 19 ? { tabRelease: { count: 3, widthMm: 6, heightMm: 2.5, at: [] } } : {}),
    }));
    runStore.useEngraveRunStore.setState({
      generated: {
        ok: true,
        stage: 'done',
        findings: [],
        feeds: null,
        cam: null,
        nc: null,
        verify: null,
        errors: [],
        programs: generatedPrograms,
      },
      simDiagnostics: [],
      simStatus: 'ready',
    } as never);

    const files = Array.from({ length: 20 }, (_, i) => ({
      index: i + 1,
      total: 20,
      setupIndex: i < 10 ? 1 : 2,
      setupId: i < 10 ? 's1' : 's2',
      toolKey: 'flat-1.0',
      filename: `tray-p${i + 1}.nc`,
      hash: `h${i + 1}`,
      nc: `G0 X0 Y0\n; p${i + 1}\nM02\n`,
      verify: null,
      done: o.allDone || i < 10,
      upload: 'present' as const,
      uploadNote: null,
    }));
    if (o.releasePrograms) {
      release.useEngraveReleaseStore.setState({
        records: {
          [o.machine]: {
            target: { host: '192.0.2.10', port: 2222 },
            jobId: job.id,
            jobName: job.name,
            job,
            airOn: false,
            phase: o.allDone ? 'done' : 'bit-change',
            files,
            walks: { airwalk: null, clean: null },
            airWalk: false,
            cleanAfter: false,
            airWalked: true,
            walk: null,
            active: o.allDone ? 20 : 10,
            next: o.allDone ? null : 11,
            atMachine: true,
            operatorStep: null,
            retouchedFor: null,
            uploading: null,
            vacuum: o.allDone ? 'off' : 'on',
            spanClosing: false,
            stopAsked: false,
            stoppedBetween: false,
            notes: [],
            settled: false,
          },
        },
      } as never);
    }
    if (o.allDone) {
      run.useMachineRunStore.setState({
        runs: {
          [o.machine]: {
            running: false,
            runId: 20,
            filename: 'tray-p20.nc',
            programHash: 'h20',
            paused: false,
            stopAsked: false,
            progress: null,
            firstProgressAt: null,
            pausedMs: 0,
            lines: [],
            outcome: { kind: 'finished', last: { line: 10, percent: 100, elapsedS: 120 }, homed: true, vacuumOff: true },
            context: { nc: 'M02\n', jobId: job.id, programIndex: 20, programTotal: 20 },
            end: {
              kind: 'finished',
              lines: [],
              offcut: {
                item: {
                  id: 'stock-offcut-1',
                  material: 'hardwood',
                  form: 'block',
                  size: { length: 160, width: 126, thickness: 25 },
                  layers: [],
                  // The shelf schema's own words: a null finish/flatness/conductive is refused
                  // before any POST, so the Keep press must offer a real offcut entry.
                  finish: 'rough',
                  flatness: 'flat',
                  domeHeight: null,
                  conductive: true,
                  quantity: 1,
                  reservations: [],
                  consumed: [],
                  source: 'offcut',
                  addedAt: '2026-11-10T08:00:00.000Z',
                },
                text: '160 × 126 × 25 mm of hardwood is left over from the cut-out — keep it on the shelf?',
                state: 'asked',
              },
              stockQuestion: null,
            },
            pendingStock: null,
          },
        },
      } as never);
    }
    // Side 2's registration record: the release store refuses a setup-2 program without one, and
    // the "Cut the tabs again" replay is a setup-2 file. It is SEEDED ONLY FOR THE END WALK — the
    // flip card is due until side 2 is registered, so a flip walk must leave it absent.
    reg.useEngraveRegistrationStore.setState({
      bySetup: o.sideTwoRegistered
        ? {
            [`${job.id}::s2`]: {
              jobId: job.id,
              setupId: 's2',
              target: { host: '192.0.2.10', port: 2222 },
              plan: { settings: {}, notes: [] },
              outcome: { usable: true, correctedG54: { x: 0, y: 0, z: 0 }, surfaceZ: -60.788 },
              measuredAt: '2026-11-10T08:00:00.000Z',
            },
          }
        : {},
      surfaces: {
        [job.id]: {
          jobId: job.id,
          target: { host: '192.0.2.10', port: 2222 },
          // A COMPLETE flat assessment: the registration reads its touches (the carried top), and
          // the Cut surface draws its tilt words — a partial object crashed the panel render.
          assessment: (() => {
            const top = o.seatZ + 25;
            const read = { id: 't0', x: 50, y: 30, z: top, at: 'above' as const, source: 'probe' as const };
            return {
              plan: { touches: [], regions: [], band: { lower: 0, upper: 0 }, level: null },
              touches: [read],
              min: { z: top, touchId: 't0', x: 50, y: 30, at: 'above', source: 'probe' },
              max: { z: top, touchId: 't0', x: 50, y: 30, at: 'above', source: 'probe' },
              spread: 0,
              drops: { xMm: 0, yMm: 0 },
              z0: { z: top, touchId: 't0', rule: 'lowest' },
              fit: null,
              tilt: { xMm: 0, yMm: 0 },
              landing: { lower: 0, upper: 0 },
              ok: true,
              verdict: 'flat' as const,
              slopeDeg: 0,
              recommendation: null,
            };
          })(),
        },
      },
    } as never);
    // What the seed actually put in the store — the spec asserts the app does not clear it.
    return Object.keys(reg.useEngraveRegistrationStore.getState().bySetup);
  }, {
    machine: MACHINE,
    allDone: opts.allDone,
    releasePrograms: opts.releasePrograms,
    sideTwoRegistered: opts.sideTwoRegistered,
    pinA: PIN_A,
    pinB: PIN_B,
    seatZ: SEAT_Z,
    boxStl: BOX_STL_JS,
  });
}

async function openCut(page: Page): Promise<void> {
  await enterCnc(page);
  // After a reload the panel mounts behind the restored job; give the first paint room.
  await expect(page.getByTestId('engrave-panel')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('cnc-mode-cut').click();
  await expect(page.getByTestId('engrave-cut-surface')).toBeVisible();
}

test('#1170 — after side 1 the flip card shows the job’s own axis and bores; the tick gates the press, which opens Register', async ({
  cm,
  page,
}) => {
  const house = await fakeHouse(page, Array.from({ length: 10 }, (_, i) => `h${i + 1}`));
  void house;
  const fake = await installFakeConsole(page, { steps: 12, idleMpos: [-1, -1, -1] });
  await cm.ready();
  await rememberMachine(page);
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await seed(page, { allDone: false, releasePrograms: true, sideTwoRegistered: false });

  await openCut(page);
  // Step 3 is the current step at the turn (the flip is its business), so the card shows without
  // the test opening a fold — this is the issue's "after program 10 the flip card shows".
  const card = page.getByTestId('engrave-flip-card');
  await expect(card).toBeVisible();
  await expect(page.getByTestId('engrave-flip-header')).toContainText('side 1 done, 10 of 20');
  await expect(page.getByTestId('engrave-flip-header')).toContainText('turn the blank');
  // THE JOB'S OWN AXIS, not a stock sentence.
  await expect(page.getByTestId('engrave-flip-axis')).toHaveText('left ↔ right');
  // THE JOB'S OWN BORES: side 2's stored pins and their reflection in the before panel.
  const before = await page.locator('[data-testid^="engrave-flip-bore-before-"]').evaluateAll((els) =>
    els.map((el) => ({ x: Number(el.getAttribute('data-x')), y: Number(el.getAttribute('data-y')) })),
  );
  const after = await page.locator('[data-testid^="engrave-flip-bore-after-"]').evaluateAll((els) =>
    els.map((el) => ({ x: Number(el.getAttribute('data-x')), y: Number(el.getAttribute('data-y')) })),
  );
  // Side 1's view is the stored pair reflected through the flip: x = 100 − 4 = 96.
  expect(before).toEqual(expect.arrayContaining([{ x: 96, y: 18 }, { x: 96, y: 42 }]));
  expect(after).toEqual(expect.arrayContaining([{ x: 4, y: 18 }, { x: 4, y: 42 }]));
  // The stop rule quotes the SHOP's tolerance (0.2 mm served by the fake house), not a literal.
  const defs = await page.evaluate(async () => {
    const m = await import('/src/store/shopDefaultsStore.ts' as string);
    const s = m.useShopDefaultsStore.getState();
    return { status: s.status, reason: s.reason, tol: s.defaults?.['registration.surfaceToleranceMm'] };
  });
  expect(defs.tol?.value ?? defs, JSON.stringify(defs)).toBe(0.2);
  await expect(page.getByTestId('engrave-flip-register-note')).toContainText('0.2 mm');
  // The registration card must be able to plan FROM THIS JOB: the same hold check it runs, read
  // here so a refusal names its numbers in the test output.
  const holdFacts = await page.evaluate(async () => {
    const jobMod = await import('/src/store/engraveJobStore.ts' as string);
    const setupMod = await import('/src/engine/cnc/engrave/jobSetup.ts' as string);
    const flipMod = await import('/src/engine/cnc/engrave/goalFlipSetups.ts' as string);
    const reg = await import('/src/engine/cnc/toolRegistry.ts' as string);
    const job = jobMod.useEngraveJobStore.getState().job;
    const goal = setupMod.jobTargetObjects(job).find((g: { role?: string }) => g.role === 'goal');
    const setup = job.setups?.[1];
    const check =
      goal === undefined || setup === undefined ? null : flipMod.flipHoldCheck(job, goal, setup, reg.getTools());
    const hold = goal === undefined || setup === undefined ? null : flipMod.dowelHold(job, goal, 'y', reg.getTools());
    return {
      pins: setup?.pins?.at ?? null,
      check,
      hold: hold !== null && hold.ok ? hold.hold.at : (hold?.reason ?? null),
    };
  });
  expect(holdFacts, JSON.stringify(holdFacts)).toMatchObject({ check: { ok: true } });
  // One press, disabled until the operator confirms the blank is turned and seated.
  const press = page.getByTestId('engrave-flip-register');
  await expect(press).toBeDisabled();
  expect(await page.getByTestId('engrave-cut-step-2').evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false);
  await page.getByTestId('engrave-flip-confirm').check();
  await expect(press).toBeEnabled();
  await press.click();
  // Side 2's registration is now the open step, with the flip's own card (the plan is built from
  // the job's hold, the probe's measured tip and the carried Z0 the fake house's seat and the
  // seeded surface give it).
  expect(await page.getByTestId('engrave-cut-step-2').evaluate((el) => (el as HTMLDetailsElement).open)).toBe(true);
  await expect(page.getByTestId('engrave-registration-flip')).toBeVisible();
  await expect(page.getByTestId('engrave-registration-start')).toHaveText('Register side 2');

  // #1170 review — NO RAW PROGRAM LIST UNDER THE CARD. The checklist's programs column used to
  // print all twenty ids; in the narrow panel that wrapped into a vertical list of `p01,` `p02,`
  // whose only visible part was the ids. A range keeps the row one line (and this guards it).
  const leaked = await page.evaluate(() => {
    const flat = (s: string | null): string => (s ?? '').replace(/\s+/g, ' ').trim();
    const all = [...document.querySelectorAll('*')] as HTMLElement[];
    return all
      .filter((el) => {
        const t = flat(el.textContent);
        return /^p01,? p02,?/.test(t) && el.children.length <= 4;
      })
      .slice(-4)
      .map((el) => ({
        tag: el.tagName,
        testid: el.getAttribute('data-testid'),
        parentTestid: el.parentElement?.getAttribute('data-testid'),
        text: flat(el.textContent).slice(0, 90),
      }));
  });
  expect(leaked, `LEAK: ${JSON.stringify(leaked)}`).toEqual([]);

  fs.mkdirSync(OUT, { recursive: true });
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(OUT, 'flip-card.png') });
  // The arrival's own output: the work light was switched on (the fake logs M821).
  expect(fake.lines()).toContain('M821');
});

test('#1170 — a reload at the flip returns to the flip card, not step 1', async ({ cm, page }) => {
  await fakeHouse(page, Array.from({ length: 10 }, (_, i) => `h${i + 1}`));
  await installFakeConsole(page, { steps: 12, idleMpos: [-1, -1, -1] });
  await cm.ready();
  await rememberMachine(page);
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await seed(page, { allDone: false, releasePrograms: true, sideTwoRegistered: false });
  await openCut(page);
  await expect(page.getByTestId('engrave-flip-card')).toBeVisible();
  const jobState = async (): Promise<unknown> =>
    page.evaluate(async () => {
      const m = await import('/src/store/engraveJobStore.ts' as string);
      const j = m.useEngraveJobStore.getState().job;
      return { name: j.name, pkg: j.package !== undefined, setups: j.setups?.length ?? 0, log: j.runLog?.length ?? 0 };
    });
  const before = await jobState();
  expect(before, JSON.stringify(before)).toMatchObject({ pkg: true, setups: 2, log: 10 });
  const persisted = await page.evaluate(async () => {
    const raw = localStorage.getItem('casemaker.engraveJob.v3');
    if (raw === null) return { raw: null };
    const schema = await import('/src/store/engraveJobSchema.ts' as string);
    const parsed = schema.parseEngraveJob(JSON.parse(raw));
    return { bytes: raw.length, ok: parsed.ok, errors: parsed.ok ? [] : parsed.errors.slice(0, 3) };
  });
  expect(persisted, JSON.stringify(persisted)).toMatchObject({ ok: true });

  // A real reload: the job comes back from the document's own persisted copy; the machine is
  // remembered again (the test's own act). The cut's in-memory stores are gone.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await cm.ready();
  await rememberMachine(page);
  const restored = await jobState();
  expect(restored, `after reload: ${JSON.stringify(restored)}`).toMatchObject({ pkg: true, setups: 2, log: 10 });
  // The app shell lands on the door after a reload (#1123 item 10 is the shell's own restore, not
  // this card). Enter the workspace the app's own way — the persisted job is what must resume on
  // the flip, and it does not pass through the wizard or a reset here.
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
  });
  // The shell's section entry is set directly here: the restored job may already have opened the
  // Job section, and the sidebar control TOGGLES it. The subject is the Cut screen's state.
  await page.evaluate(async () => {
    const m = await import('/src/store/viewportStore.ts' as string);
    m.useViewportStore.getState().setActiveSidebarSection('cnc-engrave');
  });
  await expect(page.getByTestId('engrave-panel')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('cnc-mode-cut').click();
  await expect(page.getByTestId('engrave-cut-surface')).toBeVisible();
  expect(await page.getByTestId('engrave-cut-step-1').evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false);
  await expect(page.getByTestId('engrave-flip-card')).toBeVisible();
  await expect(page.getByTestId('engrave-flip-header')).toContainText('side 1 done, 10 of 20');
});

test('#1170 — a one-sided job never shows the flip card', async ({ cm, page }) => {
  await fakeHouse(page, ['h1']);
  await installFakeConsole(page);
  await cm.ready();
  await rememberMachine(page);
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  // One setup, one program, finished: no boundary can be a flip.
  await page.evaluate(async () => {
    const defaults = await import('/src/engine/cnc/engrave/defaults.ts' as string);
    const pkgMod = await import('/src/engine/cnc/engrave/package.ts' as string);
    const jobStore = await import('/src/store/engraveJobStore.ts' as string);
    const IDENTITY = { top: 'top', bottom: 'bottom', left: 'left', right: 'right', front: 'front', back: 'back' };
    const job = defaults.defaultEngraveJob();
    job.toolKey = 'flat-1.0';
    const ids = job.labels.map((l: { id: string }) => l.id);
    job.setups = [{ id: 's1', orientation: { ...IDENTITY }, mount: { kind: 'vise' }, itemIds: ids, tools: ['flat-1.0'] }];
    const made = pkgMod.freezePackage(job, [
      { setupIndex: 1, setupId: 's1', toolKey: 'flat-1.0', nc: 'G0 X0 Y0\nM02\n', frameNc: null, programHash: 'h1' },
    ], '2026-11-10T08:00:00.000Z');
    if (!made.ok) throw new Error(made.reason);
    job.package = made.package;
    job.runLog = [{ at: '2026-11-10T08:00:00.000Z', outcome: 'finished' as const, programHash: 'h1' }];
    jobStore.useEngraveJobStore.setState({ job });
    jobStore.useEngraveJobStore.getState().setBlowWithVacuum(job.blowWithVacuum ?? true);
  });
  await openCut(page);
  await expect(page.getByTestId('engrave-flip-card')).toHaveCount(0);
});

test('#1170 — after the last program the steps stay above the end card; the replay plays only the release file; Keep writes one shelf blank', async ({
  cm,
  page,
}) => {
  const house = await fakeHouse(page, Array.from({ length: 20 }, (_, i) => `h${i + 1}`));
  const fake = await installFakeConsole(page, { steps: 6 });
  await cm.ready();
  await rememberMachine(page);
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  const seededKeys = await seed(page, { allDone: true, releasePrograms: true, sideTwoRegistered: true });
  expect(seededKeys, `seeded registration keys: ${JSON.stringify(seededKeys)}`).toEqual([
    expect.stringMatching(/::s2$/),
  ]);

  await openCut(page);
  const keysAfterMount = await page.evaluate(async () => {
    const m = await import('/src/store/engraveRegistrationStore.ts' as string);
    return Object.keys(m.useEngraveRegistrationStore.getState().bySetup);
  });
  expect(keysAfterMount, `after the Cut panel mounted: ${JSON.stringify(keysAfterMount)}`).toEqual(seededKeys);
  const end = page.getByTestId('engrave-cut-end-card');
  await expect(end).toBeVisible();
  // THE STEPS STAY ABOVE IT (#1123 item 39): all three steps are in the document, and the card is
  // after step 3 in reading order.
  await expect(page.getByTestId('engrave-cut-step-1')).toBeAttached();
  await expect(page.getByTestId('engrave-cut-step-2')).toBeAttached();
  await expect(page.getByTestId('engrave-cut-step-3')).toBeAttached();
  const order = await page.evaluate(() => {
    const step = document.querySelector('[data-testid="engrave-cut-step-3"]');
    const card = document.querySelector('[data-testid="engrave-cut-end-card"]');
    return step !== null && card !== null && Boolean(step.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(order, 'the end card is under step 3').toBe(true);
  await expect(page.getByTestId('engrave-cut-end-save')).toHaveText('Save the run record');
  await expect(page.getByTestId('engrave-cut-end-another')).toBeVisible();

  // Keep writes exactly one shelf blank, the offcut the run offered. (Asked BEFORE the replay:
  // the replay is its own machine run, and its end carries no offcut — the job's offer belongs to
  // the run that finished the part.)
  await page.getByTestId('engrave-cut-end-keep').click();
  await expect.poll(() => house.stockPosts.length, { timeout: 15_000 }).toBe(1);
  const posted = house.stockPosts[0] as { source?: string; size?: { length?: number; width?: number; thickness?: number } };
  expect(posted.source).toBe('offcut');
  expect(posted.size).toEqual(expect.objectContaining({ length: 160, width: 126, thickness: 25 }));

  // "Cut the tabs again" replays the tab-release file ONLY — no other program goes to the card.
  await page.getByTestId('engrave-cut-end-tabs').click();
  const releaseState = await page.evaluate(async (machine) => {
    const m = await import('/src/store/engraveReleaseStore.ts' as string);
    const rec = m.useEngraveReleaseStore.getState().records[machine];
    return rec === undefined ? null : { phase: rec.phase, active: rec.active, next: rec.next, notes: rec.notes.slice(-4) };
  }, MACHINE);
  const regFacts = await page.evaluate(async (machine) => {
    const rel = await import('/src/store/engraveReleaseStore.ts' as string);
    const reg = await import('/src/store/engraveRegistrationStore.ts' as string);
    const rec = rel.useEngraveReleaseStore.getState().records[machine];
    return {
      bySetup: Object.keys(reg.useEngraveRegistrationStore.getState().bySetup),
      jobId: rec?.jobId,
      target: rec?.target,
      setupId: rec?.files[19]?.setupId,
    };
  }, MACHINE);
  expect(regFacts.bySetup.length, JSON.stringify(regFacts)).toBeGreaterThan(0);
  expect((releaseState as { notes: string[] } | null)?.notes.join('\n'), JSON.stringify(releaseState)).toContain(
    'Playing program 20',
  );
  await expect
    .poll(() => fake.lines().filter((line) => line.startsWith('play ')), { timeout: 30_000 })
    .toEqual(['play /sd/gcodes/tray-p20.nc']);

  fs.mkdirSync(OUT, { recursive: true });
  await end.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(OUT, 'end-card.png') });
});
