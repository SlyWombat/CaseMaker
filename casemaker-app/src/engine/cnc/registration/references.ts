/**
 * Registration on features cut in an earlier setup (#429): after a remount, find the part by the
 * openings setup 1 cut through to the face now up, instead of by the stock's own edges.
 *
 * THE PHYSICS IS #430's. The wired probe touches Z only. An opening a through-cut left reads as a MISS:
 * the probe passes the surface − cap and touches nothing. So an opening's WALL is found exactly as a
 * stock edge is — a stepped scan that starts on solid stock, steps toward the opening, and stops at the
 * first touch off the stock — and the executor, its bounded seek, its capped touches, its XY moves at
 * the park height and its `$X` before `G90` are #430's, unchanged. (Nothing on a vise or tape mount
 * stands above the park height; the bracket is refused here, below.)
 *
 * WHICH WALLS. A wall counts only with SOLID stock on its outer side. Each scan runs on the opening's
 * mid-line (a round bore's diameter as well as a slot's width), starts `scanInsideMm` out on stock that
 * is clear of the stock's edge and of every other opening, and is capped at the opening's CENTRE — so it
 * can never reach the far wall and mistake it for this one.
 *
 * WHAT IT FINDS. Two opposite walls of one opening pair up: their midpoint is the centre, which cancels
 * the opening's own size error AND the rim offset's spread. A wall without its partner is never used —
 * it carries both errors — so an axis is planned only where both its walls can be scanned (#429 review).
 * The walls' SEPARATION is checked against the opening's size: a burr on setup 1's exit face, or a chip
 * left in the hole, moves a wall, and a width off by more than the measurement can tell (half the fine
 * step, plus twice the rim spread) makes the result unusable. The offset is the mean over the features.
 * ROTATION comes from the two features farthest apart; its RESOLUTION is worked out when planning (each
 * centre is known to a quarter of the fine step), and a turn the references cannot resolve is "not
 * measurable", never a false "re-seat it". G54 cannot rotate, so a turn certainly past the margin makes
 * the result UNUSABLE. The correction is written only through `applyCorrection`: a usable measurement,
 * and the operator's confirmation (Q12).
 *
 * WHAT IS AN OPENING. One connected opening per removal, with its own depth through the face now up
 * (`setups/registration.ts` refuses a removal that does not say it is one). One shallower than the touch
 * cap reads as a touch, not a miss, and is not used. Blind cuts on the face now up are kept clear of, as
 * openings are, by every scan start and by the surface touch.
 */

import { planRegistration, type EdgeScan, type PlanInput, type PlanResult, type ReferenceEntry, type RegistrationPlan } from './plan';
import { edgeFrom, type RegistrationOutcome, type RunData } from './outcome';
import type { RegistrationSettings } from './settings';

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** An opening an earlier setup cut through to the face now up, in this setup's work XY. */
export interface ReferenceOpening {
  itemId: string;
  name: string;
  min: [number, number];
  max: [number, number];
  /** How deep it goes below the face now up, mm. */
  depth: number;
}

export interface ReferencePlanInput extends PlanInput {
  openings: ReferenceOpening[];
  /** Blind cuts on the face now up: no scan starts, and no surface touch lands, on them. */
  blind?: { min: [number, number]; max: [number, number] }[];
}

type Rect = { min: [number, number]; max: [number, number] };
const grow = (r: Rect, by: number): Rect => ({ min: [r.min[0] - by, r.min[1] - by], max: [r.max[0] + by, r.max[1] + by] });
const inside = (x: number, y: number, r: Rect) => x > r.min[0] && x < r.max[0] && y > r.min[1] && y < r.max[1];

/**
 * A point on solid stock for the surface touch: the cut area's centre (§5.9 — Z0 is taken where the job
 * cuts), or the nearest point to it clear of every opening and blind cut.
 */
function surfacePoint(stock: PlanInput['stock'], avoid: Rect[], keep: number, want: { x: number; y: number }): { x: number; y: number } | null {
  const inset = Math.max(1, stock.cornerRadius) + keep;
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i <= 16; i++) {
    for (let j = 0; j <= 16; j++) {
      pts.push({ x: stock.xMin + inset + ((stock.xMax - stock.xMin - 2 * inset) * i) / 16, y: stock.yMin + inset + ((stock.yMax - stock.yMin - 2 * inset) * j) / 16 });
    }
  }
  pts.sort((a, b) => Math.hypot(a.x - want.x, a.y - want.y) - Math.hypot(b.x - want.x, b.y - want.y));
  pts.unshift(want);
  return pts.find((p) => !avoid.some((o) => inside(p.x, p.y, grow(o, keep)))) ?? null;
}

/** How finely a centre is known on one axis: the miss is halved once, so ± a quarter of the fine step. */
export function centreResolution(s: RegistrationSettings): number {
  return s.fineStepMm / 4;
}

/**
 * The plan: #430's (its seek, its band, its mount checks) with the stock-edge scans replaced by scans
 * of the openings' walls. Refused, by name: the bracket mount; no opening deep, wide and placed enough
 * to probe; on tape, references too close together to read the turn.
 */
export function planReferences(input: ReferencePlanInput, s: RegistrationSettings): PlanResult {
  if (input.mount === 'bracket') {
    return { ok: false, reason: 'on the bracket X and Y come from its datum: reference features are for the vise and tape' };
  }
  const keep = s.tipRadiusMm + s.cornerClearanceMm;
  const stockRect: Rect = { min: [input.stock.xMin, input.stock.yMin], max: [input.stock.xMax, input.stock.yMax] };
  const solid = grow(stockRect, -(keep + Math.max(0, input.stock.cornerRadius)));
  const blind = input.blind ?? [];
  const want = input.cutCentre ?? { x: (input.stock.xMin + input.stock.xMax) / 2, y: (input.stock.yMin + input.stock.yMax) / 2 };
  const at = surfacePoint(input.stock, [...input.openings, ...blind], keep + 1, want);
  if (at === null) return { ok: false, reason: 'no point on the face is clear of every opening for the surface touch' };
  const base = planRegistration({ ...input, cutCentre: at }, s);
  if (!base.ok) return base;

  const scans: EdgeScan[] = [];
  const references: ReferenceEntry[] = [];
  const skipped: string[] = [];
  for (const o of input.openings) {
    if (!(o.depth > s.capBelowSurfaceMm + s.surfaceBandMm)) {
      skipped.push(`${o.name}: only ${o.depth} mm deep, within the touch cap — a touch in it reads as a touch, not a miss`);
      continue;
    }
    const others = [...input.openings.filter((p) => p !== o), ...blind].map((p) => grow(p, keep));
    const entry: ReferenceEntry = {
      itemId: o.itemId,
      name: o.name,
      centre: { x: r3((o.min[0] + o.max[0]) / 2), y: r3((o.min[1] + o.max[1]) / 2) },
      size: { x: r3(o.max[0] - o.min[0]), y: r3(o.max[1] - o.min[1]) },
      xScans: [],
      yScans: [],
    };
    for (const axis of ['x', 'y'] as const) {
      const a = axis === 'x' ? 0 : 1;
      const b = axis === 'x' ? 1 : 0;
      const width = o.max[a] - o.min[a];
      const crossHalf = (o.max[b] - o.min[b]) / 2;
      const name = axis === 'x' ? 'across X' : 'across Y';
      if (!(width > s.tipDiameterMm + 2 * s.fineStepMm)) {
        skipped.push(`${o.name} ${name}: ${r3(width)} mm, too small to probe with the ${s.tipDiameterMm} mm tip`);
        continue;
      }
      if (!(crossHalf > keep)) {
        skipped.push(`${o.name} ${name}: too narrow the other way to scan its mid-line clear of its corners`);
        continue;
      }
      const along = axis === 'x' ? entry.centre.y : entry.centre.x;
      const centre = axis === 'x' ? entry.centre.x : entry.centre.y;
      const walls = [
        { at: o.min[a], outward: 1 as const, edge: (axis === 'x' ? 'right' : 'back') as EdgeScan['edge'], side: axis === 'x' ? 'left' : 'front' },
        { at: o.max[a], outward: -1 as const, edge: (axis === 'x' ? 'left' : 'front') as EdgeScan['edge'], side: axis === 'x' ? 'right' : 'back' },
      ];
      const planned: EdgeScan[] = [];
      for (const w of walls) {
        const start = w.at - w.outward * s.scanInsideMm;
        const reach = w.at + w.outward * s.scanReachMm;
        const limit = w.outward > 0 ? Math.min(reach, centre) : Math.max(reach, centre);
        const onStock = [start, w.at - w.outward * (s.tipRadiusMm + 1e-6)].every((p) => {
          const [x, y] = axis === 'x' ? [p, along] : [along, p];
          return inside(x, y, solid) && !others.some((r) => inside(x, y, r));
        });
        if (onStock) {
          planned.push({ edge: w.edge, along: r3(along), expectedAt: r3(w.at), outward: w.outward, start: r3(start), limit: r3(limit), coarseStep: s.coarseStepMm, fineStep: s.fineStepMm, label: `the ${w.side} wall of ${o.name}` });
        }
      }
      // Both walls or neither: one wall carries the opening's size error and the rim's spread.
      if (planned.length < 2) {
        skipped.push(`${o.name} ${name}: ${planned.length === 0 ? 'no wall' : 'only one wall'} has solid stock outside it, and one wall alone is not a measurement`);
        continue;
      }
      for (const sc of planned) {
        (axis === 'x' ? entry.xScans : entry.yScans).push(scans.length);
        scans.push(sc);
      }
    }
    if (entry.xScans.length + entry.yScans.length > 0) references.push(entry);
  }
  if (references.length === 0) {
    return { ok: false, reason: `no reference feature can be probed: ${skipped.join('; ') || 'there are no openings'}` };
  }

  // The turn: from the two whole features farthest apart, to what resolution.
  const span = Math.max(input.stock.xMax - input.stock.xMin, input.stock.yMax - input.stock.yMin);
  const whole = references.filter((r) => r.xScans.length > 0 && r.yScans.length > 0);
  let rotation: RegistrationPlan['referenceRotation'] = null;
  for (let i = 0; i < whole.length; i++) {
    for (let j = i + 1; j < whole.length; j++) {
      const sep = Math.hypot(whole[j]!.centre.x - whole[i]!.centre.x, whole[j]!.centre.y - whole[i]!.centre.y);
      if (rotation === null || sep > rotation.separation) {
        rotation = { between: [whole[i]!.itemId, whole[j]!.itemId], separation: r3(sep), resolutionMm: r3(((2 * centreResolution(s)) * span) / sep) };
      }
    }
  }
  const measurable = rotation !== null && rotation.resolutionMm < s.edgeMarginMm;
  if (input.mount === 'tape' && !measurable) {
    return {
      ok: false,
      reason:
        rotation === null
          ? 'on tape nothing holds the turn, and it needs two references measured on both axes'
          : `on tape nothing holds the turn, and the references are only ${rotation.separation} mm apart: a turn could be read only to ±${rotation.resolutionMm} mm across the stock, no better than the ${s.edgeMarginMm} mm margin`,
    };
  }
  const plan: RegistrationPlan = {
    ...base.plan,
    scans,
    references,
    referenceRotation: rotation,
    notes: [
      `registered on ${references.map((r) => r.name).join(', ')} — features cut in an earlier setup, read as misses through the face now up`,
      rotation === null
        ? 'the turn is not measured (no two references read on both axes)'
        : measurable
          ? `the turn is read between ${rotation.between.join(' and ')}, ${rotation.separation} mm apart, to ±${rotation.resolutionMm} mm across the stock`
          : `the turn is NOT measurable: the references are ${rotation.separation} mm apart, so it could be read only to ±${rotation.resolutionMm} mm across the stock`,
      ...skipped.map((k) => `not scanned: ${k}`),
      ...base.plan.notes.filter((n) => !/fixed jaw fixes|left edge at two points/.test(n)),
    ],
  };
  return { ok: true, plan };
}

export interface ReferenceFinding {
  itemId: string;
  name: string;
  /** The centre's offset from where the job expects it, mm, per axis — null where not measured. */
  dx: number | null;
  dy: number | null;
  /** The measured width between the walls, per axis, mm. */
  width: { x: number | null; y: number | null };
}

/** How far a measured width may be from the opening's: half the fine step, plus the rim spread twice. */
export function widthTolerance(s: RegistrationSettings): number {
  return r3(s.fineStepMm / 2 + 2 * s.tipRadiusUncertaintyMm);
}

/**
 * The outcome of a reference plan: each feature's centre offset and width, the mean offset, the turn
 * (to the plan's resolution), and whether a correction may be written at all.
 */
export function referenceOutcome(plan: RegistrationPlan, data: RunData): RegistrationOutcome & { references: ReferenceFinding[] } {
  const s = plan.settings;
  const refs = plan.references ?? [];
  const edges = data.scans.map((r) => edgeFrom(r, s.tipRadiusMm));
  const problems: string[] = edges.filter((e) => e.problem !== null).map((e) => e.problem!);
  const notes: string[] = [];

  // Every touch must have landed where it was sent, in the G54 the surface touch read back.
  const currentG54 = { x: r3(data.surface.x - plan.surfacePoint.x), y: r3(data.surface.y - plan.surfacePoint.y) };
  for (const r of data.scans) {
    for (const t of r.touches) {
      const xAxis = r.scan.edge === 'left' || r.scan.edge === 'right';
      const wx = xAxis ? t.at : r.scan.along;
      const wy = xAxis ? r.scan.along : t.at;
      if (Math.abs(t.prb.x - wx - currentG54.x) > 0.01 || Math.abs(t.prb.y - wy - currentG54.y) > 0.01) {
        problems.push(`a touch landed at machine (${t.prb.x}, ${t.prb.y}), not where it was sent — the origin moved during the scan`);
      }
    }
  }

  const tol = widthTolerance(s);
  const findings: ReferenceFinding[] = refs.map((ref) => {
    const f: ReferenceFinding = { itemId: ref.itemId, name: ref.name, dx: null, dy: null, width: { x: null, y: null } };
    for (const [axis, idx] of [['x', ref.xScans], ['y', ref.yScans]] as const) {
      if (idx.length !== 2) continue;
      const [lo, hi] = idx.map((i) => edges[i]!);
      if (lo!.foundAt === null || hi!.foundAt === null) continue;
      const width = r3(hi!.foundAt - lo!.foundAt);
      const expected = axis === 'x' ? ref.size.x : ref.size.y;
      f.width[axis] = width;
      if (Math.abs(width - expected) > tol) {
        problems.push(
          `${ref.name} measures ${width} mm ${axis === 'x' ? 'across X' : 'across Y'}, not its ${expected} mm (beyond the ±${tol} mm a width can be read to): a burr on its edge, a chip in it, or not the feature the job expects — clean it and register again`,
        );
        continue;
      }
      const d = r3(((lo!.foundAt - lo!.expectedAt) + (hi!.foundAt - hi!.expectedAt)) / 2);
      if (axis === 'x') f.dx = d;
      else f.dy = d;
    }
    return f;
  });
  const xs = findings.filter((f) => f.dx !== null).map((f) => f.dx!);
  const ys = findings.filter((f) => f.dy !== null).map((f) => f.dy!);
  const measured = { x: xs.length > 0, y: ys.length > 0 };
  if (!measured.x) problems.push('X was not measured: no reference was read across X');
  if (!measured.y) problems.push('Y was not measured: no reference was read across Y');
  const mean = (v: number[]) => (v.length === 0 ? 0 : v.reduce((a, b) => a + b, 0) / v.length);
  const offset = { x: r3(mean(xs)), y: r3(mean(ys)) };

  // The turn, between the plan's pair, to the plan's resolution. Positive is counter-clockwise from above.
  let rotationDeg: number | null = null;
  let rotationShiftMm: number | null = null;
  const rot = plan.referenceRotation ?? null;
  if (rot === null || rot.resolutionMm >= s.edgeMarginMm) {
    if (plan.mount === 'tape') problems.push('on tape nothing holds the turn, and these references cannot measure it');
    else notes.push(rot === null ? 'the turn is not measured: the fixed jaw holds it' : `the turn is not measurable to better than ±${rot.resolutionMm} mm: the fixed jaw holds it`);
  } else {
    const a = refs.find((r) => r.itemId === rot.between[0])!;
    const b = refs.find((r) => r.itemId === rot.between[1])!;
    const fa = findings[refs.indexOf(a)]!;
    const fb = findings[refs.indexOf(b)]!;
    if (fa.dx === null || fa.dy === null || fb.dx === null || fb.dy === null) {
      problems.push(`the turn could not be read: ${fa.dx === null || fa.dy === null ? a.name : b.name} was not measured on both axes`);
    } else {
      const ex = b.centre.x - a.centre.x;
      const ey = b.centre.y - a.centre.y;
      const mx = ex + (fb.dx - fa.dx);
      const my = ey + (fb.dy - fa.dy);
      const angle = Math.atan2(ex * my - ey * mx, ex * mx + ey * my);
      rotationDeg = r3((angle * 180) / Math.PI);
      const span = Math.max(plan.stock.xMax - plan.stock.xMin, plan.stock.yMax - plan.stock.yMin);
      rotationShiftMm = r3(Math.abs(angle) * span);
      if (rotationShiftMm - rot.resolutionMm > s.edgeMarginMm) {
        problems.push(
          `the part is turned ${rotationDeg}° (${rotationShiftMm} mm across the stock, ±${rot.resolutionMm}), past the ${s.edgeMarginMm} mm margin — the machine's origin cannot turn, so no correction is written: re-seat it square and register again`,
        );
      } else if (rotationShiftMm > s.edgeMarginMm) {
        notes.push(`the turn reads ${rotationShiftMm} mm across the stock, at the margin within what the references can tell (±${rot.resolutionMm} mm)`);
      }
    }
  }

  const usable = problems.length === 0;
  const withinMargin =
    usable && Math.abs(offset.x) <= s.edgeMarginMm && Math.abs(offset.y) <= s.edgeMarginMm && (rotationShiftMm === null || rotationShiftMm <= s.edgeMarginMm);
  notes.push(`walls are corrected by the measured ${s.tipRadiusMm} mm effective rim offset; it cancels in each centre`);
  return {
    edges,
    offset,
    measured,
    centre: {
      x: r3((plan.stock.xMin + plan.stock.xMax) / 2 + offset.x),
      y: r3((plan.stock.yMin + plan.stock.yMax) / 2 + offset.y),
    },
    rotationDeg,
    rotationShiftMm,
    xyChecked: measured.x && measured.y,
    withinMargin,
    margin: s.edgeMarginMm,
    surfaceZ: data.surface.z,
    probeRefZ: data.probeRefZ,
    seekFromMachineZ: plan.seek.fromMachineZ,
    currentG54,
    correctedG54: { x: r3(currentG54.x + offset.x), y: r3(currentG54.y + offset.y) },
    usable,
    problems,
    notes,
    references: findings,
  };
}
