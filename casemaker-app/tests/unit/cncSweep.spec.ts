// The exact 2.5D sweep (#182 step 5). Every geometric assertion here is against a CLOSED
// FORM, never against another run of the same code, and the capsule gate runs FIRST: the
// first benchmark of this design was taken on a capsule whose rectangle was wound the wrong
// way and had silently collapsed to half a disc (#187). A test that compared the sweep with
// itself would have passed on that.

import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tl } from './helpers/manifoldExec';
import {
  capsuleArea,
  capsuleContours,
  checkpointRegion,
  circlePolygon,
  sweepTimeline,
  stockFromSetup,
  unionCapsules,
  SWEEP_TOLERANCES,
  type SweepOpts,
} from '@/workers/geometry/sweep';
import { buildTimeline, parseGcode, stubSetup, type Setup } from '@/engine/cnc';
import { flatEndMill, toolFromMkrRecord, cuttingRadiusForSweep, shapeFromType } from '@/engine/cnc/tool';
import { parseMkrRecord } from '@/engine/cnc/gcode/mkrHeader';
import { segmentsForRadius } from '@/engine/compiler/arcResolution';
import { roundedRect } from '@/engine/compiler/profile';

type Poly = [number, number][];
const area = (polys: Poly[]) => {
  const cs = tl.CrossSection.ofPolygons(polys, 'Positive');
  const a = cs.area();
  cs.delete();
  return a;
};
const signedArea = (p: Poly) => {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const [x0, y0] = p[i]!;
    const [x1, y1] = p[(i + 1) % p.length]!;
    s += x0 * y1 - x1 * y0;
  }
  return s / 2;
};

// A 100 x 60 x 5 slab, work origin on its top-front-left corner: work z in [-5, 0].
const SLAB = { kind: 'prism' as const, outline: { kind: 'p-rect' as const, size: [100, 60] as [number, number] }, thickness: 5 };
const HOLD = { kind: 'tape-down' as const, contact: SLAB.outline };
const setup = (o: Partial<Setup> = {}) => stubSetup(SLAB, HOLD, o);
const R = 0.5; // a 1 mm flat end mill
const N = segmentsForRadius(R);
const tool = flatEndMill(2 * R);

/** Three strokes at three depths: three checkpoints, one per run of cuts at one (segment, Z). */
const THREE = [
  'S1000 M3',
  'G0 X10 Y10 Z1', 'G1 Z-0.5 F100', 'G1 X30',
  'G0 Z1', 'G0 X10 Y30', 'G1 Z-1.0', 'G1 X30',
  'G0 Z1', 'G0 X10 Y50', 'G1 Z-1.5', 'G1 X30',
].join('\n');

/** Run a program against the slab and return the volume removed plus the outcome. */
function sweep(src: string, t = tool, s = setup(), opts?: SweepOpts) {
  const timeline = buildTimeline(parseGcode(src), s);
  const out = sweepTimeline(tl, timeline, t, s, opts);
  return { out, timeline };
}

beforeAll(() => {
  expect(N).toBeGreaterThanOrEqual(8);
});

describe('GATE: one capsule against its closed form, before anything is built on it', () => {
  it('a 10 mm capsule at r = 0.5 has area 2rL + (n/2) r^2 sin(2π/n)', () => {
    const polys: Poly[] = [];
    capsuleContours(0, 0, 10, 0, R, N, polys);
    expect(polys).toHaveLength(3);
    expect(area(polys)).toBeCloseTo(capsuleArea(10, R, N), 6);
  });

  it('every contour is COUNTER-CLOCKWISE, including the rectangle', () => {
    const polys: Poly[] = [];
    capsuleContours(3, 4, -7, 11, R, N, polys);
    for (const p of polys) expect(signedArea(p)).toBeGreaterThan(0);
  });

  it('REGRESSION (#187): a clockwise rectangle would cancel the discs and leave half a disc', () => {
    // The trap, pinned: reverse the rectangle and the area collapses. If Clipper2's fill rule
    // ever changed so this stopped being true, the gate above would still hold and this one
    // would tell us the premise moved.
    const polys: Poly[] = [];
    capsuleContours(0, 0, 10, 0, R, N, polys);
    const rect = polys[2]!;
    const cw: Poly[] = [polys[0]!, polys[1]!, [...rect].reverse() as Poly];
    const got = area(cw);
    expect(got).toBeLessThan(capsuleArea(10, R, N) * 0.5);
  });

  it('a zero-length move is the disc alone', () => {
    const polys: Poly[] = [];
    capsuleContours(5, 5, 5, 5, R, N, polys);
    expect(polys).toHaveLength(1);
    expect(area(polys)).toBeCloseTo((N / 2) * R * R * Math.sin((2 * Math.PI) / N), 6);
  });

  it('the capsule is independent of direction and translation', () => {
    const a: Poly[] = [];
    const b: Poly[] = [];
    capsuleContours(0, 0, 10, 0, R, N, a);
    capsuleContours(110, -40, 100, -40, R, N, b);
    expect(area(a)).toBeCloseTo(area(b), 9);
  });

  it('circlePolygon has the circle\'s exact bounding box (n is a multiple of 4)', () => {
    const p = circlePolygon(0, 0, 2, N);
    expect(Math.max(...p.map((q) => q[0]))).toBeCloseTo(2, 12);
    expect(Math.min(...p.map((q) => q[1]))).toBeCloseTo(-2, 12);
  });
});

describe('unionCapsules: the chunked tree is a restructuring, not an approximation', () => {
  it('two disjoint capsules add; two coincident ones do not double-count', () => {
    const disjoint: Poly[] = [];
    capsuleContours(0, 0, 10, 0, R, N, disjoint);
    capsuleContours(0, 20, 10, 20, R, N, disjoint);
    const u1 = unionCapsules(tl, disjoint)!;
    expect(u1.area()).toBeCloseTo(2 * capsuleArea(10, R, N), 2);
    u1.delete();
    const same: Poly[] = [];
    capsuleContours(0, 0, 10, 0, R, N, same);
    capsuleContours(0, 0, 10, 0, R, N, same);
    const u2 = unionCapsules(tl, same)!;
    expect(u2.area()).toBeCloseTo(capsuleArea(10, R, N), 2);
    u2.delete();
  });

  it('the tree gives the same area as one flat union, across several chunk boundaries', () => {
    // 300 capsules: 5 chunks, two tree levels. A raster that actually covers area.
    const polys: Poly[] = [];
    for (let i = 0; i < 300; i++) capsuleContours(0, i * 0.3, 30, i * 0.3, R, N, polys);
    const tree = unionCapsules(tl, polys)!;
    const flat = tl.CrossSection.ofPolygons(polys, 'Positive');
    expect(tree.area()).toBeCloseTo(flat.area(), 1);
    // And the closed form of that shape: a 30 x (299 x 0.3) rectangle with capsule ends.
    const h = 299 * 0.3;
    expect(flat.area()).toBeGreaterThan(30 * h);
    expect(flat.area()).toBeLessThan((30 + 2 * R) * (h + 2 * R));
    tree.delete();
    flat.delete();
  });

  it('returns null for no contours', () => {
    expect(unionCapsules(tl, [])).toBeNull();
  });
});

describe('stock from the setup', () => {
  it('a prism stock sits in WORK coordinates with its top at Z = 0 for a stub registered on the face', () => {
    const st = stockFromSetup(tl, setup());
    if ('severity' in st) throw new Error(st.message);
    expect(st.topZ).toBeCloseTo(0, 9);
    const bb = st.stock.boundingBox();
    expect(bb.min[2]).toBeCloseTo(-5, 9);
    expect(st.stock.volume()).toBeCloseTo(100 * 60 * 5, 6);
    st.stock.delete();
  });

  it('follows the placement: a rotated, offset part lands where the frames say', () => {
    const s = setup({ placement: { origin: [10, 20, 0], rotationZ: 90, source: 'stub' } });
    s.wcs = { ...s.wcs, origin: [10, 20, 5] };
    const st = stockFromSetup(tl, s);
    if ('severity' in st) throw new Error(st.message);
    const bb = st.stock.boundingBox();
    // Rz(90) maps x in [0,100] to y in [0,100] and y in [0,60] to x in [-60,0]; the WCS is at the corner.
    expect(bb.min[0]).toBeCloseTo(-60, 6);
    expect(bb.max[0]).toBeCloseTo(0, 6);
    expect(bb.max[1]).toBeCloseTo(100, 6);
    st.stock.delete();
  });

  it('the badge: rounded-rect outline, volume within 0.1 % of the closed form', () => {
    const badge = { kind: 'prism' as const, outline: roundedRect(76.2, 38.1, 3.175), thickness: 3.81 };
    const st = stockFromSetup(tl, stubSetup(badge, HOLD));
    if ('severity' in st) throw new Error(st.message);
    const exact = (76.2 * 38.1 - (4 - Math.PI) * 3.175 * 3.175) * 3.81;
    expect(Math.abs(st.stock.volume() - exact) / exact).toBeLessThan(0.001);
    st.stock.delete();
  });

  it('refuses a non-prism stock in V1', () => {
    const st = stockFromSetup(tl, stubSetup({ kind: 'cylinder', diameter: 30, length: 50 }, { kind: 'rotary-chuck', jawDiameter: 80, stickout: 10 }));
    expect('severity' in st && st.code).toBe('stock-unsupported');
  });
});

describe('sweeping a program against the slab: closed-form volumes', () => {
  it('one straight stroke at depth d removes capsuleArea x d', () => {
    const { out } = sweep('S1000 M3\nG0 X20 Y30 Z1\nG1 Z-0.6 F100\nG1 X40\n');
    if (!out.ok) throw new Error(JSON.stringify(out.diagnostics));
    // The plunge and the stroke share the checkpoint at z = -0.6; the stroke's capsule
    // contains the plunge's disc, so the region is one capsule of length 20.
    const want = capsuleArea(20, R, N) * 0.6;
    const got = out.value.stats.removedVolume;
    expect(Math.abs(got - want) / want).toBeLessThan(0.005);
    expect(out.value.stats.checkpointsSwept).toBe(1);
    expect(out.value.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    out.value.stock.delete();
    out.value.result.delete();
  });

  it('a plunge alone removes a disc x d', () => {
    const { out } = sweep('S1000 M3\nG0 X50 Y30 Z1\nG1 Z-1.5 F100\n');
    if (!out.ok) throw new Error(JSON.stringify(out.diagnostics));
    const want = (N / 2) * R * R * Math.sin((2 * Math.PI) / N) * 1.5;
    expect(Math.abs(out.value.stats.removedVolume - want) / want).toBeLessThan(0.005);
  });

  it('a stroke entirely outside the stock footprint removes nothing', () => {
    const { out } = sweep('S1000 M3\nG0 X200 Y200 Z1\nG1 Z-1 F100\nG1 X220\n');
    if (!out.ok) throw new Error(JSON.stringify(out.diagnostics));
    expect(out.value.stats.removedVolume).toBeCloseTo(0, 6);
    expect(out.value.stats.resultVolume).toBeCloseTo(out.value.stats.stockVolume, 6);
  });

  it('a cutting move ABOVE the stock top is skipped: the rotary files feed in air at Z = +30', () => {
    const { out } = sweep('S1000 M3\nG0 X10 Y10 Z30\nG1 X50 F100\n');
    if (!out.ok) throw new Error(JSON.stringify(out.diagnostics));
    expect(out.value.stats.checkpointsSkipped).toBe(1);
    expect(out.value.stats.removedVolume).toBeCloseTo(0, 6);
  });

  it('THE LOWEST-Z RULE: a ramp is swept at its lowest Z along its whole length, and says so', () => {
    // From Z 0 to Z -1 over 20 mm. The machine removes a wedge; the sweep removes the full
    // 1 mm column (over-removal, by design: /Simulation.md §3.2). The oracle's over-cut check
    // has to tolerate this.
    const { out } = sweep('S1000 M3\nG0 X20 Y30 Z0\nG1 X40 Z-1 F100\n');
    if (!out.ok) throw new Error(JSON.stringify(out.diagnostics));
    const want = capsuleArea(20, R, N) * 1;
    expect(Math.abs(out.value.stats.removedVolume - want) / want).toBeLessThan(0.005);
    expect(out.value.diagnostics.map((d) => d.code)).toContain('ramp-over-removed');
  });

  it('two checkpoints at the SAME depth either side of a tool change are two solids and do not double-count', () => {
    const { out, timeline } = sweep(
      'S1000 M3\nG0 X20 Y30 Z1\nG1 Z-1 F100\nG1 X40\nT2M6\nS1000 M3\nG0 X20 Y30 Z1\nG1 Z-1 F100\nG1 X40\n',
      tool,
      setup({ startingTool: 1 }),
    );
    if (!out.ok) throw new Error(JSON.stringify(out.diagnostics));
    expect(timeline.checkpoints).toHaveLength(2);
    expect(out.value.perCheckpoint.filter(Boolean)).toHaveLength(2);
    const want = capsuleArea(20, R, N) * 1; // the same region twice, removed once
    expect(Math.abs(out.value.stats.removedVolume - want) / want).toBeLessThan(0.005);
  });

  it('deeper and shallower passes nest: the union is the deeper column plus the shallower ring', () => {
    // A 20 mm stroke at -0.5 then a 10 mm stroke at -1.0 inside it.
    const { out } = sweep('S1000 M3\nG0 X20 Y30 Z1\nG1 Z-0.5 F100\nG1 X40\nG0 Z1\nG0 X25\nG1 Z-1.0\nG1 X35\n');
    if (!out.ok) throw new Error(JSON.stringify(out.diagnostics));
    const want = capsuleArea(20, R, N) * 0.5 + capsuleArea(10, R, N) * 0.5;
    expect(Math.abs(out.value.stats.removedVolume - want) / want).toBeLessThan(0.005);
    expect(out.value.stats.checkpointsSwept).toBe(2);
  });

  it('stock − removal is the result: volumes are consistent and the removal is a solid', () => {
    const { out } = sweep('S1000 M3\nG0 X20 Y30 Z1\nG1 Z-0.6 F100\nG1 X40\n');
    if (!out.ok) throw new Error(JSON.stringify(out.diagnostics));
    const v = out.value;
    expect(v.removal).not.toBeNull();
    // The removal solid OVERSHOOTS the stock top by OVERSHOOT_MM on purpose (no coplanar
    // faces in the subtraction), so its own volume is larger than what it removed by exactly
    // capsuleArea x 0.01. The identity that holds is against the part of it inside the stock.
    const inside = v.removal!.intersect(v.stock);
    expect(v.stats.stockVolume - inside.volume()).toBeCloseTo(v.stats.resultVolume, 4);
    expect(v.removal!.volume() - inside.volume()).toBeCloseTo(capsuleArea(20, R, N) * 0.01, 3);
    inside.delete();
    expect(v.result.numTri()).toBeGreaterThan(12);
  });

  it('an empty program sweeps nothing and says so', () => {
    const { out } = sweep('G0 X1 Y1 Z1\n');
    if (!out.ok) throw new Error(JSON.stringify(out.diagnostics));
    expect(out.value.removal).toBeNull();
    expect(out.value.diagnostics.map((d) => d.code)).toContain('nothing-to-sweep');
  });

  it('gaps in the picture are reported, not hidden', () => {
    const { out } = sweep('S1000 M3\nG1 X5 F100\n'); // Z never established
    if (!out.ok) throw new Error(JSON.stringify(out.diagnostics));
    expect(out.value.diagnostics.map((d) => d.code)).toContain('gaps');
  });
});

describe('the must-FAIL list (§7.1): refusals and the gates that need the stock', () => {
  it('a laser job is REFUSED, not drawn as a cut', () => {
    const { out } = sweep('M321\nG0 X20 Y30 Z0\nG1 X40 S0.5 F100\nM322\n');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.diagnostics[0]?.code).toBe('laser-job');
  });

  it('a rotary job is REFUSED in V1', () => {
    const { out } = sweep('S1000 M3\nG0 X20 Y30 Z0\nG1 X40 A90 F100\n');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.diagnostics[0]?.code).toBe('rotary-job');
  });

  it('HOLDER: a cut deeper than the shoulder length is an error naming the tool', () => {
    const t = flatEndMill(1, { shoulderLength: 2, fluteLength: 3 });
    const { out } = sweep('S1000 M3\nG0 X20 Y30 Z1\nG1 Z-2.5 F100\nG1 X40\n', t);
    if (!out.ok) throw new Error(JSON.stringify(out.diagnostics));
    const d = out.value.diagnostics.find((x) => x.code === 'holder-collision');
    expect(d?.severity).toBe('error');
    expect(d?.message).toMatch(/shoulder length of 2/);
  });

  it('HOLDER: shoulderLength governs; fluteLength is only the fallback', () => {
    expect(sweep('S1000 M3\nG0 X20 Y30 Z1\nG1 Z-2.5 F100\nG1 X40\n', flatEndMill(1, { shoulderLength: null, fluteLength: 3 })).out.ok && true).toBe(true);
    const { out } = sweep('S1000 M3\nG0 X20 Y30 Z1\nG1 Z-2.5 F100\nG1 X40\n', flatEndMill(1, { shoulderLength: null, fluteLength: 3 }));
    if (!out.ok) throw new Error('refused');
    expect(out.value.diagnostics.map((d) => d.code)).not.toContain('holder-collision');
  });

  it('HOLDER: with neither length stated the verdict is "cannot be proven", a warning, never a silent pass', () => {
    // Makera's catalogue leaves shoulderLength empty for every engraver and chamfer. This is
    // the "cannot be proven" row of the verification mockup.
    const { out } = sweep('S1000 M3\nG0 X20 Y30 Z1\nG1 Z-0.6 F100\nG1 X40\n');
    if (!out.ok) throw new Error('refused');
    const d = out.value.diagnostics.find((x) => x.code === 'holder-unproven');
    expect(d?.severity).toBe('warning');
  });

  it('a RAPID through the stock is an error; a rapid above it is nothing', () => {
    const bad = sweep('G0 X20 Y30 Z1\nG0 Z-1\nG0 X40\n');
    if (!bad.out.ok) throw new Error('refused');
    const msgs = bad.out.value.diagnostics.filter((d) => d.code === 'rapid-through-stock').map((d) => d.message);
    expect(msgs).toHaveLength(2);
    // Each rapid is also RETURNED as a solid the viewport can draw (code review #4 q1): its
    // volume is the one the diagnostic reports, and nothing was subtracted from the stock.
    const { gouges, stats } = bad.out.value;
    expect(gouges).toHaveLength(2);
    expect(gouges.map((g) => g.line)).toEqual([2, 3]);
    gouges.forEach((g, i) => {
      const reported = Number(/\(([\d.]+) mm³\)/.exec(msgs[i] as string)?.[1]);
      expect(g.solid.volume()).toBeCloseTo(reported, 2);
      expect(g.solid.volume()).toBeGreaterThan(0);
    });
    expect(stats.removedVolume).toBe(0);
    gouges.forEach((g) => g.solid.delete());
    const fine = sweep('G0 X20 Y30 Z5\nG0 X40\nG0 Z1\n');
    if (!fine.out.ok) throw new Error('refused');
    expect(fine.out.value.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(fine.out.value.stats.airMovesChecked).toBe(2);
  });

  it('a gouge AFTER a cut keeps only the material still there: the solid outlives the removal it was subtracted from', () => {
    // The slot is cut first, then a rapid at Z -0.5 runs across it along Y. Its overlap with the
    // UNCUT blank includes the slot; the gouge must not, and it is built from `hit.subtract(gone)`
    // where `gone` is deleted before the sweep returns (the branch the no-prior-cut tests skip).
    const { out } = sweep('S1000 M3\nG0 X20 Y30 Z1\nG1 Z-1 F100\nG1 X40\nG0 Z1\nG0 X30 Y25\nG0 Z-0.5\nG0 Y35\n');
    if (!out.ok) throw new Error('refused');
    const msgs = out.value.diagnostics.filter((d) => d.code === 'rapid-through-stock').map((d) => d.message);
    const { gouges } = out.value;
    expect(gouges).toHaveLength(msgs.length);
    expect(gouges.length).toBeGreaterThanOrEqual(2); // the plunge, and the run across
    const along = gouges[gouges.length - 1]!;
    const reported = Number(/\(([\d.]+) mm³\)/.exec(msgs[msgs.length - 1] as string)?.[1]);
    expect(along.solid.volume()).toBeCloseTo(reported, 2);
    // The footprint of the whole run (an 10 mm capsule) over 0.5 mm of depth, less the ~1 mm x 1 mm
    // of it that is already slot: nothing like the full overlap with the uncut blank.
    const full = capsuleArea(10, R, N) * 0.5;
    expect(along.solid.volume()).toBeLessThan(full - 0.3);
    expect(along.solid.volume()).toBeGreaterThan(full - 0.7);
    // The solid is still good after everything the sweep deleted: mesh it, then delete it once.
    const mesh = along.solid.getMesh();
    expect(mesh.triVerts.length).toBeGreaterThan(0);
    gouges.forEach((g) => g.solid.delete());
    expect(out.value.stats.removedVolume).toBeGreaterThan(0);
    expect(out.value.result.volume()).toBeGreaterThan(0);
  });

  it('REGRESSION (vendor file): a RETRACT from the end of a cut is NOT "through stock" — the tool is in the hole it just made', () => {
    // 169 of 169 errors on ACRYLIC-Balloon.nc were `G0 Z2` retracts starting 0.3 mm deep in
    // their own cut, measured against the UNCUT blank. Material means the stock at that step.
    // #194 step 7: the retract is now proved in air ANALYTICALLY — +Z from the exact end point
    // of the immediately preceding cut, same X,Y — so it never builds a tool body or runs a
    // boolean at all. It was the single most common air move in every vendor file.
    const { out } = sweep('S1000 M3\nG0 X20 Y30 Z1\nG1 Z-0.3 F100\nG1 X40\nG0 Z2\n');
    if (!out.ok) throw new Error('refused');
    expect(out.value.diagnostics.filter((d) => d.code === 'rapid-through-stock')).toEqual([]);
    expect(out.value.stats.airMovesClearedByConstruction).toBe(1);
    expect(out.value.stats.airMovesRechecked).toBe(0); // no uncut-blank boolean was needed
  });

  it('a retract from the end of an ARC leaves only numerical slivers, which are below the noise floor', () => {
    // Four of the five residual vendor errors ended on a G2 segment: the retract disc and the
    // simplified cut region disagree to the bit there. The floor is derived from the named
    // tolerances, not picked.
    const { out } = sweep('S1000 M3\nG0 X20 Y30 Z1\nG1 Z-0.3 F100\nG2 X30 Y40 I10 J0\nG0 Z2\n');
    if (!out.ok) throw new Error('refused');
    expect(out.value.diagnostics.filter((d) => d.code === 'rapid-through-stock')).toEqual([]);
  });

  it('…but a genuine shallow graze is still an order of magnitude above the floor and IS caught', () => {
    // A rapid 0.05 mm below the top over 20 mm: ~2 mm³ against a floor of ~0.2 mm³.
    const { out } = sweep('G0 X20 Y30 Z1\nG0 Z-0.05\nG0 X40\n');
    if (!out.ok) throw new Error('refused');
    expect(out.value.diagnostics.filter((d) => d.code === 'rapid-through-stock').length).toBeGreaterThanOrEqual(1);
  });

  it('ORDER MATTERS: a rapid down into a pocket cut EARLIER is routine; into one cut only LATER is a crash', () => {
    const pocket = 'S1000 M3\nG0 X20 Y30 Z1\nG1 Z-1 F100\nG1 X40\nG0 Z5\n';
    const earlier = sweep(pocket + 'G0 X30\nG0 Z-0.5\n');
    if (!earlier.out.ok) throw new Error('refused');
    expect(earlier.out.value.diagnostics.filter((d) => d.code === 'rapid-through-stock')).toEqual([]);
    const later = sweep('S1000 M3\nG0 X30 Y30 Z5\nG0 Z-0.5\nG0 Z5\nG0 X20\nG1 Z-1 F100\nG1 X40\n');
    if (!later.out.ok) throw new Error('refused');
    // TWO errors, and both are right: the plunge (line 3) enters uncut material, and the
    // retract (line 4) starts inside it — nothing was removed by a rapid, so it is still there.
    const lines = later.out.value.diagnostics.filter((d) => d.code === 'rapid-through-stock').map((d) => Number(/line (\d+)/.exec(d.message)?.[1]));
    expect(lines).toEqual([3, 4]);
  });

  it('a rapid BELOW the bed is an error', () => {
    const { out } = sweep('G0 X20 Y30 Z1\nG0 Z-6\n');
    if (!out.ok) throw new Error('refused');
    expect(out.value.diagnostics.map((d) => d.code)).toContain('rapid-below-bed');
  });

  it("THE RULE: a spindle-off feed move is nothing in air, an error near the material", () => {
    // 2 mm above the stock top: more than the 1 mm margin away. Nothing.
    const air = sweep('G0 X20 Y30 Z2\nG1 X40 F100\n');
    if (!air.out.ok) throw new Error('refused');
    expect(air.out.value.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    // 0.5 mm above the top: within the margin. Error.
    const near = sweep('G0 X20 Y30 Z0.5\nG1 X40 F100\n');
    if (!near.out.ok) throw new Error('refused');
    expect(near.out.value.diagnostics.map((d) => d.code)).toContain('spindle-off-near-stock');
    // Into the stock. Error, and it is NOT swept as a cut.
    const into = sweep('G0 X20 Y30 Z1\nG1 Z-0.5 F100\nG1 X40\n');
    if (!into.out.ok) throw new Error('refused');
    expect(into.out.value.diagnostics.map((d) => d.code)).toContain('spindle-off-near-stock');
    expect(into.out.value.stats.removedVolume).toBeCloseTo(0, 6);
  });

  it('THE RULE: a spindle-off feed move near the BED is an error', () => {
    // The slab's bottom is at -5; a feed at -4.5 is within 1 mm of it. (It is also inside the
    // stock; the bed check fires first and that is the one named.)
    const { out } = sweep('G0 X20 Y30 Z1\nG1 Z-4.5 F100\n');
    if (!out.ok) throw new Error('refused');
    expect(out.value.diagnostics.map((d) => d.code)).toContain('spindle-off-near-bed');
  });

  it('the fixture is NOT checked yet, and the sweep says so rather than staying quiet', () => {
    const vise: Setup = setup({ workholding: { kind: 'vise', jawFaces: [{ origin: [0, 0, 0], normal: [1, 0, 0] }, { origin: [1, 0, 0], normal: [-1, 0, 0] }], jawHeight: 8 } });
    const { out } = sweep('S1000 M3\nG0 X20 Y30 Z1\nG1 Z-0.6 F100\nG1 X40\n', tool, vise);
    if (!out.ok) throw new Error('refused');
    expect(out.value.diagnostics.map((d) => d.code)).toContain('fixture-unchecked');
  });

  it('A MIS-REGISTERED PLACEMENT PREDICTS THE SCRAP: half the stroke off the stock removes half a capsule', () => {
    // The stub is also a test fixture (/Simulation.md §1.1). Shift the part so its right edge
    // sits at work X = 30: a stroke from 20 to 40 is half on, half off.
    const s = setup({ placement: { origin: [-70, 0, 0], rotationZ: 0, source: 'stub' } });
    const { out } = sweep('S1000 M3\nG0 X20 Y30 Z1\nG1 Z-0.6 F100\nG1 X40\n', tool, s);
    if (!out.ok) throw new Error('refused');
    const halfCapsule = 2 * R * 10 + ((N / 2) * R * R * Math.sin((2 * Math.PI) / N)) / 2;
    const want = halfCapsule * 0.6;
    expect(Math.abs(out.value.stats.removedVolume - want) / want).toBeLessThan(0.01);
  });
});

describe('the air-move gate after code review #4: the tool body is swept EXACTLY, and the floor is honest', () => {
  const errs = (src: string) => {
    const { out } = sweep(src);
    if (!out.ok) throw new Error(JSON.stringify(out.diagnostics));
    return out.value.diagnostics.filter((d) => d.code === 'rapid-through-stock').map((d) => Number(/line (\d+)/.exec(d.message)?.[1]));
  };

  it('REGRESSION: a plunge from safe height to 0.3 mm deep IS a crash — the old floor scaled with the whole Z span and hid it', () => {
    // Volume π r² × 0.31 ≈ 0.24 mm³. The old floor: tolerance × perimeter × 5.3 mm ≈ 0.18 mm³
    // against the uncut blank; marginal at r = 0.5 and hidden outright for shallower plunges.
    expect(errs('G0 X20 Y30 Z5\nG0 Z-0.3\n')).toEqual([2]);
    expect(errs('G0 X20 Y30 Z5\nG0 Z-0.05\n')).toEqual([2]);
  });

  it('REGRESSION: a horizontal rapid along a slot it has already cut is NOT an error — the old check was a 1 µm sheet with a zero floor', () => {
    const slot = 'S1000 M3\nG0 X20 Y30 Z1\nG1 Z-1 F100\nG1 X40\nG0 Z5\nG0 X20\n';
    expect(errs(slot + 'G0 Z-1\nG0 X40\n')).toEqual([]);
    // ...and 0.2 mm BELOW the slot floor it is one, over the whole length.
    expect(errs(slot + 'G0 Z-1.2\nG0 X40\n')).toEqual([7, 8]);
  });

  it('REGRESSION: a DIAGONAL descent into a pocket is swept as the hull of the tool at both ends, not as a box at its final depth', () => {
    // Pocket at X 60..70, 1 mm deep. The rapid descends from (20, 30, 5) to (65, 30, -0.3): the
    // tool is below the top only over the last ~2.5 mm of travel, all of it inside the pocket.
    // The old box put the tool at -0.3 along ALL 45 mm — a false crash through solid stock.
    const pocket = 'S1000 M3\nG0 X60 Y30 Z1\nG1 Z-1 F100\nG1 X70\nG0 Z5\nG0 X20\n';
    expect(errs(pocket + 'G0 X65 Z-0.3\n')).toEqual([]);
    // Aim it 10 mm short of the pocket instead and the last stretch is through solid: error.
    expect(errs(pocket + 'G0 X50 Z-0.3\n')).toEqual([7]);
  });

  it('REGRESSION: a RAMP is credited only with what it has reached — a rapid into material the ramp left behind IS a crash', () => {
    // A ramp from Z 0 at X 20 to Z -1 at X 40. At X 22 it was ~0.1 mm deep; a rapid to -0.9 there
    // hits ~0.8 mm of material. The old prefix used the checkpoint's lowest Z along the whole
    // ramp and let this pass. At X 39 the ramp was ~0.95 mm deep: a rapid to -0.9 is clear.
    const ramp = 'S1000 M3\nG0 X20 Y30 Z0\nG1 X40 Z-1 F100\nG0 Z5\n';
    expect(errs(ramp + 'G0 X22\nG0 Z-0.9\n')).toEqual([6]);
    expect(errs(ramp + 'G0 X39\nG0 Z-0.9\n')).toEqual([]);
  });

  it('a vertical plunge inside a bucket is not a "ramp" and is not flagged as over-removed', () => {
    const { out } = sweep('S1000 M3\nG0 X20 Y30 Z0\nG1 Z-1 F100\nG1 X40\n');
    if (!out.ok) throw new Error('refused');
    expect(out.value.diagnostics.map((d) => d.code)).not.toContain('ramp-over-removed');
    expect(out.value.stats.removedVolume).toBeCloseTo(capsuleArea(20, R, N) * 1, 1);
  });

  it('a 3D / dense job is REFUSED by name with its count, before any geometry is built', () => {
    // 1 001 cuts, each at its own Z: 1 001 checkpoints. The vendor fatigue-test.nc has 685 200.
    const lines = ['S1000 M3', 'G0 X20 Y30 Z1'];
    for (let i = 0; i <= 1000; i++) lines.push(`G1 X${20 + (i % 2) * 10} Z${(-0.001 * (i + 1)).toFixed(3)} F100`);
    const { out, timeline } = sweep(lines.join('\n') + '\n');
    expect(timeline.checkpoints.length).toBeGreaterThan(1000);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.diagnostics[0]?.code).toBe('dense-3d-refused');
    expect(out.diagnostics[0]?.message).toContain(String(timeline.checkpoints.length));
  });
});

describe('tools: V1 sweeps a flat end mill and refuses everything else BY NAME', () => {
  it.each([
    ['Flat End', 'flat'], ['flat end mill', 'flat'], ['Ball Nose', 'ball'], ['ball end mill', 'ball'],
    ['Tapered Ball Nose', 'tapered-ball'], ['Engraving', 'engraving'], ['Chamfer', 'chamfer'],
    ['Drill', 'drill'], ['Thread', 'thread'], ['Bull Nose', 'bull'], ['', 'unknown'], ['Laser', 'unknown'],
  ])('%s -> %s', (text, shape) => {
    expect(shapeFromType(text)).toBe(shape);
  });

  it("reads Studio's own TOOL record", () => {
    const rec = parseMkrRecord(';@MKR|TOOL|number=1|id=112111313812|name=3.175*12mm Flat End(Metal)|type=Flat End|handlediameter=3.175|sticklength=0|shoulderlength=12|flutelength=12|diameter=3.175|tipdiameter=3.175|cornerradius=0|angle=0|halfAngle=0', 9)!;
    const t = toolFromMkrRecord(rec);
    expect(t).toMatchObject({ number: 1, shape: 'flat', tipDiameter: 3.175, shoulderLength: 12, fluteLength: 12, cornerRadius: 0 });
    expect(cuttingRadiusForSweep(t)).toEqual({ ok: true, radius: 3.175 / 2 });
  });

  it('refuses a V-bit rather than simulating it as a flat end', () => {
    const t = toolFromMkrRecord(parseMkrRecord(';@MKR|TOOL|number=3|name=3.175*0.1mm*30º Engraving|type=Engraving|diameter=3.175|tipdiameter=0.1|halfAngle=15', 1)!);
    const r = cuttingRadiusForSweep(t);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/Engraving/);
    const { out } = sweep('S1000 M3\nG0 X20 Y30 Z1\nG1 Z-0.6 F100\nG1 X40\n', t);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.diagnostics[0]?.code).toBe('tool-refused');
  });

  it('refuses a missing type, a corner radius (bull nose), and a missing diameter', () => {
    expect(cuttingRadiusForSweep(flatEndMill(1, { typeText: '', shape: 'unknown' })).ok).toBe(false);
    expect(cuttingRadiusForSweep(flatEndMill(1, { cornerRadius: 0.2 })).ok).toBe(false);
    expect(cuttingRadiusForSweep(flatEndMill(1, { tipDiameter: null, diameter: null })).ok).toBe(false);
  });
});

describe('the region a checkpoint removes is exposed for the oracle (§7)', () => {
  it('checkpointRegion of one stroke is one capsule', () => {
    const timeline = buildTimeline(parseGcode('S1000 M3\nG0 X20 Y30 Z1\nG1 Z-0.6 F100\nG1 X40\n'), setup());
    const { region, contours } = checkpointRegion(tl, timeline.checkpoints[0]!, R);
    expect(contours).toBe(1 + 3); // the plunge's disc + the stroke's three contours
    expect(region!.area()).toBeCloseTo(capsuleArea(20, R, N), 3);
    region!.delete();
  });

  it('the tolerances a band is derived from are named, not guessed', () => {
    expect(SWEEP_TOLERANCES.chord).toBe(0.005);
    expect(SWEEP_TOLERANCES.simplify).toBe(0.002);
    expect(SWEEP_TOLERANCES.simplifyLevels(64)).toBe(1);
    expect(SWEEP_TOLERANCES.simplifyLevels(64 * 8)).toBe(2);
    expect(SWEEP_TOLERANCES.simplifyLevels(64 * 64)).toBe(3);
  });
});

describe('performance smoke: the measured budget holds', () => {
  it('a 1000-move raster over 60 x 20 at three depths sweeps in well under the budget', () => {
    const lines = ['S1000 M3'];
    for (const z of [-0.4, -0.9, -1.2]) {
      lines.push(`G0 X8 Y8 Z1`, `G1 Z${z} F100`);
      let flip = false;
      for (let y = 8; y <= 28; y += 0.63) {
        lines.push(flip ? 'G1 X8' : 'G1 X68');
        lines.push(`G1 Y${(y + 0.63).toFixed(2)}`);
        flip = !flip;
      }
    }
    const { out, timeline } = sweep(lines.join('\n'));
    if (!out.ok) throw new Error(JSON.stringify(out.diagnostics));
    expect(timeline.summary.cuttingMoves).toBeGreaterThan(190);
    expect(out.value.stats.checkpointsSwept).toBe(3);
    expect(out.value.stats.removedVolume).toBeGreaterThan(60 * 20 * 0.4);
    expect(out.value.stats.ms.total).toBeLessThan(15_000);
  });
});

// ---------------------------------------------------------------------------------------
// #194: the recheck is LOCAL. Every test above exercises the air gate's ANSWERS, and they are
// unchanged; these exercise its COST, which is what the issue was about — the old design
// subtracted one global running union rebuilt on every recheck, so a question about a few
// cubic millimetres forced the whole program's removal to be evaluated.
// ---------------------------------------------------------------------------------------
describe('#194: a recheck consults only the removal its own move can meet', () => {
  const errs = (src: string) => {
    const { out } = sweep(src);
    if (!out.ok) throw new Error(JSON.stringify(out.diagnostics));
    return out.value.diagnostics.filter((d) => d.code === 'rapid-through-stock').map((d) => Number(/line (\d+)/.exec(d.message)?.[1]));
  };

  it('40 well-separated pockets with a retract after each: every retract cleared by construction, and cheap', () => {
    const lines = ['S1000 M3'];
    for (let i = 0; i < 40; i++) {
      const x = 5 + (i % 8) * 11;
      const y = 5 + Math.floor(i / 8) * 13;
      lines.push(`G0 X${x} Y${y} Z1`, `G1 Z-0.5 F100`, `G1 X${x + 6}`, 'G0 Z1');
    }
    const { out } = sweep(lines.join('\n') + '\n');
    if (!out.ok) throw new Error(JSON.stringify(out.diagnostics));
    expect(out.value.diagnostics.filter((d) => d.code === 'rapid-through-stock')).toEqual([]);
    // #194 step 7: each `G0 Z1` is +Z at the cut's own end point, right after the cut, so all
    // 40 are proved in air with NO boolean; not one reaches the uncut-blank test or a recheck.
    expect(out.value.stats.airMovesClearedByConstruction).toBe(40);
    expect(out.value.stats.airMovesRechecked).toBe(0);
    // Generous: the point is an ORDER, not a budget. The old design's number on this program
    // is not recorded; on TopClamp one recheck ran past 33 s.
    expect(out.value.stats.ms.airCheck).toBeLessThan(1500);
  });

  it('a rapid through material a DISTANT pocket did not remove is still an error — culling must not turn a miss into a pass', () => {
    // The pocket is at X 60..70; the rapid at X 20 is 40 mm from anything it cut. The two solids'
    // boxes do not overlap, so the recheck sees no removal and must report the crash.
    const pocket = 'S1000 M3\nG0 X60 Y30 Z1\nG1 Z-1 F100\nG1 X70\nG0 Z5\nG0 X20\n';
    expect(errs(pocket + 'G0 Z-0.5\n')).toEqual([7]);
  });

  it('a rapid through material an OVERLAPPING earlier cut removed is still cleared', () => {
    const pocket = 'S1000 M3\nG0 X60 Y30 Z1\nG1 Z-1 F100\nG1 X70\nG0 Z5\nG0 X60\n';
    expect(errs(pocket + 'G0 X70 Z-0.9\n')).toEqual([]);
  });
});

// #194 step 7: a retract that is provably in air is not tested at all. The guard rails below
// each pin one clause of the rule: exact end point, same X,Y, +Z, and the immediately preceding
// event being the cut. Anything that fails one of them takes the full geometric path.
describe('#194 step 7: a retract provably in air needs no boolean', () => {
  /** One 20 mm slot at Z -1: its last cutting move ends at (40, 30, -1). */
  const CUT = 'S1000 M3\nG0 X20 Y30 Z1\nG1 Z-1 F100\nG1 X40\n';

  it('a +Z retract from the cut\'s own end point at the same X,Y is cleared by construction', () => {
    const { out } = sweep(CUT + 'G0 Z2\n');
    if (!out.ok) throw new Error(JSON.stringify(out.diagnostics));
    expect(out.value.diagnostics.filter((d) => d.code === 'rapid-through-stock')).toEqual([]);
    expect(out.value.stats.airMovesClearedByConstruction).toBe(1);
    expect(out.value.stats.airMovesRechecked).toBe(0);
  });

  it('the SAME retract with any X,Y change, however small, takes the normal path', () => {
    // +0.001 mm in X: the tool body is no longer the cut's own column, so it is swept and tested.
    const { out } = sweep(CUT + 'G0 X40.001 Z2\n');
    if (!out.ok) throw new Error(JSON.stringify(out.diagnostics));
    expect(out.value.stats.airMovesClearedByConstruction).toBe(0);
    expect(out.value.stats.airMovesRechecked).toBe(1); // met the blank, and was cleared on the re-test
    expect(out.value.diagnostics.filter((d) => d.code === 'rapid-through-stock')).toEqual([]);
  });

  it('a -Z rapid at the cut\'s end point (below the cut floor) is NOT cleared, and is still an error', () => {
    const { out } = sweep(CUT + 'G0 Z-1.5\n');
    if (!out.ok) throw new Error(JSON.stringify(out.diagnostics));
    expect(out.value.stats.airMovesClearedByConstruction).toBe(0);
    expect(out.value.diagnostics.map((d) => d.code)).toContain('rapid-through-stock');
  });

  it('a retract after a SPINDLE-OFF feed takes the normal path', () => {
    // M5 makes the zero-length `G1` a spindle-off air move; the `G0 Z2` after it has a feed,
    // not a cut, as its immediately preceding event, so it is not cleared by construction.
    const { out } = sweep(CUT + 'M5\nG1 X40 Y30 F100\nG0 Z2\n');
    if (!out.ok) throw new Error(JSON.stringify(out.diagnostics));
    expect(out.value.stats.airMovesClearedByConstruction).toBe(0);
    expect(out.value.stats.airMovesRechecked).toBeGreaterThanOrEqual(1);
  });

  it('a retract after a move whose position was unknown (an unswept cut) takes the normal path', () => {
    // The cut at a Z the program never established is a gap, not a checkpoint, so it proves
    // nothing; the following rapid is not even collectible as an air move (Z unknown).
    const { out, timeline } = sweep('S1000 M3\nG1 X40 F100\nG0 Z2\n');
    if (!out.ok) throw new Error(JSON.stringify(out.diagnostics));
    expect(timeline.summary.unsweptMoves).toBe(1);
    expect(out.value.stats.airMovesClearedByConstruction).toBe(0);
  });

  it('a rapid starting where a cut ended but not the NEXT move (another move intervened) takes the normal path', () => {
    // A zero-length rapid sits between the cut and the retract, so the retract's immediately
    // preceding event is a rapid, not the cut — it must not be cleared by construction. (This
    // is the clause that makes "immediately preceding" strict.)
    const { out } = sweep(CUT + 'G0 Z-1\nG0 Z2\n');
    if (!out.ok) throw new Error(JSON.stringify(out.diagnostics));
    expect(out.value.stats.airMovesClearedByConstruction).toBe(0);
  });
});

describe('#194: the time budget and progress are part of the contract', () => {
  it('budgetMs: 0 is refused with sweep-budget-exceeded, and a later sweep on the same wasm heap still works', () => {
    const { out } = sweep(THREE, tool, setup(), { budgetMs: 0 });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.diagnostics[0]?.code).toBe('sweep-budget-exceeded');
    expect(out.diagnostics[0]?.message).toMatch(/checkpoint 1 of 3/);
    // The refusal deleted every handle it had created; if it had not, this would throw or hang.
    const after = sweep(THREE);
    expect(after.out.ok).toBe(true);
  });

  it('onProgress is called once per checkpoint, in order, ending at (total, total)', () => {
    const seen: [number, number][] = [];
    const { out, timeline } = sweep(THREE, tool, setup(), { onProgress: (done, total) => seen.push([done, total]) });
    expect(out.ok).toBe(true);
    const total = timeline.checkpoints.length;
    expect(total).toBe(3);
    expect(seen).toEqual([[1, total], [2, total], [3, total]]);
  });
});

// ---------------------------------------------------------------------------------------
// OPT-IN: a real vendor file (`npm run reference-gcode:fetch`). Skipped when absent.
// ---------------------------------------------------------------------------------------
const CORPUS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'reference-gcode');

describe.skipIf(!existsSync(CORPUS))('a real 2.5D vendor job sweeps end to end', () => {
  it('LED/ACRYLIC-Balloon.nc: ten Z levels, 3 300 cuts with arcs, removes a positive volume with no errors', () => {
    const parsed = parseGcode(readFileSync(join(CORPUS, 'LED/ACRYLIC-Balloon.nc'), 'latin1'));
    // Size a slab to the job: the stock is the cutting moves' XY extent plus a margin, and
    // thick enough to hold the deepest cut. The file's own stock is not stated.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, minZ = Infinity;
    for (const e of parsed.events) {
      if (e.kind !== 'move' || e.mode !== 'cut') continue;
      for (const p of [e.from, e.to]) {
        if (p[0] !== null) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); }
        if (p[1] !== null) { minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
        if (p[2] !== null) minZ = Math.min(minZ, p[2]);
      }
    }
    const thickness = Math.ceil(-minZ + 1);
    const part = { kind: 'prism' as const, outline: { kind: 'p-rect' as const, size: [maxX - minX + 10, maxY - minY + 10] as [number, number] }, thickness };
    const s = stubSetup(part, { kind: 'tape-down', contact: part.outline });
    // Put the part's model origin 5 mm below/left of the cuts; the work origin stays on the top face at (0, 0).
    s.placement = { origin: [minX - 5, minY - 5, 0], rotationZ: 0, source: 'stub' };
    s.wcs = { origin: [0, 0, thickness], source: 'stub', uncertainty: 0.05 };
    const timeline = buildTimeline(parsed, s);
    // The file's TOOL header is not Studio's (it is a Carvera-era file without one), so use
    // the tool its comment names: a 3.175 mm flat end mill.
    const out = sweepTimeline(tl, timeline, flatEndMill(3.175), s);
    if (!out.ok) throw new Error(JSON.stringify(out.diagnostics));
    expect(out.value.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    // #194 step 7: the file's retracts are `G0 Z<n>` from the end of the cut just made, so they
    // are all cleared ANALYTICALLY now — the airMovesRechecked count collapses to near zero and
    // the air gate stops being where the sweep's time goes. Removed volume is produced by the
    // per-checkpoint sweep, which step 7 does not touch, so it is unchanged.
    expect(out.value.stats.airMovesClearedByConstruction).toBeGreaterThan(150); // the retracts
    expect(out.value.stats.airMovesRechecked).toBeLessThan(10); // near zero, and every one clear
    expect(out.value.stats.removedVolume).toBeGreaterThan(0);
    expect(out.value.stats.resultVolume).toBeLessThan(out.value.stats.stockVolume);
    expect(out.value.stats.checkpointsSwept).toBeGreaterThan(5);
    expect(out.value.stats.ms.total).toBeLessThan(120_000);
    // Non-regression, deliberately loose, and now far below the bar: with the retracts gone the
    // gate is a few hundred ms on this file. Opt-in: it needs the corpus present.
    expect(out.value.stats.ms.airCheck).toBeLessThan(12_000);
  });
});
