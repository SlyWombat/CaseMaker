/**
 * #881 — HOW MANY LEVEL PLANNERS TO RUN. The rule, alone in one module so the main thread's pool
 * and the sim worker that states the decision compute the same number from the same code.
 *
 * Two limits apply, and the smaller wins:
 *
 * - CORES. One fewer than the machine's cores (the sim worker keeps one busy assembling), never
 *   more than eight, and one on a phone — a coarse pointer is the app's own signal that the
 *   device is a handset whose cores and battery are not ours to spend.
 *
 * - MEMORY. Every planner holds one level at a time, so the pool's peak is
 *   `planners × the largest level's peak + the parent`. #889 states the program's budget
 *   (640 MB on a computer, 256 MB on a phone) and the CAM states the program's own estimate;
 *   what is left over buys planners, and `navigator.deviceMemory` (where the browser reports it)
 *   can only lower the count further.
 */

import type { LevelPlanMemory } from '@/engine/cnc/cam/rough3d';

/**
 * How many planners the machine's cores allow — the upper bound before memory is considered.
 * One fewer than the cores (the sim worker keeps one busy), capped at eight, and one on a phone.
 */
export function adaptivePoolSize(
  nav: { hardwareConcurrency?: number } | undefined = typeof navigator === 'undefined' ? undefined : navigator,
  coarsePointer: boolean = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches,
): number {
  if (coarsePointer) return 1;
  const cores = Math.max(1, Math.floor(nav?.hardwareConcurrency ?? 2));
  return Math.min(8, Math.max(1, cores - 1));
}

/**
 * #881 — one planner's own cost before its level: the worker's module, the job's shared settings
 * and the planner's fixed tables. Measured in Chromium on the bench goal: about 10.4 MB across
 * eight idle planners; 12 MB allows a little for the busiest. Calibrated with the #881 CDP probe
 * (scripts/cdpHeap.mts), which reads each worker target rather than node RSS.
 */
export const LEVEL_PLANNER_BASE_BYTES = 12 * 1024 * 1024;

/**
 * #881 — bytes per covered cell one planner's level costs: the mask, its polygons and the sweep
 * path the level builds, and the moves it hands back (packed, 33 bytes each). A conservative
 * upper bound for the memory bound; the CDP probe measures the real figure and this number is
 * re-stated with it in the hand-in.
 */
export const LEVEL_PLANNER_BYTES_PER_CELL = 160;

/** What ONE planner's largest level is estimated to cost, bytes: the base plus its cells. */
export function estimateLevelPlannerBytes(cells: number): number {
  const n = Number.isFinite(cells) ? Math.max(0, cells) : 0;
  return LEVEL_PLANNER_BASE_BYTES + n * LEVEL_PLANNER_BYTES_PER_CELL;
}

/**
 * #881 — what a device that REPORTS its memory (`navigator.deviceMemory`, GB) may run: two
 * planners at 4 GB, one at 2 GB. Chromium caps the value at 8, so "8" is "plenty" and leaves the
 * core rule in charge. Absent (Safari, Firefox, Node) → the core rule alone.
 */
export function deviceMemoryPoolCap(deviceMemoryGb: number | undefined): number {
  if (deviceMemoryGb === undefined || !Number.isFinite(deviceMemoryGb)) return Number.POSITIVE_INFINITY;
  if (deviceMemoryGb <= 2) return 1;
  if (deviceMemoryGb <= 4) return 2;
  return Number.POSITIVE_INFINITY;
}

export interface PoolSizingInput {
  /** The page's stated budget for the program, bytes (#889's 640 MB / 256 MB by device). */
  budgetBytes: number;
  /** The parent's own estimated peak while the pool runs — the program the CAM is assembling. */
  parentBytes: number;
  /** The largest level's estimated peak, bytes (`estimateLevelPlannerBytes`). */
  levelBytes: number;
  /** The core rule's answer (`adaptivePoolSize`). */
  coreCap: number;
  /** `navigator.deviceMemory`, GB, when the browser reports it. */
  deviceMemoryGb?: number;
}

/**
 * The number of planners the limits allow. Never fewer than one: a pool that answered zero would
 * leave the CAM waiting forever, and the smaller pool is always the honest answer. When the
 * parent alone already stands at the budget the count is 1 — the least the pool can add.
 */
export function memoryBoundPoolSize(input: PoolSizingInput): number {
  const coreCap = Math.max(1, Math.floor(input.coreCap));
  const deviceCap = deviceMemoryPoolCap(input.deviceMemoryGb);
  const cap = Math.min(coreCap, deviceCap);
  const spare = input.budgetBytes - input.parentBytes;
  const byMemory = input.levelBytes > 0 ? Math.floor(spare / input.levelBytes) : cap;
  return Math.max(1, Math.min(cap, byMemory));
}

/** The decision, as a fact the run can state (and a test can pin). */
export interface PoolSizing {
  /** How many planners run. */
  planners: number;
  /** The core rule's answer, for the sentence to tell the two limits apart. */
  coreCap: number;
  /** The page's stated budget, bytes. */
  budgetBytes: number;
  /** The parent's estimated peak, bytes. */
  parentBytes: number;
  /** The largest level's estimated peak, bytes. */
  levelBytes: number;
}

/** Apply the rule to the run's own numbers and keep the inputs beside the answer. */
export function sizePool(input: PoolSizingInput): PoolSizing {
  return {
    planners: memoryBoundPoolSize(input),
    coreCap: Math.max(1, Math.floor(input.coreCap)),
    budgetBytes: input.budgetBytes,
    parentBytes: input.parentBytes,
    levelBytes: input.levelBytes,
  };
}

/** The device memory a browser is willing to state, GB; undefined where it reports none. */
export function reportedDeviceMemory(): number | undefined {
  if (typeof navigator === 'undefined') return undefined;
  const value = (navigator as { deviceMemory?: number }).deviceMemory;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** MB, rounded, for the Technical line (and the run's own words). */
export function mbOf(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

export type { LevelPlanMemory };
