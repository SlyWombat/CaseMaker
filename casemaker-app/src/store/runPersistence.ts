/**
 * #1123 item 11 — A GENERATED RUN OUTLIVES A RELOAD.
 *
 * The bench lost a 12-minute Generate to a reload (twice: a 32-bit browser, then a machine-record
 * refresh). The run — the programs, the receipt's facts, the checks and the simulation verdicts —
 * is not a document the operator saved, so nothing kept it. This module puts it in IndexedDB and
 * restores it while its key still matches:
 *
 *     job sha  ·  build
 *
 *   - the JOB SHA is the run's own `inputs.job` — the jobFingerprint the Generate stamped, so an
 *     edit after Generate is a different job and its run is not offered back;
 *   - the BUILD is `__APP_VERSION__` + `__BUILD_COMMIT__`; a new build may read the stored result
 *     differently, so it is not restored across builds.
 *
 * THE SHOP IS NOT A KEY (review, 2026-11-09). An ETag moves for reasons that do not make the run
 * wrong — finishing a program appends to the location record, an inventory note or a probe value
 * writes, D's location poll sees an unrelated edit. The stored run keeps `shopSignature` as a
 * DIAGNOSTIC only; the precise test is `recheckRunInputs()`, which compares every input the run
 * actually stamped (margins, machine frame, shop defaults, feeds, catalogue, cutters, conditions,
 * surface) once after restoring and marks the first that moved with the ordinary named stale line.
 *
 * A BUILD MISMATCH IS NEVER SILENT. When only another build's record exists for this job, the run
 * store carries one plain sentence — "The generated run was made by a different build of the app;
 * generate again" — instead of the work simply vanishing. The note clears on the next Generate.
 *
 * Storage is IndexedDB (not localStorage): a 19-program tray run is megabytes of NC text, and the
 * job autosave's ~5 MB quota is already shared with the job. The IO is injectable so a spec runs
 * against an in-memory map (the `meshBlobs` pattern).
 */

import { useEngraveJobStore } from './engraveJobStore';
import { useEngraveRunStore, recheckRunInputs, type EngraveRunState } from './engraveRunStore';
import { useToolRegistryStore } from './toolRegistryStore';
import { useLocationStore } from './locationStore';
import { jobFingerprint } from '@/engine/cnc/engrave/package';
import type { EngraveRunInputs } from '@/engine/cnc/engrave/runInputs';
import type { EngraveJob } from '@/types/engraveJob';

/** The plain line when the stored run belongs to another build. */
export const BUILD_CHANGED_NOTE = 'The generated run was made by a different build of the app; generate again';

/** The durable half of a settled run. Live fields (progress, error, simProgram, simStopped) stay out. */
export type PersistedRunState = Pick<
  EngraveRunState,
  | 'generated'
  | 'oracle'
  | 'oraclePrograms'
  | 'simDiagnostics'
  | 'simStatus'
  | 'pathOnly'
  | 'simEngine'
  | 'simGridPitchMm'
  | 'simPrograms'
  | 'runMount'
  | 'phase'
  | 'acknowledged'
  | 'acknowledgedFor'
  | 'staleSince'
  | 'staleReason'
  | 'inputs'
  | 'changedSinceLast'
  | 'previousVerdict'
  | 'shopSignature'
>;

export interface StoredRunRecord {
  /** `jobSha:build:shopSignature` — one record per exact key; the latest run wins. */
  id: string;
  jobSha: string;
  build: string;
  shopSignature: string;
  savedAt: string;
  state: PersistedRunState;
}

/** The store's seam; a spec supplies an in-memory map. */
export interface RunRecordIO {
  put: (record: StoredRunRecord) => Promise<void>;
  listByJob: (jobSha: string) => Promise<StoredRunRecord[]>;
}

export type RunRestoreOutcome = 'restored' | 'none' | 'build-changed' | 'busy';

export interface RestoreRunOptions {
  /** The open job. Defaults to the job store's. */
  job?: EngraveJob;
  /** Its fingerprint, when a caller already has it (the spec passes one). */
  jobSha?: string;
  build?: string;
  io?: RunRecordIO;
  /** A spec seam: the stamps the current stores would produce (see `recheckRunInputs`). */
  currentInputs?: EngraveRunInputs;
  /** False skips waiting for the house reads (the spec). */
  settle?: boolean;
  waitMs?: number;
  /** False skips the post-restore input comparison (the spec's fabricated stamps). */
  recheck?: boolean;
}

const DB_NAME = 'casemaker-runs';
const STORE = 'runs';
const INDEX = 'jobSha';
/** How many stored runs to keep. A run is megabytes; ten is plenty for the bench's two jobs. */
const MAX_RECORDS = 10;

let io: RunRecordIO | null = null;

/** Test seam: replace the IndexedDB store (the app never calls this). `null` restores it. */
export function setRunRecordIO(next: RunRecordIO | null): void {
  io = next;
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB is not available in this build'));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex(INDEX, 'jobSha');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('the run store could not be opened'));
  });
}

async function prune(db: IDBDatabase): Promise<void> {
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  const all = await new Promise<StoredRunRecord[]>((resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result as StoredRunRecord[]);
    request.onerror = () => reject(request.error ?? new Error('the run store could not be read'));
  });
  if (all.length <= MAX_RECORDS) return;
  all.sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
  for (const old of all.slice(MAX_RECORDS)) store.delete(old.id);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('the run store could not be pruned'));
  });
}

function indexedDbIO(): RunRecordIO {
  return {
    async put(record) {
      const db = await openDatabase();
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).put(record);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error ?? new Error('the run could not be stored'));
        });
        await prune(db);
      } finally {
        db.close();
      }
    },
    async listByJob(jobSha) {
      const db = await openDatabase();
      try {
        return await new Promise<StoredRunRecord[]>((resolve, reject) => {
          const tx = db.transaction(STORE, 'readonly');
          const request = tx.objectStore(STORE).index(INDEX).getAll(jobSha);
          request.onsuccess = () => resolve(request.result as StoredRunRecord[]);
          request.onerror = () => reject(request.error ?? new Error('the stored runs could not be read'));
        });
      } finally {
        db.close();
      }
    },
  };
}

function recordIO(): RunRecordIO {
  return io ?? indexedDbIO();
}

/** `__APP_VERSION__` + `__BUILD_COMMIT__`; both are build-time constants (vite's `define`). */
export function runBuildId(): string {
  const version = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'unknown';
  const commit = typeof __BUILD_COMMIT__ === 'string' && __BUILD_COMMIT__ !== '' ? __BUILD_COMMIT__ : 'unknown';
  return `${version}+${commit}`;
}

/** The durable half of a run state, as plain data ready for IndexedDB. */
export function snapshotRun(state: EngraveRunState): PersistedRunState {
  return {
    generated: state.generated,
    oracle: state.oracle,
    oraclePrograms: state.oraclePrograms,
    simDiagnostics: state.simDiagnostics,
    simStatus: state.simStatus,
    pathOnly: state.pathOnly,
    simEngine: state.simEngine,
    simGridPitchMm: state.simGridPitchMm,
    simPrograms: state.simPrograms,
    runMount: state.runMount,
    phase: state.phase,
    acknowledged: state.acknowledged,
    acknowledgedFor: state.acknowledgedFor,
    staleSince: state.staleSince,
    staleReason: state.staleReason,
    inputs: state.inputs,
    changedSinceLast: state.changedSinceLast,
    previousVerdict: state.previousVerdict,
    shopSignature: state.shopSignature,
  };
}

/**
 * Write the settled run now, or null when there is nothing settled to write. The key's job sha is
 * the run's own stamp (`inputs.job`), not the job as it is at save time: a job edited after
 * Generate must not lend its identity to the old program.
 */
export async function persistRunNow(
  state: EngraveRunState = useEngraveRunStore.getState(),
  target: RunRecordIO = recordIO(),
): Promise<StoredRunRecord | null> {
  if (state.generated === null || state.inputs === null || state.shopSignature === null) return null;
  if (state.phase !== 'ready' && state.phase !== 'blocked') return null;
  const build = runBuildId();
  const record: StoredRunRecord = {
    id: `${state.inputs.job}:${build}`,
    jobSha: state.inputs.job,
    build,
    shopSignature: state.shopSignature,
    savedAt: new Date().toISOString(),
    state: snapshotRun(state),
  };
  try {
    await target.put(record);
    return record;
  } catch {
    return null; // no durable copy: the next reload is the one the beforeunload warning protects
  }
}

/** True only while a reload would drop work that is not yet in durable storage. */
export function shouldWarnBeforeReload(state: Pick<EngraveRunState, 'phase' | 'generated'>): boolean {
  return state.phase === 'generating' || state.phase === 'simulating' || state.phase === 'checking';
}

/**
 * Keep the settled runs stored, and warn before a reload that would drop an in-flight one.
 * Returns the teardown (the App's effect).
 */
export function startRunPersistence(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void persistRunNow();
    }, 150);
  };
  const unsubscribe = useEngraveRunStore.subscribe((state, prev) => {
    if (
      state.phase !== prev.phase ||
      state.generated !== prev.generated ||
      state.oracle !== prev.oracle ||
      state.simStatus !== prev.simStatus ||
      state.acknowledgedFor !== prev.acknowledgedFor ||
      state.staleSince !== prev.staleSince ||
      state.shopSignature !== prev.shopSignature
    ) {
      schedule();
    }
  });
  const onBeforeUnload = (event: BeforeUnloadEvent): void => {
    if (!shouldWarnBeforeReload(useEngraveRunStore.getState())) return;
    event.preventDefault();
    // The legacy contract still needs returnValue in some browsers; the string is not shown.
    event.returnValue = '';
  };
  if (typeof window !== 'undefined') window.addEventListener('beforeunload', onBeforeUnload);
  return () => {
    unsubscribe();
    if (timer !== null) clearTimeout(timer);
    if (typeof window !== 'undefined') window.removeEventListener('beforeunload', onBeforeUnload);
  };
}

/**
 * Whether the house reads the shop signature is made of have settled. A build with no service
 * settles at once (`tools: 'absent'`): there will never be a location read to wait for. True
 * means the signature is meaningful; false means it is not, and a mismatch must not be stated.
 */
function shopSettled(): boolean {
  const tools = useToolRegistryStore.getState().status;
  const location = useLocationStore.getState().status;
  if (tools === 'checking') return false;
  if (location !== 'unknown') return true;
  return tools === 'absent';
}

async function waitForShopSettled(ms: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (shopSettled()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return shopSettled();
}

/**
 * Restore the stored run for the open job, after the first render. Called once at boot; a run
 * already generated in this session is never overwritten ('busy').
 */
export async function restoreOpenRun(options: RestoreRunOptions = {}): Promise<RunRestoreOutcome> {
  const run = useEngraveRunStore.getState();
  if (run.phase !== 'idle' || run.generated !== null) return 'busy';
  // Wait briefly for the reads the RECHECK compares. An unanswered house no longer blocks the
  // restore (the key is job+build): restore anyway, skip the one-shot comparison, and let the live
  // watchers judge each input as its store settles.
  const settled = options.settle === false ? true : await waitForShopSettled(options.waitMs ?? 3000);
  const job = options.job ?? useEngraveJobStore.getState().job;
  const jobSha = options.jobSha ?? jobFingerprint(job);
  const build = options.build ?? runBuildId();
  const target = options.io ?? recordIO();
  let records: StoredRunRecord[];
  try {
    records = await target.listByJob(jobSha);
  } catch {
    return 'none';
  }
  if (records.length === 0) return 'none';
  const sameBuild = records
    .filter((record) => record.build === build)
    .sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
  if (sameBuild.length === 0) {
    useEngraveRunStore.setState({ restoreNote: BUILD_CHANGED_NOTE });
    return 'build-changed';
  }
  // The latest run this build stored for the job. The shop is not consulted: the recheck below is
  // the precise test, and an ETag moved by a record write must not throw the run away.
  const record = sameBuild[0]!;
  useEngraveRunStore.setState({
    ...record.state,
    progress: null,
    simProgram: null,
    error: null,
    simStopped: false,
    restoreNote: null,
  });
  if (options.recheck !== false && settled) recheckRunInputs(options.currentInputs);
  return 'restored';
}
