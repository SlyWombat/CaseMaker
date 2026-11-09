// @vitest-environment jsdom
// #1123 item 11 — a 12-minute Generate survives a reload.
//
// The stored run is keyed by (job sha, build). Red-first behaviours:
//   - the same job and build restore the programs/receipt/checks/simulation verdicts;
//   - a shop ETag moving WITHOUT an input change (a finished program writes the location record)
//     does NOT refuse the run: it restores and stays current;
//   - a changed feeds table restores the run and marks it stale with the ordinary 'feeds' reason;
//   - only another build's record does not restore, and says so in one plain line;
//   - an in-flight run is warned about before a reload drops it.
import { beforeEach, describe, expect, it } from 'vitest';
import { runShopSignature, useEngraveRunStore } from '@/store/engraveRunStore';
import { useLocationStore } from '@/store/locationStore';
import { useToolRegistryStore } from '@/store/toolRegistryStore';
import type { EngraveGenerated } from '@/workers/sim/engraveGenerate';
import {
  BUILD_CHANGED_NOTE,
  persistRunNow,
  restoreOpenRun,
  runBuildId,
  setRunRecordIO,
  shouldWarnBeforeReload,
  snapshotRun,
  type PersistedRunState,
  type RunRecordIO,
  type StoredRunRecord,
} from '@/store/runPersistence';

const GENERATED = { ok: true, stage: 'done', nc: 'G0 X0 Y0\nG1 Z-1 F100\n', programs: [] } as unknown as EngraveGenerated;

/** The stamps a real run keeps; only their equality matters here. */
const INPUTS = {
  hold: 'h',
  job: 'job-sha-1',
  margins: 'm',
  machine: 'mc',
  shop: 's',
  feeds: 'f',
  catalogue: 'c',
  cutters: 'ct',
  surface: 'sf',
} as const;

function runState(over: Partial<PersistedRunState> = {}): PersistedRunState {
  return {
    generated: GENERATED,
    oracle: null,
    oraclePrograms: [],
    simDiagnostics: [],
    simStatus: 'ok',
    pathOnly: false,
    simEngine: null,
    simGridPitchMm: null,
    simPrograms: [],
    phase: 'ready',
    acknowledged: false,
    acknowledgedFor: null,
    staleSince: null,
    staleReason: null,
    inputs: INPUTS,
    changedSinceLast: [],
    previousVerdict: null,
    lastGenerateMs: null,
    shopSignature: 'shop-a',
    ...over,
  } as PersistedRunState;
}

function record(over: Partial<StoredRunRecord> = {}): StoredRunRecord {
  const build = runBuildId();
  const shopSignature = over.shopSignature ?? 'shop-a';
  const jobSha = over.jobSha ?? 'job-sha-1';
  return {
    id: `${jobSha}:${build}`,
    jobSha,
    build,
    shopSignature,
    savedAt: '2026-11-09T15:00:00.000Z',
    state: runState(),
    ...over,
  };
}

function memoryIO(records: StoredRunRecord[] = []): RunRecordIO & { written: StoredRunRecord[] } {
  const store = new Map(records.map((r) => [r.id, r]));
  const written: StoredRunRecord[] = [];
  return {
    written,
    put: async (r) => {
      store.set(r.id, r);
      written.push(r);
    },
    listByJob: async (jobSha) => [...store.values()].filter((r) => r.jobSha === jobSha),
  };
}

const exact = (io: RunRecordIO) => ({
  io,
  settle: false,
  jobSha: 'job-sha-1',
  build: runBuildId(),
  currentInputs: INPUTS,
});

beforeEach(() => {
  useEngraveRunStore.getState().reset();
  setRunRecordIO(null);
  // A settled, service-less shop by default; the unsettled test sets its own.
  useToolRegistryStore.setState({ status: 'absent' });
  useLocationStore.setState({ status: 'absent', etag: null, location: null });
});

describe('#1123 item 11 — a generated run is restored while its key matches', () => {
  it('restores the programs, checks and simulation verdicts for the same job, build and shop', async () => {
    const io = memoryIO([record()]);
    expect(await restoreOpenRun(exact(io))).toBe('restored');
    const run = useEngraveRunStore.getState();
    expect(run.generated).toEqual(GENERATED);
    expect(run.phase).toBe('ready');
    expect(run.simStatus).toBe('ok');
    expect(run.inputs).toEqual(INPUTS);
    expect(run.restoreNote).toBeNull();
    // Nothing from a live run leaks in.
    expect(run.progress).toBeNull();
    expect(run.error).toBeNull();
    expect(run.simProgram).toBeNull();
  });

  it('a location-record write that moves only the ETag (a finished program) does not stop the restore', async () => {
    // The bench case: cutting p01 appends to the location's finishedPrograms, which moves the
    // location ETag. That is not an input the run stamped, so the run must come back and stay
    // current — the shop signature is a diagnostic, never a key.
    useLocationStore.setState({ status: 'present', etag: 'etag-before-the-cut', location: null, reason: null });
    const io = memoryIO([record({ shopSignature: runShopSignature() })]);
    useLocationStore.setState({ etag: 'etag-after-the-finished-program' });
    expect(await restoreOpenRun(exact(io))).toBe('restored');
    const run = useEngraveRunStore.getState();
    expect(run.generated).toEqual(GENERATED);
    expect(run.staleSince).toBeNull();
    expect(run.staleReason).toBeNull();
    expect(run.restoreNote).toBeNull();
  });

  it('an unsettled house keeps the restored run unverified until the reads settle, then compares every input', async () => {
    useToolRegistryStore.setState({ status: 'checking' });
    useLocationStore.setState({ status: 'unknown' });
    const io = memoryIO([record()]);
    const outcome = await restoreOpenRun({
      ...exact(io),
      settle: true,
      waitMs: 20,
      currentInputs: { ...INPUTS, margins: 'm-changed' },
    });
    expect(outcome).toBe('restored');
    const before = useEngraveRunStore.getState();
    expect(before.generated).toEqual(GENERATED);
    expect(before.restoreChecking).toBe(true);
    expect(before.staleSince).toBeNull();
    // The reads settle (a no-service build answers 'absent'); the deferred comparison runs once.
    useToolRegistryStore.setState({ status: 'absent' });
    const after = useEngraveRunStore.getState();
    expect(after.restoreChecking).toBe(false);
    expect(after.staleSince).not.toBeNull();
    expect(after.staleReason).toBe('margins');
  });

  it('the deferred comparison clears the unverified state when nothing moved', async () => {
    useToolRegistryStore.setState({ status: 'checking' });
    useLocationStore.setState({ status: 'unknown' });
    const io = memoryIO([record()]);
    expect(await restoreOpenRun({ ...exact(io), settle: true, waitMs: 20 })).toBe('restored');
    expect(useEngraveRunStore.getState().restoreChecking).toBe(true);
    useToolRegistryStore.setState({ status: 'absent' });
    const after = useEngraveRunStore.getState();
    expect(after.restoreChecking).toBe(false);
    expect(after.staleSince).toBeNull();
    expect(after.staleReason).toBeNull();
  });

  it('a changed FEEDS table restores the run and marks it stale with the ordinary named reason', async () => {
    const io = memoryIO([record()]);
    expect(await restoreOpenRun({ ...exact(io), currentInputs: { ...INPUTS, feeds: 'f-changed' } })).toBe('restored');
    const run = useEngraveRunStore.getState();
    expect(run.generated).toEqual(GENERATED);
    expect(run.staleSince).not.toBeNull();
    expect(run.staleReason).toBe('feeds');
  });

  it('a different build does not restore, and says why', async () => {
    const io = memoryIO([record({ build: '1.0.0+oldcommit' })]);
    expect(await restoreOpenRun(exact(io))).toBe('build-changed');
    expect(useEngraveRunStore.getState().generated).toBeNull();
    expect(useEngraveRunStore.getState().restoreNote).toBe(BUILD_CHANGED_NOTE);
    expect(BUILD_CHANGED_NOTE).toBe('The generated run was made by a different build of the app; generate again');
  });

  it('no stored run is silent, not a note', async () => {
    expect(await restoreOpenRun(exact(memoryIO()))).toBe('none');
    expect(useEngraveRunStore.getState().generated).toBeNull();
    expect(useEngraveRunStore.getState().restoreNote).toBeNull();
  });

  it('never overwrites a run already generated in this session', async () => {
    useEngraveRunStore.setState({ generated: GENERATED, phase: 'ready' });
    expect(await restoreOpenRun(exact(memoryIO([record({ state: runState({ generated: null }) })])))).toBe('busy');
    expect(useEngraveRunStore.getState().generated).toBe(GENERATED);
  });
});

describe('#1123 item 11 — saving a settled run', () => {
  it('snapshots the durable fields and drops the live ones', () => {
    const snapshot = snapshotRun({
      ...useEngraveRunStore.getState(),
      ...runState(),
      progress: { op: 'sequence', fraction: 0.35, text: 'planning' } as never,
      error: 'a live error',
      simProgram: { index: 2, count: 5 },
    });
    expect(snapshot.generated).toEqual(GENERATED);
    expect(snapshot.shopSignature).toBe('shop-a');
    expect(snapshot).not.toHaveProperty('progress');
    expect(snapshot).not.toHaveProperty('error');
    expect(snapshot).not.toHaveProperty('simProgram');
  });

  it('writes one record keyed by job sha, build and the run’s own shop signature', async () => {
    const io = memoryIO();
    setRunRecordIO(io);
    const written = await persistRunNow({
      ...useEngraveRunStore.getState(),
      ...runState(),
    } as never);
    expect(written).not.toBeNull();
    expect(io.written).toHaveLength(1);
    expect(io.written[0]).toMatchObject({
      jobSha: 'job-sha-1',
      build: runBuildId(),
      shopSignature: 'shop-a',
    });
    expect(io.written[0]!.id).toBe(`job-sha-1:${runBuildId()}`);
  });

  it('does not write before there is a settled run', async () => {
    const io = memoryIO();
    setRunRecordIO(io);
    expect(await persistRunNow({ ...useEngraveRunStore.getState(), ...runState({ generated: null }) } as never)).toBeNull();
    expect(await persistRunNow({ ...useEngraveRunStore.getState(), ...runState({ phase: 'generating' }) } as never)).toBeNull();
    expect(io.written).toHaveLength(0);
  });

  it('warns before a reload only while a run is in flight', () => {
    expect(shouldWarnBeforeReload({ phase: 'generating', generated: null })).toBe(true);
    expect(shouldWarnBeforeReload({ phase: 'simulating', generated: GENERATED })).toBe(true);
    expect(shouldWarnBeforeReload({ phase: 'checking', generated: GENERATED })).toBe(true);
    expect(shouldWarnBeforeReload({ phase: 'ready', generated: GENERATED })).toBe(false);
    expect(shouldWarnBeforeReload({ phase: 'idle', generated: null })).toBe(false);
  });
});
