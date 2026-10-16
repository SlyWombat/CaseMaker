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
  currentG54: { x: number; y: number };
  correctedG54: { x: number; y: number };
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
  if (touches.length === 0) return { ...base, foundAt: null, problem: `the ${scan.edge} scan made no touch` };
  const above = touches.find((t) => t.kind === 'above');
  if (above) {
    return {
      ...base,
      foundAt: null,
      problem: `a touch on the ${scan.edge} scan read ${r3(above.prb.z)}, higher than the stock — a clamp or a taller jaw is in the way`,
    };
  }
  if (touches[0]!.kind !== 'stock') {
    return {
      ...base,
      foundAt: null,
      problem: `the first touch, ${Math.abs(scan.start - scan.expectedAt)} mm inside where the ${scan.edge} edge should be, was already off the stock — it is not where the job expects it`,
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
    return { ...base, foundAt: null, problem: `no ${scan.edge} edge was found within the scan's reach` };
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

  const currentG54 = { x: r3(data.surface.x - plan.surfacePoint.x), y: r3(data.surface.y - plan.surfacePoint.y) };
  for (const r of data.scans) {
    for (const t of r.touches) {
      const wx = r.scan.edge === 'left' || r.scan.edge === 'right' ? t.at : r.scan.along;
      const wy = r.scan.edge === 'left' || r.scan.edge === 'right' ? r.scan.along : t.at;
      if (Math.abs(t.prb.x - wx - currentG54.x) > 0.01 || Math.abs(t.prb.y - wy - currentG54.y) > 0.01) {
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
  let correctedG54 = { x: r3(currentG54.x + offset.x), y: r3(currentG54.y + offset.y) };
  if (plan.mount === 'bracket' && plan.bracketOrigin) {
    correctedG54 = { x: r3(plan.bracketOrigin.x), y: r3(plan.bracketOrigin.y) };
    offset = { x: r3(correctedG54.x - currentG54.x), y: r3(correctedG54.y - currentG54.y) };
    notes.push(`X and Y from the bracket: ${plan.bracketOrigin.from}`);
  }

  const usable = problems.length === 0;
  const withinMargin =
    usable &&
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
    withinMargin,
    margin: s.edgeMarginMm,
    surfaceZ: data.surface.z,
    probeRefZ: data.probeRefZ,
    currentG54,
    correctedG54,
    usable,
    problems,
    notes,
  };
}

/** Z0 for the cutter: the surface + (cutter PRB − reference PRB) — #387. */
export function cutterZ0(outcome: Pick<RegistrationOutcome, 'surfaceZ' | 'probeRefZ'>, cutterRefZ: number): number {
  return r3(outcome.surfaceZ + (cutterRefZ - outcome.probeRefZ));
}

export function correctionLine(outcome: RegistrationOutcome, cutterRefZ: number): string {
  const f = (n: number) => r3(n).toFixed(3);
  return `G10 L2 P1 X${f(outcome.correctedG54.x)} Y${f(outcome.correctedG54.y)} Z${f(cutterZ0(outcome, cutterRefZ))}`;
}
