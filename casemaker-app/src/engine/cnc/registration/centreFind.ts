/**
 * #827 — FIND A CENTRE WITH THE 3D PROBE: Studio's bore / boss / round-part routine, and the
 * geometry its readings turn into.
 *
 * THE ROUTINE (the 2026-10-31 bench session, #790): touch −X and +X at the estimated centre,
 * recentre on the midpoint, touch −Y and +Y, recentre, then repeat the X pair once at the new
 * centre. The repeat is what makes the pair honest on a feature the first estimate was off;
 * every touch that triggers is released with `G38.5` PROBE-AWAY before any `G0` — a retract
 * straight after a sideways contact raised `ALARM: unexpected probe trigger` on the bench.
 *
 * WHAT THE SPAN MEANS. A PRB is the BALL'S CENTRE. A bore's wall lies one effective radius
 * OUTSIDE each ball centre, so the diameter is span + 2R; a boss's outer face lies one radius
 * INSIDE each ball centre, so the diameter is span − 2R. The centre is the midpoint either way.
 * The bench measured exactly this: ball centres 7.196–7.235 apart in the vise's ⌀8.88 counterbore,
 * with R = 0.875 giving ⌀ 8.95–8.99 — the app reads the same figure Studio's Diagnostic wanted.
 *
 * FRAME. Work XY in, work XY out. The executor sends the moves in whichever frame is in force
 * and subtracts it, as every other touch does.
 */

/** Which feature's centre the routine finds. */
export type CentreKind = 'bore' | 'boss';

/** The operator's ask, as the Register step hands it over. */
export interface CentreFindRequest {
  kind: CentreKind;
  /** The operator's estimate, WORK XY — the centre of the stock or the feature. */
  at: { x: number; y: number };
  /**
   * The furthest each touch travels from the estimate, mm — the operator's search radius. A bore
   * larger than this, or a boss reaching past it, is a miss the outcome names; nothing travels
   * further than this, so a wrong estimate cannot send the ball across the bed.
   */
  searchMm: number;
  /** The probe's measured effective radius, mm (the accessory's `rimOffsetMm`). */
  ballRadiusMm: number;
  /** The stock's thickness, mm — the touch depth never leaves it. */
  stockThicknessMm?: number;
  /** The touch feed, mm/min. */
  touchFeed: number;
  /** #1207 — the most the search may travel (`registration.centreSearchMaxMm`), mm. */
  maxSearchMm: number;
}

/** One axis's pair of touches, as the executor will run them. */
export interface CentreAxisPair {
  axis: 'x' | 'y';
  /** Where the axis's first (negative) touch starts, WORK XY, and the signed travel. */
  minus: { from: { x: number; y: number }; travelMm: number };
  plus: { from: { x: number; y: number }; travelMm: number };
}

/** The whole routine, ready for the executor. */
export interface CentreFindPlan {
  kind: CentreKind;
  at: { x: number; y: number };
  /** The ball's centre runs this far below the measured top, mm. */
  depthMm: number;
  /** The axis pairs in order: X, Y, then X again at the recentred Y. */
  order: readonly ('x' | 'y')[];
  /** Each pair's start geometry for the CURRENT centre — the executor re-asks per iteration. */
  searchMm: number;
  ballRadiusMm: number;
  touchFeed: number;
}

/** Below this the ball cannot meet the wall at all: refuse rather than guess a height. */
export const MIN_CENTRE_DEPTH_MM = 0.3;


const r3 = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * How far below the measured top the ball's CENTRE travels: one radius (the equator on the wall)
 * for a part thicker than two radii, half the thickness for thinner ones (the ball meets the top
 * corner instead and the offset shrinks with it). Never less than {@link MIN_CENTRE_DEPTH_MM}.
 */
export function centreTouchDepthMm(ballRadiusMm: number, stockThicknessMm: number | undefined): number {
  const thickness = stockThicknessMm !== undefined && stockThicknessMm > 0 ? stockThicknessMm : ballRadiusMm * 2;
  return r3(Math.max(MIN_CENTRE_DEPTH_MM, Math.min(ballRadiusMm, thickness / 2)));
}

/**
 * The horizontal distance from the ball's centre to the wall at the trigger, mm — one radius at
 * or below the equator's depth, `sqrt(R² − depth²)` when the ball meets the top corner instead.
 */
export function centreWallOffsetMm(depthBelowTopMm: number, ballRadiusMm: number): number {
  if (depthBelowTopMm >= ballRadiusMm) return r3(ballRadiusMm);
  return r3(Math.sqrt(Math.max(0, ballRadiusMm * ballRadiusMm - depthBelowTopMm * depthBelowTopMm)));
}

/** Why a centre find cannot be planned here, in a sentence the operator can act on. */
export interface CentreFindRefusal {
  ok: false;
  reason: string;
}

/**
 * The routine for one request, or the sentence that refuses it. The planner refuses an
 * unmeasured radius, a search that is not a positive distance inside the safe bound, and a stock
 * too thin for the ball to sit below its top at all.
 */
export function planCentreFind(req: CentreFindRequest): { ok: true; plan: CentreFindPlan } | CentreFindRefusal {
  if (!(req.ballRadiusMm > 0)) {
    return {
      ok: false,
      reason: 'the probe has no measured effective radius — measure its tip in Manage › Accessories, then find the centre',
    };
  }
  if (!(req.searchMm > 0) || req.searchMm > req.maxSearchMm) {
    return {
      ok: false,
      reason: `the search radius must be between 0 and ${req.maxSearchMm} mm — a wrong estimate must not send the ball across the bed`,
    };
  }
  if (req.stockThicknessMm !== undefined && req.stockThicknessMm <= 0) {
    return { ok: false, reason: 'the stock has no thickness to touch against — say how thick it is, then find the centre' };
  }
  const depthMm = centreTouchDepthMm(req.ballRadiusMm, req.stockThicknessMm);
  if (depthMm < MIN_CENTRE_DEPTH_MM) {
    return {
      ok: false,
      reason: `the stock is thinner than the ball can sit below its top (${MIN_CENTRE_DEPTH_MM} mm minimum) — measure with the wired probe instead`,
    };
  }
  return {
    ok: true,
    plan: {
      kind: req.kind,
      at: { x: r3(req.at.x), y: r3(req.at.y) },
      depthMm,
      order: ['x', 'y', 'x'],
      searchMm: r3(req.searchMm),
      ballRadiusMm: r3(req.ballRadiusMm),
      touchFeed: req.touchFeed,
    },
  };
}

/**
 * Where one touch of a pair starts, and how far it travels.
 *
 * A BORE is touched OUTWARD from the estimate: the start is the centre on that axis and the
 * travel is the search radius, so the ball meets the wall from inside whatever the bore's size
 * (up to the search).
 *
 * A BOSS (and a round part's outside) is touched INWARD from beyond its edge: the start is the
 * estimate plus the search radius on that side, and the travel is the search radius, so the ball
 * meets the outer wall from outside. A boss larger than the search starts under the material —
 * the executor's guarded descent refuses that rather than driving the ball into it.
 */
export function centrePair(
  kind: CentreKind,
  at: { x: number; y: number },
  axis: 'x' | 'y',
  sign: -1 | 1,
  searchMm: number,
): { from: { x: number; y: number }; travelMm: number } {
  const outward = kind === 'bore';
  // A bore starts at the centre and travels outward `sign × search`; a boss starts `sign × search`
  // away and travels back inward, so its relative word is the opposite sign and its length `search`.
  const startAlong = at[axis] + (outward ? 0 : sign * searchMm);
  const travelMm = r3(outward ? sign * searchMm : -sign * searchMm);
  const from = axis === 'x' ? { x: r3(startAlong), y: r3(at.y) } : { x: r3(at.x), y: r3(startAlong) };
  return { from, travelMm };
}

/** One axis's measurement: the two ball centres, the centre they imply, and the diameter. */
export interface CentrePairReading {
  axis: 'x' | 'y';
  /** Ball centres at the two walls, work coordinate along the axis. */
  minus: number;
  plus: number;
  centre: number;
  spanMm: number;
  /** The measured diameter, mm — bore: span + 2R; boss: span − 2R. */
  diameterMm: number;
}

/**
 * One axis's pair, turned into its centre: the midpoint of the two ball centres, the span
 * between them, and the diameter the kind and the radius make of it.
 */
export function readCentrePair(
  kind: CentreKind,
  axis: 'x' | 'y',
  minus: number,
  plus: number,
  ballRadiusMm: number,
): CentrePairReading {
  const centre = r3((minus + plus) / 2);
  const spanMm = r3(Math.abs(plus - minus));
  const diameterMm = r3(kind === 'bore' ? spanMm + 2 * ballRadiusMm : spanMm - 2 * ballRadiusMm);
  return { axis, minus: r3(minus), plus: r3(plus), centre, spanMm, diameterMm };
}
