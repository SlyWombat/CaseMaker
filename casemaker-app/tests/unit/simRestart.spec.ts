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
  'M7',
  'S12000 M3',
  'G0 X2 Y2 Z5',
  'G0 Z1',
  'G1 Z-1 F200',
  'G1 X10 Y2',
  'G1 X10 Y6',
  'G1 X2 Y6',
  'G0 Z15',
  'M9',
  'M5',
  'G28',
  'M02',
].join('\n');

const EVENTS = buildTimeline(parseGcode(PROGRAM), SETUP, Z1).events.length;
/** The event index of the first cut move: resuming there restores the tool at [2, 2, −1]. */
const CUT_STEP = 6;

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
});
