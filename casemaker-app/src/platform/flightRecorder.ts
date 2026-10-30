/**
 * #787 — THE FLIGHT RECORDER: a record of what the app was doing that outlives the tab.
 *
 * Why it exists: an out-of-memory renderer kill ("Aw, Snap", error code Out of Memory) leaves no
 * JS stack, and Chrome's Crashpad minidumps are off on the maintainer's machine and would not show
 * our state anyway. So the app keeps its own record: breadcrumbs written WHILE it works, into
 * IndexedDB (a dead tab cannot lose them), plus a session marker that survives a crash and is
 * cleared only on a clean unload.
 *
 * WHAT IS A CRUMB. A small JSON object with a timestamp — a session start, the start and end of a
 * heavy work run, a worker stage, a coarse progress count, a memory sample, a finding. The ring
 * holds the LAST {@link CRUMB_LIMIT} crumbs (~1 MB at most); older ones fall off, because the only
 * crumbs worth reading are the ones nearest the stop.
 *
 * THE MARKER IS localStorage, THE CRUMBS ARE IndexedDB. The marker is one tiny record written at
 * load and cleared on unload; a clean exit's unload handler must write it synchronously, which
 * IndexedDB cannot promise during `pagehide`. The crumbs are many and only need to be durable
 * soon, not synchronously, so they go where the meshes go (#720): IndexedDB, with an injectable
 * seam for specs.
 *
 * NOTHING LEAVES THE MACHINE. The recorder only records. Saving a report writes a local file; the
 * separate Send action (crash report store) is the user's press, and the test in its own module
 * holds that line.
 *
 * IndexedDB and localStorage are absent in some contexts (jsdom, a locked-down build): every write
 * is best-effort and every failure is swallowed — a crash recorder must never be the thing that
 * breaks the app it is watching.
 */

export type CrumbKind = 'session' | 'work' | 'stage' | 'progress' | 'memory' | 'finding' | 'error' | 'note';

/** The heavy work a crumb belongs to. `preview` and `import` are the other long-running paths. */
export type WorkScope = 'generate' | 'simulate' | 'smart-pick' | 'preview' | 'import';

export interface Crumb {
  /** ms since epoch. */
  at: number;
  kind: CrumbKind;
  work?: WorkScope;
  /** A stage name from the worker or the store: 'sample', 'plan', 'post', 'sweep', 'playback'. */
  stage?: string;
  /** Human words for the stage, e.g. 'roughing level 41 of 112'. */
  label?: string;
  done?: number;
  total?: number;
  /** Free-form, JSON-safe facts (the job's size numbers, a finding's code/severity, heap numbers). */
  data?: Record<string, unknown>;
}

/** The last 500 crumbs, or however many fit in ~1 MB — whichever bound binds first. */
export const CRUMB_LIMIT = 500;
export const CRUMB_BYTES_LIMIT = 1_000_000;

/** How long a crumb may sit in memory before it is written to IndexedDB. */
const FLUSH_DELAY_MS = 400;

/** What a heavy work run looked like when it started — the facts the report quotes. */
export interface WorkFacts {
  /** The job's name and its content fingerprint, so the report says WHICH job. */
  jobName?: string;
  jobFingerprint?: string;
  /** Stock L × W × T, mm. */
  stock?: { length: number; width: number; thickness: number };
  /** Enabled item count, and the goal mesh's triangle count and bytes when a goal is being cut. */
  items?: number;
  goalTriangles?: number;
  goalBytes?: number;
  /** The job document, WITHOUT its mesh bytes (they are named by hash in `goalHashes`). */
  job?: unknown;
  /** The meshes the job references: name, hash, format and size — never the bytes here. */
  meshes?: { name: string; sha256: string; format: string; bytes: number }[];
}

/** The marker a clean unload clears; a crash leaves it set for the next load to find. */
export interface SessionMarker {
  id: string;
  startedAt: number;
  appVersion: string;
  commit: string | null;
  /** The work that was running when the marker was last touched, and its stage. */
  work: WorkScope | null;
  stage: string | null;
  label: string | null;
}

/** What the previous (unclean) session left: its marker and its last crumbs. */
export interface PreviousSession {
  marker: SessionMarker;
  crumbs: Crumb[];
}

/** The persistence seam, injectable so a spec runs without IndexedDB or a browser. */
export interface FlightCrumbIO {
  load(): Promise<Crumb[]>;
  save(crumbs: readonly Crumb[]): Promise<void>;
}

/** The marker seam (localStorage by default). */
export interface FlightMarkerIO {
  read(): SessionMarker | null;
  write(marker: SessionMarker | null): void;
}

let crumbIO: FlightCrumbIO | null = null;
let markerIO: FlightMarkerIO | null = null;
let ring: Crumb[] = [];
let ringBytes = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let started = false;
let session: SessionMarker | null = null;
let unloadBound = false;
let memoryTimer: ReturnType<typeof setInterval> | null = null;

const DEFAULT_DB = 'casemaker-flight-recorder';
const DEFAULT_STORE = 'recorder';
const DEFAULT_KEY = 'crumbs';
const MARKER_KEY = 'casemaker.flight.session.v1';

/** Spec seam for the crumb store. `null` restores IndexedDB. */
export function setFlightCrumbIO(io: FlightCrumbIO | null): void {
  crumbIO = io;
}
/** Spec seam for the marker store. `null` restores localStorage. */
export function setFlightMarkerIO(io: FlightMarkerIO | null): void {
  markerIO = io;
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB is not available'));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DEFAULT_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DEFAULT_STORE)) db.createObjectStore(DEFAULT_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('the flight recorder store could not be opened'));
  });
}

function defaultCrumbs(): FlightCrumbIO {
  return {
    async load() {
      try {
        const db = await openDatabase();
        try {
          return await new Promise<Crumb[]>((resolve, reject) => {
            const tx = db.transaction(DEFAULT_STORE, 'readonly');
            const request = tx.objectStore(DEFAULT_STORE).get(DEFAULT_KEY);
            request.onsuccess = () => resolve(Array.isArray(request.result) ? (request.result as Crumb[]) : []);
            request.onerror = () => reject(request.error ?? new Error('the crumbs could not be read'));
          });
        } finally {
          db.close();
        }
      } catch {
        return [];
      }
    },
    async save(crumbs) {
      try {
        const db = await openDatabase();
        try {
          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(DEFAULT_STORE, 'readwrite');
            tx.objectStore(DEFAULT_STORE).put(crumbs, DEFAULT_KEY);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error ?? new Error('the crumbs could not be stored'));
            tx.onabort = () => reject(tx.error ?? new Error('the crumbs could not be stored'));
          });
        } finally {
          db.close();
        }
      } catch {
        // A recorder that cannot record must not disturb the app it is watching.
      }
    },
  };
}

function defaultMarker(): FlightMarkerIO {
  return {
    read() {
      try {
        if (typeof localStorage === 'undefined') return null;
        const raw = localStorage.getItem(MARKER_KEY);
        if (raw === null) return null;
        const parsed: unknown = JSON.parse(raw);
        return typeof parsed === 'object' && parsed !== null ? (parsed as SessionMarker) : null;
      } catch {
        return null;
      }
    },
    write(marker) {
      try {
        if (typeof localStorage === 'undefined') return;
        if (marker === null) localStorage.removeItem(MARKER_KEY);
        else localStorage.setItem(MARKER_KEY, JSON.stringify(marker));
      } catch {
        // As above: a full or blocked store silences the recorder, nothing else.
      }
    },
  };
}

function bytesOf(crumb: Crumb): number {
  try {
    return JSON.stringify(crumb).length;
  } catch {
    return 64;
  }
}

/** The in-memory ring, oldest first. A copy: the caller must not edit the recorder's state. */
export function flightCrumbs(): Crumb[] {
  return ring.map((c) => ({ ...c }));
}

/** The current session's marker, or null before `startFlightRecorder`. */
export function flightSession(): SessionMarker | null {
  return session === null ? null : { ...session };
}

function trim(): void {
  while (ring.length > CRUMB_LIMIT) {
    ringBytes -= bytesOf(ring[0]!);
    ring.shift();
  }
  while (ringBytes > CRUMB_BYTES_LIMIT && ring.length > 1) {
    ringBytes -= bytesOf(ring[0]!);
    ring.shift();
  }
  if (ringBytes < 0) ringBytes = 0;
}

function scheduleFlush(): void {
  if (typeof setTimeout === 'undefined') return;
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushFlightRecorder();
  }, FLUSH_DELAY_MS);
}

/** Write the ring to its store NOW. Best-effort; safe to call at any time. */
export async function flushFlightRecorder(): Promise<void> {
  const io = crumbIO ?? defaultCrumbs();
  await io.save(ring);
}

/**
 * Append one crumb to the ring. The only writer of the in-memory state; every note below funnels
 * through here. A `stage` crumb forces a flush — stages are few and the crash matters most between
 * them; progress crumbs ride the debounce.
 */
export function recordCrumb(crumb: Omit<Crumb, 'at'> & { at?: number }): void {
  const full: Crumb = { at: crumb.at ?? Date.now(), ...crumb };
  ring.push(full);
  ringBytes += bytesOf(full);
  trim();
  if (full.kind === 'stage' || full.kind === 'work') void flushFlightRecorder();
  else scheduleFlush();
}

/** The browser facts a report opens with. Absent pieces stay absent rather than guessed. */
export function environmentFacts(): Record<string, unknown> {
  const nav = typeof navigator === 'undefined' ? null : navigator;
  const perf = typeof performance === 'undefined'
    ? null
    : (performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } });
  const heap = perf?.memory;
  return {
    userAgent: nav?.userAgent ?? null,
    language: nav?.language ?? null,
    deviceMemoryGb: (nav as (Navigator & { deviceMemory?: number }) | null)?.deviceMemory ?? null,
    hardwareConcurrency: nav?.hardwareConcurrency ?? null,
    screen: typeof screen === 'undefined' ? null : { width: screen.width, height: screen.height },
    heap: heap === undefined
      ? null
      : {
          usedMb: Number((heap.usedJSHeapSize / 1_048_576).toFixed(1)),
          totalMb: Number((heap.totalJSHeapSize / 1_048_576).toFixed(1)),
          limitMb: Number((heap.jsHeapSizeLimit / 1_048_576).toFixed(1)),
        },
  };
}

/** One memory sample crumb. Called by the interval while work runs. */
export function sampleMemory(): void {
  const facts = environmentFacts();
  const heap = facts.heap as { usedMb: number; totalMb: number; limitMb: number } | null;
  if (heap === null) return;
  recordCrumb({ kind: 'memory', data: { ...heap, source: 'window' } });
}

/** Start sampling while a heavy run is in progress; a no-op when a sample has no source. */
export function startMemoryWatch(intervalMs = 5_000): void {
  stopMemoryWatch();
  if (typeof setInterval === 'undefined') return;
  memoryTimer = setInterval(sampleMemory, intervalMs);
}

export function stopMemoryWatch(): void {
  if (memoryTimer !== null) {
    clearInterval(memoryTimer);
    memoryTimer = null;
  }
}

function writeMarker(marker: SessionMarker | null): void {
  const io = markerIO ?? defaultMarker();
  io.write(marker);
}

/**
 * A clean unload: note it, stop the memory watch and CLEAR the marker, so the next load does not
 * mistake a normal close for a crash. Bound to `pagehide`/`beforeunload`; exported so a spec (and
 * a desktop close path) can invoke the same act without a window.
 */
export function markCleanExit(): void {
  stopMemoryWatch();
  if (started) recordCrumb({ kind: 'note', data: { event: 'clean-exit' } });
  writeMarker(null);
}

function bindUnload(): void {
  if (unloadBound || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  unloadBound = true;
  window.addEventListener('pagehide', markCleanExit);
  window.addEventListener('beforeunload', markCleanExit);
}

/**
 * Begin a session. Reads the previous marker — a leftover one means the last session died
 * uncleanly — and the crumbs it left; both are RETURNED for the banner, and this session's ring
 * starts empty (its first flush replaces the stored crumbs). Writes this session's marker and binds
 * the clean-exit clear.
 */
export async function startFlightRecorder(opts: {
  appVersion: string;
  commit?: string | null;
  now?: number;
}): Promise<PreviousSession | null> {
  const io = crumbIO ?? defaultCrumbs();
  const storedMarker = (markerIO ?? defaultMarker()).read();
  const previousCrumbs = await io.load();
  const previous: PreviousSession | null = storedMarker === null ? null : { marker: storedMarker, crumbs: previousCrumbs };

  ring = [];
  ringBytes = 0;
  started = true;
  session = {
    id: `s-${Date.now().toString(36)}-${Math.floor(Math.random() * 0x100000).toString(36)}`,
    startedAt: opts.now ?? Date.now(),
    appVersion: opts.appVersion,
    commit: opts.commit ?? null,
    work: null,
    stage: null,
    label: null,
  };
  writeMarker(session);
  bindUnload();
  recordCrumb({ kind: 'session', data: { version: session.appVersion, commit: session.commit, marker: session.id, ...environmentFacts() } });
  return previous;
}

/** True between `startFlightRecorder` and a reset (specs only need to know for assertions). */
export function flightRecorderStarted(): boolean {
  return started;
}

/** The heavy work started: its facts and the job go into one crumb, and the marker says what ran. */
export function noteWorkStart(work: WorkScope, facts: WorkFacts = {}): void {
  recordCrumb({ kind: 'work', work, stage: 'start', data: facts as Record<string, unknown> });
  if (session !== null) {
    session = { ...session, work, stage: 'start', label: null };
    writeMarker(session);
  }
  startMemoryWatch();
}

/** A worker stage started / finished, with its progress words. */
export function noteStage(work: WorkScope, stage: string, label?: string, done?: number, total?: number): void {
  recordCrumb({ kind: 'stage', work, stage, ...(label === undefined ? {} : { label }), ...(done === undefined ? {} : { done }), ...(total === undefined ? {} : { total }) });
  if (session !== null) {
    session = { ...session, work, stage, label: label ?? null };
    writeMarker(session);
  }
}

/** Coarse progress inside a stage. Debounced by the ring's own flush, not by dropping the event. */
export function noteProgress(work: WorkScope, stage: string, done: number, total: number, label?: string): void {
  recordCrumb({ kind: 'progress', work, stage, done, total, ...(label === undefined ? {} : { label }) });
}

/** A finding the run raised, small enough to survive in the report. */
export function noteFinding(finding: { code: string; severity: string; message: string }): void {
  recordCrumb({ kind: 'finding', data: { code: finding.code, severity: finding.severity, message: finding.message } });
}

/** The work ended (successfully or refused); the marker says nothing is running. */
export function noteWorkEnd(work: WorkScope, outcome: 'done' | 'refused' | 'failed' | 'cancelled'): void {
  recordCrumb({ kind: 'work', work, stage: 'end', data: { outcome } });
  if (session !== null) {
    session = { ...session, work: null, stage: null, label: null };
    writeMarker(session);
  }
  stopMemoryWatch();
}

/**
 * What the previous session's last moments were, in words for the banner: when it stopped, what it
 * was doing, the last stage count and the last heap figure. Null fields are honestly null.
 */
export interface CrashMoment {
  stoppedAt: number | null;
  work: WorkScope | null;
  stage: string | null;
  label: string | null;
  heapMb: number | null;
  lastCrumbAt: number | null;
}

export function crashMoment(previous: PreviousSession): CrashMoment {
  const lastProgress = [...previous.crumbs].reverse().find((c) => c.kind === 'progress' || (c.kind === 'stage' && c.label !== undefined));
  const lastMemory = [...previous.crumbs].reverse().find((c) => c.kind === 'memory');
  const heap = lastMemory?.data?.usedMb;
  return {
    stoppedAt: previous.crumbs.length > 0 ? previous.crumbs[previous.crumbs.length - 1]!.at : previous.marker.startedAt,
    work: previous.marker.work,
    stage: previous.marker.stage,
    label: previous.marker.label ?? lastProgress?.label ?? null,
    heapMb: typeof heap === 'number' ? heap : null,
    lastCrumbAt: previous.crumbs.length > 0 ? previous.crumbs[previous.crumbs.length - 1]!.at : null,
  };
}

/** The job facts captured at the last heavy-work start, if a crumb holds them. */
export function lastWorkFacts(previous: PreviousSession): WorkFacts | null {
  const work = [...previous.crumbs].reverse().find((c) => c.kind === 'work' && c.stage === 'start');
  return work?.data === undefined ? null : (work.data as unknown as WorkFacts);
}

/** A report's shape — one JSON file the user can save or send. */
export interface CrashReport {
  kind: 'casemaker-crash-report';
  version: 1;
  createdAt: string;
  app: { version: string; commit: string | null; desktop: boolean };
  environment: Record<string, unknown>;
  stopped: { at: string | null; work: WorkScope | null; stage: string | null; label: string | null; heapMb: number | null };
  crumbs: Crumb[];
  job: WorkFacts | null;
  /** The mesh bytes, only when the user chose to include them. */
  meshes?: { name: string; sha256: string; format: string; data: string }[];
}

/**
 * Build the report from what the previous session left. Pure: the caller supplies the app facts,
 * the job facts and (only on the user's choice) the mesh bytes; nothing here fetches or sends.
 */
export function buildCrashReport(
  previous: PreviousSession,
  opts: {
    appVersion: string;
    commit: string | null;
    desktop: boolean;
    includeJob?: WorkFacts | null;
    meshes?: { name: string; sha256: string; format: string; data: string }[];
    now?: number;
  },
): CrashReport {
  const moment = crashMoment(previous);
  const job = opts.includeJob ?? lastWorkFacts(previous);
  return {
    kind: 'casemaker-crash-report',
    version: 1,
    createdAt: new Date(opts.now ?? Date.now()).toISOString(),
    app: { version: opts.appVersion, commit: opts.commit, desktop: opts.desktop },
    environment: environmentFacts(),
    stopped: {
      at: moment.stoppedAt === null ? null : new Date(moment.stoppedAt).toISOString(),
      work: moment.work,
      stage: moment.stage,
      label: moment.label,
      heapMb: moment.heapMb,
    },
    crumbs: previous.crumbs,
    job,
    ...(opts.meshes === undefined || opts.meshes.length === 0 ? {} : { meshes: opts.meshes }),
  };
}

/** A crash report's file name, from the time it describes. */
export function crashReportFileName(stoppedAt: number | null, now = Date.now()): string {
  const d = new Date(stoppedAt ?? now);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `casemaker-crash-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
}

/** Forget the session state and the ring. SPECS ONLY — the app never calls this. */
export function __resetFlightRecorderForTests(): void {
  ring = [];
  ringBytes = 0;
  started = false;
  session = null;
  unloadBound = false;
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  stopMemoryWatch();
  crumbIO = null;
  markerIO = null;
}
