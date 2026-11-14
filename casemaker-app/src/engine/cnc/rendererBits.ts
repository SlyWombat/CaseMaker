/**
 * #1124 — THE PLANNER'S BROWSER REQUIREMENT, CHECKED BEFORE GENERATE.
 *
 * The bench's failure (2026-11-09): planning `m1trayF-banded2` in a 32-bit x86 Chrome under
 * Windows ARM64 emulation died at "planning: sequence — setup 1, 35 %" with "Array buffer
 * allocation failed". The 35 % tick is the ball rank, which accumulated ~704 MiB of per-IR
 * stamp fields before #1125's stamp cap (measured: peak 703.7 MiB; 454 MiB after the cap on
 * Set B — the floor below; the largest single buffer ~5.5 MiB) — no single
 * allocation is pathological; a 32-bit renderer's address space is what runs out. The same
 * failure happened on land13 and land14, so it is the environment, not a regression.
 *
 * TWO SIGNALS, ONE VERDICT:
 *   1. `navigator.userAgentData.getHighEntropyValues(['bitness', 'architecture'])` where the
 *      browser has it (Chromium): bitness '32' is decisive, cheap and known before the probe.
 *   2. A probe allocation at app start: reserve the rank's measured floor in chunks the size of
 *      the plan's own buffers, then release them. A renderer that cannot reserve the floor is
 *      address-limited whether or not it can say its bitness — it would die in the rank.
 *
 * The sentence is the issue's own. The operator's action is the same for both signals — open the
 * app in a 64-bit browser — and the app offers no Fix control, because it cannot install one.
 *
 * The probe is SKIPPED when bitness says 32: there is nothing left to learn, and the hopeless
 * renderer should not be asked for another 454 MiB. When bitness says 64 (or cannot answer) the
 * probe still runs, because a 64-bit browser under real memory pressure is address-limited too.
 */

/** The diagnostic code the guide's chapter 8 carries a row for (the cnc-guide spec scans this). */
export const BROWSER_32_BIT_CODE = 'browser-32-bit';

/** Bitness 32: the browser states the cause, and the remedy is a different browser. */
export const BROWSER_32_BIT_SENTENCE = 'This browser is 32-bit; the planner needs a 64-bit browser';

export interface RendererRefusal {
  code: typeof BROWSER_32_BIT_CODE;
  severity: 'error';
  sentence: string;
}

/**
 * The two refusals both signals raise, sharing the one code. `code: 'browser-32-bit'` is written
 * here literally because `tests/unit/cncGuide.spec.ts` scans `src/engine/cnc` for `code: '…'` and
 * requires a guide row.
 */
export const BROWSER_32_BIT_REFUSAL: RendererRefusal = {
  code: 'browser-32-bit',
  severity: 'error',
  sentence: BROWSER_32_BIT_SENTENCE,
};

/**
 * The press probe's WARNING (the landing ruling, 2026-11-09): the page could not reserve the floor
 * just now, but a 64-bit renderer under transient pressure is not a verdict — Generate proceeds and
 * the operator is told, so a real OOM reads as the cause rather than a mystery mid-plan failure.
 */
export const MEMORY_TIGHT_TITLE = 'Memory is tight in this page';
export const MEMORY_TIGHT_BODY = 'Generating anyway. If it stops, close other tabs and press Generate again.';
export const BROWSER_MEMORY_SHORT_WARNING = `${MEMORY_TIGHT_TITLE}. ${MEMORY_TIGHT_BODY}`;

/**
 * The run's own out-of-memory failure, in the operator's words: the raw text of the bench's
 * failure ("Array buffer allocation failed") becomes a named cause with the remedy.
 */
export const PLANNER_OUT_OF_MEMORY_SENTENCE =
  'the planner ran out of memory in this browser; close other tabs or use a 64-bit browser';

/**
 * The planner's measured address-space floor (MB): the ball rank's peak AFTER #1125's stamp cap.
 * The bench's death (2026-11-09) was at "planning: sequence — setup 1, 35 %", E's 703.7 MiB of
 * ArrayBuffers; with the stamp cap in place E's Set B measurement of the same stage is 454 MiB,
 * and that is the floor the probe must be able to reserve (the manager's landing note). It is
 * not the plan's total appetite, so a pass is necessary, not sufficient.
 */
export const PLANNER_PEAK_FLOOR_MB = 454;

/**
 * The plan's largest single ArrayBuffer is ~5.5 MiB. The probe reserves the floor in 8 MiB rows,
 * at the scale of the allocations that really accumulate — a single huge buffer would test the
 * wrong thing (contiguous address space, not the aggregate the rank needs).
 */
export const PROBE_CHUNK_MB = 8;

export interface ProbeResult {
  ok: boolean;
  /** What the probe managed to reserve, MB. */
  reservedMb: number;
  /** The size at which the allocation threw, MB — null when the floor was reached. */
  failedAtMb: number | null;
}

/**
 * Reserve the planner's floor in chunks, then release every chunk. The allocation is synchronous
 * and only reserves address space (the buffers are never written), so a 64-bit browser pays a
 * brief virtual-memory reservation, not 454 MiB of resident memory.
 *
 * `allocate` is injectable so a unit test can fail the probe without a hostile renderer.
 */
export function probeAddressSpace(
  opts: {
    floorMb?: number;
    chunkMb?: number;
    allocate?: (bytes: number) => ArrayBuffer;
  } = {},
): ProbeResult {
  const floorMb = opts.floorMb ?? PLANNER_PEAK_FLOOR_MB;
  const chunkMb = opts.chunkMb ?? PROBE_CHUNK_MB;
  const allocate = opts.allocate ?? ((bytes: number) => new ArrayBuffer(bytes));
  const held: ArrayBuffer[] = [];
  let reservedMb = 0;
  try {
    while (reservedMb + chunkMb <= floorMb) {
      held.push(allocate(chunkMb * 1024 * 1024));
      reservedMb += chunkMb;
    }
    return { ok: reservedMb >= floorMb, reservedMb, failedAtMb: null };
  } catch {
    return { ok: false, reservedMb, failedAtMb: reservedMb + chunkMb };
  } finally {
    // Drop the only references. The arrays are unreachable from here; a later allocation (the
    // planner's own) is what makes V8 collect them — the probe never asks for them back.
    held.length = 0;
  }
}

/** The high-entropy answers this check reads. Both are strings the browser may omit. */
export interface HighEntropyValues {
  bitness?: string;
  architecture?: string;
}

/** The one Navigator member the check touches, structurally — jsdom and Node have no UAData. */
export interface UserAgentDataLike {
  getHighEntropyValues?: (hints: string[]) => Promise<HighEntropyValues>;
}

export interface NavigatorLike {
  userAgentData?: UserAgentDataLike | null;
}

/** `'32' | '64'` when the browser states it, `null` when it does not (or says something else). */
export function parseRendererBitness(values: HighEntropyValues | null | undefined): '32' | '64' | null {
  const bitness = values?.bitness?.trim();
  return bitness === '32' || bitness === '64' ? bitness : null;
}

/**
 * Ask the browser its bitness. Absent `userAgentData` (Firefox, Safari, jsdom, Node), absent
 * `getHighEntropyValues`, or a rejected call all answer `null` — "cannot say", not "64-bit".
 */
export async function readRendererBitness(
  nav: NavigatorLike | null | undefined = (globalThis as { navigator?: NavigatorLike }).navigator,
): Promise<'32' | '64' | null> {
  const uaData = nav?.userAgentData;
  if (uaData === null || uaData === undefined || typeof uaData.getHighEntropyValues !== 'function') {
    return null;
  }
  try {
    return parseRendererBitness(await uaData.getHighEntropyValues(['bitness', 'architecture']));
  } catch {
    return null;
  }
}

/** `undefined` means "read the global navigator" — the call site does not have to pass one. */
type NavigableNavigator = NavigatorLike | null | undefined;

/** What the panel subscribes to. `checking` is not a refusal: Generate stays available. */
export interface RendererVerdict {
  state: 'checking' | 'ok' | 'unsupported';
  refusal: RendererRefusal | null;
  /** The press probe's warning (never a refusal): shown beside Generate; null otherwise. */
  warning: string | null;
}

/**
 * One verdict per page, held as a plain module value (the `toolRegistry` pattern): the panel
 * subscribes with `useSyncExternalStore`, and the snapshot identity is stable between changes.
 */
let verdict: RendererVerdict = { state: 'checking', refusal: null, warning: null };
let started = false;
/** True once the STARTUP check ran and BOTH of its probes failed (the press then re-probes). */
let startupProbeFailed = false;
const listeners = new Set<() => void>();

export function getRendererVerdict(): RendererVerdict {
  return verdict;
}

export function subscribeRendererVerdict(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function publish(next: RendererVerdict): void {
  verdict = next;
  for (const listener of listeners) listener();
}

/** How long the startup check waits before its one retry (the landing ruling, 2026-11-09). */
export const PROBE_RETRY_DELAY_MS = 2000;

export interface RendererCheckOptions {
  /** The wait between the first startup probe and its one retry. */
  retryDelayMs?: number;
  /** Injectable for tests: the wait itself (defaults to a `setTimeout` promise). */
  wait?: (ms: number) => Promise<void>;
}

const defaultWait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Start the check, once per page. Called from `main.tsx` AFTER the first render: the probe
 * reserves ~454 MiB of address space for a moment and must not delay first paint.
 *
 * THE LANDING RULING (2026-11-09) — A FAILED STARTUP PROBE IS NOT A VERDICT. The probe runs in
 * the first-render window, when the app's own startup allocations peak; a transient allocation
 * failure there was published as a permanent refusal and disabled Generate on a healthy 64-bit
 * browser (measured in the e2e: the same page reserves the floor four seconds later). So:
 *   - bitness '32' still refuses IMMEDIATELY (no probe — there is nothing left to learn);
 *   - otherwise a failed probe retries ONCE after {@link PROBE_RETRY_DELAY_MS};
 *   - if the retry fails too the verdict stays 'checking' — Generate stays AVAILABLE, and the
 *     press runs its own deliberate re-probe ({@link recheckRendererForGenerate});
 *   - only a failure at the press refuses, and that verdict then stands for the page.
 *
 * A detector that throws is treated as "cannot tell" (`ok`): the check is a guard, and a broken
 * guard must not disable Generate on a healthy browser.
 */
export function startRendererCheck(
  nav: NavigableNavigator = undefined,
  probe: () => ProbeResult = probeAddressSpace,
  opts: RendererCheckOptions = {},
): void {
  if (started) return;
  started = true;
  const wait = opts.wait ?? defaultWait;
  void (async () => {
    if ((await readRendererBitness(nav)) === '32') {
      publish({ state: 'unsupported', refusal: BROWSER_32_BIT_REFUSAL, warning: null });
      return;
    }
    if (probe().ok) {
      publish({ state: 'ok', refusal: null, warning: null });
      return;
    }
    await wait(opts.retryDelayMs ?? PROBE_RETRY_DELAY_MS);
    if (probe().ok) {
      publish({ state: 'ok', refusal: null, warning: null });
      return;
    }
    // Neither attempt reserved the floor — NOT a refusal: Generate stays available and its press
    // re-probes deliberately (a startup peak must not brick a healthy browser).
    startupProbeFailed = true;
    publish({ state: 'checking', refusal: null, warning: null });
  })().catch(() => publish({ state: 'ok', refusal: null, warning: null }));
}

/**
 * THE PRESS'S OWN PROBE (the landing ruling). Generate calls this when the startup verdict is not
 * 'ok' — i.e. both startup attempts failed. Bitness '32' refuses before the probe and returns the
 * refusal. Every other answer WARNS and returns NULL: a failed reservation publishes
 * {@link BROWSER_MEMORY_SHORT_WARNING} beside Generate and the run proceeds — the main thread's
 * memory is a proxy (the planner runs in its own worker, #1148), and a real allocation failure is
 * named by `operatorRunError` when the run hits it. Never restores the refusal: that was the brick.
 */
export async function recheckRendererForGenerate(
  nav: NavigableNavigator = undefined,
  probe: () => ProbeResult = probeAddressSpace,
): Promise<RendererRefusal | null> {
  if ((await readRendererBitness(nav)) === '32') {
    publish({ state: 'unsupported', refusal: BROWSER_32_BIT_REFUSAL, warning: null });
    return BROWSER_32_BIT_REFUSAL;
  }
  if (probe().ok) {
    publish({ state: 'ok', refusal: null, warning: null });
    return null;
  }
  // THE PRESS WARNS, NEVER REFUSES (the landing ruling): Generate proceeds and the line beside it
  // states the risk; a real out-of-memory failure in the run is named by `operatorRunError`.
  publish({ state: 'checking', refusal: null, warning: BROWSER_MEMORY_SHORT_WARNING });
  return null;
}

/**
 * #1123 item 52 — THE WARNING BELONGS TO ITS RUN. The press probe publishes it beside Generate;
 * the run recorded it in its Log at the start, so once that run ends the line must not stay on the
 * panel. Only the warning is cleared: a refusal (a 32-bit browser) is a fact about the page and
 * stands.
 */
export function clearRendererWarning(): void {
  if (verdict.warning === null) return;
  publish({ ...verdict, warning: null });
}

/**
 * Whether the STARTUP check ran and BOTH its probes failed. The press re-probes only then —
 * 'checking' also covers a page that never ran the check (a test harness, an embedded panel),
 * and that is not a failure to act on.
 */
export function rendererProbeFailedAtStartup(): boolean {
  return startupProbeFailed;
}

/** Test seam: put the page's verdict back before `startRendererCheck` (no probe runs). */
export function resetRendererCheck(): void {
  started = false;
  startupProbeFailed = false;
  publish({ state: 'checking', refusal: null, warning: null });
}
