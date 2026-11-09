/**
 * #924 — the independent, DESIGN-SIDE oracle (gate statements 5 and 6 of
 * `docs/reviews/2026-11-02-cnc-review/03-simulation-gate.md` §2.3(e)).
 *
 * `oracle.ts`'s `computeOracle` is the CAM grading its own homework: the flat floor it predicts is
 * `offset(offset(design, -planeRadius), tipRadius)` (#584, `engraveGenerate.ts`) and the V groove
 * it predicts shares `grooveRadiusAt`'s cone with the engine that sweeps it (`oracle.ts:100-125`).
 * A bug that is consistent with itself on both sides of that shared math is invisible to it — #741
 * (the V flank widened past the shank, 20-60 % excess volume) was found only by an EXTERNAL sweep
 * (`tools/render.py`), because the oracle's own groove prediction used the same uncapped cone the
 * engine swept with.
 *
 * This module checks the simulation against the RAW DESIGN instead, with its own math:
 *
 *   - {@link checkDesignReach} — `Simulation.md` §7's point-in-polygon check, on the RAW outline
 *     as drawn and the cutter's radius from its Tool record ({@link designCutterOf}). Points on a
 *     grid are classified by exact point-to-segment distance and winding number, never by
 *     offsetting, at every level from each item's floor to its top face (#924 re-opened, B1/B2).
 *   - {@link flatCapsuleVolumeMm3} / {@link vGrooveVolumeMm3} — closed-form removed-volume formulas
 *     derived directly from the swept solid's geometry (a flat-ended cylinder or a cone, integrated
 *     along a straight run), not from the engine's own union/sweep code.
 *   - {@link checkGoalCutInto} — the 3D half (#924's scope note, #909): a cut-into-the-goal /
 *     leftover-above-the-goal comparison against a {@link GoalHeightfield}, ported numerically from
 *     the bench's `tools/goal_check.py` (`d = sweptTop - goalTop`; `d < -CUT_INTO` is cut-into,
 *     `d > leftover thresholds` is leftover material) so the app itself can read the same verdict
 *     the demo page's external tool does, not only a human looking at the page.
 */

import { ARC_CHORD_TOLERANCE_MM, SWEEP_SIMPLIFY_EPS_MM } from '@/engine/compiler/arcResolution';
import type { ManifoldToplevel } from '@/workers/geometry/evaluateOp';
import { ORACLE_AREA_FLOOR, type OracleBbox, type OraclePolygon, type OracleSliceAt } from '@/engine/cnc/engrave/oracleTypes';
import type { Tool } from '@/engine/cnc/tool';
import type { GoalHeightfield } from '@/engine/cnc/engrave/goalHeightfield';
import { goalTopAt, type ResultTop } from '@/engine/cnc/engrave/goalCoverage';

// ---------------------------------------------------------------------------------------------
// Part 1 — the 2D/area design check (gate statement 5).
// ---------------------------------------------------------------------------------------------

/**
 * The cutter's radius as a function of height above its tip, read from the Tool record alone —
 * never from the CAM's cone (`vProfile`'s `VCone`, `grooveRadiusAt`) or its plane radius.
 */
export interface DesignCutter {
  /** Radius at the tip, mm; a flat's whole cutting radius. */
  tipRadius: number;
  /** Widening per mm of height, tan(half angle); 0 for a flat. */
  tanHalf: number;
  /** The body's radius, where a flank stops widening; Infinity when the record states none. */
  maxRadius: number;
  /** A ball's radius: below it the profile is the sphere's. */
  ballRadius?: number;
}

/** One design item: its outline as drawn, the depth it is cut to, and the cutter that cuts it. */
export interface DesignCheckItem {
  /** Matches `OraclePredicted.itemId` so a report can name the item. */
  itemId?: string;
  /** The raw outline as drawn (outer contours CCW, holes CW), never an offset of it. */
  design: OraclePolygon[];
  /** The item's floor depth below the work top face, mm (positive). */
  depth: number;
  /** The cutter, from the Tool record. Absent on an allowance-only footprint. */
  cutter?: DesignCutter;
  /** Depth of the surface the item sits on, mm (0 = the stock's top face). */
  surfaceDepth?: number;
  /** The stock's colour boundary below the top face, mm, from the job's own stock; null without a film. */
  film?: number | null;
  /** A V-carve whose depth follows the outline: its edge meets the outline at its top face. */
  variableDepth?: true;
  /** Set when the generator stated it cut shallower than the job asks; `depth` is then the cut depth. */
  jobDepth?: number;
  /**
   * A design footprint that explains removal near other items but is not graded itself (a drilled
   * hole's disc, a cut-out's band). Without it, a hole beside a label reads as that label's "too far".
   */
  allowOnly?: true;
}

const DEG = Math.PI / 180;

/** A positive number from a record field, or null (0 is "unset" in the tool vocabulary). */
function stated(v: number | null | undefined): number | null {
  return v !== null && v !== undefined && Number.isFinite(v) && v > 0 ? v : null;
}

/** The cutter as the check reads it, from the Tool record's own fields; null when it states no width. */
export function designCutterOf(tool: Tool): DesignCutter | null {
  const vShape = tool.shape === 'engraving' || tool.shape === 'chamfer';
  if (vShape) {
    const tip = tool.tipDiameter === null && tool.shape === 'chamfer' ? 0 : tool.tipDiameter;
    const half = stated(tool.halfAngle) ?? (stated(tool.angle) === null ? null : stated(tool.angle)! / 2);
    if (tip === null || !(tip >= 0) || half === null || !(half < 90)) return null;
    const body = stated(tool.diameter);
    return { tipRadius: tip / 2, tanHalf: Math.tan(half * DEG), maxRadius: body !== null && body > tip ? body / 2 : Infinity };
  }
  const d = stated(tool.diameter) ?? stated(tool.tipDiameter);
  if (d === null) return null;
  return tool.shape === 'ball'
    ? { tipRadius: 0, tanHalf: 0, maxRadius: d / 2, ballRadius: d / 2 }
    : { tipRadius: d / 2, tanHalf: 0, maxRadius: d / 2 };
}

/** The cutter's radius `h` mm above its tip. */
export function cutterRadiusAt(c: DesignCutter, h: number): number {
  const hh = Math.max(0, h);
  if (c.ballRadius !== undefined) {
    const R = c.ballRadius;
    return hh >= R ? R : Math.sqrt(Math.max(0, 2 * R * hh - hh * hh));
  }
  return Math.min(c.tipRadius + hh * c.tanHalf, c.maxRadius);
}

/** Height above the item's floor where its cut edge should meet the outline. */
function planeHeight(item: DesignCheckItem, cutter: DesignCutter): number {
  const surface = item.surfaceDepth ?? 0;
  const top = Math.max(0, item.depth - surface);
  if (item.variableDepth === true || cutter.tanHalf === 0) return top;
  // A V meets the outline at the colour boundary when its cut reaches past it, else at its floor
  // (the same rule `vCarvePlane` applies, restated from the job's own film depth).
  const film = item.film ?? null;
  return film !== null && film > surface + 1e-9 ? Math.min(top, Math.max(0, item.depth - film)) : 0;
}

/**
 * How far past the outline an over-cut is still looked for, mm, beyond the item's own allowance.
 * Removal further out belongs to some other operation (a trace, a chamfer, a thread) this check
 * does not grade.
 */
const DESIGN_ZONE_PAD_MM = 1;
/** The comparison grid's pitch, mm, when the caller states none. */
export const DESIGN_CHECK_PITCH_MM = 0.02;
const LEVEL_STEP_MM = 0.1;
const MAX_LEVEL_STEPS = 16;
const ABOVE = 0.001;

export interface DesignCheckOptions {
  /** Tolerance beyond each item's own allowance, mm; the sweep's own band when the caller has it. */
  band?: number;
  /** The comparison grid's pitch, mm. */
  pitchMm?: number;
}

/** One item's result at one level. */
export interface DesignCheckLevel {
  itemId?: string;
  z: number;
  /** Area of the outline tested on the reach side, mm² (its denominator); 0 above the reach level. */
  reachableArea: number;
  /** Part of that area the simulation did not remove, mm². */
  unreached: number;
  /** Removed area outside the outline by more than the cutter's own widening plus the band, mm². */
  tooFar: number;
  unreachedBbox?: OracleBbox | null;
  tooFarBbox?: OracleBbox | null;
}

export interface DesignCheckReport {
  ok: boolean;
  band: number;
  /** The grid the points were tested on, for the report's own line. */
  gridNote?: string;
  pitchMm: number;
  levels: DesignCheckLevel[];
  worst: {
    unreached: number;
    tooFar: number;
    unreachedAt?: { itemId?: string; z: number; bbox: OracleBbox } | null;
    tooFarAt?: { itemId?: string; z: number; bbox: OracleBbox } | null;
  };
  areaFloor: number;
  /** One sentence: the method, and the depth each clamped item was judged at. */
  sentence: string;
}

type Seg = [number, number, number, number];

/** An outline prepared for point queries: its edges, bucketed, and its bbox. */
interface Shape {
  segs: Seg[];
  box: OracleBbox;
  cell: number;
  cols: number;
  rows: number;
  buckets: Map<number, number[]>;
}

function shapeOf(polygons: readonly OraclePolygon[]): Shape {
  const segs: Seg[] = [];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const ring of polygons) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % ring.length]!;
      segs.push([a[0], a[1], b[0], b[1]]);
      x0 = Math.min(x0, a[0]);
      y0 = Math.min(y0, a[1]);
      x1 = Math.max(x1, a[0]);
      y1 = Math.max(y1, a[1]);
    }
  }
  const cell = 0.25;
  const cols = Math.max(1, Math.ceil((x1 - x0) / cell) + 1);
  const rows = Math.max(1, Math.ceil((y1 - y0) / cell) + 1);
  const buckets = new Map<number, number[]>();
  segs.forEach((s, k) => {
    const c0 = Math.floor((Math.min(s[0], s[2]) - x0) / cell);
    const c1 = Math.floor((Math.max(s[0], s[2]) - x0) / cell);
    const r0 = Math.floor((Math.min(s[1], s[3]) - y0) / cell);
    const r1 = Math.floor((Math.max(s[1], s[3]) - y0) / cell);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const key = r * cols + c;
        const list = buckets.get(key);
        if (list === undefined) buckets.set(key, [k]);
        else list.push(k);
      }
    }
  });
  return { segs, box: { min: [x0, y0], max: [x1, y1] }, cell, cols, rows, buckets };
}

function segDist2(px: number, py: number, s: Seg): number {
  const dx = s[2] - s[0];
  const dy = s[3] - s[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - s[0]) * dx + (py - s[1]) * dy) / len2));
  const ex = s[0] + t * dx - px;
  const ey = s[1] + t * dy - py;
  return ex * ex + ey * ey;
}

/** Is any edge of `shape` within `t` of the point? Exact point-to-segment distance. */
function edgeWithin(shape: Shape, px: number, py: number, t: number): boolean {
  const { box, cell, cols, rows, buckets, segs } = shape;
  if (px < box.min[0] - t || px > box.max[0] + t || py < box.min[1] - t || py > box.max[1] + t) return false;
  const c0 = Math.max(0, Math.floor((px - t - box.min[0]) / cell));
  const c1 = Math.min(cols - 1, Math.floor((px + t - box.min[0]) / cell));
  const r0 = Math.max(0, Math.floor((py - t - box.min[1]) / cell));
  const r1 = Math.min(rows - 1, Math.floor((py + t - box.min[1]) / cell));
  const t2 = t * t;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const list = buckets.get(r * cols + c);
      if (list === undefined) continue;
      for (const k of list) if (segDist2(px, py, segs[k]!) <= t2) return true;
    }
  }
  return false;
}

/**
 * Winding-number membership on the global lattice (points at `(k + ½)·pitch`, `(j + ½)·pitch`):
 * for every row j an outline crosses, the half-open index ranges [k0, k1) of points inside it.
 * Built once per outline by walking its edges, so a row costs only the edges that cross it.
 */
type Rows = Map<number, [number, number][]>;

function rowsOf(segs: readonly Seg[], pitch: number): Rows {
  const hits = new Map<number, { x: number; w: number }[]>();
  for (const [ax, ay, bx, by] of segs) {
    if (ay === by) continue;
    const lo = Math.min(ay, by);
    const hi = Math.max(ay, by);
    // Scanning left to right, the winding left of a point is minus the crossings passed (CCW outers).
    const w = by > ay ? -1 : 1;
    for (let j = Math.ceil(lo / pitch - 0.5); (j + 0.5) * pitch < hi; j++) {
      const y = (j + 0.5) * pitch;
      if (y < lo) continue;
      const x = ax + ((y - ay) / (by - ay)) * (bx - ax);
      const list = hits.get(j);
      if (list === undefined) hits.set(j, [{ x, w }]);
      else list.push({ x, w });
    }
  }
  const rows: Rows = new Map();
  for (const [j, list] of hits) {
    list.sort((a, b) => a.x - b.x);
    const out: [number, number][] = [];
    let wind = 0;
    let start = 0;
    for (const h of list) {
      const before = wind;
      wind += h.w;
      if (before <= 0 && wind > 0) start = h.x;
      else if (before > 0 && wind <= 0) {
        const k0 = Math.ceil(start / pitch - 0.5);
        const k1 = Math.ceil(h.x / pitch - 0.5);
        if (k1 > k0) out.push([k0, k1]);
      }
    }
    if (out.length > 0) rows.set(j, out);
  }
  return rows;
}

/**
 * Every lattice point within `t` of the outline's edge, as merged index ranges per row: exactly the
 * points `edgeWithin(shape, x, y, t)` accepts, built once from the segments instead of searched per
 * point (#924 follow-up: j02's reach loop asked 44 million points one by one, 54 s of the run).
 *
 * The points within `t` of one segment form its capsule, which is convex, so on a row it is one
 * interval: the hull of the pieces where the nearest point is either end (two discs) or the
 * segment's interior (the slab within `t` of the line). The closed test `≤ t` matches `segDist2`.
 */
function nearRowsOf(shape: Shape, t: number, pitch: number): Rows {
  const out = new Map<number, [number, number][]>();
  const t2 = t * t;
  for (const [ax, ay, bx, by] of shape.segs) {
    const jLo = Math.ceil((Math.min(ay, by) - t) / pitch - 0.5);
    const jHi = Math.floor((Math.max(ay, by) + t) / pitch - 0.5);
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    for (let j = jLo; j <= jHi; j++) {
      const y = (j + 0.5) * pitch;
      let lo = Infinity;
      let hi = -Infinity;
      // The two end discs.
      for (const [cx, cy] of [
        [ax, ay],
        [bx, by],
      ] as const) {
        const h2 = t2 - (y - cy) * (y - cy);
        if (h2 >= 0) {
          const h = Math.sqrt(h2);
          lo = Math.min(lo, cx - h);
          hi = Math.max(hi, cx + h);
        }
      }
      // The slab: projection parameter in [0, 1] and distance to the line ≤ t. Both are linear in x
      // on this row, so each is an interval (or all/none when its x coefficient is 0).
      if (len2 > 0) {
        let sLo = -Infinity;
        let sHi = Infinity;
        // s(x) = ((x − ax)·dx + (y − ay)·dy) / len2 ∈ [0, 1]
        const s0 = ((y - ay) * dy) / len2 - (ax * dx) / len2;
        const s1 = dx / len2;
        const clamp = (c0: number, c1: number, min: number, max: number): void => {
          // c0 + c1·x ∈ [min, max]
          if (c1 === 0) {
            if (c0 < min || c0 > max) {
              sLo = Infinity;
              sHi = -Infinity;
            }
            return;
          }
          const xa = (min - c0) / c1;
          const xb = (max - c0) / c1;
          sLo = Math.max(sLo, Math.min(xa, xb));
          sHi = Math.min(sHi, Math.max(xa, xb));
        };
        clamp(s0, s1, 0, 1);
        // signed distance to the line: ((x − ax)·dy − (y − ay)·dx) / len ∈ [−t, t]
        const len = Math.sqrt(len2);
        clamp((-ax * dy - (y - ay) * dx) / len, dy / len, -t, t);
        if (sLo <= sHi) {
          lo = Math.min(lo, sLo);
          hi = Math.max(hi, sHi);
        }
      }
      if (lo > hi) continue;
      const k0 = Math.ceil(lo / pitch - 0.5);
      const k1 = Math.floor(hi / pitch - 0.5) + 1;
      if (k1 <= k0) continue;
      const list = out.get(j);
      if (list === undefined) out.set(j, [[k0, k1]]);
      else list.push([k0, k1]);
    }
  }
  for (const [j, list] of out) out.set(j, mergeRanges(list));
  return out;
}

/** The union of sorted-or-not index ranges, merged. */
function mergeRanges(ranges: [number, number][]): [number, number][] {
  if (ranges.length < 2) return ranges;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [[sorted[0]![0], sorted[0]![1]]];
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1]!;
    const [a, b] = sorted[i]!;
    if (a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** `from` minus `minus` (both merged), as index ranges. */
function subtractRanges(from: readonly [number, number][], minus: readonly [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const [a0, b0] of from) {
    let a = a0;
    for (const [c, d] of minus) {
      if (d <= a || c >= b0) continue;
      if (c > a) out.push([a, c]);
      a = Math.max(a, d);
      if (a >= b0) break;
    }
    if (a < b0) out.push([a, b0]);
  }
  return out;
}

const rangeCount = (ranges: readonly [number, number][]): number => ranges.reduce((n, [a, b]) => n + (b - a), 0);

interface Prepared {
  item: DesignCheckItem;
  shape: Shape;
  rows: Rows;
  floorZ: number;
  topZ: number;
  cutter: DesignCutter | null;
  hRef: number;
  rRef: number;
  levels: number[];
}

function levelsOf(p: Omit<Prepared, 'levels' | 'rows'>): number[] {
  const top = p.topZ - ABOVE;
  const zs = new Set<number>([p.floorZ + ABOVE]);
  const c = p.cutter;
  if (c !== null && c.tanHalf > 0 && p.item.allowOnly !== true) {
    const height = p.topZ - p.floorZ;
    if (p.hRef > ABOVE && p.floorZ + p.hRef < top) zs.add(p.floorZ + p.hRef);
    if (Number.isFinite(c.maxRadius)) {
      const hCap = (c.maxRadius - c.tipRadius) / c.tanHalf;
      if (hCap > 0 && p.floorZ + hCap + ABOVE < top) zs.add(p.floorZ + hCap + ABOVE);
    }
    const step = Math.max(LEVEL_STEP_MM, height / MAX_LEVEL_STEPS);
    for (let h = step; p.floorZ + h < top; h += step) zs.add(p.floorZ + h);
  }
  if (top > p.floorZ + ABOVE) zs.add(top);
  return [...zs].map((z) => Math.round(z * 1e4) / 1e4).sort((a, b) => a - b);
}

/** Running bbox of the failing points, so a report can say where. */
class PointBox {
  n = 0;
  private x0 = Infinity;
  private y0 = Infinity;
  private x1 = -Infinity;
  private y1 = -Infinity;
  add(x: number, y: number): void {
    this.n++;
    if (x < this.x0) this.x0 = x;
    if (y < this.y0) this.y0 = y;
    if (x > this.x1) this.x1 = x;
    if (y > this.y1) this.y1 = y;
  }
  /** Every point of row `y` with index in [k0, k1), at once (the same bbox and count as one by one). */
  addRange(k0: number, k1: number, y: number, pitch: number): void {
    if (k1 <= k0) return;
    this.add((k0 + 0.5) * pitch, y);
    this.add((k1 - 0.5) * pitch, y);
    this.n += k1 - k0 - 2;
  }
  box(half: number): OracleBbox | null {
    return this.n === 0 ? null : { min: [this.x0 - half, this.y0 - half], max: [this.x1 + half, this.y1 + half] };
  }
}

const fmt = (v: number): string => String(Math.round(v * 1000) / 1000);

/**
 * `Simulation.md` §7's check, against the RAW outline, by points — never by offsetting.
 *
 * Reach: every grid point of an item's outline at least the cutter's radius at its reference plane
 * (plus the band) from the outline's edge must be removed at the item's floor (at its top face for a
 * variable-depth V). Too far: at every level from the floor to the item's top face, a removed point
 * within the item's zone is explained only by some item cut that deep — inside its outline, or
 * outside by no more than its own cutter widens above its reference plane, plus the band — or by an
 * allowance-only footprint. Distances are exact point-to-segment, membership is winding number.
 */
export function checkDesignReach(
  tl: ManifoldToplevel,
  items: readonly DesignCheckItem[],
  sliceAt: OracleSliceAt,
  opts: DesignCheckOptions,
  gridNote?: string,
): DesignCheckReport {
  void tl;
  const band = opts.band ?? SWEEP_SIMPLIFY_EPS_MM + 2 * ARC_CHORD_TOLERANCE_MM;
  const pitch = opts.pitchMm ?? DESIGN_CHECK_PITCH_MM;
  const cellArea = pitch * pitch;

  const prepared: Prepared[] = [];
  for (const item of items) {
    if (item.design.length === 0 || !(item.depth > 0)) continue;
    const cutter = item.cutter ?? null;
    if (item.allowOnly !== true && cutter === null) continue;
    const floorZ = -item.depth;
    const topZ = -(item.surfaceDepth ?? 0);
    const hRef = cutter === null ? 0 : planeHeight(item, cutter);
    const rRef = cutter === null ? 0 : cutterRadiusAt(cutter, hRef);
    const shape = shapeOf(item.design);
    const base = { item, shape, floorZ, topZ, cutter, hRef, rRef };
    prepared.push({ ...base, rows: rowsOf(shape.segs, pitch), levels: item.allowOnly === true ? [] : levelsOf(base) });
  }
  const graded = prepared.filter((p) => p.item.allowOnly !== true);

  /** How far outside its outline item `p`'s cut may stand at level z, mm. */
  const allowance = (p: Prepared, z: number): number =>
    p.cutter === null ? 0 : Math.max(0, cutterRadiusAt(p.cutter, z - p.floorZ) - p.rRef);
  const reaches = (p: Prepared, z: number): boolean => p.floorZ <= z + 1e-6 && z <= p.topZ + 1e-6;
  const overlaps = (a: OracleBbox, b: OracleBbox, pad: number): boolean =>
    a.min[0] - pad <= b.max[0] && b.min[0] <= a.max[0] + pad && a.min[1] - pad <= b.max[1] && b.min[1] <= a.max[1] + pad;

  const levels: DesignCheckLevel[] = [];
  const allLevels = [...new Set(graded.flatMap((p) => p.levels))].sort((a, b) => a - b);
  for (const z of allLevels) {
    const slice = sliceAt(z);
    const cut = slice === null ? (new Map() as Rows) : rowsOf(shapeOf(slice.toPolygons() as OraclePolygon[]).segs, pitch);
    slice?.delete();
    for (const p of graded) {
      if (!p.levels.includes(z)) continue;
      const reachHere = p.item.variableDepth === true ? z === p.levels[p.levels.length - 1] : z === p.levels[0];
      const zone = allowance(p, z) + band + DESIGN_ZONE_PAD_MM;
      const explainers = prepared.filter((e) => reaches(e, z) && overlaps(e.shape.box, p.shape.box, zone + allowance(e, z) + band));
      const j0 = Math.ceil((p.shape.box.min[1] - zone) / pitch - 0.5);
      const j1 = Math.floor((p.shape.box.max[1] + zone) / pitch - 0.5);
      const k0 = Math.ceil((p.shape.box.min[0] - zone) / pitch - 0.5);
      const k1 = Math.floor((p.shape.box.max[0] + zone) / pitch - 0.5);
      const unreached = new PointBox();
      const tooFar = new PointBox();
      let deep = 0;
      const near = reachHere ? nearRowsOf(p.shape, p.rRef + band, pitch) : null;
      for (let j = j0; j <= j1; j++) {
        const y = (j + 0.5) * pitch;
        const cutRow = mergeRanges(cut.get(j) ?? []);
        if (reachHere) {
          const ownRow = mergeRanges(p.rows.get(j) ?? []);
          deep += rangeCount(ownRow);
          // Only the outline's points the sweep did NOT remove can be unreached; of those, the ones
          // at least the cutter's radius (plus the band) from the edge are.
          const left = subtractRanges(ownRow, cutRow);
          if (left.length > 0) {
            for (const [a, b] of subtractRanges(left, near!.get(j) ?? [])) unreached.addRange(a, b, y, pitch);
          }
        }
        if (cutRow.length === 0) continue;
        const clipped = subtractRanges(cutRow, [[-Infinity, k0], [k1 + 1, Infinity]]);
        const inside = mergeRanges(explainers.flatMap((e) => e.rows.get(j) ?? []));
        for (const [a, b] of subtractRanges(clipped, inside)) {
          for (let k = a; k < b; k++) {
            const x = (k + 0.5) * pitch;
            if (!edgeWithin(p.shape, x, y, zone)) continue;
            if (explainers.some((e) => edgeWithin(e.shape, x, y, allowance(e, z) + band))) continue;
            tooFar.add(x, y);
          }
        }
      }
      levels.push({
        itemId: p.item.itemId,
        z,
        reachableArea: reachHere ? deep * cellArea : 0,
        unreached: unreached.n * cellArea,
        tooFar: tooFar.n * cellArea,
        unreachedBbox: unreached.box(pitch / 2),
        tooFarBbox: tooFar.box(pitch / 2),
      });
    }
  }

  let worstUnreached = 0;
  let worstTooFar = 0;
  let worstUnreachedAt: { itemId?: string; z: number; bbox: OracleBbox } | null = null;
  let worstTooFarAt: { itemId?: string; z: number; bbox: OracleBbox } | null = null;
  for (const l of levels) {
    if (l.unreached > worstUnreached) {
      worstUnreached = l.unreached;
      worstUnreachedAt = l.unreachedBbox ? { itemId: l.itemId, z: l.z, bbox: l.unreachedBbox } : null;
    }
    if (l.tooFar > worstTooFar) {
      worstTooFar = l.tooFar;
      worstTooFarAt = l.tooFarBbox ? { itemId: l.itemId, z: l.z, bbox: l.tooFarBbox } : null;
    }
  }
  const areaFloor = ORACLE_AREA_FLOOR;
  const ok = worstUnreached <= areaFloor && worstTooFar <= areaFloor;
  const clamped = graded
    .filter((p) => p.item.jobDepth !== undefined)
    .map((p) => `${p.item.itemId ?? 'an item'} is judged at the ${fmt(p.item.depth)} mm it is cut to, not the job's ${fmt(p.item.jobDepth!)} mm`);
  const verdict = ok
    ? 'every outline is reached and nothing is cut past it'
    : worstTooFar > areaFloor && worstTooFarAt
      ? `${worstTooFarAt.itemId ?? 'an item'} is cut ${fmt(worstTooFar)} mm² past its outline at Z ${fmt(worstTooFarAt.z)}`
      : `${worstUnreachedAt?.itemId ?? 'an item'} leaves ${fmt(worstUnreached)} mm² of its outline uncut at Z ${fmt(worstUnreachedAt?.z ?? 0)}`;
  const sentence =
    `Design check against the raw outlines, points on a ${fmt(pitch)} mm grid, band ${fmt(band)} mm, every level from each floor to its top face: ${verdict}.` +
    (clamped.length === 0 ? '' : ` ${clamped.join('; ')}.`);
  return {
    ok,
    band,
    gridNote: gridNote ?? `points on a ${fmt(pitch)} mm grid`,
    pitchMm: pitch,
    levels,
    worst: { unreached: worstUnreached, tooFar: worstTooFar, unreachedAt: worstUnreachedAt, tooFarAt: worstTooFarAt },
    areaFloor,
    sentence,
  };
}

// ---------------------------------------------------------------------------------------------
// Part 2 — analytic volumes, a second implementation (gate statement 6).
// ---------------------------------------------------------------------------------------------

/**
 * The volume a FLAT-bottomed round tool of radius `r` removes tracing a straight run of length `L`
 * (centre-to-centre) to a constant depth `d` — a prism the length of the run plus a half-cylinder
 * cap at each end, i.e. the capsule footprint times the depth:
 *
 *   V = (2 r L + pi r^2) * d
 *
 * Derived directly from the swept solid's own shape (a capsule prism), never from the engine's
 * `capsuleArea`/`capsuleContours` (`workers/geometry/sweep.ts`) — this is a second, independent
 * implementation of the same number, not a caller of the first one.
 */
export function flatCapsuleVolumeMm3(lengthMm: number, radiusMm: number, depthMm: number): number {
  if (lengthMm < 0 || radiusMm <= 0 || depthMm <= 0) return 0;
  return (2 * radiusMm * lengthMm + Math.PI * radiusMm * radiusMm) * depthMm;
}

/**
 * The volume a V cutter of half-angle `halfAngleDeg` removes tracing a straight run of length `L`
 * to tip depth `d`, body uncapped (the stroke is shallower than the cutter's cone-to-body
 * transition — #741's own condition for the bug: this formula is only valid while the cut stays
 * on the cone, which is the caller's job to confirm against the tool's own `outerRadius`/`maxGrow`,
 * never this function's).
 *
 * At a horizontal slice `z` below the tip (0 <= z <= d) the cone's radius is `z * tan(halfAngle)`,
 * so the slice's own footprint is a capsule of that radius along the same run — same shape as
 * {@link flatCapsuleVolumeMm3}, but the radius now varies with depth. Integrating
 * `2*L*z*tan(a) + pi*z^2*tan(a)^2` from 0 to d gives the closed form:
 *
 *   V = L * tan(a) * d^2 + (pi/3) * tan(a)^2 * d^3
 *
 * (the first term is the straight wedge the full length runs; the second is one full cone — the
 * two half-cone ends of the stroke, capsule-style, add up to exactly one). Independent of
 * `grooveRadiusAt`/`VCone` (`engine/cnc/vProfile.ts`) — this integrates the cone's own geometry
 * directly, never calling the engine's cone-sweep code.
 */
export function vGrooveVolumeMm3(lengthMm: number, halfAngleDeg: number, depthMm: number): number {
  if (lengthMm < 0 || halfAngleDeg <= 0 || halfAngleDeg >= 90 || depthMm <= 0) return 0;
  const t = Math.tan((halfAngleDeg * Math.PI) / 180);
  return lengthMm * t * depthMm * depthMm + (Math.PI / 3) * t * t * depthMm * depthMm * depthMm;
}

/**
 * The volume a real V cutter removes tracing a straight run of length `L` to tip depth `d`: a tip
 * of radius `t0`, a flank widening by `tan(a)` per mm, and a body of radius `R` above the cone
 * (`null` when the record states none, so the cone never stops). Each horizontal slice is a
 * capsule of the cutter's radius at that height, `2ρL + πρ²`, integrated from the tip up:
 *
 *   cone part (0 ≤ h ≤ h1):  2L(t0·h1 + tan(a)·h1²/2) + π((t0 + tan(a)·h1)³ − t0³) / (3·tan(a))
 *   body part (h1 < h ≤ d):  (2RL + πR²)(d − h1),   h1 = min(d, (R − t0) / tan(a))
 */
export function cappedVGrooveVolumeMm3(
  lengthMm: number,
  tipRadiusMm: number,
  halfAngleDeg: number,
  bodyRadiusMm: number | null,
  depthMm: number,
): number {
  if (lengthMm < 0 || tipRadiusMm < 0 || halfAngleDeg <= 0 || halfAngleDeg >= 90 || depthMm <= 0) return 0;
  const t = Math.tan((halfAngleDeg * Math.PI) / 180);
  const hCap = bodyRadiusMm === null || bodyRadiusMm <= tipRadiusMm ? Infinity : (bodyRadiusMm - tipRadiusMm) / t;
  const h1 = Math.min(depthMm, hCap);
  const top = tipRadiusMm + t * h1;
  const cone = 2 * lengthMm * (tipRadiusMm * h1 + (t * h1 * h1) / 2) + (Math.PI * (top ** 3 - tipRadiusMm ** 3)) / (3 * t);
  const body = depthMm > h1 ? (2 * top * lengthMm + Math.PI * top * top) * (depthMm - h1) : 0;
  return cone + body;
}

export interface VolumeAgreementOptions {
  /** Relative tolerance band, as a fraction of the analytic figure. Defaults to 2% — well inside the #741 gap (20-60%), well outside ordinary float/approximation drift. */
  toleranceFraction?: number;
}

export interface VolumeAgreementReport {
  ok: boolean;
  analyticMm3: number;
  simulatedMm3: number;
  /** `(simulated - analytic) / analytic`, signed — positive means the simulation removed MORE than the independent figure predicts (#741's direction). */
  excessFraction: number;
  toleranceFraction: number;
  sentence: string;
}

/** Compares a simulated/measured removed volume against one of the closed forms above, gate statement 6. */
export function checkVolumeAgreement(
  itemLabel: string,
  simulatedMm3: number,
  analyticMm3: number,
  opts: VolumeAgreementOptions = {},
): VolumeAgreementReport {
  const toleranceFraction = opts.toleranceFraction ?? 0.02;
  const excessFraction = analyticMm3 > 0 ? (simulatedMm3 - analyticMm3) / analyticMm3 : simulatedMm3 > 0 ? Infinity : 0;
  const ok = Math.abs(excessFraction) <= toleranceFraction;
  const pct = (excessFraction * 100).toFixed(1);
  const sentence = ok
    ? `${itemLabel}: removed volume agrees with the analytic figure (${pct} %, within ${(toleranceFraction * 100).toFixed(0)} %).`
    : `${itemLabel}: removed volume disagrees with the analytic figure by ${pct} % (simulated ${simulatedMm3.toFixed(1)} mm³ vs analytic ${analyticMm3.toFixed(1)} mm³) — outside the ${(toleranceFraction * 100).toFixed(0)} % tolerance.`;
  return { ok, analyticMm3, simulatedMm3, excessFraction, toleranceFraction, sentence };
}

// ---------------------------------------------------------------------------------------------
// Part 3 — the 3D half (#924's scope note, #909): swept surface vs the goal heightfield.
// ---------------------------------------------------------------------------------------------

/** 0.01 mm — the same floor `tools/goal_check.py`'s `CUT_INTO` constant uses before a dip counts as cut-into rather than float/grid noise. */
export const GOAL_CUT_INTO_FLOOR_MM = 0.01;

/** The leftover-material reporting bands `goal_check.py` prints (0.1 / 0.3 / 1 mm), kept here so the app's sentence matches the bench tool's. */
export const GOAL_LEFTOVER_BANDS_MM = [0.1, 0.3, 1] as const;

/**
 * #948 — THE PASS LINE's LABELLED FALLBACK: the share of the goal's top surface that must stand
 * within the 0.1 mm band (the first leftover band) for the run to pass. It is the demo page's own
 * rule — "zero cut-into AND top-surface coverage ≥ 95 %" — and the shop owns it as
 * `goal.passCoverage` (seeded 0.95); this is the number a caller with no location reads, labelled
 * as a fallback.
 */
export const GOAL_PASS_COVERAGE_FALLBACK = 0.95;

export interface GoalCutIntoOptions {
  /** Overrides {@link GOAL_CUT_INTO_FLOOR_MM}. */
  cutIntoFloorMm?: number;
  /**
   * #948 — the sampler the LEFTOVER bands and the pass line are read with. The page judges them
   * from the swept top at each goal cell's centre (its own stamp); a caller that can reproduce
   * that read for the same program hands it here, and `sweptTop` stays the cut-into judge. Absent:
   * `sweptTop` answers both (the pre-#948 reading).
   */
  leftoverTop?: ResultTop;
  /**
   * #948 — the top-surface coverage the run must reach to pass, 0–1: the share of the goal's
   * covered cells standing within {@link GOAL_LEFTOVER_BANDS_MM}[0] of the goal. The shop's
   * `goal.passCoverage`; absent → {@link GOAL_PASS_COVERAGE_FALLBACK}.
   */
  passCoverage?: number;
  /**
   * #955/V2-2 — THE EDGE-BREAK ALLOWANCE, as GATE parameters (A's R3): the V bit's cutting reach
   * of a design edge and the cone's own leg, computed by the caller from the job's `edgeBreak`
   * field capped by the chamfer Tool record — never from the CAM's plan. Absent = no allowance and
   * the pre-V2-2 reading exactly, so a job with no edge break keeps every existing pin.
   */
  edgeBreak?: {
    reachMm: number;
    legMm: number;
    /**
     * #964 — THE PAGE'S `who` RULE: the tool NUMBER of the V bit the allowance is sized from.
     * When stated (with `whoAt`), a cell is excused as edge break only where the DEEPEST stamp in
     * that cell is this cutter — a cell a flat or a ball cut deepest is judged, not excused,
     * exactly as `goal_check.py` gates on `who`. Absent: the geometry-only reading (the
     * synthetic fixtures' pre-`who` behaviour).
     */
    toolNumber?: number;
    /**
     * #1064 — WHICH EDGES THE BAND SEEDS FROM. `silhouette` (default, and what an absent field
     * means) is the part's own outline; `all` adds every interior design wall (the pre-#1064
     * reading, which let a stated rim chamfer excuse a V floor pocket's lip at an interior wall).
     */
    edges?: 'silhouette' | 'all';
  };
  /**
   * #1064 (d) — THE PLAN'S PREDICTED LIP BEVEL, mm (`depth·tan(half)` per side on a floor-correct
   * V pocket; `PlanOutcome.predictedCutIntoMm`). Stated in the sentence BESIDE the measured
   * number, never instead of it: "predicted 0.60 mm, measured 0.52 mm". Absent = no prediction.
   */
  predictedCutIntoMm?: number;
  /**
   * #964 — the per-cell identity of the lowest stamp: the tool number that left it (0 = none),
   * sampled on the same grid as the swept top. Needed only with `edgeBreak.toolNumber`.
   */
  whoAt?: (x: number, y: number) => number | null;
  /**
   * #955 — the largest cutting tool's radius, mm, for the wall-shadow exclusion. Absent = the
   * shadow class is reported as 0 (a caller with no tool set); the edge-break band still runs.
   */
  wallShadowRadiusMm?: number;
  /** #1092 (gate v8) — the blank's thickness, mm: the silhouette proof's floor beside the part is
   *  `−(thickness + breakthrough)`. Falls back to the goal field's own value, then to the design's
   *  own depth (topZ − minZ). */
  stockThicknessMm?: number;
  /** #1092 — the job's breakthrough, mm (the through rule's extra depth at a through feature). */
  breakthroughMm?: number;
  /**
   * v5 (#970) — THE DEEPEST CUTTER'S CL POINT at this cell: the (x, y) of the stamp that left the
   * cell's lowest reach (`StampedTop.clX/clY`; sweptPoint.ts). The wall-shadow cell is excused
   * only when this point stays at least `wallShadowRadiusMm` from the wall (the cell sits at the
   * disc's rim — a stamp artefact) or when the V cut it within its leg; with no CL the cell is
   * ADJUDICATED, the conservative side (an uncounted excusal is a false pass).
   */
  clAt?: (x: number, y: number) => { x: number; y: number } | null;
}

export interface GoalCutIntoReport {
  ok: boolean;
  /**
   * #948 — FALSE when the comparison could not run at all (no swept top to sample: a rotary or
   * exact-engine sweep the caller could get no flat top from). The numeric fields are then zero
   * and `ok` stays TRUE — an unchecked goal is a stated gap, not a pass and not a failure — and
   * {@link reason} says why. Every report a comparison produced has this true.
   */
  ran: boolean;
  /** Why the comparison did not run; null when {@link ran} is true. */
  reason: string | null;
  /** Covered goal cells the comparison ran over. */
  goalCells: number;
  pitchMm: number;
  cutIntoFloorMm: number;
  /** Share of covered cells cut more than the floor below the goal, 0-1 — the RAW figure, before
   *  any exclusion (the page's raw line; E compares it cell for cell, #964). */
  cutIntoFraction: number;
  /** The RAW cut's area, mm²: every cut-into cell before any exclusion. */
  cutIntoAreaMm2: number;
  /** `sum(max(0, goalTop - sweptTop)) * cellArea` over the RAW cut-into cells — the volume the
   *  sweep left over-cut, before any exclusion, mm³. */
  cutIntoVolumeMm3: number;
  /** The RAW deepest cut, mm, before any exclusion — wall cells included. */
  maxCutIntoMm: number;
  /**
   * #948 — WHERE the RAW deepest cut-into cell is, in the work frame (the goal cell's own sample
   * point), so the Cut card can say "Cuts 0.42 mm into the design at 41.2, 25.3" rather than only
   * how deep. Null when nothing was cut into — and null on an unchecked report, where there is no
   * cell to name. Before #964 this was the adjudicated cell when an edge break applied; the raw
   * figure is the page's own and is what the report now states, with the adjudicated maximum
   * beside it ({@link adjudicatedMaxMm}).
   */
  maxCutIntoAt: { x: number; y: number } | null;
  /**
   * #945 — THE CONSERVATIVE COLUMN READ BESIDE THE VERDICT, present only when the caller supplied
   * the page's own stamp AND a column grid (the verdict above is then that stamp). It reads each
   * cell as the HIGHEST of the four columns bracketing it, so it is one column lenient — blind to
   * a gouge narrower than a cell — and carries the half-cell slope bias. A diagnostic, never the
   * pass. #964: absent on an exact-engine sweep, which has no columns to read.
   */
  columnCutInto?: { fraction: number; maxMm: number; at: { x: number; y: number } | null };
  /** Share of covered cells left standing more than each of {@link GOAL_LEFTOVER_BANDS_MM} above the goal, 0-1, same order. */
  leftoverFractions: number[];
  leftoverVolumeMm3: number;
  maxLeftoverMm: number;
  /** Share of covered cells within the cut-into floor on both sides — the coverage % the acceptance asks for. */
  coverageFraction: number;
  /**
   * #948 — the TOP-SURFACE coverage the pass line was judged at, 0–1: the share of covered cells
   * standing within {@link GOAL_LEFTOVER_BANDS_MM}[0] (0.1 mm) of the goal — the demo page's
   * `coveragePct` = 100 − 100 × `leftoverFractions[0]`. NOT the same band as
   * {@link coverageFraction}. The report states the number it judged against so a reader never has
   * to know the constant; the measured value is `1 − leftoverFractions[0]`.
   */
  passCoverage: number;
  /** #955/V2-2 — share of covered cells excluded as EDGE BREAK (a V bit within its reach of a design edge, no deeper than its leg), 0-1. */
  edgeBreakFraction: number;
  /** #955 — share excluded as WALL CELLS (a cell straddling a wall step), 0-1. */
  wallNotScoredFraction: number;
  /** #955 — share excluded as WALL SHADOW (behind a wall, beyond the sweep's reach), 0-1. */
  shadowNotScoredFraction: number;
  /**
   * #996 (gate v6) — cells excused as STRADDLING A STEP ON PROOF: the step over the cell is at
   * least as tall as the read intrusion and the swept floor is at the design's low side (see
   * {@link STRADDLING_SLACK_MM}). Printed beside wall/shadow so the excuse can never be silent.
   */
  straddlingNotScoredCells: number;
  /** #996 — the tallest step (mm) among the straddling cells excused; 0 when none. */
  straddlingMaxStepMm: number;
  /**
   * #1092 / gate v8 — THE EXCUSE IS A PROOF BOUNDED BY THE GOAL'S OWN RELIEF. A wall, border or
   * shadow cell is excused only when its depth is no more than the goal's local relief at the cell
   * (max − min of the covered goal top within the shadow radius; a border cell also counts the
   * stock top as a high side) plus {@link STRADDLING_SLACK_MM}. These three count the cells whose
   * CLASS would have excused them and which are COUNTED instead — the excuse is never silent.
   */
  wallOverReliefCells: number;
  /** #1092 — see {@link wallOverReliefCells}. */
  shadowOverReliefCells: number;
  /** #1092 — see {@link wallOverReliefCells}. */
  borderOverReliefCells: number;
  /** #1092 — the deepest over-relief cell (counted where its class would have excused it). */
  overReliefDeepest: { mm: number; x: number; y: number; cls: 'wall' | 'border' | 'shadow' } | null;
  /**
   * #1092 (gate v8, 0f's ruling) — SILHOUETTE cells excused on proof: covered cells facing
   * uncovered grid, cut no deeper than the blank's floor (`stock top + thickness + breakthrough`)
   * with the deepest stamp's CL on the UNCOVERED side, at least `r − pitch` from the outline.
   */
  silhouetteExcusedCells: number;
  /** #1092 — the deepest silhouette cell excused and its CL's distance from the outline, mm. */
  silhouetteDeepest: { mm: number; x: number; y: number; clDistanceMm: number } | null;
  /** #955/#964 — the 0.1 mm-floor share AFTER the exclusions (wall and wall shadow always; edge
   *  break when the job states one): the pass line's judged number, 0-1. */
  adjudicatedFraction: number;
  /** #964 — the deepest cut among the ADJUDICATED cells, mm (0 when none): the number the page's
   *  `cutInto0p1` max states, beside the raw {@link maxCutIntoMm}. */
  adjudicatedMaxMm: number;
  /** #964 — WHERE the adjudicated deepest cell is, in the work frame; null when the adjudicated
   *  set is empty. The card names a cell the pass actually judged, not an excluded one. */
  adjudicatedMaxAt: { x: number; y: number } | null;
  medianDeltaMm: number;
  sentence: string;
}

/**
 * #955/V2-2 — THE DESIGN EDGES a heightfield can see: a step deeper than 0.2 mm between
 * neighbouring goal cells (a wall), or the model's silhouette (a covered cell beside an uncovered
 * one). Both sides of a step are marked, as E's `goal_check.py` does.
 */
const GOAL_EDGE_STEP_MM = 0.2;

/**
 * #996 — THE STRADDLING-CELL EXCUSE, ON PROOF (gate v6). A cell whose CENTRE sits on a vertical
 * step reads the step's high side while the cutter correctly stops at the step: the comparison is
 * sample-against-sample on the face's plane, where the design is multi-valued. Such a cell is
 * excused only when BOTH hold:
 *   - the step actually straddled (`max − min` over the centre and the cell's four corners) is at
 *     least as tall as the read intrusion `d = goal(centre) − swept(centre)` — so a one-cell gouge
 *     on flat ground (step 0) can never qualify; and
 *   - the swept floor is no more than this slack below the design's low side over the cell — the
 *     tool never went below the lowest design height within the cell, so nothing was cut that the
 *     design keeps.
 * No distance term anywhere. Excused cells are counted and their tallest step kept, both printed
 * beside wall/shadow, so the excuse can never become a silent class.
 */
export const STRADDLING_SLACK_MM = 0.005;

/** #996 — the adjudicated floor, mm: a cut shallower than this is raw-only (never judged), so the
 *  straddling excuse (and its printed count) applies exactly to the cells the gate would judge. */
const ADJUDICATED_FLOOR_MM = 0.1;

function designEdgeCells(goal: GoalHeightfield): Uint8Array {
  const { nx, ny, covered, z } = goal;
  const wall = new Uint8Array(nx * ny);
  // An uncovered cell reads as the stock below the goal: any covered neighbour then differs by far
  // more than the step, which is the silhouette edge (#955's rim).
  const outside = goal.minZ - 1;
  const at = (k: number): number => (covered[k] === 1 ? (z[k] as number) : outside);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (i + 1 < nx && Math.abs(at(k) - at(k + 1)) > GOAL_EDGE_STEP_MM) {
        wall[k] = 1;
        wall[k + 1] = 1;
      }
      if (j + 1 < ny && Math.abs(at(k) - at(k + nx)) > GOAL_EDGE_STEP_MM) {
        wall[k] = 1;
        wall[k + nx] = 1;
      }
    }
  }
  return wall;
}

/**
 * THE GRID'S OWN BORDER, when it ends at the model (#964, F's curved property seeds). A covered
 * cell on the outermost row/column has no neighbour beyond it, so `designEdgeCells` above never
 * sees its silhouette — and for a part whose stock IS the part, the goal's grid ends exactly at
 * the model. An outline cut then reads as a full-depth gouge in the cell centred on the boundary
 * (the sloped seed: four corners at 10 mm, adjudicated 2.5e-5 against F's zero line).
 *
 * These cells are UNADJUDICABLE, not band material: they are excluded from the cut-into reading
 * only, never fed to the edge-break allowance or the wall shadow — a job with no stated edge break
 * must not have a synthetic gouge near the field's border excused as one (the pinned gate specs
 * goalEdgeBreak/goalAdjudicated964 caught exactly that when the first version marked them as
 * ordinary walls).
 */
function borderCells(goal: GoalHeightfield): Uint8Array {
  const { nx, ny, covered } = goal;
  const border = new Uint8Array(nx * ny);
  for (let i = 0; i < nx; i++) {
    if (covered[i] === 1) border[i] = 1;
    const bottom = (ny - 1) * nx + i;
    if (covered[bottom] === 1) border[bottom] = 1;
  }
  for (let j = 0; j < ny; j++) {
    const left = j * nx;
    if (covered[left] === 1) border[left] = 1;
    const right = j * nx + nx - 1;
    if (covered[right] === 1) border[right] = 1;
  }
  return border;
}

/**
 * v5 — THE WALL DISTANCE, ONCE PER GOAL. A run's programs each call the check on the SAME
 * heightfield object (`goalHeightfieldFor` caches it), and the wall mask is a fact of the goal:
 * a WeakMap keeps the O(N) transform from being paid per program. The value is derived only from
 * the goal object, so an entry cannot go stale while that object is alive.
 */
const wallDistanceCache = new WeakMap<GoalHeightfield, Float32Array>();
function wallDistances(goal: GoalHeightfield, wall: Uint8Array): Float32Array {
  const hit = wallDistanceCache.get(goal);
  if (hit !== undefined) return hit;
  const field = wallDistanceField(wall, goal.nx, goal.ny, goal.pitch);
  wallDistanceCache.set(goal, field);
  return field;
}

/**
 * v5 — THE EXACT DISTANCE (mm) from every cell's centre to the nearest WALL cell's centre, by
 * Felzenszwalb's 1-D squared-distance passes over the mask (O(n), exact — never the 8 % of a
 * chamfer approximation, because the shadow rule compares against the radius at its boundary).
 */
function wallDistanceField(wall: Uint8Array, nx: number, ny: number, pitch: number): Float32Array {
  const INF = 1e20;
  const f = new Float64Array(nx * ny);
  for (let k = 0; k < f.length; k++) f[k] = wall[k] === 1 ? 0 : INF;
  const n = Math.max(nx, ny);
  const src = new Float64Array(n);
  const dst = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const edt1d = (len: number): void => {
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s = (src[q]! + q * q - (src[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
      while (s <= z[k]!) {
        k--;
        s = (src[q]! + q * q - (src[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (z[k + 1]! < q) k++;
      const d = q - v[k]!;
      dst[q] = d * d + src[v[k]!]!;
    }
  };
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) src[i] = f[j * nx + i]!;
    edt1d(nx);
    for (let i = 0; i < nx; i++) f[j * nx + i] = dst[i]!;
  }
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) src[j] = f[j * nx + i]!;
    edt1d(ny);
    for (let j = 0; j < ny; j++) f[j * nx + i] = dst[j]!;
  }
  const dist = new Float32Array(nx * ny);
  for (let k = 0; k < dist.length; k++) dist[k] = Math.sqrt(f[k]!) * pitch;
  return dist;
}

/** Every cell within `radiusMm` of a set cell (the disk dilation `goal_check.py` uses). */
function dilateCells(mask: Uint8Array, nx: number, ny: number, pitch: number, radiusMm: number): Uint8Array {
  const out = new Uint8Array(nx * ny);
  const r = Math.ceil(radiusMm / pitch);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (mask[j * nx + i] !== 1) continue;
      for (let dj = -r; dj <= r; dj++) {
        const jj = j + dj;
        if (jj < 0 || jj >= ny) continue;
        for (let di = -r; di <= r; di++) {
          const ii = i + di;
          if (ii < 0 || ii >= nx) continue;
          if (Math.hypot(di * pitch, dj * pitch) > radiusMm + 1e-9) continue;
          out[jj * nx + ii] = 1;
        }
      }
    }
  }
  return out;
}

/**
 * #1092 (gate v8) — THE GOAL'S OWN RELIEF AT A CELL: `max − min` of the COVERED goal top over the
 * sampled cells within `radiusMm` of (x, y). A heightfield mis-reads a cutter near a wall by at
 * most the wall's own height; this is that height, computed per cell, so an excused cell's depth
 * is bounded by the geometry it sits on — never by a constant (a 2 mm cap would count a real
 * artefact at a 20 mm wall; a 20 mm cap would hide a 19 mm gouge at a 1 mm step).
 *
 * A BORDER cell adds the STOCK TOP as a high side (`goal.topZ`): beyond the silhouette there is no
 * goal sample, and the material the rim stands in is the blank at the stock top.
 *
 * Only the cells about to be excused call it (a few thousand at most), so the disc walk is cheap;
 * uncovered cells contribute nothing (the design only exists where it is covered).
 */
function depths_ceiling(depth: number, thicknessMm: number, breakthroughMm: number): boolean {
  return depth <= thicknessMm + breakthroughMm + STRADDLING_SLACK_MM + 1e-12;
}

function reliefAt(goal: GoalHeightfield, x: number, y: number, radiusMm: number, borderCell: boolean): number {
  const pitch = goal.pitch;
  const r = Math.ceil(radiusMm / pitch);
  const ci = Math.round((x - goal.x0) / pitch);
  const cj = Math.round((y - goal.y0) / pitch);
  let hi = -Infinity;
  let lo = Infinity;
  let sawOutside = false;
  for (let dj = -r; dj <= r; dj++) {
    const jj = cj + dj;
    if (jj < 0 || jj >= goal.ny) {
      sawOutside = true;
      continue;
    }
    for (let di = -r; di <= r; di++) {
      const ii = ci + di;
      if (ii < 0 || ii >= goal.nx) {
        sawOutside = true;
        continue;
      }
      if (Math.hypot(di * pitch, dj * pitch) > radiusMm + 1e-9) continue;
      const kk = jj * goal.nx + ii;
      if (goal.covered[kk] !== 1) {
        sawOutside = true;
        continue;
      }
      const z = goal.z[kk]!;
      if (!Number.isFinite(z)) continue;
      if (z > hi) hi = z;
      if (z < lo) lo = z;
    }
  }
  if (hi === -Infinity) return 0;
  // #1092 — THE STOCK TOP IS THE HIGH SIDE WHEREVER THE BLANK IS WITHIN REACH: a border cell, or
  // any cell whose relief disc reaches uncovered grid (the part's rim shadow band included). The
  // heightfield skips uncovered cells, so without this the rim's shadow strip read a relief of 0
  // and every wall-foot cell inside it was counted (the vendor tray's 8.32 % band).
  if ((borderCell || sawOutside) && goal.topZ > hi) hi = goal.topZ;
  return hi - lo;
}

/**
 * The 3D analogue of {@link checkDesignReach}: compares the ACTUAL swept surface with the GOAL
 * heightfield, not with the app's own cut plan — closing the gap #909 named ("the app's own check
 * passes, because it compares the simulation with the app's plan, not with the goal"). Ported
 * numerically from the bench's `docs/bench/2026-10-28-z1-real-jobs/tools/goal_check.py` (`d =
 * sweptTop - goalTop` over covered goal cells; `d < -CUT_INTO` is cut INTO the part, `d` above the
 * leftover bands is material left standing) so the app can read the same verdict in-app, for
 * #945/#946's pass criteria, rather than only the demo page's external tool.
 *
 * #955/V2-2 — THE EDGE-BREAK ALLOWANCE (E's `goal_check.py` rule, ported): a cell cut into by a V
 * bit within that bit's reach of a design edge, and no deeper below the goal than the bit's leg, is
 * EDGE BREAK and not cut-into. The bit's reach/leg are GATE parameters handed in by the caller from
 * the job's `edgeBreak` field and the chamfer Tool record (A's R3); this function reads no CAM plan.
 * Wall cells and the wall shadow are reported as unadjudicable shares beside the verdict, exactly
 * as E reports them. With no `edgeBreak` option the pre-V2-2 reading is returned to the bit.
 */
export function checkGoalCutInto(goal: GoalHeightfield, sweptTop: ResultTop | null, opts: GoalCutIntoOptions = {}): GoalCutIntoReport {
  const cutIntoFloorMm = opts.cutIntoFloorMm ?? GOAL_CUT_INTO_FLOOR_MM;
  const passCoverage = opts.passCoverage ?? GOAL_PASS_COVERAGE_FALLBACK;
  // #964 — an exact-engine sweep keeps no column grid, so the caller may bring ONLY the page's
  // stamp (`leftoverTop`). With neither read there is nothing to compare; state it, never pass.
  if (sweptTop === null && opts.leftoverTop === undefined) {
    return goalCutIntoUnchecked(
      'the goal check was given neither a swept top nor the page’s own stamp — there is nothing to compare the goal with',
      passCoverage,
    );
  }
  const cellArea = goal.pitch * goal.pitch;
  const nx = goal.nx;
  const ny = goal.ny;
  const cells = nx * ny;
  const dOf = new Float64Array(cells);
  const sampled = new Uint8Array(cells);
  const deltas: number[] = [];
  const leftoverCounts = GOAL_LEFTOVER_BANDS_MM.map(() => 0);
  let leftoverVolumeMm3 = 0;
  let maxLeftover = 0;
  let withinBoth = 0;
  let covered = 0;
  let columnCells = 0;
  let columnMax = 0;
  let columnAt: { x: number; y: number } | null = null;

  // #945 — ONE VERDICT, THE PAGE'S OWN POINT READ. When the caller supplies the exact stamp (the
  // app's goal jobs do; `sweptPoint.ts`), cut-into is judged on it exactly as `goal_check.py` does
  // — the cutter's own surface at the goal cell's centre, every program of the run folded in (the
  // session's accumulated field) — so the app and the page cannot disagree about a cell. The
  // conservative column read (`sweptTop`) stays beside it as the diagnostic: it reads the HIGHEST
  // of the four columns bracketing a cell (one column lenient, blind to a gouge narrower than a
  // cell) and carries the half-cell slope bias, which showed up as a cliff-edge phantom when it
  // was the verdict (the top-clamp card's 1,930 cells, #948).
  const verdictTop = (opts.leftoverTop ?? sweptTop) as ResultTop;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (goal.covered[k] !== 1) continue;
      const x = goal.x0 + i * goal.pitch;
      const y = goal.y0 + j * goal.pitch;
      const top = verdictTop(x, y) ?? (sweptTop === null ? null : sweptTop(x, y));
      if (top === null) continue;
      covered++;
      const goalTop = goal.z[k] as number;
      const d = top - goalTop; // + leftover, - cut-into, same sign convention as goal_check.py
      dOf[k] = d;
      sampled[k] = 1;
      deltas.push(d);
      if (opts.leftoverTop !== undefined && sweptTop !== null) {
        const cTop = sweptTop(x, y);
        if (cTop !== null && cTop - goalTop < -cutIntoFloorMm) {
          columnCells++;
          if (goalTop - cTop > columnMax) {
            columnMax = goalTop - cTop;
            columnAt = { x, y };
          }
        }
      }
      // #948/#945 — the leftover bands, the pass line and the cut-into verdict all read the page's
      // own point of the sweep (the same field, one model).
      const dLeft = (verdictTop(x, y) ?? top) - goalTop;
      for (let b = 0; b < GOAL_LEFTOVER_BANDS_MM.length; b++) {
        if (dLeft > GOAL_LEFTOVER_BANDS_MM[b]!) leftoverCounts[b]! += 1;
      }
      if (dLeft > GOAL_LEFTOVER_BANDS_MM[0]!) {
        leftoverVolumeMm3 += dLeft * cellArea;
        maxLeftover = Math.max(maxLeftover, dLeft);
      }
      if (Math.abs(d) <= cutIntoFloorMm) withinBoth++;
    }
  }

  const n = Math.max(covered, 1);
  // THE RAW CUT (before any exclusion) — the figure the report has always carried, and the one
  // the page's own raw line states: every cell below the floor, wall cells and all.
  let rawCutCells = 0;
  let rawVolumeMm3 = 0;
  let rawMaxCutInto = 0;
  let rawMaxCutIntoAt: { x: number; y: number } | null = null;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (sampled[k] !== 1 || dOf[k]! >= -cutIntoFloorMm) continue;
      rawCutCells++;
      const depth = -dOf[k]!;
      rawVolumeMm3 += depth * cellArea;
      if (depth > rawMaxCutInto) {
        rawMaxCutInto = depth;
        rawMaxCutIntoAt = { x: goal.x0 + i * goal.pitch, y: goal.y0 + j * goal.pitch };
      }
    }
  }

  // #955/#964 — THE GATE'S UNADJUDICABLE CELLS, IN EVERY GOAL JOB. Wall cells (a step deeper than
  // 0.2 mm between neighbouring goal cells) and the wall shadow (the heightfield cannot adjudicate
  // behind them) are excluded from the ADJUDICATED reading whatever the job states. Only the rim
  // EDGE-BREAK allowance depends on the job's own `edgeBreak` (a stated V bit's reach and leg).
  const wall = designEdgeCells(goal);
  const border = borderCells(goal);
  // THE PART'S OWN SILHOUETTE IS A DESIGN EDGE (the manager's sanction, #959): it is the edge an
  // edge break exists for. The band seeds from `wall ∪ border`, so the chamfer's legitimate break
  // of the outer rim is excused like any interior edge's — without it, cells just inside the rim
  // were adjudicated even though the nearest wall was 0.10 mm away, inside a 1.5875 mm reach. The
  // WALL SHADOW still seeds from `wall` alone (a different question, measured separately).
  // #1064 — THE BAND SEEDS ONLY FROM THE EDGES THE JOB NAMED: the part's silhouette by default,
  // every interior design wall only when the statement says `all`. A rim chamfer no longer excuses
  // a V floor pocket's lip at an interior wall without the job having said so.
  const bandEdges = opts.edgeBreak?.edges ?? 'silhouette';
  const bandSeed = new Uint8Array(cells);
  for (let k = 0; k < cells; k++) if (border[k] === 1 || (bandEdges === 'all' && wall[k] === 1)) bandSeed[k] = 1;
  const shadowRadius = opts.wallShadowRadiusMm;
  const shadow =
    shadowRadius !== undefined && shadowRadius > 0
      ? dilateCells(wall, nx, ny, goal.pitch, shadowRadius)
      : null;
  // v5 (#970) — THE SHADOW CELL IS NO LONGER BLANKET-EXCUSED. E's tray incident: the V's CL was
  // driven into a wall's base (a feed at (19.800, 12.050, -4.692), 3.49 mm into the land) and the
  // whole strip beside the wall — 8.1 % of the tray — was excused as wall shadow. The rule now:
  // a shadow cell is excused only if (a) the V cut it and the cut is no deeper than its leg, or
  // (b) the deepest cutter's CL point stays at least the shadow radius from the wall there (the
  // cell sits at the disc's rim — a stamp artefact). Everything else is adjudicated. The CL
  // distance is read from the exact wall-distance field at the CL's own cell; the comparison keeps
  // one cell of allowance for the grid discretisation of the wall (stated).
  const wallDist = shadow === null ? null : wallDistances(goal, wall);
  const allowance = opts.edgeBreak;
  const allowanceActive = allowance !== undefined && allowance.reachMm > 0 && allowance.legMm > 0;
  const band = allowanceActive ? dilateCells(bandSeed, nx, ny, goal.pitch, allowance.reachMm) : null;
  const excluded = new Uint8Array(cells);
  let edgeBreakCells = 0;
  let wallNotScoredCells = 0;
  let shadowNotScoredCells = 0;
  let straddlingNotScoredCells = 0;
  let straddlingMaxStepMm = 0;
  let wallOverReliefCells = 0;
  let shadowOverReliefCells = 0;
  let borderOverReliefCells = 0;
  let overReliefDeepest: GoalCutIntoReport['overReliefDeepest'] = null;
  let silhouetteExcusedCells = 0;
  let silhouetteDeepest: GoalCutIntoReport['silhouetteDeepest'] = null;
  // #1092 (gate v8) — THE RELIEF RADIUS IS THE SHADOW RADIUS r (the largest cutter's radius; the
  // cell class and the stamp artefact share the same disc). A caller with no tool set has no r:
  // the relief then reads the cell's OWN extent — one pitch, the same four axial neighbours the
  // straddling proof reads — so a class proof still measures the local step (the v6 behaviour
  // callers without a cutter rely on), never a bare zero.
  const reliefRadiusMm = shadowRadius !== undefined && shadowRadius > 0 ? shadowRadius : goal.pitch;
  // #1092 — THE SILHOUETTE: a covered cell facing uncovered grid. The design is multi-valued across
  // that edge (material one side, the blank the other), so the outline cut is judged by the blank's
  // own floor and the stamp's CL, not by the design alone (0f's ruling).
  const silhouette = new Uint8Array(cells);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (goal.covered[k] !== 1) continue;
      for (const [di, dj] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
        const ci = i + di;
        const cj = j + dj;
        if (ci < 0 || cj < 0 || ci >= nx || cj >= ny || goal.covered[cj * nx + ci] !== 1) {
          silhouette[k] = 1;
          break;
        }
      }
    }
  }
  // The outline's own cells, for the CL's distance to it when the CL point leaves the grid (a
  // contour's tool centre can sit outside the goal's footprint entirely). Cached per point.
  const outlineCells: { x: number; y: number }[] = [];
  for (let k = 0; k < cells; k++) {
    if (wall[k] !== 1) continue;
    const i = k % nx;
    const j = (k - i) / nx;
    outlineCells.push({ x: goal.x0 + i * goal.pitch, y: goal.y0 + j * goal.pitch });
  }
  const outlineDistCache = new Map<string, number>();
  const outlineDistance = (x: number, y: number): number => {
    const key = `${x.toFixed(3)},${y.toFixed(3)}`;
    const hit = outlineDistCache.get(key);
    if (hit !== undefined) return hit;
    let best = Infinity;
    for (const c of outlineCells) {
      const d = Math.hypot(c.x - x, c.y - y);
      if (d < best) best = d;
    }
    outlineDistCache.set(key, best);
    return best;
  };
  const noteOverRelief = (cls: 'wall' | 'border' | 'shadow', depth: number, x: number, y: number): void => {
    if (cls === 'wall') wallOverReliefCells++;
    else if (cls === 'border') borderOverReliefCells++;
    else shadowOverReliefCells++;
    if (overReliefDeepest === null || depth > overReliefDeepest.mm) overReliefDeepest = { mm: depth, x, y, cls };
  };
  // The v6 straddling proof's own step read, shared by the class proofs below (the axial
  // neighbours; uncovered or off-grid neighbours contribute nothing).
  const straddleProof = (
    k: number,
    i: number,
    j: number,
    depth: number,
    stepSlackMm = 0,
    includeStockTop = false,
  ): { ok: boolean; step: number } => {
    const zc = goal.z[k]!;
    if (!Number.isFinite(zc)) return { ok: false, step: 0 };
    let hi = zc;
    let lo = zc;
    for (const [di, dj] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
      const ci = i + di;
      const cj = j + dj;
      if (ci < 0 || cj < 0 || ci >= nx || cj >= ny) continue;
      const kk = cj * nx + ci;
      if (sampled[kk] !== 1) continue;
      const z = goal.z[kk]!;
      if (!Number.isFinite(z)) continue;
      if (z > hi) hi = z;
      if (z < lo) lo = z;
    }
    // #1092 — A BORDER CELL'S HIGH SIDE IS THE STOCK TOP. Its edge faces uncovered grid, which
    // contributes no sample, so without the stock top a silhouette cell's step reads 0 and the
    // proof could never excuse the part's own outline cut (measured: the curved-ops property
    // parts' 10 mm outline reads, and the tray corpus's rim cells).
    if (includeStockTop && goal.topZ > hi) hi = goal.topZ;
    const step = hi - lo;
    const swept = zc + dOf[k]!;
    return { ok: step > 0 && step + stepSlackMm + 1e-12 >= depth && swept >= lo - STRADDLING_SLACK_MM, step };
  };
  for (let k = 0; k < cells; k++) {
    if (sampled[k] !== 1 || dOf[k]! >= -cutIntoFloorMm) continue;
    const depth = -dOf[k]!;
    // #964 — the page's `who` rule: with a stated V number, only a cell whose DEEPEST stamp is
    // that cutter can be edge break. A cutter we cannot identify (no `whoAt`, or 0) is not
    // excused — the conservative side: an uncounted excusal is a false pass.
    const i = k % nx;
    const j = (k - i) / nx;
    const whoOk = band === null || allowance === undefined || allowance.toolNumber === undefined
      || opts.whoAt?.(goal.x0 + i * goal.pitch, goal.y0 + j * goal.pitch) === allowance.toolNumber;
    if (band !== null && band[k] === 1 && depth <= allowance!.legMm + 1e-9 && whoOk) {
      excluded[k] = 1;
      edgeBreakCells++;
      continue;
    }
    // #1092 (gate v8, 0f's ruling) — THE SILHOUETTE CELL, ON PROOF. The blank's floor beside the
    // part is `−(thickness + breakthrough)`; the cell is excused only when the read is no deeper
    // than the stock top down to that floor (plus the slack) AND the deepest stamp's CL lies on the
    // UNCOVERED side, at least `r − pitch` from the outline — the same disc-rim proof the shadow
    // class uses. A cut below the blank's floor, or a contour whose CL is inside the silhouette,
    // is COUNTED (and the print says so).
    let silhouetteFallThrough = false;
    if (silhouette[k] === 1) {
      const x = goal.x0 + i * goal.pitch;
      const y = goal.y0 + j * goal.pitch;
      const thickness = opts.stockThicknessMm ?? goal.stockThicknessMm ?? goal.topZ - goal.minZ;
      const breakthrough = opts.breakthroughMm ?? goal.breakthroughMm ?? 0;
      const ceiling = thickness + breakthrough; // stock top − (the blank's floor)
      let clDistanceMm: number | null = null;
      let clOutside = false;
      if (opts.clAt !== undefined && shadowRadius !== undefined) {
        const cl = opts.clAt(x, y);
        if (cl !== null) {
          const ci = Math.round((cl.x - goal.x0) / goal.pitch);
          const cj = Math.round((cl.y - goal.y0) / goal.pitch);
          const onGrid = ci >= 0 && cj >= 0 && ci < nx && cj < ny;
          // On the UNCOVERED side: the CL's own cell is uncovered, or the point left the goal's
          // grid entirely (no goal sample there at all).
          clOutside = !onGrid || goal.covered[cj * nx + ci] !== 1;
          clDistanceMm = onGrid ? outlineDistance(cl.x, cl.y) : outlineDistance(cl.x, cl.y);
        }
      }
      if (
        depth <= ceiling + STRADDLING_SLACK_MM + 1e-12 &&
        clOutside &&
        clDistanceMm !== null &&
        clDistanceMm >= (shadowRadius ?? goal.pitch) - goal.pitch - 1e-9
      ) {
        excluded[k] = 1;
        silhouetteExcusedCells++;
        if (silhouetteDeepest === null || depth > silhouetteDeepest.mm) silhouetteDeepest = { mm: depth, x, y, clDistanceMm };
        continue;
      }
      // #1092 (0f's follow-up) — A FAILED SILHOUETTE CL TEST FALLS THROUGH to the v6 straddling
      // proof, exactly as a v5-failed shadow cell does: an OPEN POCKET reaching the rim (the
      // property parts' 3 mm notch) legitimately has its CL inside the part, and its cells
      // straddle the notch's step. The silhouette CL test stays; it is just not the only proof.
      silhouetteFallThrough = true;
    }
    if (!silhouetteFallThrough && (wall[k] === 1 || border[k] === 1)) {
      // #1092 (gate v8) — A WALL OR BORDER CELL IS NO LONGER EXCUSED BY CLASS. It goes through the
      // same straddling proof the v6 rule runs for every other cell, with the goal's own RELIEF at
      // the cell as the ceiling: a heightfield mis-reads a cutter beside a wall by at most the
      // wall's height, so a cell deeper than that is a real cut whatever its class. A cell that
      // fails the proof is COUNTED, and its class's over-relief counter says so.
      const cls: 'wall' | 'border' = wall[k] === 1 ? 'wall' : 'border';
      const x = goal.x0 + i * goal.pitch;
      const y = goal.y0 + j * goal.pitch;
      const relief = reliefAt(goal, x, y, reliefRadiusMm, cls === 'border');
      // The rule's own slack absorbs the heightfield's sampling of the step (measured 0.0004 mm on
      // the tray's 2.885 mm floor): the design floor and the sampled one differ by less than it.
      const proof = straddleProof(k, i, j, depth, STRADDLING_SLACK_MM, cls === 'border');
      if (proof.ok && depth <= relief + STRADDLING_SLACK_MM + 1e-12) {
        excluded[k] = 1;
        wallNotScoredCells++;
      } else {
        noteOverRelief(cls, depth, x, y);
      }
      continue;
    }
    let shadowOverRelief: { depth: number; x: number; y: number } | null = null;
    if (!silhouetteFallThrough && shadow !== null && shadow[k] === 1 && wall[k] !== 1) {
      const x = goal.x0 + i * goal.pitch;
      const y = goal.y0 + j * goal.pitch;
      const vDeepest = allowance !== undefined && allowance.toolNumber !== undefined
        && opts.whoAt?.(x, y) === allowance.toolNumber;
      const excusedByV = vDeepest && allowance !== undefined && depth <= allowance.legMm + 1e-9;
      let excusedByCl = false;
      if (!excusedByV && opts.clAt !== undefined && wallDist !== null) {
        const cl = opts.clAt(x, y);
        if (cl !== null) {
          const ci = Math.round((cl.x - goal.x0) / goal.pitch);
          const cj = Math.round((cl.y - goal.y0) / goal.pitch);
          if (ci >= 0 && cj >= 0 && ci < nx && cj < ny) {
            excusedByCl = wallDist[cj * nx + ci]! >= shadowRadius! - goal.pitch - 1e-9;
          }
        }
      }
      if (excusedByV || excusedByCl) {
        // #1092 (gate v8) — the v5 proof stands, but it is now bounded by the goal's own relief:
        // a shadow cell deeper than the wall it sits behind is a real cut, not a disc artefact.
        const relief = reliefAt(goal, x, y, reliefRadiusMm, false);
        if (depth <= relief + STRADDLING_SLACK_MM + 1e-12) {
          excluded[k] = 1;
          shadowNotScoredCells++;
          continue;
        }
        shadowOverRelief = { depth, x, y };
      }
      // v6 (#996) — a shadow cell the v5 rule cannot excuse stays ADJUDICATED, but it is still
      // "about to be judged": the straddling-cell proof below runs for it too. (The organizer's
      // remaining cell is exactly this class — a v5 shadow cell on a 0.11 mm step.)
    }
    // #996 (gate v6) — THE STRADDLING-CELL EXCUSE, ON PROOF. Only a cell about to be judged
    // reaches here (edge break, wall and shadow have had their say, so a 0.5 mm step stays the wall
    // class and is never double-counted). The step is read over the cell's AXIAL neighbours
    // (`straddleProof`; the heightfield is cell-centred, so those are the four the cell's edges
    // face — a diagonal face leaves all four diagonal centres on one side).
    if (depth > ADJUDICATED_FLOOR_MM) {
      const proof = straddleProof(k, i, j, depth);
      if (proof.ok) {
        excluded[k] = 1;
        straddlingNotScoredCells++;
        if (proof.step > straddlingMaxStepMm) straddlingMaxStepMm = proof.step;
        continue;
      }
    }
    // #1092 — a shadow cell whose v5 proof passed but whose depth exceeds the goal's relief has
    // now reached adjudication: its class would have excused it, so the count is not silent.
    if (shadowOverRelief !== null) {
      noteOverRelief('shadow', shadowOverRelief.depth, shadowOverRelief.x, shadowOverRelief.y);
    }
  }

  // #1092 — a data dump for the analyst (a guarded diagnostic; no behaviour change). Enabled by
  // CM_GOAL_DEBUG=1 through globalThis so this module needs no Node typings.
  const debugFlag = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.CM_GOAL_DEBUG;
  if (debugFlag === '1') {
    const thicknessD = opts.stockThicknessMm ?? goal.stockThicknessMm ?? goal.topZ - goal.minZ;
    const breakthroughD = opts.breakthroughMm ?? goal.breakthroughMm ?? 0;
    const clAtD = opts.clAt;
    const whoAtD = opts.whoAt;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        if (sampled[k] !== 1 || dOf[k]! >= -ADJUDICATED_FLOOR_MM || excluded[k] === 1) continue;
        const x = goal.x0 + i * goal.pitch;
        const y = goal.y0 + j * goal.pitch;
        const designZ = goal.z[k]!;
        const sweptZ = designZ + dOf[k]!;
        const depth = -dOf[k]!;
        const who = whoAtD?.(x, y) ?? -1;
        const cl = clAtD?.(x, y) ?? null;
        let clX = Number.NaN;
        let clY = Number.NaN;
        let clCov = -2;
        let clWallDist = Number.NaN;
        if (cl !== null) {
          clX = cl.x;
          clY = cl.y;
          const ci = Math.round((cl.x - goal.x0) / goal.pitch);
          const cj = Math.round((cl.y - goal.y0) / goal.pitch);
          const onGrid = ci >= 0 && cj >= 0 && ci < nx && cj < ny;
          clCov = onGrid ? goal.covered[cj * nx + ci]! : -1;
          clWallDist = outlineDistance(cl.x, cl.y);
        }
        const cellWallDist = wallDist === null ? Number.NaN : wallDist[k]!;
        const proof = straddleProof(k, i, j, depth);
        const isShadow = shadow !== null && shadow[k] === 1 ? 1 : 0;
        // The excuses, in the order the rule tries them, each with the value that decided it.
        const bandHit = band !== null && band[k] === 1 ? 1 : 0;
        const whoOkD = band === null || allowance === undefined || allowance.toolNumber === undefined || who === allowance.toolNumber ? 1 : 0;
        const legOkD = allowance !== undefined && depth <= allowance.legMm + 1e-9 ? 1 : 0;
        const reliefD = reliefAt(goal, x, y, reliefRadiusMm, border[k] === 1);
        const ceilOkD = depths_ceiling(depth, thicknessD, breakthroughD) ? 1 : 0;
        const silClOkD = cl !== null && clCov !== 1 && clWallDist >= (shadowRadius ?? goal.pitch) - goal.pitch - 1e-9 ? 1 : 0;
        const shadowVD = allowance !== undefined && allowance.toolNumber !== undefined && who === allowance.toolNumber && depth <= allowance.legMm + 1e-9 ? 1 : 0;
        const shadowClD = cl !== null && shadowRadius !== undefined && clWallDist >= shadowRadius - goal.pitch - 1e-9 ? 1 : 0;
        console.log(
          [
            'GOALCELL',
            x.toFixed(3), y.toFixed(3), designZ.toFixed(4), sweptZ.toFixed(4), depth.toFixed(4),
            who, cl === null ? '' : clX.toFixed(3), cl === null ? '' : clY.toFixed(3), cl === null ? '' : String(clCov), cl === null ? '' : clWallDist.toFixed(3),
            Number.isNaN(cellWallDist) ? '' : cellWallDist.toFixed(3),
            wall[k], border[k], silhouette[k], isShadow, proof.step.toFixed(4), proof.ok ? 1 : 0,
            bandHit, whoOkD, legOkD, reliefD.toFixed(4), reliefRadiusMm.toFixed(4), ceilOkD, silClOkD, shadowVD, shadowClD,
          ].join(','),
        );
      }
    }
  }
  // THE ADJUDICATED SET — the gate's reading, and what the pass and the sentence judge, in every
  // goal job: the 0.1 mm floor after the unadjudicable cells are excluded (and the edge break,
  // when the job states one).
  let adjudicatedCells = 0;
  let adjudicatedVolumeMm3 = 0;
  let adjudicatedMaxMm = 0;
  let adjudicatedMaxAt: { x: number; y: number } | null = null;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (sampled[k] !== 1) continue;
      if (dOf[k]! >= -0.1) continue;
      if (excluded[k] === 1) continue;
      adjudicatedCells++;
      const depth = -dOf[k]!;
      adjudicatedVolumeMm3 += depth * cellArea;
      if (depth > adjudicatedMaxMm) {
        adjudicatedMaxMm = depth;
        adjudicatedMaxAt = { x: goal.x0 + i * goal.pitch, y: goal.y0 + j * goal.pitch };
      }
    }
  }

  deltas.sort((a, b) => a - b);
  const medianDeltaMm = deltas.length === 0 ? 0 : deltas[Math.floor(deltas.length / 2)]!;
  const cutIntoFraction = rawCutCells / n;
  const adjudicatedFraction = adjudicatedCells / n;
  const edgeBreakFraction = edgeBreakCells / n;
  const wallNotScoredFraction = wallNotScoredCells / n;
  const shadowNotScoredFraction = shadowNotScoredCells / n;
  const leftoverFractions = leftoverCounts.map((c) => c / n);
  const coverageFraction = withinBoth / n;
  // #948 — THE PASS LINE. The page's rule is zero cut-into AND top-surface coverage ≥ the pass
  // line, where coverage is the share standing within the FIRST leftover band (0.1 mm) of the
  // goal — `1 − leftoverFractions[0]`, never `coverageFraction` (a different band). A run that
  // cut nothing into the goal but left 16 % of it standing above the goal is the page's
  // "Deviates", so it is not this check's pass either.
  const surfaceCoverage = 1 - (leftoverFractions[0] ?? 0);
  const passPct = Number((passCoverage * 100).toFixed(2));
  const surfacePct = Number((surfaceCoverage * 100).toFixed(2));
  const coverageOk = surfaceCoverage + 1e-9 >= passCoverage;
  // #955/#964 — THE PASS IS THE PAGE'S LINE IN EVERY GOAL JOB: zero at the 0.1 mm floor after the
  // unadjudicable cells are excluded (E's `cutInto0p1Pct`; F's scorer line 2). Wall cells and the
  // wall shadow are the gate's rule whatever the job states; the edge-break allowance adds the
  // rim cells only when the job states one.
  const judgedCells = adjudicatedCells;
  const ok = judgedCells === 0 && coverageOk;
  const straddlingClause =
    straddlingNotScoredCells > 0
      ? `; ${straddlingNotScoredCells} cell${straddlingNotScoredCells === 1 ? '' : 's'} on a ${straddlingMaxStepMm.toFixed(3)} mm step, excused on proof`
      : '';
  // #1092 — THE EXCUSE IS PRINTED, NEVER SILENT: cells a class would have excused but which are
  // COUNTED because they are deeper than the goal's own relief, with the deepest one named.
  const deepest = overReliefDeepest as { mm: number; x: number; y: number; cls: 'wall' | 'border' | 'shadow' } | null;
  // #1092 — silhouette cells excused on proof are printed beside the classes, with the deepest and
  // its CL distance from the outline (0f's ruling).
  const silhouetteNote =
    silhouetteExcusedCells > 0 && silhouetteDeepest !== null
      ? `; ${silhouetteExcusedCells} silhouette cell(s) excused on proof (deepest ${silhouetteDeepest.mm.toFixed(3)} mm at ${silhouetteDeepest.x.toFixed(2)}, ${silhouetteDeepest.y.toFixed(2)}; CL ${silhouetteDeepest.clDistanceMm.toFixed(3)} mm from the outline)`
      : '';
  const overReliefNote =
    wallOverReliefCells + shadowOverReliefCells + borderOverReliefCells > 0 && deepest !== null
      ? `; ${wallOverReliefCells + shadowOverReliefCells + borderOverReliefCells} cell(s) a class would have excused are counted instead (wall ${wallOverReliefCells}, border ${borderOverReliefCells}, shadow ${shadowOverReliefCells}; deepest ${deepest.mm.toFixed(3)} mm at ${deepest.x.toFixed(2)}, ${deepest.y.toFixed(2)})`
      : '';
  const excludedNote =
    edgeBreakCells + wallNotScoredCells + shadowNotScoredCells + straddlingNotScoredCells > 0 ||
    wallOverReliefCells + shadowOverReliefCells + borderOverReliefCells + silhouetteExcusedCells > 0
      ? ` (the rim edge break${edgeBreakCells > 0 ? `, ${(edgeBreakFraction * 100).toFixed(2)} % of the goal,` : ''} and ${(wallNotScoredFraction * 100 + shadowNotScoredFraction * 100).toFixed(2)} % of cells the heightfield cannot adjudicate are not counted${straddlingClause}${overReliefNote}${silhouetteNote})`
      : overReliefNote === '' && silhouetteNote === ''
        ? ''
        : ` (${(overReliefNote + silhouetteNote).replace(/^; /, '')})`;
  // #1064 (d) — MEASURED BESIDE PREDICTED. The plan's own bevel prediction rides in the sentence
  // when the caller supplies it; the measured number is still the verdict.
  const predictedNote =
    opts.predictedCutIntoMm === undefined
      ? ''
      : ` The plan predicted ${opts.predictedCutIntoMm.toFixed(2)} mm, measured ${adjudicatedMaxMm.toFixed(2)} mm.`;
  const sentence =
    judgedCells > 0
      ? `goal check: ${(adjudicatedFraction * 100).toFixed(2)} % of the goal (${cutIntoAreaMm2(adjudicatedCells, cellArea).toFixed(1)} mm²) cut into by up to ${adjudicatedMaxMm.toFixed(3)} mm — ${adjudicatedVolumeMm3.toFixed(1)} mm³ over-cut${excludedNote}.${predictedNote}`
      : coverageOk
        ? `goal check: no cell cut more than 0.1 mm into the goal${excludedNote} (${(coverageFraction * 100).toFixed(1)} % of the goal within ${cutIntoFloorMm} mm).`
        : `goal check: coverage ${surfacePct} % of the goal's top surface — the pass line asks ${passPct} % (${((1 - surfaceCoverage) * 100).toFixed(2)} % stands more than ${GOAL_LEFTOVER_BANDS_MM[0]} mm above the goal).`;

  return {
    ok,
    ran: true,
    reason: null,
    goalCells: covered,
    pitchMm: goal.pitch,
    cutIntoFloorMm,
    cutIntoFraction,
    cutIntoAreaMm2: cutIntoAreaMm2(rawCutCells, cellArea),
    cutIntoVolumeMm3: rawVolumeMm3,
    maxCutIntoMm: rawMaxCutInto,
    maxCutIntoAt: rawMaxCutIntoAt,
    ...(opts.leftoverTop === undefined || sweptTop === null
      ? {}
      : { columnCutInto: { fraction: columnCells / n, maxMm: columnMax, at: columnAt } }),
    leftoverFractions,
    leftoverVolumeMm3,
    maxLeftoverMm: maxLeftover,
    coverageFraction,
    passCoverage,
    medianDeltaMm,
    edgeBreakFraction,
    wallNotScoredFraction,
    shadowNotScoredFraction,
    straddlingNotScoredCells,
    straddlingMaxStepMm,
    wallOverReliefCells,
    shadowOverReliefCells,
    borderOverReliefCells,
    overReliefDeepest,
    silhouetteExcusedCells,
    silhouetteDeepest,
    adjudicatedFraction,
    adjudicatedMaxMm,
    adjudicatedMaxAt,
    sentence,
  };
}

function cutIntoAreaMm2(cells: number, cellArea: number): number {
  return cells * cellArea;
}

/**
 * #948 — a goal whose swept top the caller could not sample, STATED rather than skipped. The
 * report carries `ran: false` and the reason, and `ok` is true: the run is not failed for a check
 * that could not run, and it is never reported as a pass either (the sentence says what was not
 * compared). A caller that can sample the swept top calls {@link checkGoalCutInto} instead.
 */
export function goalCutIntoUnchecked(reason: string, passCoverage: number = GOAL_PASS_COVERAGE_FALLBACK): GoalCutIntoReport {
  return {
    ok: true,
    ran: false,
    reason,
    goalCells: 0,
    pitchMm: 0,
    cutIntoFloorMm: GOAL_CUT_INTO_FLOOR_MM,
    cutIntoFraction: 0,
    cutIntoAreaMm2: 0,
    cutIntoVolumeMm3: 0,
    maxCutIntoMm: 0,
    maxCutIntoAt: null,
    leftoverFractions: GOAL_LEFTOVER_BANDS_MM.map(() => 0),
    leftoverVolumeMm3: 0,
    maxLeftoverMm: 0,
    coverageFraction: 0,
    passCoverage,
    medianDeltaMm: 0,
    edgeBreakFraction: 0,
    wallNotScoredFraction: 0,
    straddlingNotScoredCells: 0,
    straddlingMaxStepMm: 0,
    wallOverReliefCells: 0,
    shadowOverReliefCells: 0,
    borderOverReliefCells: 0,
    overReliefDeepest: null,
    silhouetteExcusedCells: 0,
    silhouetteDeepest: null,
    shadowNotScoredFraction: 0,
    adjudicatedFraction: 0,
    adjudicatedMaxMm: 0,
    adjudicatedMaxAt: null,
    sentence: `goal check: not run — ${reason}. Nothing was compared against the goal here, so this is not a pass.`,
  };
}

export { goalTopAt };

