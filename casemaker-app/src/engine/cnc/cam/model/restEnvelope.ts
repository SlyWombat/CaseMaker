/**
 * #1028 — THE LEFTOVER'S BALL, BY ITS REMOVAL ENVELOPE.
 *
 * A per-point drop-cutter test cannot name the ball that would take a leftover: on a sloped wall
 * the tip under the centre stands `r · (1/cos α − 1)` above the wall (0.2 mm even at r = 0.25 on
 * the notched plate's 56° walls), so every radius fails the goal band, and the natural fallback
 * (tip below the standing surface) passes only at the smallest radius — 90.7 % at 0.25 mm, 25.6 %
 * at 2 mm (#1027's measured table). What separates a good ball from a bad one is its REMOVAL
 * ENVELOPE over the neighbourhood: a ball of radius r whose tip is at `p` cuts a cell at
 * `tip(p) + r − √(r² − |p − cell|²)`, so taking the minimum over every nearby tip position p
 * gives the lowest surface any r-ball reaches there. The finish passes at the ball's own
 * step-over leave a scallop `r − √(r² − (s/2)²)` above that minimum, and that is the surface the
 * operator gets.
 *
 * A radius is a candidate when the envelope-plus-scallop lands within the band of the goal at the
 * acceptance's share of the leftover cells (90 %) or at the deepest one. The largest such radius
 * (six bisection steps on [0.25 mm, R_finish]) is the answer; below 0.5 mm the plan keeps its
 * plain absence (a ball that small is not a cutter the operator would reach for).
 *
 * COST (#1028 §8.9): cells capped at 2 000 (a deterministic stride plus the deepest), p sampled
 * within the radius at `max(cellPitch, r/2)` (≤ 25 per cell), six radii — ≤ 300 000 tip lookups,
 * each a cached triangle-bin drop-cutter, and only when no catalogue ball was measured.
 */

export interface EnvelopeCell {
  x: number;
  y: number;
  /** The goal's own height at the cell (the surface the ball must reach). */
  goalZ: number;
  /** How far the plan's own stamp stands over the goal there — used to keep the deepest cell. */
  aboveMm: number;
}

export interface RemovalEnvelopeOptions {
  /** The finish ball's radius, mm — the bisection's upper bound. */
  finishRadiusMm: number;
  /** The plan's cell pitch, mm — the neighbourhood sample never finer than this. */
  cellPitchMm: number;
  /** The feed row's step-over fraction of the ball's diameter (the shop's own; 0.45 default). */
  stepOverFraction?: number;
  /** The band the ball must reach within, mm. */
  bandMm?: number;
}

export interface RemovalEnvelopeResult {
  /** The answer, rounded to 0.5 mm; null when no radius ≥ 0.5 mm reaches. */
  diameterMm: number | null;
  /** The largest reaching radius, mm (null when none). */
  radiusMm: number | null;
  /** The share of cells the answer reached (0 when none). */
  share: number;
}

/** Deterministic cap: a stride sample of `cap` cells plus the deepest one (the six-field rule). */
export function capEnvelopeCells(cells: readonly EnvelopeCell[], cap = 2000): EnvelopeCell[] {
  if (cells.length <= cap) return [...cells];
  const stride = cells.length / cap;
  const out: EnvelopeCell[] = [];
  for (let i = 0; i < cap; i++) out.push(cells[Math.min(cells.length - 1, Math.floor(i * stride))]!);
  let deepest = out[0]!;
  for (const c of cells) if (c.aboveMm > deepest.aboveMm) deepest = c;
  if (!out.includes(deepest)) out[out.length - 1] = deepest;
  return out;
}

/**
 * The scallop a pass at the ball's own step-over leaves over the envelope's minimum, mm.
 * `s = stepOverFraction × 2r` (the feed row's fraction), so the ball's own pitch scales with it.
 */
export function envelopeScallopMm(radiusMm: number, stepOverFraction: number): number {
  const s = stepOverFraction * 2 * radiusMm;
  const half = s / 2;
  if (!(radiusMm > 0) || !(half > 0)) return 0;
  return radiusMm - Math.sqrt(Math.max(0, radiusMm * radiusMm - half * half));
}

/** Whether one radius's removal envelope reaches the goal across the cells (the rule above). */
export function envelopeReaches(
  cells: readonly EnvelopeCell[],
  radiusMm: number,
  tipAt: (x: number, y: number) => number | null,
  opts: RemovalEnvelopeOptions,
): { share: number; deepestReached: boolean } {
  const band = opts.bandMm ?? 0.1;
  const scallop = envelopeScallopMm(radiusMm, opts.stepOverFraction ?? 0.45);
  const step = Math.max(opts.cellPitchMm, radiusMm / 2);
  let reached = 0;
  let deepestReached = false;
  let deepestAbove = -Infinity;
  for (const cell of cells) {
    let envelope = Infinity;
    for (let px = cell.x - radiusMm; px <= cell.x + radiusMm + 1e-9; px += step) {
      for (let py = cell.y - radiusMm; py <= cell.y + radiusMm + 1e-9; py += step) {
        const d = Math.hypot(px - cell.x, py - cell.y);
        if (d > radiusMm) continue;
        const tip = tipAt(px, py);
        if (tip === null) continue;
        const surface = tip + radiusMm - Math.sqrt(Math.max(0, radiusMm * radiusMm - d * d));
        if (surface < envelope) envelope = surface;
      }
    }
    const cut = envelope === Infinity ? Infinity : envelope + scallop;
    const hit = cut <= cell.goalZ + band;
    if (hit) reached++;
    if (cell.aboveMm > deepestAbove) {
      deepestAbove = cell.aboveMm;
      deepestReached = hit;
    }
  }
  return { share: cells.length === 0 ? 0 : reached / cells.length, deepestReached };
}

/**
 * The largest ball whose removal envelope takes the leftover: six bisection steps on
 * [0.25 mm, R_finish], the acceptance's share (90 %) OR the deepest cell, rounded to 0.5 mm.
 */
export function removalEnvelopeBall(
  cellsIn: readonly EnvelopeCell[],
  tipAt: (x: number, y: number) => number | null,
  opts: RemovalEnvelopeOptions,
): RemovalEnvelopeResult {
  const cells = capEnvelopeCells(cellsIn);
  if (cells.length === 0) return { diameterMm: null, radiusMm: null, share: 0 };
  const accept = (r: number): { ok: boolean; share: number } => {
    const { share, deepestReached } = envelopeReaches(cells, r, tipAt, opts);
    return { ok: share >= 0.9 || deepestReached, share };
  };
  let lo = 0.25;
  let hi = Math.max(lo, opts.finishRadiusMm);
  let best: { radius: number; share: number } | null = null;
  const first = accept(lo);
  if (first.ok) best = { radius: lo, share: first.share };
  for (let i = 0; i < 6; i++) {
    const mid = (lo + hi) / 2;
    const test = accept(mid);
    if (test.ok) {
      best = { radius: mid, share: test.share };
      lo = mid;
    } else {
      hi = mid;
    }
  }
  if (best === null) return { diameterMm: null, radiusMm: null, share: 0 };
  const rounded = Math.round((best.radius * 2) / 0.5) * 0.5;
  if (rounded < 0.5) return { diameterMm: null, radiusMm: best.radius, share: best.share };
  return { diameterMm: rounded, radiusMm: best.radius, share: best.share };
}
