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
 * free. #224: `warmup()` builds the whole anchor chain during loading (the client shows it as
 * "preparing playback…"), so the first user scrub does not pay for it, and a seek to the last
 * checkpoint returns the sweep's own `result` / `removal` instead of rebuilding the tail.
 *
 * Playback is indexed two ways: by CHECKPOINT (what the scrubber bar shows) and by program
 * STEP (what the event list shows). A step maps to the last checkpoint whose first cutting
 * move is at or before it — "everything cut so far" — which is what the picture at that
 * moment should contain.
 *
 * The caller owns the playback and must `dispose()` it; it does not own the sweep result.
 * Every handle `stockAt` and `removalAt` return is the playback's, including the uncut stock
 * (a clone, never the sweep's own handle), so the caller never has to know which is which.
 * Both are EVICTABLE: mesh them in the same call that asked for them, never store or delete
 * them. `removalAt(k)` is the volume the stock lost (`/Simulation.md` §8: removed material is
 * visible geometry), the very solid `stockAt(k)` subtracted — it overshoots the stock top by
 * `OVERSHOOT_MM`, so intersect it with the stock to get what was actually cut.
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

/**
 * Cumulative unions kept at every this-many checkpoints. Was 32 (#194). #224 measured, with the
 * chain built during loading, that 32 left a post-load worst cold seek of 1.3-1.6 s on
 * PCB-UV-MASK PART2 — the ≤32-solid union chain onto one anchor plus the ~0.4 s subtraction that
 * every seek pays. At 16 PART2's worst is 0.73 s; the extra anchors cost +14 % peak RSS
 * (772→883 MB, the issue's budget is +25 %) and the 912-checkpoint pcb-test-air still measures
 * 0.21 s at +17 %. See /Simulation.md §8.0.
 */
export const ANCHOR_EVERY = 16;
/** Stocks kept, most recently used. */
export const STOCK_CACHE = 6;

export interface Playback {
  /** Number of checkpoints; valid indices are -1 (before any cut) … count-1. */
  readonly count: number;
  /** The stock after checkpoints 0..k. `k = -1` is the uncut stock. Owned by the playback; valid until the next `stockAt` evicts it or `dispose()`. */
  stockAt(k: number): ManifoldInstance;
  /**
   * Everything removed by checkpoints 0..k, as one solid, or null when nothing has been (k = -1,
   * or no checkpoint up to k cut anything). Same ownership as `stockAt`: the playback's, valid
   * until the stock cache evicts k or `dispose()`. Overshoots the stock top; see the file comment.
   */
  removalAt(k: number): ManifoldInstance | null;
  /** The checkpoint index "cut so far" at program step `step`, or -1 before the first cut. */
  checkpointAtStep(step: number): number;
  /** Removed volume after checkpoints 0..k; monotone non-decreasing in k. */
  removedVolumeAt(k: number): number;
  /**
   * Build the WHOLE anchor chain now (#224), up to the last anchor at or below `count-1`,
   * materialised. A cold seek that would otherwise walk the chain (`count-1` builds every
   * anchor, 3-7 s on the PCB corpus) pays for it here instead, off the scrub path: `session.load`
   * calls this so the client can show it as part of loading, and the first real scrub is cheap.
   * Idempotent — anchors already built are reused.
   */
  warmup(): void;
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
  interface Frame { stock: ManifoldInstance; removal: ManifoldInstance | null }
  const stocks = new Map<number, Frame>();
  const volumes = new Map<number, number>();
  let base: ManifoldInstance | null = null;
  const stockVolume = sweep.stock.volume();

  // First cutting step of each checkpoint, for the step → checkpoint map. Checkpoints are in
  // program order, so these are non-decreasing.
  const firstStep = timeline.checkpoints.map((cp) => cp.steps[0] ?? Number.POSITIVE_INFINITY);

  const isAnchor = (k: number): boolean => k % ANCHOR_EVERY === ANCHOR_EVERY - 1;

  /**
   * Build every anchor up to the last one at or below `k` (#224). The unions here are lazy but
   * `materialise` forces each into a leaf, so the chain is walked and meshed once, forward.
   */
  const buildAnchorsTo = (k: number): void => {
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
  };

  /** removal[0] ∪ … ∪ removal[k], as a NEW handle the caller owns, or null if nothing was removed. */
  const cumulativeTo = (k: number): ManifoldInstance | null => {
    // Advance the anchor chain as far as needed, without evaluating anything (unions are lazy).
    buildAnchorsTo(k);
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

  /** The cached frame for checkpoint `kk` (0..count-1), computing it and evicting the oldest if need be. */
  const frameAt = (kk: number): Frame => {
    // #224: the sweep already holds the final stock (`result`) and the final cumulative removal
    // (`removal`) — it built and evaluated both to report their volumes. Return them for the last
    // frame instead of rebuilding the tail chain and subtracting again. NOT cached and NEVER
    // deleted here: these are the sweep's handles, freed by the session (`disposeSweep`). The
    // identity tests rely on this being the same handle every time.
    if (kk === count - 1) return { stock: sweep.result, removal: sweep.removal };
    const cached = stocks.get(kk);
    if (cached) {
      // Refresh its age.
      stocks.delete(kk);
      stocks.set(kk, cached);
      return cached;
    }
    // `c` is a per-seek chain used once, never an anchor, so keeping it alive (it is evaluated by
    // the subtraction below and again when meshed) does not touch the trap in the file comment.
    const c = cumulativeTo(kk);
    const f: Frame = { stock: c ? sweep.stock.subtract(c) : sweep.stock.translate([0, 0, 0]), removal: c };
    stocks.set(kk, f);
    if (stocks.size > STOCK_CACHE) {
      const oldest = stocks.keys().next().value as number;
      const ev = stocks.get(oldest);
      ev?.stock.delete();
      ev?.removal?.delete();
      stocks.delete(oldest);
    }
    return f;
  };

  const stockAt = (k: number): ManifoldInstance => {
    if (k < 0 || count === 0) {
      base ??= sweep.stock.translate([0, 0, 0]);
      return base;
    }
    return frameAt(Math.min(k, count - 1)).stock;
  };

  const removalAt = (k: number): ManifoldInstance | null => {
    if (k < 0 || count === 0) return null;
    return frameAt(Math.min(k, count - 1)).removal;
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

  /** Build the whole anchor chain now (#224); see the interface doc. No-op once built (or empty). */
  const warmup = (): void => {
    if (count > 0) buildAnchorsTo(count - 1);
  };

  const dispose = (): void => {
    for (const a of anchors.values()) a?.delete();
    for (const f of stocks.values()) {
      f.stock.delete();
      f.removal?.delete();
    }
    base?.delete();
    anchors.clear();
    stocks.clear();
    base = null;
    anchoredTo = -1;
  };

  return { count, stockAt, removalAt, checkpointAtStep, removedVolumeAt, warmup, dispose };
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
