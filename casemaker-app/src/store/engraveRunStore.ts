/**
 * The engrave RUN state (#206): one Generate press takes the job through
 * generate → verify → simulate → oracle, and this store owns the result, the phase and the
 * staleness rule.
 *
 * The rule the whole issue turns on: a result is only savable while it still describes the job
 * on screen. Any edit to the job after a Generate marks the run STALE (the subscription at the
 * bottom), and a stale run cannot be saved — the user regenerates. There is no "save anyway".
 *
 * It holds no wasm handle and no mesh: `engraveGenerate` returns plain data and the oracle a
 * plain report. The sim program itself lives in `simStore` (this store only drives its load and
 * reads its diagnostics); the client is reached by a dynamic `import()` behind `__FEATURE_SIM__`,
 * exactly as `engravePreviewStore.ts` does, so a build with the flag off contains neither the sim
 * client nor its worker.
 */

import { create } from 'zustand';
import type { EngraveJob } from '@/types/engraveJob';
import type { EngraveGenerated } from '@/workers/sim/engraveGenerate';
import type { OraclePredicted, OracleReport } from '@/engine/cnc/engrave/oracle';
import type { SimDiagnostic } from '@/workers/sim/session';
import type { SimStatus } from './simStore';
import { jobTool, toSetup } from '@/engine/cnc/engrave/jobSetup';
import { Z1 } from '@/engine/cnc/machine';
import { resolveMachine } from '@/engine/cnc/calibration';
import type { MachineCalibration } from '@/engine/cnc';
import { useSettingsStore } from './settingsStore';
import { useEngraveJobStore } from './engraveJobStore';
import { useSimStore } from './simStore';

export type EngraveRunPhase = 'idle' | 'generating' | 'simulating' | 'checking' | 'ready' | 'blocked';

/** The two worker calls the run needs. */
export type EngraveRunClient = {
  engraveGenerate: (job: EngraveJob, calibration?: MachineCalibration | null) => Promise<EngraveGenerated>;
  simOracle: (predicted: OraclePredicted[]) => Promise<OracleReport>;
};

const loadClient = async (): Promise<EngraveRunClient> => {
  if (!__FEATURE_SIM__) throw new Error('the engrave run is not enabled in this build');
  return import('@/engine/jobs/simClient');
};
let clientLoader: () => Promise<EngraveRunClient> = loadClient;
/** For tests: swap the (lazy) client for a fake. */
export function setEngraveRunClientLoader(fn: (() => Promise<EngraveRunClient>) | null): void {
  clientLoader = fn ?? loadClient;
}

/**
 * The warning codes that mean "a human must look at the machine before this file is run"
 * (#206): an unmeasured vise, and a holder whose reach or clearance to the fixture is not
 * proven. A warning from any of these lists requires the panel's acknowledgement tick.
 */
export const ACKNOWLEDGE_CODES: ReadonlySet<string> = new Set([
  'vise-default',
  'holder-vs-fixture-unproven',
  'holder-unproven',
]);

export interface EngraveRunState {
  /** The last generated result — kept on screen while a newer run builds. */
  generated: EngraveGenerated | null;
  oracle: OracleReport | null;
  /** The diagnostics of the simulation load this run performed (#193, #204). */
  simDiagnostics: SimDiagnostic[];
  /** The terminal status of that load, or null before it ran. */
  simStatus: SimStatus | null;
  /**
   * True when that load was PATH-ONLY — the sweep was refused and only the tool path is drawn
   * (#194). Captured here, not read back from `simStore` at render time, so the coverage
   * sentence (#243) describes the run this panel actually performed, not whatever the Simulate
   * panel loaded afterwards.
   */
  pathOnly: boolean;
  phase: EngraveRunPhase;
  /** The clearance acknowledgement (see `ACKNOWLEDGE_CODES`), reset on every Generate. */
  acknowledged: boolean;
  /** Set when the job changed after a Generate; null while the result still matches. */
  staleSince: number | null;
  /** A thrown failure from any stage that is not already a finding (generate, load, oracle). */
  error: string | null;
  /** Run the whole pipeline for the job as it is NOW. */
  generate: () => Promise<void>;
  setAcknowledged: (v: boolean) => void;
  /** Forget the run (and the staleness). Does not touch the job. */
  reset: () => void;
}

/** Everything but `generate`/`setAcknowledged`/`reset`, for the pure helpers below. */
export type EngraveRunView = Pick<
  EngraveRunState,
  'generated' | 'oracle' | 'simDiagnostics' | 'simStatus' | 'phase' | 'acknowledged' | 'staleSince' | 'error'
>;

/** Warning codes across every row, so an acknowledgement is required for the right reasons. */
export function requiredAckCodes(v: EngraveRunView): string[] {
  const codes = new Set<string>();
  for (const f of v.generated?.findings ?? []) if (f.severity === 'warning') codes.add(f.code);
  for (const f of v.generated?.verify?.findings ?? []) if (f.severity === 'warning') codes.add(f.code);
  for (const d of v.simDiagnostics) if (d.severity === 'warning') codes.add(d.code);
  return [...codes].filter((c) => ACKNOWLEDGE_CODES.has(c));
}

/** Count errors across the findings, the verifier and the sweep (#206's "zero errors"). */
export function runErrorCodes(v: EngraveRunView): string[] {
  const codes: string[] = [];
  for (const f of v.generated?.findings ?? []) if (f.severity === 'error') codes.push(f.code);
  for (const f of v.generated?.verify?.findings ?? []) if (f.severity === 'error') codes.push(f.code);
  for (const d of v.simDiagnostics) if (d.severity === 'error') codes.push(d.code);
  return codes;
}

/**
 * Why Save is disabled, or null when it is allowed. Order matters: the first true reason is the
 * one the user should fix first.
 */
export function saveBlocker(v: EngraveRunView): string | null {
  if (!v.generated) return 'Generate first.';
  if (v.staleSince !== null) return 'the job or the machine frame changed since it was generated';
  const errors = runErrorCodes(v);
  if (errors.length > 0) return `${errors.length} error${errors.length === 1 ? '' : 's'} outstanding`;
  if (v.phase === 'generating' || v.phase === 'simulating' || v.phase === 'checking') return 'the run is still going';
  if (v.generated.nc === null) return 'no program was produced';
  if (v.simStatus !== 'ready') return 'the simulation did not finish';
  if (!v.oracle) return 'the prediction has not been checked';
  if (!v.oracle.ok) return 'the simulation does not match the prediction';
  const missing = requiredAckCodes(v);
  if (missing.length > 0 && !v.acknowledged) return 'tick the clearance checkbox below';
  return null;
}

/**
 * Why uploading to the machine is disabled, or null when it is allowed (#255).
 *
 * **Never weaker than {@link saveBlocker}** — every reason Save is blocked is a reason Upload is
 * blocked, and the first line here is what makes that true rather than a coincidence of the two
 * lists happening to agree. That direction is the safe one: a program nobody may keep is certainly
 * not one to send.
 *
 * The one clause it adds is the verifier's report having to EXIST. `saveBlocker` does not need it —
 * `runErrorCodes` reads `generated.verify?.findings ?? []`, so an absent report contributes no
 * errors and a program with no report would slip through. Uploading does need it: the upload gate
 * is a statement about a report (`programUploadProblem`), and there is no such statement to make
 * without one. Reachable only from a hand-edited store, and answered with a sentence rather than a
 * crash.
 */
export function uploadBlocker(v: EngraveRunView): string | null {
  const save = saveBlocker(v);
  if (save !== null) return save;
  if (!v.generated?.verify) return 'the program carries no verifier report';
  return null;
}

let seq = 0;

export const useEngraveRunStore = create<EngraveRunState>()((set, get) => {
  const empty = {
    oracle: null,
    simDiagnostics: [] as SimDiagnostic[],
    simStatus: null as SimStatus | null,
    pathOnly: false,
    acknowledged: false,
    staleSince: null as number | null,
    error: null as string | null,
  };

  async function run(): Promise<void> {
    const job = useEngraveJobStore.getState().job;
    const mine = ++seq;
    set({ ...empty, phase: 'generating', generated: get().generated });

    // ONE machine per run (#297): the saved frame is read once, here, and handed to the generator
    // (post, verify, frame file) and to the simulation load below. Two reads could straddle a change
    // to the saved frame and leave the gate and the sim judging different machines for one .nc.
    const calibration = useSettingsStore.getState().machineCalibration ?? null;

    let client: EngraveRunClient;
    let generated: EngraveGenerated;
    try {
      client = await clientLoader();
      generated = await client.engraveGenerate(job, calibration);
    } catch (e) {
      if (mine === seq) set({ phase: 'blocked', error: e instanceof Error ? e.message : String(e) });
      return;
    }
    if (mine !== seq) return;

    // The job may have been edited while generating: the result already describes an older job. So
    // may the machine's saved frame (#301): the result was generated against the one read above.
    const stale =
      useEngraveJobStore.getState().job !== job ||
      (useSettingsStore.getState().machineCalibration ?? null) !== calibration;
    if (stale) {
      set({ generated, phase: 'blocked', staleSince: Date.now() });
      return;
    }

    set({ generated });
    if (!generated.ok || generated.nc === null) {
      set({ phase: 'blocked' });
      return;
    }

    const tool = jobTool(job);
    if (!tool) {
      set({ phase: 'blocked', error: 'the job has no usable cutter' });
      return;
    }

    set({ phase: 'simulating' });
    try {
      await useSimStore.getState().loadProgram(generated.nc, toSetup(job, resolveMachine(Z1, calibration)), tool, Z1.id, calibration);
    } catch (e) {
      if (mine === seq) set({ phase: 'blocked', error: e instanceof Error ? e.message : String(e) });
      return;
    }
    if (mine !== seq) return;

    const sim = useSimStore.getState();
    if (sim.status !== 'ready') {
      set({ phase: 'blocked', simStatus: sim.status, simDiagnostics: sim.diagnostics, pathOnly: sim.pathOnly, error: sim.status === 'error' ? sim.error : null });
      return;
    }
    set({ phase: 'checking', simStatus: sim.status, simDiagnostics: sim.diagnostics, pathOnly: sim.pathOnly });

    try {
      const oracle = await client.simOracle(generated.predicted);
      if (mine !== seq) return;
      set({ oracle, phase: oracle.ok ? 'ready' : 'blocked' });
    } catch (e) {
      if (mine === seq) set({ phase: 'blocked', error: e instanceof Error ? e.message : String(e) });
    }
  }

  return {
    generated: null,
    oracle: null,
    simDiagnostics: [],
    simStatus: null,
    pathOnly: false,
    phase: 'idle',
    acknowledged: false,
    staleSince: null,
    error: null,
    generate: run,
    setAcknowledged: (v) => set({ acknowledged: v }),
    reset: () => {
      seq += 1; // orphan any run in flight
      set({ generated: null, ...empty, phase: 'idle' });
    },
  };
});

// Any edit to the job after a Generate makes the result stale (#206). This is the whole
// "subscribe to engraveJobStore" requirement; nothing else may clear `staleSince` but a
// fresh Generate.
useEngraveJobStore.subscribe((state, prev) => {
  if (state.job === prev.job) return;
  markStale();
});

// So does a change to the machine's saved frame (#301). The program was posted, verified and
// simulated against the frame read when Generate started (#297); a different frame is a different
// machine, and Save and Upload must not carry on offering the old result.
useSettingsStore.subscribe((state, prev) => {
  if (state.machineCalibration === prev.machineCalibration) return;
  markStale();
});

function markStale(): void {
  const s = useEngraveRunStore.getState();
  if (s.generated && s.staleSince === null) useEngraveRunStore.setState({ staleSince: Date.now() });
}
