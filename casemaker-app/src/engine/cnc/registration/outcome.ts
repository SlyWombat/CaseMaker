/**
 * The registration's outcome maths (#430 phase 1): from the touches, where the stock IS, how far that
 * is from where the job expects it, and the origin that would put the job on it — and whether the
 * measurement is good enough to write one at all.
 *
 * AN EDGE is between the last touch ON the stock and the first touch OFF it, moved back toward the
 * stock by the effective rim offset (`tipRadiusMm`, measured 2026-10-15): the probe reads the stock
 * until its centre is that far past the edge.
 *
 * THE CURRENT ORIGIN comes from the touches themselves: a `[PRB:…]` is in machine coordinates and the
 * touch was commanded in work coordinates, so G54 XY = machine − work. Every touch must agree; one
 * that landed elsewhere makes the whole measurement unusable.
 *
 * USABLE, OR NOT (#430 review). The origin is written only from a measurement that is whole: every
 * scan bracketed its edge, every axis the mount leaves to be found was measured, no touch met
 * something above the surface, and every touch landed where it was sent. `problems` says what is
 * missing; `applyCorrection` refuses on any of it.
 *
 * THE CORRECTION, in #387's order (decision Q12 — written only after the operator confirms):
 *   - X, Y: the current G54 moved by the offset (the bracket: the anchor's origin);
 *   - Z0 = surface + (cutter PRB − reference PRB), the reference being the probe's own `M491`.
 */

import type { Edge, EdgeScan, RegistrationPlan } from './plan';
import type { Prb, TouchKind } from './readings';

export interface ScanTouch {
  at: number;
  prb: Prb;
  kind: TouchKind;
  /**
   * #525 — this reading is the 3D probe's SIDEWAYS touch: `at` is the stylus BALL'S CENTRE along the
   * scan's axis at the trigger (work coordinates), not a point on the stock that was stepped over.
   * The edge is that centre less `edgeOffsetMm` (the ball's horizontal centre-to-edge distance at
   * the touch depth — one radius at the equator, less when the ball meets the top corner), so
   * `edgeFrom` corrects it directly instead of bracketing it between an on and an off touch.
   */
  sideContact?: true;
  /** The horizontal ball offset for a side contact, mm (`probe3d.ts`'s `ballOffsetMm`). */
  edgeOffsetMm?: number;
}

export interface ScanRecord {
  scan: EdgeScan;
  touches: ScanTouch[];
}

export interface RunData {
  probeRefZ: number;
  surface: Prb;
  scans: ScanRecord[];
}

export interface EdgeFinding {
  edge: Edge;
  along: number;
  expectedAt: number;
  foundAt: number | null;
  problem: string | null;
}

export interface RegistrationOutcome {
  edges: EdgeFinding[];
  offset: { x: number; y: number };
  measured: { x: boolean; y: boolean };
  centre: { x: number; y: number };
  rotationDeg: number | null;
  /** How far the rotation moves the stock's far end, mm (over the stock's length). */
  rotationShiftMm: number | null;
  withinMargin: boolean;
  margin: number;
  surfaceZ: number;
  probeRefZ: number;
  /**
   * The plan's seek height, in MACHINE Z — the resolved machine's `toolChange.clearanceZ` it sought from
   * (carried so the recovery sentence names the same height the plan lifted to, never a constant).
   */
  seekFromMachineZ: number;
  /** The G54 in force during the touches — null on the bracket, where every move was sent in machine XY. */
  currentG54: { x: number; y: number } | null;
  correctedG54: { x: number; y: number };
  /**
   * Whether X and Y were CHECKED by a touch. On the bracket without the confirming touch they were not:
   * they are the bracket's, taken on trust (#427 review) — never shown as "confirmed".
   */
  xyChecked: boolean;
  /**
   * Bracket with Q10's confirming touch (#427): how far each far edge is from where the bracket's corner
   * and the stock's size put it, mm (null: that edge was not scanned). The origin stays the bracket's.
   */
  bracketCheck?: { x: number | null; y: number | null };
  /** Whether an origin may be written from this at all. */
  usable: boolean;
  /** Why not, one sentence each. Empty when usable. */
  problems: string[];
  notes: string[];
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

export function edgeFrom(record: ScanRecord, tipRadius: number): EdgeFinding {
  const { scan, touches } = record;
  const base = { edge: scan.edge, along: scan.along, expectedAt: scan.expectedAt };
  // The name a sentence uses: a feature's wall by its label (#429), else the stock's edge.
  const what = scan.label ?? `the ${scan.edge} edge`;
  if (touches.length === 0) return { ...base, foundAt: null, problem: `the scan of ${what} made no touch` };
  // #525 — a SIDEWAYS touch finds the edge in one reading: the stylus ball triggers with its centre
  // standing `edgeOffsetMm` outside the wall, so the wall is the centre less that offset along the
  // outward direction. There is no on/off bracket to halve. The offset is the module's geometry
  // (radius at the equator, less when the ball meets the top corner); `tipRadius` is its fallback.
  const side = touches.find((t) => t.sideContact === true);
  if (side !== undefined) {
    if (side.kind !== 'stock') {
      return { ...base, foundAt: null, problem: `the sideways touch on ${what} found nothing within its travel` };
    }
    return { ...base, foundAt: r3(side.at - scan.outward * (side.edgeOffsetMm ?? tipRadius)), problem: null };
  }
  // A high reading is an obstacle — unless the plan says this scan's high reading is the mount's own top
  // past a recessed stock (#517: the vise jaw above a thin sheet), in which case it is the first touch off.
  const above = touches.find((t) => t.kind === 'above');
  if (above && scan.aboveIsEdge !== true) {
    return {
      ...base,
      foundAt: null,
      problem: `a touch on the scan of ${what} read ${r3(above.prb.z)}, higher than the stock — a clamp or a taller jaw is in the way`,
    };
  }
  // #593 — a first touch off the stock is no longer a blanket refusal: the executor searched inward
  // for the edge and records it below. A reference scan (a wall, by its `label`) has no inward
  // search, so a miss there is still "not where the job expects it".
  if (touches[0]!.kind !== 'stock' && scan.label !== undefined) {
    return {
      ...base,
      foundAt: null,
      problem: `the first touch, ${Math.abs(scan.start - scan.expectedAt)} mm short of where ${what} should be, was already off the stock — it is not where the job expects it`,
    };
  }
  const ordered = [...touches].sort((a, b) => scan.outward * (a.at - b.at));
  let lastOn: number | null = null;
  let firstOff: number | null = null;
  for (const t of ordered) {
    if (t.kind === 'stock') {
      if (firstOff === null) lastOn = t.at;
    } else if (firstOff === null) {
      firstOff = t.at;
    }
  }
  if (lastOn === null || firstOff === null) {
    // A stock-edge scan that never touched the stock, inward or outward (#593), names the whole
    // range the probe searched; any other shortfall keeps the plan's own reach sentence.
    if (lastOn === null && scan.oppositeAt !== undefined) {
      const axis = scan.edge === 'left' || scan.edge === 'right' ? 'X' : 'Y';
      const lo = Math.min(scan.start, scan.limit, scan.oppositeAt);
      const hi = Math.max(scan.start, scan.limit, scan.oppositeAt);
      return {
        ...base,
        foundAt: null,
        problem: `${what} was not found — the probe searched ${axis} ${r3(lo)} to ${r3(hi)} mm and never touched the stock`,
      };
    }
    return { ...base, foundAt: null, problem: `${what} was not found within the scan's reach` };
  }
  return { ...base, foundAt: r3((lastOn + firstOff) / 2 - scan.outward * tipRadius), problem: null };
}

export function computeOutcome(plan: RegistrationPlan, data: RunData): RegistrationOutcome {
  const s = plan.settings;
  const edges = data.scans.map((r) => edgeFrom(r, s.tipRadiusMm));
  const problems: string[] = edges.filter((e) => e.problem !== null).map((e) => e.problem!);
  const notes: string[] = [];

  const dxs = edges.filter((e) => (e.edge === 'left' || e.edge === 'right') && e.foundAt !== null).map((e) => e.foundAt! - e.expectedAt);
  const dys = edges.filter((e) => (e.edge === 'front' || e.edge === 'back') && e.foundAt !== null).map((e) => e.foundAt! - e.expectedAt);
  const mean = (v: number[]) => (v.length === 0 ? 0 : v.reduce((a, b) => a + b, 0) / v.length);
  const measured = { x: dxs.length > 0, y: dys.length > 0 };

  // Rotation from two found points on one edge; its shift over the stock's length is what a margin judges.
  let rotationDeg: number | null = null;
  let rotationShiftMm: number | null = null;
  const lefts = edges.filter((e) => e.edge === 'left' && e.foundAt !== null);
  if (lefts.length >= 2) {
    const [a, b] = [lefts[0]!, lefts[lefts.length - 1]!];
    if (b.along !== a.along) {
      const slope = (b.foundAt! - a.foundAt!) / (b.along - a.along);
      rotationDeg = r3((Math.atan(slope) * 180) / Math.PI);
      rotationShiftMm = r3(Math.abs(slope) * (plan.stock.yMax - plan.stock.yMin));
    }
  }

  // The frame the touches were sent in: the G54 in force, read back from the surface touch — or, on the
  // bracket, the bracket's origin, because every move there is sent in machine XY from it (#427).
  const onBracket = plan.mount === 'bracket' && plan.bracketOrigin !== null;
  const g54InForce = { x: r3(data.surface.x - plan.surfacePoint.x), y: r3(data.surface.y - plan.surfacePoint.y) };
  const sentFrom = onBracket ? { x: plan.bracketOrigin!.x, y: plan.bracketOrigin!.y } : g54InForce;
  for (const r of data.scans) {
    for (const t of r.touches) {
      const wx = r.scan.edge === 'left' || r.scan.edge === 'right' ? t.at : r.scan.along;
      const wy = r.scan.edge === 'left' || r.scan.edge === 'right' ? r.scan.along : t.at;
      if (Math.abs(t.prb.x - wx - sentFrom.x) > 0.01 || Math.abs(t.prb.y - wy - sentFrom.y) > 0.01) {
        problems.push(
          `a touch landed at machine (${t.prb.x}, ${t.prb.y}), not where it was sent — the origin moved during the scan`,
        );
      }
    }
  }

  // Which axes the mount leaves to be found: the bracket's are the anchor's; the others need both.
  if (plan.mount !== 'bracket') {
    if (!measured.x) problems.push('X was not measured: no left edge was found');
    if (!measured.y) problems.push('Y was not measured: no front edge was found');
  }

  let offset = { x: r3(mean(dxs)), y: r3(mean(dys)) };
  let correctedG54 = { x: r3(g54InForce.x + offset.x), y: r3(g54InForce.y + offset.y) };
  // #427 — on the bracket every move is sent in machine XY from the bracket's origin, so the surface touch
  // must have landed exactly there: anything else means the move did not go where it was sent (or ran in
  // another frame), and nothing measured here can be trusted.
  if (plan.mount === 'bracket' && plan.bracketOrigin) {
    const want = { x: plan.bracketOrigin.x + plan.surfacePoint.x, y: plan.bracketOrigin.y + plan.surfacePoint.y };
    if (Math.abs(data.surface.x - want.x) > 0.01 || Math.abs(data.surface.y - want.y) > 0.01) {
      problems.push(
        `the surface touch landed at machine (${data.surface.x}, ${data.surface.y}), not at (${r3(want.x)}, ${r3(want.y)}) where it was sent from the bracket’s origin`,
      );
    }
  }
  let bracketCheck: RegistrationOutcome['bracketCheck'];
  if (plan.mount === 'bracket' && plan.bracketOrigin && plan.scans.length > 0) {
    // The touches were sent from the bracket's origin (G53), so a found edge's distance from where it was
    // expected is the stock's distance from the corner — plus its size error.
    bracketCheck = { x: measured.x ? r3(mean(dxs)) : null, y: measured.y ? r3(mean(dys)) : null };
    for (const [axis, dev, edge] of [
      ['X', bracketCheck.x, 'right'],
      ['Y', bracketCheck.y, 'back'],
    ] as const) {
      if (dev === null) problems.push(`the confirming touch found no ${edge} edge`);
      else if (Math.abs(dev) > s.edgeMarginMm) {
        problems.push(
          `the ${edge} edge is ${dev} mm (${axis}) from where the bracket’s corner and the stock’s size put it — more than the ${s.edgeMarginMm} mm margin: push the stock into the bracket’s corner on both faces and check its size, then register again`,
        );
      }
    }
  }
  if (onBracket) {
    // The origin is the bracket's. The G54 in force before is unknown here (nothing was sent in it), so
    // there is no offset from it to report: the confirming touch's deviations are `bracketCheck`.
    correctedG54 = { x: r3(plan.bracketOrigin!.x), y: r3(plan.bracketOrigin!.y) };
    offset = { x: 0, y: 0 };
    notes.push(`X and Y from the bracket: ${plan.bracketOrigin!.from}`);
    if (!bracketCheck) notes.push('X and Y were NOT checked by any touch: they are the bracket’s, taken on trust');
  }

  const usable = problems.length === 0;
  const xyChecked = onBracket ? bracketCheck !== undefined : measured.x && measured.y;
  const withinMargin =
    usable &&
    xyChecked &&
    Math.abs(offset.x) <= s.edgeMarginMm &&
    Math.abs(offset.y) <= s.edgeMarginMm &&
    (rotationShiftMm === null || rotationShiftMm <= s.edgeMarginMm);
  notes.push(`edges are corrected by the measured ${s.tipRadiusMm} mm effective rim offset`);
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
    xyChecked,
    ...(bracketCheck ? { bracketCheck } : {}),
    withinMargin,
    margin: s.edgeMarginMm,
    surfaceZ: data.surface.z,
    probeRefZ: data.probeRefZ,
    seekFromMachineZ: plan.seek.fromMachineZ,
    currentG54: onBracket ? null : g54InForce,
    correctedG54,
    usable,
    problems,
    notes,
  };
}

/**
 * Z0 for the cutter: the surface + (cutter PRB − reference PRB) — #387.
 *
 * `outcome.surfaceZ` is always a MEASURED surface. After a facing pass (#432 slice 4, decision 4:
 * probe → face → re-touch → engrave) it is the re-touch's reading, not the first probe's: a skim
 * never takes exactly its nominal depth (spindle growth, deflection, a tilted blank), so the datum
 * is measured again on the faced top and fed back through `{...outcome, surfaceZ: measured}` rather
 * than computed by subtracting the depth. The expected surface — the first reading minus the depth
 * posted — is the re-touch's BAND, which is what `retouchSurface` checks the measurement against.
 */
export function cutterZ0(outcome: Pick<RegistrationOutcome, 'surfaceZ' | 'probeRefZ'>, cutterRefZ: number): number {
  return r3(outcome.surfaceZ + (cutterRefZ - outcome.probeRefZ));
}

export function correctionLine(outcome: RegistrationOutcome, cutterRefZ: number): string {
  const f = (n: number) => r3(n).toFixed(3);
  return `G10 L2 P1 X${f(outcome.correctedG54.x)} Y${f(outcome.correctedG54.y)} Z${f(cutterZ0(outcome, cutterRefZ))}`;
}
