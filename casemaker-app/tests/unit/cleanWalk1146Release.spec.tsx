// @vitest-environment jsdom
// #1146 — the release integration: the air walk before program 1, the cleaning pass after every
// finished program, both ON by default (the maintainer's 2026-11-09 ruling), both as FILES the
// release uploads and the verifier checked. Both switches off means neither file is planned,
// uploaded or played; after a Stop nothing moves until the operator presses Clean now. The upload
// and the console are fake clients; nothing reaches a machine.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { waitFor } from '@testing-library/react';
import { setMachineConsoleLoader, type ConsoleSend, type MachineConsoleClient } from '@/platform/machineConsole';
import { setMachineUploadLoader } from '@/platform/machineUpload';
import { ShopDefaultsSchema } from '@/platform/defaultsClient';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { jobSetups } from '@/engine/cnc/engrave/jobSetup';
import { programHash } from '@/engine/cnc/programHash';
import type { ReleaseSource } from '@/engine/cnc/engrave/release';
import { resetMachineRunStore, setRunEndIO, type RunEndIO } from '@/store/machineRunStore';
import { resetRunConfirmStore } from '@/store/runConfirmStore';
import { resetEngraveReleaseStore, useEngraveReleaseStore, type ReleaseRecord } from '@/store/engraveReleaseStore';
import { resetEngraveRegistrationStore, useEngraveRegistrationStore } from '@/store/engraveRegistrationStore';
import { resetShopDefaultsStore, useShopDefaultsStore } from '@/store/shopDefaultsStore';
import { resetLocationStore } from '@/store/locationStore';
import { planRegistration } from '@/engine/cnc/registration/plan';
import { registrationSettings } from '@/engine/cnc/registration/settings';
import type { RegistrationOutcome } from '@/engine/cnc/registration/outcome';
import type { VerifyReport } from '@/engine/cnc/verify';
import type { EngraveJob } from '@/types/engraveJob';

const TARGET = { host: '192.0.2.10', port: 2222 };
const VERIFY: VerifyReport = {
  ok: true,
  findings: [],
  stats: { lines: 1, cuttingMoves: 0, deepestZ: 0, bbox: { min: [0, 0, 0], max: [1, 1, 0] } },
};
const NC1 = 'M331\nG0 X0 Y0\nM02\n';
const NC2 = 'G0 X1 Y1\nM332\nM02\n';

/** The job: the default blank (100 × 60, vise — no fixture above the top), two programs. */
function twoProgramJob(): EngraveJob {
  const job = defaultEngraveJob();
  job.name = 'Clean job';
  const first = jobSetups(job)[0]!;
  job.setups = [first, { ...first, id: 'setup-2', tools: ['flat-1.0'] }];
  return job;
}

function sourcesOf(programs: { nc: string; setupId: string }[]): ReleaseSource[] {
  return programs.map((p) => ({
    setupIndex: p.setupId === 'setup-2' ? 2 : 1,
    setupId: p.setupId,
    toolKey: 'flat-1.0',
    nc: p.nc,
    hash: programHash(p.nc),
    verify: VERIFY,
  }));
}

const sent: string[] = [];
const uploaded: string[] = [];
/** What the fake card holds: filename → text, so the test reads the exact bytes uploaded. */
const onCard = new Map<string, string>();

/**
 * A controller that finishes each played program after `finishAfter` polls, and answers an abort
 * with Idle at once. `play` records the file the machine was asked to run.
 */
function controller(finishAfter = 0): MachineConsoleClient {
  let playing = false;
  let polls = 0;
  let aborted = false;
  return {
    async open() {
      return {
        async send(line: string): Promise<ConsoleSend> {
          sent.push(line);
          let text = 'ok';
          if (line === '?') {
            if (!playing || aborted) text = '<Idle|MPos:0,0,0>';
            else if (polls++ < finishAfter) text = '<Run|MPos:0,0,0|P:10,20,5>';
            else text = '<Idle|P:9,100,4>';
          } else if (line.startsWith('play ')) {
            playing = true;
            polls = 0;
            aborted = false;
            text = 'File size 10';
          } else if (line === 'abort') {
            aborted = true;
            text = 'ok\nAborted playing or paused file.';
          }
          return { ok: true, line, text, frames: 1, elapsedMs: 1 };
        },
        async close() {},
      };
    },
  };
}

function runEndIO(): RunEndIO {
  return {
    refreshStock: async () => {},
    stockItem: () => null,
    consume: async () => ({ ok: true, text: '' }),
    addOffcut: async () => ({ ok: true, text: '' }),
    inventory: () => [],
    updateItem: async () => ({ ok: true, text: '' }),
    machineIdFor: () => null,
    recordFinishedProgram: async () => ({ ok: true, added: true, text: '' }),
    minSideMm: () => 5,
    offerOffcuts: () => false,
    wearWeight: () => ({ value: 1, source: 'test' }),
    newId: () => 'offcut-1',
    now: () => '2026-11-10T00:00:00.000Z',
  };
}

/** The shop's two switches, as a location that chose them. */
function shop(walks: { clean: boolean; air: boolean }): void {
  useShopDefaultsStore.setState({
    status: 'present',
    defaults: ShopDefaultsSchema.parse({
      'run.cleanAfterProgram': { value: walks.clean, source: 'chosen', setAt: '2026-11-10T00:00:00.000Z', unit: null, note: null },
      'run.airWalkBeforeCut': { value: walks.air, source: 'chosen', setAt: '2026-11-10T00:00:00.000Z', unit: null, note: null },
    }),
  });
}

const record = (): ReleaseRecord | undefined => useEngraveReleaseStore.getState().records[`${TARGET.host}:${TARGET.port}`];
const plays = (): string[] => sent.filter((line) => line.startsWith('play '));
const playedFiles = (): string[] => plays().map((line) => line.replace(/^play \/sd\/gcodes\//, ''));

/**
 * Plan and upload through the store, exactly as the release step's buttons do (nothing runs).
 * Both programs are setup 1's: this suite is about the walks, and a second setup would need its
 * own registration before its program may play (#1088), which is another spec's subject.
 */
async function planAndUpload(job: EngraveJob): Promise<void> {
  const sources = sourcesOf([
    { nc: NC1, setupId: 'setup-1' },
    { nc: NC2, setupId: 'setup-1' },
  ]);
  useEngraveReleaseStore.getState().plan(TARGET, job, sources);
  await useEngraveReleaseStore.getState().uploadAll(TARGET);
}

/** The same, then Start: the air walk is the first thing the machine is asked to play. */
async function uploadAndStart(job: EngraveJob): Promise<void> {
  await planAndUpload(job);
  useEngraveReleaseStore.getState().startRelease(TARGET);
}

beforeEach(() => {
  sent.length = 0;
  uploaded.length = 0;
  onCard.clear();
  resetRunConfirmStore();
  resetMachineRunStore();
  resetEngraveReleaseStore();
  resetEngraveRegistrationStore();
  resetLocationStore();
  resetShopDefaultsStore();
  setMachineConsoleLoader(async () => controller(0));
  setMachineUploadLoader(async () => ({
    status: async () => ({ ok: true, text: '<Idle|MPos:0,0,0>' }),
    upload: async (_target, program) => {
      uploaded.push(program.filename);
      onCard.set(program.filename, new TextDecoder().decode(program.content));
      return { ok: true, bytes: program.content.length, packets: 1, alreadyPresent: false };
    },
  }));
  setRunEndIO(runEndIO());
});

afterEach(() => {
  setMachineConsoleLoader(null);
  setMachineUploadLoader(null);
  setRunEndIO(null);
  resetShopDefaultsStore();
});

describe('#1146 — the walks ride the release, as files', () => {
  it('plans and uploads both walks with the programs (both switches are ON by default)', async () => {
    const job = twoProgramJob();
    await planAndUpload(job);
    const rec = record()!;
    expect(rec.airWalk).toBe(true);
    expect(rec.cleanAfter).toBe(true);
    expect(rec.walks.airwalk).not.toBeNull();
    expect(rec.walks.clean).not.toBeNull();
    expect(uploaded).toEqual([
      'Clean-job-p1.nc',
      'Clean-job-p2.nc',
      'Clean-job-airwalk.nc',
      'Clean-job-clean.nc',
    ]);
    const walk = rec.walks.clean!;
    expect(walk.verify.ok).toBe(true);
    // No fixture stands above the default vise job's top: the sweep is 5 mm above work Z0.
    expect(walk.sweepZ).toBe(5);
  });

  it('plays the air walk before program 1, then a cleaning pass after every finished program', async () => {
    const job = twoProgramJob();
    await uploadAndStart(job);
    const rec = () => record()!;

    await waitFor(() => expect(rec().phase).toBe('airwalk'), { timeout: 15000 });
    // The walk is the FIRST play: no program file has been asked to run.
    await waitFor(() => expect(playedFiles()).toEqual(['Clean-job-airwalk.nc']), { timeout: 15000 });
    // The air walk switches no accessory (a Z1 has no laser): no M851 yet.
    expect(sent).not.toContain('M851');

    await waitFor(() => expect(rec().phase).toBe('running'), { timeout: 15000 });
    await waitFor(() => expect(playedFiles()).toEqual(['Clean-job-airwalk.nc', 'Clean-job-p1.nc']), { timeout: 15000 });
    // The programs re-state the vacuum span's own word (item 41).
    expect(sent).toContain('M851');

    // The cleaning pass follows program 1 before the bit-change pause.
    await waitFor(() => expect(rec().phase).toBe('cleaning'), { timeout: 15000 });
    await waitFor(() => expect(playedFiles().at(-1)).toBe('Clean-job-clean.nc'), { timeout: 15000 });
    await waitFor(() => expect(rec().phase).toBe('bit-change'), { timeout: 15000 });
    expect(rec().next).toBe(2);

    // Program 2, then its own cleaning pass, then done. The air walk never plays again.
    useEngraveReleaseStore.getState().confirmChange(TARGET);
    await waitFor(() => expect(rec().phase).toBe('cleaning'), { timeout: 15000 });
    await waitFor(() => expect(rec().phase).toBe('done'), { timeout: 15000 });
    const files = playedFiles();
    expect(files).toEqual([
      'Clean-job-airwalk.nc',
      'Clean-job-p1.nc',
      'Clean-job-clean.nc',
      'Clean-job-p2.nc',
      'Clean-job-clean.nc',
    ]);

    // The uploaded texts say what the machine will do: the cleaning pass carries the direct air
    // pair and no auto-mode vacuum words; every move is a rapid at the sweep Z inside the blank.
    const clean = onCard.get('Clean-job-clean.nc')!;
    expect(clean).toContain('M811');
    expect(clean).toContain('M812');
    expect(clean).not.toContain('M331');
    expect(clean).not.toContain('M332');
    expect(clean).not.toMatch(/S\d+ M3/);
    const moves = clean.split('\n').filter((line) => /^G0 /.test(line));
    expect(moves.length).toBeGreaterThan(0);
    // Follow the modal words: every commanded XY stays inside the 100 × 60 footprint, every Z at
    // or above the sweep height.
    let x = 0;
    let y = 0;
    for (const line of moves) {
      const xw = /X(-?\d+(?:\.\d+)?)/.exec(line);
      const yw = /Y(-?\d+(?:\.\d+)?)/.exec(line);
      if (xw) x = Number(xw[1]);
      if (yw) y = Number(yw[1]);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(100);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(60);
      const zs = [...line.matchAll(/Z(-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
      for (const z of zs) expect(z).toBeGreaterThanOrEqual(5);
    }
    // The air walk is the stock outline, once, and carries no accessory words. The post's modal
    // X/Y words omit an unchanged axis, so the corners are checked as the axis words they print.
    const air = onCard.get('Clean-job-airwalk.nc')!;
    expect(air).not.toContain('M811');
    expect(air).not.toContain('M851');
    expect(air).toContain('X100');
    expect(air).toContain('Y60');
  });

  it('both switches off: neither walk is planned, uploaded or played', async () => {
    shop({ clean: false, air: false });
    const job = twoProgramJob();
    await uploadAndStart(job);
    const rec = record()!;
    expect(rec.airWalk).toBe(false);
    expect(rec.cleanAfter).toBe(false);
    expect(rec.walks.airwalk).toBeNull();
    expect(rec.walks.clean).toBeNull();
    expect(uploaded).toEqual(['Clean-job-p1.nc', 'Clean-job-p2.nc']);
    await waitFor(() => expect(record()!.phase).toBe('running'), { timeout: 15000 });
    await waitFor(() => expect(playedFiles()).toEqual(['Clean-job-p1.nc']), { timeout: 15000 });
    // No clean after program 1: straight to the bit-change pause.
    await waitFor(() => expect(record()!.phase).toBe('bit-change'), { timeout: 15000 });
    expect(playedFiles()).toEqual(['Clean-job-p1.nc']);
  });

  it('after a Stop nothing moves on its own; Clean now runs the pass once the machine is Idle', async () => {
    const job = twoProgramJob();
    await uploadAndStart(job);
    await waitFor(() => expect(record()!.phase).toBe('running'), { timeout: 15000 });
    useEngraveReleaseStore.getState().stop(TARGET);
    await waitFor(() => expect(record()!.phase).toBe('stopped'), { timeout: 20000 });
    const atStop = plays().length;
    // No automatic motion follows the stop, however long it sits.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(plays().length).toBe(atStop);
    expect(record()!.walk).toBeNull();

    useEngraveReleaseStore.getState().cleanNow(TARGET);
    await waitFor(() => expect(record()!.phase).toBe('cleaning'), { timeout: 15000 });
    await waitFor(() => expect(record()!.phase).toBe('stopped'), { timeout: 15000 });
    expect(playedFiles().at(-1)).toBe('Clean-job-clean.nc');
  });

  it('refuses a sweep above the machine’s travel height, and runs without the pass', async () => {
    // A registration whose measured top puts the machine's clearance only 2 mm above work Z0 —
    // below the walk's stock-top sweep at 5. The plan refuses by name and plans no walk.
    const outcome: RegistrationOutcome = {
      edges: [],
      offset: { x: 0, y: 0 },
      measured: { x: true, y: true },
      centre: { x: 19.05, y: 38.1 },
      rotationDeg: null,
      rotationShiftMm: null,
      withinMargin: true,
      margin: 0.2,
      // Machine clearance is -3; a top at -7 leaves only 4 mm of work-frame height above Z0 —
      // below the walk's 5 mm stock-top sweep.
      surfaceZ: -7,
      probeRefZ: -80,
      seekFromMachineZ: -3,
      currentG54: { x: -181.55, y: -184.8 },
      correctedG54: { x: -181.55, y: -184.8 },
      xyChecked: true,
      usable: true,
      problems: [],
      notes: [],
    };
    const { settings } = registrationSettings(null);
    const planned = planRegistration(
      {
        stock: { xMin: 0, yMin: 0, xMax: 100, yMax: 60, cornerRadius: 0 },
        mount: 'vise',
        expectedSurface: { machineZ: outcome.surfaceZ, from: 'the blank, as registered' },
        seekFromMachineZ: outcome.seekFromMachineZ,
        fixtureBelowSurfaceMm: 0.72,
        cutCentre: { x: 40, y: 30 },
      },
      settings,
    );
    if (!planned.ok) throw new Error(planned.reason);
    const job = twoProgramJob();
    useEngraveRegistrationStore.getState().record(job.id, TARGET, planned.plan, outcome);

    const sources = sourcesOf([
      { nc: NC1, setupId: 'setup-1' },
      { nc: NC2, setupId: 'setup-1' },
    ]);
    useEngraveReleaseStore.getState().plan(TARGET, job, sources);
    const rec = record()!;
    expect(rec.walks.airwalk).toBeNull();
    expect(rec.walks.clean).toBeNull();
    expect(rec.notes.join('\n')).toContain("above the machine's travel height");
    expect(rec.notes.join('\n')).toContain('4.00');
  });
});
