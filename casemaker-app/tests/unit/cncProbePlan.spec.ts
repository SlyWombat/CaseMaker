// The probe planner (#188, decision 26). NO WASM: the outline is handed in as polygons where a
// real rounded corner is needed, and as kernel-free profiles elsewhere.
//
// The acceptance this has to hold up: the nest, the clamps and the chuck each fall out of the
// SAME call with no per-case branching in the caller, a covered edge refuses by NAME rather
// than returning a touch point inside the fixture, and the badge case reports its ±0.15 mm.

import { describe, it, expect } from 'vitest';
import {
  planProbing,
  profilePolygons,
  PROBE_RESIDUAL_MM,
  CHUCK_AXIS_RESIDUAL_MM,
  type ProbePart,
  type ProbeResult,
} from '@/engine/cnc/probePlan';
import {
  circleProfile,
  pMirrorX,
  pRotate,
  pTranslate,
  rectProfile,
  roundedRect,
} from '@/engine/compiler/profile';
import type { Polygons } from '@/engine/cnc/cam/pocket';
import type { Workholding } from '@/engine/cnc/setup';
import type { Vec2 } from '@/types/units';

/** The badge's outline: 38.1 × 25.4 with the R3.175 corners `make_badge.py` draws. */
function roundedRectPolygon(w: number, h: number, r: number, seg = 16): Polygons {
  const boxes: [number, number, number][] = [
    [r, r, 180], // bottom-left, 180° → 270°
    [w - r, r, 270], // bottom-right, 270° → 360°
    [w - r, h - r, 0], // top-right, 0° → 90°
    [r, h - r, 90], // top-left, 90° → 180°
  ];
  const pts: Vec2[] = [];
  for (const [cx, cy, start] of boxes) {
    for (let i = 0; i <= seg; i++) {
      const a = ((start + (90 * i) / seg) * Math.PI) / 180;
      const p: Vec2 = [cx + r * Math.cos(a), cy + r * Math.sin(a)];
      const prev = pts[pts.length - 1];
      if (!prev || Math.hypot(p[0] - prev[0], p[1] - prev[1]) > 1e-9) pts.push(p);
    }
  }
  return [pts];
}

const BADGE: ProbePart = { outline: roundedRectPolygon(38.1, 25.4, 3.175) };
const PLATE: ProbePart = { outline: rectProfile(60, 30) };

function plan(part: ProbePart, hold: Workholding, toleranceMm: number): ProbeResult {
  return planProbing(part, hold, { tipDiameter: 3, toleranceMm });
}

/** Every touch sits a ball radius in from the edge's ends — never on a corner. */
function expectClearOfCorners(r: ProbeResult, tipR = 1.5): void {
  if ('refuse' in r) throw new Error('refused');
  for (const t of r.touches) {
    const d0 = Math.hypot(t.at[0] - t.edge[0][0], t.at[1] - t.edge[0][1]);
    const d1 = Math.hypot(t.at[0] - t.edge[1][0], t.at[1] - t.edge[1][1]);
    expect(Math.min(d0, d1), `touch ${t.at} on ${t.edgeLength.toFixed(1)} mm edge`).toBeGreaterThanOrEqual(tipR - 1e-6);
  }
}

describe('planProbing (#188)', () => {
  it('leaves the badge in its nest on Z alone, reporting the ±0.15 mm seat clearance', () => {
    // The nest holds the part to its pocket clearance and locates nothing to precision, so when
    // the job tolerates that slop the whole plan is the Z probe (§7.3).
    const r = plan(BADGE, { kind: 'printed-nest', nest: 'badge-blank', seatClearance: 0.15 }, 0.15);
    expect('refuse' in r).toBe(false);
    if ('refuse' in r) return;
    expect(r.touches).toEqual([]);
    expect(r.probeZ).toBe(true);
    expect(r.residual).toBeCloseTo(0.15, 12);
    expect(r.datums).toEqual([]);
    expect(r.notes.join(' ')).toMatch(/already held within/);
  });

  it('refuses a plate whose every edge is under a clamp, naming the clamp', () => {
    // Four clamps, one per side, each OVERHANGING the 60 × 30 plate — the way a real clamp
    // reaches past the edge to hold it. Nothing fixes XY, so every axis needs a touch and every
    // candidate edge's touch points land inside a footprint.
    const hold: Workholding = {
      kind: 'top-clamps',
      clamps: [
        { at: [30, 0], footprint: pTranslate([0, -4], rectProfile(60, 8)) },
        { at: [30, 28], footprint: pTranslate([0, 24], rectProfile(60, 8)) },
        { at: [0, 15], footprint: pTranslate([-4, 0], rectProfile(8, 30)) },
        { at: [60, 15], footprint: pTranslate([56, 0], rectProfile(8, 30)) },
      ],
    };
    const r = plan(PLATE, hold, 0.05);
    expect('refuse' in r).toBe(true);
    if (!('refuse' in r)) throw new Error('expected a refusal');
    expect(r.code).toBe('no-reachable-edge');
    expect(r.obstruction).toMatch(/^clamp \d/);
    expect(r.message).toMatch(/clamp \d.*in the way/);
  });

  it('plans around a clamp instead of refusing when another edge is free', () => {
    // One clamp over the top edge only; the bottom edge and both ends are clear.
    const hold: Workholding = {
      kind: 'top-clamps',
      clamps: [{ at: [30, 28], footprint: pTranslate([0, 24], rectProfile(60, 8)) }],
    };
    const r = plan(PLATE, hold, 0.05);
    expect('refuse' in r).toBe(false);
    if ('refuse' in r) return;
    expect(r.touches.length).toBe(3); // a pair for position + rotation, then the closing axis
    // No touch point may sit under the clamp (which covers y ∈ [24, 32]).
    for (const t of r.touches) expect(t.at[1]).toBeLessThan(24.9);
    expectClearOfCorners(r);
  });

  it('gives a cylinder in the chuck an axis datum and a Z probe, and probes no rotation', () => {
    const r = plan(
      { outline: circleProfile(15), axisymmetric: true },
      { kind: 'rotary-chuck', jawDiameter: 80, stickout: 10 },
      0.05,
    );
    expect('refuse' in r).toBe(false);
    if ('refuse' in r) return;
    expect(r.touches).toEqual([]);
    expect(r.probeZ).toBe(true);
    expect(r.residual).toBeCloseTo(CHUCK_AXIS_RESIDUAL_MM, 12);
    expect(r.rotationResidual).toBe(0);
    expect(r.datums[0]!.fixes).toEqual(['x', 'y']);
  });

  it('refuses a bare cylinder under tape: a circle has no straight edge to touch', () => {
    const r = plan({ outline: circleProfile(15), axisymmetric: true }, { kind: 'tape-down', contact: circleProfile(15) }, 0.05);
    expect('refuse' in r).toBe(true);
    if (!('refuse' in r)) throw new Error('expected a refusal');
    expect(r.code).toBe('no-reachable-edge');
    expect(r.obstruction).toBeUndefined(); // nothing was in the way; the outline has no edge
  });

  it('probes a taped plate on both axes and rotation, and flags that .nc cannot compensate', () => {
    const r = plan(PLATE, { kind: 'tape-down', contact: rectProfile(60, 30) }, 0.05);
    expect('refuse' in r).toBe(false);
    if ('refuse' in r) return;
    expect(r.touches.length).toBe(3);
    const pair = r.touches.filter((t) => t.fixes.includes('rotation'));
    expect(pair.length).toBe(2);
    // The pair shares ONE edge — that is what makes rotation fall out of two touches.
    expect(pair[0]!.edge).toEqual(pair[1]!.edge);
    const closing = r.touches.find((t) => !t.fixes.includes('rotation'))!;
    expect(closing.reads).not.toBe(pair[0]!.reads);
    expect(r.residual).toBeCloseTo(PROBE_RESIDUAL_MM, 12);
    expect(r.rotationResidual).toBeGreaterThan(0);
    expect(r.notes.join(' ')).toMatch(/static \.nc cannot compensate/);
    expectClearOfCorners(r);
  });

  it('touches only Y in the vise, because the fixed jaw already holds X and rotation', () => {
    // The jaw faces carry inward normals; the part is gripped across X at 0 and 38.1.
    const hold: Workholding = {
      kind: 'vise',
      jawFaces: [
        { origin: [0, 0, 0], normal: [1, 0, 0] },
        { origin: [38.1, 0, 0], normal: [-1, 0, 0] },
      ],
      jawHeight: 10,
    };
    const r = plan(BADGE, hold, 0.05);
    expect('refuse' in r).toBe(false);
    if ('refuse' in r) return;
    expect(r.touches.length).toBe(1);
    expect(r.touches[0]!.reads).toBe('y');
    expect(r.touches[0]!.fixes).toEqual(['y']);
    expect(r.rotationResidual).toBe(0);
    expect(r.notes.join(' ')).toMatch(/rotation is fixed mechanically/);
  });

  it('needs no touch at all on the anchor bracket, whose datum already covers XY and rotation', () => {
    const r = plan(BADGE, { kind: 'anchor-bracket', anchor: 1, offset: [0, 0] }, 0.05);
    expect('refuse' in r).toBe(false);
    if ('refuse' in r) return;
    expect(r.touches).toEqual([]);
    expect(r.datums[0]!.fixes).toEqual(['x', 'y', 'rotation']);
  });

  it('reads the straight sides of a rounded outline without a corner special case', () => {
    // The badge's R3.175 corners must not stop the planner finding the 38.1 mm side — but they
    // do SHORTEN it, because the straight part of that side is only 38.1 − 2r ≈ 31.75 mm. That
    // is the "a radiused corner is a poor datum" consequence, falling out of the query.
    const r = plan(BADGE, { kind: 'tape-down', contact: rectProfile(38.1, 25.4) }, 0.05);
    expect('refuse' in r).toBe(false);
    if ('refuse' in r) return;
    expect(r.touches.length).toBe(3);
    const longest = Math.max(...r.touches.map((t) => t.edgeLength));
    expect(longest).toBeGreaterThan(31);
    expect(longest).toBeLessThan(33.5); // the tangential ends are swallowed, not invented
    expectClearOfCorners(r);
  });
});

describe('profilePolygons (the kernel-free subset)', () => {
  it('recovers a rect, a circle, and a translated / rotated / mirrored child', () => {
    expect(profilePolygons(rectProfile(4, 2))).toEqual([[[0, 0], [4, 0], [4, 2], [0, 2]]]);
    expect(profilePolygons(rectProfile(4, 2, true))![0]![0]).toEqual([-2, -1]);
    expect(profilePolygons(circleProfile(5, 8))![0]!).toHaveLength(8);
    expect(profilePolygons(pTranslate([1, 2], rectProfile(2, 2)))![0]![0]).toEqual([1, 2]);
    // pRotate is counter-clockwise: (2, 0) at 90° → (0, 2).
    expect(profilePolygons(pRotate(90, rectProfile(2, 2)))![0]![1]![0]).toBeCloseTo(0, 9);
    expect(profilePolygons(pRotate(90, rectProfile(2, 2)))![0]![1]![1]).toBeCloseTo(2, 9);
    // pMirrorX reflects across x = 0: (2, 0) → (−2, 0).
    expect(profilePolygons(pMirrorX(rectProfile(2, 2)))![0]![1]).toEqual([-2, 0]);
  });

  it('returns null for a rounded rect, so the badge outline comes from the worker', () => {
    // roundedRect is pOffset(pOffset(rect)) — two Clipper2 nodes this module does not carry.
    expect(profilePolygons(roundedRect(38.1, 25.4, 3.175))).toBeNull();
    const r = planProbing(
      { outline: roundedRect(38.1, 25.4, 3.175) },
      { kind: 'tape-down', contact: rectProfile(1, 1) },
      { tipDiameter: 3 },
    );
    expect('refuse' in r && r.code).toBe('no-outline');
  });
});
