/**
 * Checkpointed playback (#182 step 8, `/Simulation.md` §8.0): the stock at any point in
 * the program, cheaply, in either direction.
 *
 * A boolean per frame is impossible (§4: ~0.7 s per Z level). So the sweep precomputes one
 * removal solid per checkpoint, and playback shows
 *
 *   stockAt(k) = stock − (removal[0] ∪ … ∪ removal[k])
 *
 * Checkpoints are CAUSAL (`Checkpoint.run`): everything in k happened before anything in
 * k+1, so this really is "the stock after step k's last cut". Between checkpoints the tool
 * animates over a static stock — a legitimate compromise, not the norm: dexel simulators
 * update per move; this one does not, and says so.
 *
 * Memory is BOUNDED. The first version cached every cumulative union and every stock, and a
 * 719-checkpoint vendor job ran the wasm heap out. Now the cumulative union is kept only at
 * every `ANCHOR_EVERY`-th checkpoint (each is the previous anchor plus a few solids, built
 * forward once), and stocks live in a small most-recently-used cache. A seek costs at most
 * `ANCHOR_EVERY` lazy unions plus one subtraction; a seek back to a recently shown frame is
 * free.
 *
 * Playback is indexed two ways: by CHECKPOINT (what the scrubber bar shows) and by program
 * STEP (what the event list shows). A step maps to the last checkpoint whose first cutting
 * move is at or before it — "everything cut so far" — which is what the picture at that
 * moment should contain.
 *
 * The caller owns the playback and must `dispose()` it; it does not own the sweep result.
 * Every handle `stockAt` returns is the playback's, including the uncut stock (a clone, never
 * the sweep's own handle), so the caller never has to know which is which.
 *
 * ONE MANIFOLD TRAP governs the shape of this code. A `translate()` of a LAZY boolean (an op
 * node) is a new node that SHARES the original's children; and when a same-op child's last
 * JS handle is deleted, Manifold flattens it into its parent by MOVING those children out.
 * So "clone the anchor union, add a few solids, delete the intermediates" corrupts the
 * anchor itself, and the next seek through it crashes the wasm ("null function or function
 * signature mismatch"). Characterised in this session: the same chain over a real LEAF is
 * fine, keeping every intermediate handle alive is fine, and `compose([lazy])` does NOT
 * help (it hands back the same node). Anchors are therefore materialised into true leaves
 * once, by a mesh round-trip, and every per-seek chain is built fresh and used once.
 */

import type { Timeline } from '@/engine/cnc/emulator/timeline';
import type { ManifoldToplevel } from './evaluateOp';
import type { SweepResult } from './sweep';

type ManifoldInstance = InstanceType<ManifoldToplevel['Manifold']>;

/** Cumulative unions kept at every this-many checkpoints. */
export const ANCHOR_EVERY = 32;
/** Stocks kept, most recently used. */
export const STOCK_CACHE = 6;

export interface Playback {
  /** Number of checkpoints; valid indices are -1 (before any cut) … count-1. */
  readonly count: number;
  /** The stock after checkpoints 0..k. `k = -1` is the uncut stock. Owned by the playback; valid until the next `stockAt` evicts it or `dispose()`. */
  stockAt(k: number): ManifoldInstance;
  /** The checkpoint index "cut so far" at program step `step`, or -1 before the first cut. */
  checkpointAtStep(step: number): number;
  /** Removed volume after checkpoints 0..k; monotone non-decreasing in k. */
  removedVolumeAt(k: number): number;
  dispose(): void;
}

export function createPlayback(tl: ManifoldToplevel, timeline: Timeline, sweep: SweepResult): Playback {
  const solids = sweep.perCheckpoint;
  const count = solids.length;
  // anchors[a] = removal[0] ∪ … ∪ removal[a], kept for a = ANCHOR_EVERY-1, 2·ANCHOR_EVERY-1, …
  // (null where nothing has been removed by a). Built forward, once.
  const anchors = new Map<number, ManifoldInstance | null>();
  let anchoredTo = -1;
  // Most-recently-used stocks, insertion order = age.
  const stocks = new Map<number, ManifoldInstance>();
  const volumes = new Map<number, number>();
  let base: ManifoldInstance | null = null;
  const stockVolume = sweep.stock.volume();

  // First cutting step of each checkpoint, for the step → checkpoint map. Checkpoints are in
  // program order, so these are non-decreasing.
  const firstStep = timeline.checkpoints.map((cp) => cp.steps[0] ?? Number.POSITIVE_INFINITY);

  const isAnchor = (k: number): boolean => k % ANCHOR_EVERY === ANCHOR_EVERY - 1;

  /** removal[0] ∪ … ∪ removal[k], as a NEW handle the caller owns, or null if nothing was removed. */
  const cumulativeTo = (k: number): ManifoldInstance | null => {
    // Advance the anchor chain as far as needed, without evaluating anything (unions are lazy).
    while (anchoredTo < k && anchoredTo + ANCHOR_EVERY <= k) {
      const next = anchoredTo + ANCHOR_EVERY;
      const prev = anchoredTo >= 0 ? anchors.get(anchoredTo) ?? null : null;
      const parts: ManifoldInstance[] = prev ? [prev] : [];
      for (let i = anchoredTo + 1; i <= next; i++) {
        const s = solids[i] ?? null;
        if (s) parts.push(s);
      }
      // Never alias: an anchor is deleted on dispose, a sweep solid is not ours to delete. And
      // materialise it: an anchor is reused by every seek past it (see the trap above).
      anchors.set(next, materialise(tl, unionOwned(parts)));
      anchoredTo = next;
    }
    const a = isAnchor(k) || k === anchoredTo ? k : Math.floor((k + 1) / ANCHOR_EVERY) * ANCHOR_EVERY - 1;
    const start = anchors.has(a) ? (anchors.get(a) ?? null) : null;
    const from = anchors.has(a) ? a : -1;
    const parts: ManifoldInstance[] = start ? [start] : [];
    for (let i = from + 1; i <= k; i++) {
      const s = solids[i] ?? null;
      if (s) parts.push(s);
    }
    return unionOwned(parts);
  };

  const stockAt = (k: number): ManifoldInstance => {
    if (k < 0 || count === 0) {
      base ??= sweep.stock.translate([0, 0, 0]);
      return base;
    }
    const kk = Math.min(k, count - 1);
    const cached = stocks.get(kk);
    if (cached) {
      // Refresh its age.
      stocks.delete(kk);
      stocks.set(kk, cached);
      return cached;
    }
    const c = cumulativeTo(kk);
    const s = c ? sweep.stock.subtract(c) : sweep.stock.translate([0, 0, 0]);
    c?.delete();
    stocks.set(kk, s);
    if (stocks.size > STOCK_CACHE) {
      const oldest = stocks.keys().next().value as number;
      stocks.get(oldest)?.delete();
      stocks.delete(oldest);
    }
    return s;
  };

  const removedVolumeAt = (k: number): number => {
    if (k < 0 || count === 0) return 0;
    const kk = Math.min(k, count - 1);
    const v = volumes.get(kk);
    if (v !== undefined) return v;
    const r = stockVolume - stockAt(kk).volume();
    volumes.set(kk, r);
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
    for (const a of anchors.values()) a?.delete();
    for (const s of stocks.values()) s.delete();
    base?.delete();
    anchors.clear();
    stocks.clear();
    base = null;
    anchoredTo = -1;
  };

  return { count, stockAt, checkpointAtStep, removedVolumeAt, dispose };
}

/**
 * Evaluate a lazy node into a true LEAF the caller owns (a mesh round-trip: the only way
 * found that yields a node sharing nothing with the lazy tree); the lazy handle is consumed.
 */
function materialise(tl: ManifoldToplevel, lazy: ManifoldInstance | null): ManifoldInstance | null {
  if (!lazy) return null;
  const leaf = new tl.Manifold(lazy.getMesh());
  lazy.delete();
  return leaf;
}

/**
 * A NEW handle for the union of `parts` (lazy: a chain of `add`s evaluates on first use), or
 * null for none. Never one of the parts themselves: a lone part is cloned, so the result is
 * always the caller's to delete.
 */
function unionOwned(parts: ManifoldInstance[]): ManifoldInstance | null {
  if (parts.length === 0) return null;
  let acc = (parts[0] as ManifoldInstance).translate([0, 0, 0]);
  for (let i = 1; i < parts.length; i++) {
    const next = acc.add(parts[i] as ManifoldInstance);
    acc.delete();
    acc = next;
  }
  return acc;
}
