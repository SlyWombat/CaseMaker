// The restart slice in `simStore` (#249): the store holds the loaded program, so it can produce a
// restart without the wasm sweep. A fake worker client stands in for the load; the generator runs
// for real on the program text.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setSimClientLoader, useSimStore, type SimClient, type SimState } from '@/store/simStore';
import type { SimLoadResult } from '@/workers/sim/session';
import { parseGcode } from '@/engine/cnc/gcode';
import { buildTimeline } from '@/engine/cnc/emulator/timeline';
import { flatEndMill } from '@/engine/cnc/tool';
import { Z1 } from '@/engine/cnc/machine';
import { stubSetup, type Setup } from '@/engine/cnc/setup';
import { rectProfile } from '@/engine/compiler/profile';
import { RESTART_TOOL_LENGTH_NOTE } from '@/engine/cnc/restart';

const TOOL = flatEndMill(1);
const SETUP: Setup = stubSetup(
  { kind: 'prism', outline: rectProfile(20, 10), thickness: 5 },
  { kind: 'tape-down', contact: rectProfile(20, 10) },
  { startingTool: 1 },
  Z1,
);

const PROGRAM = [
  'G90 G21',
  'T1 M6',
  'M331',
  'S12000 M3',
  'G0 X2 Y2 Z5',
  'G0 Z1',
  'G1 Z-1 F200',
  'G1 X10 Y2',
  'G1 X10 Y6',
  'G1 X2 Y6',
  'G0 Z15',
  'M332',
  'M5',
  'G28',
  'M02',
].join('\n');

const TIMELINE = buildTimeline(parseGcode(PROGRAM), SETUP, Z1);
const EVENTS = TIMELINE.events.length;
/** The event index of the first cut move: resuming there restores the tool at [2, 2, −1]. */
const CUT_STEP = (() => {
  for (let i = 0; i < TIMELINE.events.length; i++) {
    const e = TIMELINE.events[i];
    if (e === undefined || e.kind !== 'move' || e.synthetic !== undefined) continue;
    const w = TIMELINE.stateAt(i).work;
    if (w[0] === 10 && w[1] === 2 && w[2] === -1) return i;
  }
  throw new Error('the resume move was not found in the fixture program');
})();

const READY = {
  ok: true,
  diagnostics: [],
  summary: { steps: EVENTS, diagnosticCounts: {} },
  pauses: [],
  checkpoints: [],
  meshes: { stock: {}, result: {}, removal: null, gouges: [] },
} as unknown as SimLoadResult;

function fakeClient(result: SimLoadResult): SimClient {
  return {
    setSimSinks: () => {},
    loadSim: async () => result,
    requestFrame: () => {},
    simPath: async () => ({ xyz: new Float32Array(0), step: new Uint32Array(0), kind: new Uint8Array(0), t: new Float32Array(0) }),
    disposeSim: async () => {},
  } as unknown as SimClient;
}

async function load(): Promise<void> {
  await useSimStore.getState().loadProgram(PROGRAM, SETUP, TOOL, 'Z1');
}

/** The same program, but with an arbitrary result standing in for what the sweep answered. */
async function loadWith(result: SimLoadResult): Promise<void> {
  setSimClientLoader(async () => fakeClient(result));
  await useSimStore.getState().loadProgram(PROGRAM, SETUP, TOOL, 'Z1');
}

/** The #393 case: the sweep produced material (`ok: true`) and found the cutter in the jaw. */
const INTO_JAW = {
  ...READY,
  diagnostics: [{ source: 'sweep', severity: 'error', code: 'tool-into-fixture', message: 'the cutter is inside the fixed jaw', checkpoint: 1 }],
} as unknown as SimLoadResult;

/** The runner drew a path and the sweep refused: no material, so nothing to restart from. */
const PATH_ONLY = {
  ok: false,
  pathOnly: true,
  diagnostics: [{ source: 'sweep', severity: 'error', code: 'tool-into-fixture', message: 'the cutter is inside the fixed jaw', checkpoint: 1 }],
  summary: { steps: EVENTS, diagnosticCounts: {} },
  pauses: [],
} as unknown as SimLoadResult;

beforeEach(() => {
  setSimClientLoader(async () => fakeClient(READY));
  useSimStore.setState({ status: 'idle', restart: null, step: -1, stepCount: 0, path: null, info: null } as Partial<SimState>);
});

afterEach(async () => {
  // `dispose` is what clears the module-private `lastLoad`, so a later spec starts with none.
  await useSimStore.getState().dispose();
  setSimClientLoader(null);
});

describe('simStore.generateRestart (#249)', () => {
  it('generates a restart for the loaded program at the current step', async () => {
    await load();
    expect(useSimStore.getState().status).toBe('ready');
    useSimStore.getState().setStep(CUT_STEP);

    useSimStore.getState().generateRestart({ baseName: 'job.nc' });
    const r = useSimStore.getState().restart;
    expect(r).not.toBeNull();
    expect(r?.ok).toBe(true);
    expect(r?.fileName).toBe(`job-restart-step${CUT_STEP}.nc`);
    expect(r?.nc as string).toContain('G90 G21');
    expect(r?.runSheet).toContain(RESTART_TOOL_LENGTH_NOTE);
    expect(r?.verify?.ok).toBe(true);
  });

  it('clears the restart on a fresh load and on clearRestart', async () => {
    await load();
    useSimStore.getState().setStep(CUT_STEP);
    useSimStore.getState().generateRestart({ baseName: 'job' });
    expect(useSimStore.getState().restart).not.toBeNull();

    useSimStore.getState().clearRestart();
    expect(useSimStore.getState().restart).toBeNull();

    useSimStore.getState().generateRestart({ baseName: 'job' });
    expect(useSimStore.getState().restart).not.toBeNull();
    await load();
    expect(useSimStore.getState().restart).toBeNull();
  });

  it('does nothing before a program is loaded', () => {
    useSimStore.setState({ restart: null } as Partial<SimState>);
    useSimStore.getState().generateRestart({ baseName: 'job' });
    expect(useSimStore.getState().restart).toBeNull();
  });

  // #395 — `status: 'ready'` and "this program is safe" are different questions (#393). The pin
  // here is that the safety one is asked: the restart's own verifier checks the STOCK's depth
  // limit, so a file whose cutter went into the fixed jaw verifies clean and would repeat it.
  it('refuses when the sweep found an error, even though the load is `ready`', async () => {
    await loadWith(INTO_JAW);
    // The load is not refused — the panel draws the gouged cut, which is the point of #194.
    expect(useSimStore.getState().status).toBe('ready');
    useSimStore.getState().setStep(CUT_STEP);
    expect(useSimStore.getState().restart).toBeNull();

    useSimStore.getState().generateRestart({ baseName: 'job.nc' });
    const r = useSimStore.getState().restart;
    expect(r?.ok).toBe(false);
    expect(r?.nc).toBeNull();
    expect(r?.fileName).toBeNull();
    expect(r?.verify).toBeNull();
    expect(r?.runSheet).toEqual([]);
    expect(r?.errors).toHaveLength(1);
    // The error it names is the one the sweep raised, with its checkpoint — not a count.
    expect(r?.errors[0]).toMatch(/tool-into-fixture at checkpoint 1/);
  });

  it('refuses when the load was path-only: the sweep refused, so there is nothing to resume', async () => {
    await loadWith(PATH_ONLY);
    const s = useSimStore.getState();
    expect(s.status).toBe('refused');
    expect(s.pathOnly).toBe(true);
    expect(s.stepCount).toBeGreaterThan(0); // a path-only load still owns the timeline (#194)

    useSimStore.getState().generateRestart({ baseName: 'job.nc' });
    const r = useSimStore.getState().restart;
    expect(r?.ok).toBe(false);
    expect(r?.nc).toBeNull();
    expect(r?.errors).toHaveLength(1);
    // Both facts, because both are true: the sweep's own errors AND that there is no material.
    expect(r?.errors[0]).toMatch(/tool-into-fixture at checkpoint 1/);
    expect(r?.errors[0]).toMatch(/only its path was drawn and no material was cut/);
  });

  it('still generates one when the sweep raised only warnings', async () => {
    await loadWith({ ...READY, diagnostics: [{ source: 'sweep', severity: 'warning', code: 'thin-floor', message: 'the floor is thin' }] } as unknown as SimLoadResult);
    useSimStore.getState().setStep(CUT_STEP);
    useSimStore.getState().generateRestart({ baseName: 'job.nc' });
    expect(useSimStore.getState().restart?.ok).toBe(true);
  });
});
