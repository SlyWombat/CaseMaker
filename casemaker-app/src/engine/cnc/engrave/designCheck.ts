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
import { ORACLE_AREA_FLOOR, type OracleBbox, type OraclePolygon, type OracleSliceAt } from '@/engine/cnc/engrave/oracle';
import type { Tool } from '@/engine/cnc/tool';
import type { GoalHeightfield } from '@/engine/cnc/cam/surface3d';
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
      for (let j = j0; j <= j1; j++) {
        const y = (j + 0.5) * pitch;
        const cutRow = mergeRanges(cut.get(j) ?? []);
        if (reachHere) {
          const ownRow = mergeRanges(p.rows.get(j) ?? []);
          deep += rangeCount(ownRow);
          // Only the outline's points the sweep did NOT remove can be unreached; of those, the ones
          // at least the cutter's radius (plus the band) from the edge are.
          for (const [a, b] of subtractRanges(ownRow, cutRow)) {
            for (let k = a; k < b; k++) {
              const x = (k + 0.5) * pitch;
              if (!edgeWithin(p.shape, x, y, p.rRef + band)) unreached.add(x, y);
            }
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

export interface GoalCutIntoOptions {
  /** Overrides {@link GOAL_CUT_INTO_FLOOR_MM}. */
  cutIntoFloorMm?: number;
}

export interface GoalCutIntoReport {
  ok: boolean;
  /** Covered goal cells the comparison ran over. */
  goalCells: number;
  pitchMm: number;
  cutIntoFloorMm: number;
  /** Share of covered cells cut more than the floor below the goal, 0-1. */
  cutIntoFraction: number;
  cutIntoAreaMm2: number;
  /** `sum(max(0, goalTop - sweptTop)) * cellArea` over cut-into cells — volume over-cut into the part, mm³. */
  cutIntoVolumeMm3: number;
  maxCutIntoMm: number;
  /** Share of covered cells left standing more than each of {@link GOAL_LEFTOVER_BANDS_MM} above the goal, 0-1, same order. */
  leftoverFractions: number[];
  leftoverVolumeMm3: number;
  maxLeftoverMm: number;
  /** Share of covered cells within the cut-into floor on both sides — the coverage % the acceptance asks for. */
  coverageFraction: number;
  medianDeltaMm: number;
  sentence: string;
}

/**
 * The 3D analogue of {@link checkDesignReach}: compares the ACTUAL swept surface with the GOAL
 * heightfield, not with the app's own cut plan — closing the gap #909 named ("the app's own check
 * passes, because it compares the simulation with the app's plan, not with the goal"). Ported
 * numerically from the bench's `docs/bench/2026-10-28-z1-real-jobs/tools/goal_check.py` (`d =
 * sweptTop - goalTop` over covered goal cells; `d < -CUT_INTO` is cut INTO the part, `d` above the
 * leftover bands is material left standing) so the app can read the same verdict in-app, for
 * #945/#946's pass criteria, rather than only the demo page's external tool.
 */
export function checkGoalCutInto(goal: GoalHeightfield, sweptTop: ResultTop, opts: GoalCutIntoOptions = {}): GoalCutIntoReport {
  const cutIntoFloorMm = opts.cutIntoFloorMm ?? GOAL_CUT_INTO_FLOOR_MM;
  const cellArea = goal.pitch * goal.pitch;
  const deltas: number[] = [];
  let cutIntoCells = 0;
  let cutIntoVolumeMm3 = 0;
  let maxCutInto = 0;
  const leftoverCounts = GOAL_LEFTOVER_BANDS_MM.map(() => 0);
  let leftoverVolumeMm3 = 0;
  let maxLeftover = 0;
  let withinBoth = 0;
  let covered = 0;

  for (let j = 0; j < goal.ny; j++) {
    for (let i = 0; i < goal.nx; i++) {
      const k = j * goal.nx + i;
      if (goal.covered[k] !== 1) continue;
      const x = goal.x0 + i * goal.pitch;
      const y = goal.y0 + j * goal.pitch;
      const top = sweptTop(x, y);
      if (top === null) continue;
      covered++;
      const goalTop = goal.z[k] as number;
      const d = top - goalTop; // + leftover, - cut-into, same sign convention as goal_check.py
      deltas.push(d);
      if (d < -cutIntoFloorMm) {
        cutIntoCells++;
        cutIntoVolumeMm3 += -d * cellArea;
        maxCutInto = Math.max(maxCutInto, -d);
      }
      for (let b = 0; b < GOAL_LEFTOVER_BANDS_MM.length; b++) {
        if (d > GOAL_LEFTOVER_BANDS_MM[b]!) leftoverCounts[b]! += 1;
      }
      if (d > GOAL_LEFTOVER_BANDS_MM[0]!) {
        leftoverVolumeMm3 += d * cellArea;
        maxLeftover = Math.max(maxLeftover, d);
      }
      if (Math.abs(d) <= cutIntoFloorMm) withinBoth++;
    }
  }

  const n = Math.max(covered, 1);
  deltas.sort((a, b) => a - b);
  const medianDeltaMm = deltas.length === 0 ? 0 : deltas[Math.floor(deltas.length / 2)]!;
  const cutIntoFraction = cutIntoCells / n;
  const leftoverFractions = leftoverCounts.map((c) => c / n);
  const coverageFraction = withinBoth / n;
  const ok = cutIntoCells === 0;
  const sentence = ok
    ? `goal check: no cell cut more than ${cutIntoFloorMm} mm into the goal (${(coverageFraction * 100).toFixed(1)} % of the goal within ${cutIntoFloorMm} mm).`
    : `goal check: ${(cutIntoFraction * 100).toFixed(2)} % of the goal (${cutIntoAreaMm2(cutIntoCells, cellArea).toFixed(1)} mm²) cut into by up to ${maxCutInto.toFixed(3)} mm — ${cutIntoVolumeMm3.toFixed(1)} mm³ over-cut.`;

  return {
    ok,
    goalCells: covered,
    pitchMm: goal.pitch,
    cutIntoFloorMm,
    cutIntoFraction,
    cutIntoAreaMm2: cutIntoAreaMm2(cutIntoCells, cellArea),
    cutIntoVolumeMm3,
    maxCutIntoMm: maxCutInto,
    leftoverFractions,
    leftoverVolumeMm3,
    maxLeftoverMm: maxLeftover,
    coverageFraction,
    medianDeltaMm,
    sentence,
  };
}

function cutIntoAreaMm2(cells: number, cellArea: number): number {
  return cells * cellArea;
}

export { goalTopAt };
