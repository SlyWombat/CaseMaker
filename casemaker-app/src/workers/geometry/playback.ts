/**
 * Checkpointed playback (#182 step 8, `/Simulation.md` §8.0): the stock at any point in
 * the program, cheaply, in either direction.
 *
 * A boolean per frame is impossible (§4: ~0.7 s per Z level). So the sweep precomputes one
 * removal solid per checkpoint, and playback holds the CUMULATIVE union up to each one:
 *
 *   stockAt(k) = stock − (removal[0] ∪ … ∪ removal[k])
 *
 * The cumulative unions are built forward once (each is the previous plus one solid, and
 * Manifold's booleans are lazy, so building the chain is cheap and evaluation happens on
 * demand) and then cached, so seeking backwards costs nothing. Between checkpoints the tool
 * animates over a static stock — a legitimate compromise, not the norm: dexel simulators
 * update per move; this one does not, and says so.
 *
 * Playback is indexed two ways: by CHECKPOINT (what the scrubber bar shows) and by program
 * STEP (what the event list shows). A step maps to the last checkpoint whose first cutting
 * move is at or before it — "everything cut so far" — which is what the picture at that
 * moment should contain.
 *
 * The caller owns the playback and must `dispose()` it; it does not own the sweep result.
 */

import type { Timeline } from '@/engine/cnc/emulator/timeline';
import type { ManifoldToplevel } from './evaluateOp';
import type { SweepResult } from './sweep';

type ManifoldInstance = InstanceType<ManifoldToplevel['Manifold']>;

export interface Playback {
  /** Number of checkpoints; valid indices are -1 (before any cut) … count-1. */
  readonly count: number;
  /** The stock after checkpoints 0..k. `k = -1` is the uncut stock. Owned by the playback. */
  stockAt(k: number): ManifoldInstance;
  /** The checkpoint index "cut so far" at program step `step`, or -1 before the first cut. */
  checkpointAtStep(step: number): number;
  /** Removed volume after checkpoints 0..k; monotone non-decreasing in k. */
  removedVolumeAt(k: number): number;
  dispose(): void;
}

export function createPlayback(timeline: Timeline, sweep: SweepResult): Playback {
  const solids = sweep.perCheckpoint;
  const count = solids.length;
  // cumulative[k] = removal[0] ∪ … ∪ removal[k], or null if nothing has been removed by k.
  const cumulative: (ManifoldInstance | null)[] = new Array<ManifoldInstance | null>(count).fill(null);
  const stocks: (ManifoldInstance | null)[] = new Array<ManifoldInstance | null>(count).fill(null);
  const volumes: (number | null)[] = new Array<number | null>(count).fill(null);
  let built = -1;
  const stockVolume = sweep.stock.volume();

  // First cutting step of each checkpoint, for the step → checkpoint map. Checkpoints are in
  // program order of first appearance, so these are non-decreasing.
  const firstStep = timeline.checkpoints.map((cp) => cp.steps[0] ?? Number.POSITIVE_INFINITY);

  const buildTo = (k: number): void => {
    while (built < k) {
      const next = built + 1;
      const prev = built >= 0 ? cumulative[built] ?? null : null;
      const solid = solids[next] ?? null;
      if (!solid) {
        // Nothing removed at this checkpoint: the cumulative is unchanged. Share by CLONING,
        // never by aliasing, so dispose() can delete every entry exactly once.
        cumulative[next] = prev ? prev.translate([0, 0, 0]) : null;
      } else {
        cumulative[next] = prev ? prev.add(solid) : solid.translate([0, 0, 0]);
      }
      built = next;
    }
  };

  const stockAt = (k: number): ManifoldInstance => {
    if (k < 0 || count === 0) return sweep.stock;
    const kk = Math.min(k, count - 1);
    const cached = stocks[kk];
    if (cached) return cached;
    buildTo(kk);
    const c = cumulative[kk];
    const s = c ? sweep.stock.subtract(c) : sweep.stock.translate([0, 0, 0]);
    stocks[kk] = s;
    return s;
  };

  const removedVolumeAt = (k: number): number => {
    if (k < 0 || count === 0) return 0;
    const kk = Math.min(k, count - 1);
    const v = volumes[kk] ?? null;
    if (v !== null) return v;
    const r = stockVolume - stockAt(kk).volume();
    volumes[kk] = r;
    return r;
  };

  const checkpointAtStep = (step: number): number => {
    // Last index whose first cutting step is <= step: binary search over a non-decreasing list.
    let lo = 0;
    let hi = count - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((firstStep[mid] as number) <= step) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans;
  };

  const dispose = (): void => {
    for (const c of cumulative) c?.delete();
    for (const s of stocks) s?.delete();
    cumulative.fill(null);
    stocks.fill(null);
    built = -1;
  };

  return { count, stockAt, checkpointAtStep, removedVolumeAt, dispose };
}
