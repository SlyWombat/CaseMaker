/**
 * #1124 — THE PLANNER'S BROWSER REQUIREMENT, CHECKED BEFORE GENERATE.
 *
 * The bench's failure (2026-11-09): planning `m1trayF-banded2` in a 32-bit x86 Chrome under
 * Windows ARM64 emulation died at "planning: sequence — setup 1, 35 %" with "Array buffer
 * allocation failed". The 35 % tick is the ball rank, which accumulates ~704 MiB of per-IR
 * stamp fields (measured: peak 703.7 MiB, the largest single buffer ~5.5 MiB) — no single
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
 * renderer should not be asked for another 704 MiB. When bitness says 64 (or cannot answer) the
 * probe still runs, because a 64-bit browser under real memory pressure is address-limited too.
 */

/** The diagnostic code the guide's chapter 8 carries a row for (the cnc-guide spec scans this). */
export const BROWSER_32_BIT_CODE = 'browser-32-bit';

/** The plain sentence the Generate button carries, verbatim from the issue. */
export const BROWSER_32_BIT_SENTENCE = 'This browser is 32-bit; the planner needs a 64-bit browser';

export interface RendererRefusal {
  code: typeof BROWSER_32_BIT_CODE;
  severity: 'error';
  sentence: string;
}

/**
 * The one refusal both signals raise. `code: 'browser-32-bit'` is written here literally because
 * `tests/unit/cncGuide.spec.ts` scans `src/engine/cnc` for `code: '…'` and requires a guide row.
 */
export const BROWSER_32_BIT_REFUSAL: RendererRefusal = {
  code: 'browser-32-bit',
  severity: 'error',
  sentence: BROWSER_32_BIT_SENTENCE,
};

/**
 * The ball rank's measured peak on `m1trayF-banded2` (MB): E's 703.7 MiB of ArrayBuffers at
 * "planning: sequence — setup 1, 35 %", the stage the bench died in. It is the floor the probe
 * must be able to reserve; it is not the plan's total appetite, so a pass is necessary, not
 * sufficient.
 */
export const PLANNER_PEAK_FLOOR_MB = 704;

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
 * brief virtual-memory reservation, not 704 MiB of resident memory.
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

/**
 * The verdict Generate needs: a refusal, or null when this renderer can do the planner's work.
 * Bitness '32' short-circuits before the probe; every other answer takes the probe.
 */
export async function detectRendererRefusal(
  nav: NavigableNavigator = undefined,
  probe: () => ProbeResult = probeAddressSpace,
): Promise<RendererRefusal | null> {
  if ((await readRendererBitness(nav)) === '32') return BROWSER_32_BIT_REFUSAL;
  return probe().ok ? null : BROWSER_32_BIT_REFUSAL;
}

/** `undefined` means "read the global navigator" — the call site does not have to pass one. */
type NavigableNavigator = NavigatorLike | null | undefined;

/** What the panel subscribes to. `checking` is not a refusal: Generate stays available. */
export interface RendererVerdict {
  state: 'checking' | 'ok' | 'unsupported';
  refusal: RendererRefusal | null;
}

/**
 * One verdict per page, held as a plain module value (the `toolRegistry` pattern): the panel
 * subscribes with `useSyncExternalStore`, and the snapshot identity is stable between changes.
 */
let verdict: RendererVerdict = { state: 'checking', refusal: null };
let started = false;
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

/**
 * Start the check, once per page. Called from `main.tsx` AFTER the first render: the probe
 * reserves ~704 MiB of address space for a moment and must not delay first paint.
 *
 * A detector that throws is treated as "cannot tell" (`ok`): the check is a guard, and a broken
 * guard must not disable Generate on a healthy browser.
 */
export function startRendererCheck(
  nav: NavigableNavigator = undefined,
  probe: () => ProbeResult = probeAddressSpace,
): void {
  if (started) return;
  started = true;
  void detectRendererRefusal(nav, probe).then(
    (refusal) => publish(refusal === null ? { state: 'ok', refusal: null } : { state: 'unsupported', refusal }),
    () => publish({ state: 'ok', refusal: null }),
  );
}

/** Test seam: put the page's verdict back before `startRendererCheck` (no probe runs). */
export function resetRendererCheck(): void {
  started = false;
  publish({ state: 'checking', refusal: null });
}
