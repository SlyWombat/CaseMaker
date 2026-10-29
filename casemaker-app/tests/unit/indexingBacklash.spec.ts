// #757 — ACCEPTANCE: 4-axis 180° indexing and backlash, as castellated slots.
//
// Maintainer request 2026-10-29 (Test 2). The part is a ⌀30 rod with two straight slots milled
// down its length, one at A = 0° and its mirror at A = 180°, cut by the #241 indexed pipeline
// (`cam/indexed.ts`) — a constant A per run, one pass as wide as the cutter, zero lead-in and
// lead-out, a high feed, and rapid transitions. The design leaves a stated wall between the two
// slot floors: 12.5 mm deep on a ⌀30 rod is a 5.00 mm wall through the centre.
//
// The test drives the engine directly, as #241's fixtures do: indexed faces cannot be authored in
// the app yet (R-UI-11). It goes generate → post → re-parse → timeline → verify → the exact sweep
// → an analytic oracle, and pins:
//   - each slot is exactly the cutter's diameter wide (6.000 mm);
//   - the corners are square to the cutter's own polygon resolution;
//   - the wall is 5.000 mm at BOTH sides of the slot — the reference the bench caliper reading is
//     compared to (docs/bench/757-indexing-backlash.md);
//   - A is stated on a rapid before each run's first cut, and every turn is in air;
//   - zero lead-in/lead-out is accepted as generated, and the post's feed ceiling is pinned by its
//     sentence (the first attempt at 1500 mm/min was refused, and 1200 is the highest it takes).

import { describe, it, expect } from 'vitest';
import { tl } from './helpers/manifoldExec';
import { generateIndexed, type IndexedSpec } from '@/engine/cnc/cam/indexed';
import { postZ1, type PostContext } from '@/engine/cnc/post/z1';
import { buildTimeline, parseGcode, stubSetup, Z1 } from '@/engine/cnc';
import { flatEndMill } from '@/engine/cnc/tool';
import { segmentsForRadius } from '@/engine/compiler/arcResolution';
import { sweepTimeline, type SweepResult } from '@/workers/geometry/sweep';
import { verifyProgram } from '@/engine/cnc/verify';
import type { CutParams } from '@/engine/cnc/feeds';

const R = 15; // ⌀30 rod
const LENGTH = 40;
const D = 6; // the slot's width: one pass, the cutter's diameter
const RT = D / 2;
const DEPTH = 12.5; // floor at radius 2.5 — a 5.00 mm wall through the centre
const WALL = 2 * (R - DEPTH);
const STOCK = { kind: 'cylinder' as const, diameter: 2 * R, length: LENGTH };
const HOLD = { kind: 'rotary-chuck' as const, jawDiameter: 25, stickout: LENGTH };
const setup = () => stubSetup(STOCK, HOLD, { startingTool: 1 }, Z1);
const TOOL = flatEndMill(D, { shoulderLength: 20, fluteLength: 20 });
/** A high feed, at the post's own ceiling (see the pin at the end). */
const PARAMS: CutParams = { rpm: 12000, feed: 1200, plungeFeed: 300, stepDown: DEPTH, stepOver: 1, peck: 1, air: true };
/** #729 item 5 — the pass starts one cutter radius clear of the jaws at X 0. */
const JAW_CLEAR = RT + 3;
/** #724 B3 — and ends with the cutter's edge at the rod's free end. */
const END_X = LENGTH - RT;
const N_STOCK = segmentsForRadius(R);

const ctx = (): PostContext => ({
  jobName: 'castellated 0/180',
  stock: { length: LENGTH, width: 2 * R, thickness: 2 * R },
  materialName: 'softwood',
  zDatum: 'rotary-axis',
  origin: 'topFrontLeft',
  camVersion: '1.0.0',
  toolKey: 'fixture',
});

const spec = (params: CutParams = PARAMS): IndexedSpec => ({
  radius: R,
  faces: [
    { a: 0, fromX: JAW_CLEAR, toX: END_X, depth: DEPTH },
    { a: 180, fromX: JAW_CLEAR, toX: END_X, depth: DEPTH },
  ],
  tool: TOOL,
  params,
  rapid: Z1.rapidEstimate,
});

/** Area of a regular n-gon inscribed in a circle of radius r — the mesh the stock really is. */
const polygonArea = (r: number, n: number): number => (n / 2) * r * r * Math.sin((2 * Math.PI) / n);

/** The slot's full-section area: |y| ≤ D/2, from the floor z = R − DEPTH to the circle. */
const SLOT_AREA =
  (D / 2) * Math.sqrt(R * R - (D / 2) ** 2) + R * R * Math.asin(D / (2 * R)) - D * (R - DEPTH);

/**
 * The material ONE rounded end of the pass removes beyond its centreline span: the cutter's disc
 * reaches `reach(x)` across the slot at distance x inside the cap (`reach` = 0 at its far edge,
 * RT at the pass end). The same cap integral #241's fixtures use.
 */
function capVolume(n = 600): number {
  let v = 0;
  const dx = RT / n;
  for (let i = 0; i < n; i++) {
    const x = (i + 0.5) * dx;
    const reach = Math.sqrt(Math.max(0, RT * RT - (x - RT) ** 2));
    const dy = (2 * reach) / n;
    for (let j = 0; j < n; j++) {
      const y = -reach + (j + 0.5) * dy;
      v += Math.max(0, Math.sqrt(R * R - y * y) - (R - DEPTH)) * dx * dy;
    }
  }
  return v;
}

function dispose(s: SweepResult): void {
  s.stock.delete();
  s.result.delete();
  s.removal?.delete();
  for (const cp of s.perCheckpoint) cp?.delete();
  for (const g of s.gouges) g.solid.delete();
}

/** What ONE run took off the blank: its removal solid, trimmed to the stock. */
function removedSolid(sweep: SweepResult, k: number) {
  const solid = sweep.perCheckpoint[k];
  if (!solid) throw new Error(`checkpoint ${k} removed nothing`);
  return solid.intersect(sweep.stock);
}

/** The pipeline the acceptance names: generate → post → re-parse → verify → exact sweep. */
function runPipeline(params: CutParams = PARAMS) {
  const ir = generateIndexed(spec(params));
  expect(ir.frame).toBe('rotary');
  for (const op of ir.operations) for (const m of op.moves) expect(m.a).toBeTypeOf('number');

  const posted = postZ1(ir, ctx(), Z1);
  if (!posted.ok) throw new Error(`the post refused the indexed program: ${posted.errors.join('; ')}`);
  const timeline = buildTimeline(parseGcode(posted.text), setup());
  expect(timeline.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(timeline.summary.rotary).toBe(true);
  expect(timeline.summary.rotaryClass).toBe('indexed');

  const verified = verifyProgram(posted.text, {
    setup: setup(),
    machine: Z1,
    tool: TOOL,
    depthLimit: () => 0,
    minRapidZ: 1,
    rotary: { radius: R, stickout: LENGTH, tailstock: false },
  });
  // Zero lead-in and lead-out needs no allowance: the verifier takes the pass as generated.
  expect(verified.findings.filter((f) => f.severity === 'error').map((f) => `${f.line} ${f.code}`)).toEqual([]);

  const out = sweepTimeline(tl, timeline, TOOL, setup());
  if (!out.ok) throw new Error(`the sweep refused the indexed program: ${JSON.stringify(out.diagnostics)}`);
  expect(out.value.stats.engine).toBe('exact');
  expect(out.value.stats.checkpointsSwept).toBe(2);
  expect(out.value.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  return { ir, posted, timeline, verified, sweep: out.value };
}

/** The runs that cut: one checkpoint per index, both at the slot's floor. */
const cuttingRuns = (timeline: { checkpoints: { a: number | null; z: number }[] }) =>
  timeline.checkpoints.filter((cp) => cp.z < R).map((cp) => ({ a: cp.a, z: cp.z }));

/** Relative comparison, because the oracle is a volume in the thousands of mm³. */
function expectWithin(got: number, want: number, relative: number, what: string): void {
  const err = Math.abs(got - want) / want;
  expect(err, `${what}: ${got.toFixed(4)} against ${want.toFixed(4)} (${(err * 100).toFixed(3)} %)`).toBeLessThan(relative);
}

describe('#757 the 180° indexed castellated slots', () => {
  it('cuts one cutter-wide slot per index, with equal walls at both sides', () => {
    const { timeline, sweep } = runPipeline();

    // ONE RUN PER INDEX, each at the same floor: the two faces are symmetric about the axis.
    expect(cuttingRuns(timeline)).toEqual([
      { a: 0, z: R - DEPTH },
      { a: 180, z: R - DEPTH },
    ]);

    const top = removedSolid(sweep, 0);
    const bottom = removedSolid(sweep, 1);
    const topBB = top.boundingBox();
    const bottomBB = bottom.boundingBox();

    // EACH SLOT IS THE CUTTER'S DIAMETER WIDE. The pass is one tool width: the cutter's polygon
    // sweeps two vertical walls, and the widest line between them is its diameter. The mesh's own
    // facet error is r(1 − cos(π/n)) — stated below the assertion, not hidden in the tolerance.
    const facet = RT * (1 - Math.cos(Math.PI / segmentsForRadius(RT)));
    expect(topBB.max[1]! - topBB.min[1]!, `top slot width, facet ${facet.toFixed(4)} mm`).toBeCloseTo(D, 6);
    expect(bottomBB.max[1]! - bottomBB.min[1]!, 'bottom slot width').toBeCloseTo(D, 6);

    // THE FLOORS ARE MIRROR IMAGES: one at z = 2.5, the other at −2.5, so the wall between them
    // is 5.00 mm and each side's is the same distance from the axis.
    expect(topBB.min[2]!).toBeCloseTo(R - DEPTH, 6);
    expect(bottomBB.max[2]!).toBeCloseTo(-(R - DEPTH), 6);
    expect(topBB.min[2]! - bottomBB.max[2]!).toBeCloseTo(WALL, 6);

    // THE WALL AT BOTH SIDES, measured inside the slot's width at mid-length: the material spans
    // z −2.5 … 2.5 at +Y and at −Y, and the two thicknesses are equal — the bench reference.
    const mid = (JAW_CLEAR + END_X) / 2;
    const halfWidth = topBB.max[1]!;
    const wallAt = (side: 1 | -1): number => {
      const y0 = side * (halfWidth - 0.2);
      const y1 = side * (halfWidth - 0.1);
      const box = tl.Manifold.cube([0.2, Math.abs(y1 - y0), 2 * R], true).translate([mid, (y0 + y1) / 2, 0]);
      const wall = sweep.result.intersect(box);
      const bb = wall.boundingBox();
      const thickness = bb.max[2]! - bb.min[2]!;
      expect(bb.min[2]!, `wall at ${side > 0 ? '+Y' : '−Y'}: bottom`).toBeCloseTo(-(R - DEPTH), 6);
      expect(bb.max[2]!, `wall at ${side > 0 ? '+Y' : '−Y'}: top`).toBeCloseTo(R - DEPTH, 6);
      wall.delete();
      box.delete();
      return thickness;
    };
    const plus = wallAt(1);
    const minus = wallAt(-1);
    expect(plus).toBeCloseTo(WALL, 6);
    expect(minus).toBeCloseTo(WALL, 6);
    expect(plus).toBeCloseTo(minus, 6);
    expect(Math.abs(plus - minus), 'the bench reading this test is the reference for').toBeLessThan(1e-6);

    // THE CORNERS ARE SQUARE to the cutter's resolution: just inside the wall the material's top
    // is the slot floor (2.5); just outside it the rod is untouched, up to its surface at that y.
    const cornerTop = (off: number): number => {
      const box = tl.Manifold.cube([0.2, 0.1, 2 * R], true).translate([mid, halfWidth + off, 0]);
      const part = sweep.result.intersect(box);
      const bb = part.boundingBox();
      part.delete();
      box.delete();
      return bb.max[2]!;
    };
    expect(cornerTop(-0.1), 'floor just inside the wall').toBeCloseTo(R - DEPTH, 6);
    const outerY = halfWidth + 0.05;
    expect(cornerTop(0.1), 'surface just outside the wall').toBeCloseTo(Math.sqrt(R * R - outerY * outerY), 2);

    top.delete();
    bottom.delete();
    dispose(sweep);
  });

  it('the removed volume is the closed form of the cutter’s own slot', () => {
    const { sweep } = runPipeline();

    // The slot at full section is |y| ≤ D/2 from the floor to the circle, times the pass's
    // centreline span, plus one rounded end cap at each end. The stock's own n-gon costs the
    // sweep a little of the cap (its surface is inscribed), which is the 1 % band.
    const want = SLOT_AREA * (END_X - JAW_CLEAR) + 2 * capVolume();
    const stats = sweep.stats;
    expectWithin(stats.removedVolume / 2, want, 0.01, 'one slot');
    for (const k of [0, 1]) {
      const solid = removedSolid(sweep, k);
      expectWithin(solid.volume(), want, 0.01, `slot at checkpoint ${k}`);
      solid.delete();
    }
    // The accounting closes exactly, and the stock is the inscribed n-gon the mesh really has.
    expect(stats.resultVolume).toBeCloseTo(stats.stockVolume - stats.removedVolume, 6);
    expectWithin(stats.stockVolume, polygonArea(R, N_STOCK) * LENGTH, 0.0001, 'stock');
    dispose(sweep);
  });

  it('states A on a rapid before each cut and takes every turn in air', () => {
    const { ir, verified } = runPipeline();
    const moves = ir.operations.flatMap((op) => op.moves);

    // A on a rapid before each run's first cut: every operation opens at the safe height with its
    // index stated, and every move carries one (the rotary frame's rule).
    for (const op of ir.operations) {
      const first = op.moves[0]!;
      expect(first.kind).toBe('rapid');
      expect(first.z).toBeGreaterThanOrEqual(R);
      expect(first.a).toBeTypeOf('number');
      expect(op.moves.every((m) => m.y === 0 && m.a === first.a)).toBe(true);
    }
    expect(ir.operations.map((op) => op.moves[0]!.a)).toEqual([0, 180]);

    // EVERY TURN IS IN AIR: where A changes between consecutive moves, the move carrying the new
    // A is a rapid at or above the stock's surface.
    let turns = 0;
    for (let i = 1; i < moves.length; i++) {
      const prev = moves[i - 1]!;
      const next = moves[i]!;
      if (next.a !== prev.a) {
        turns++;
        expect(next.kind, `turn ${turns} is not a rapid`).toBe('rapid');
        expect(next.z, `turn ${turns} at Z ${next.z}`).toBeGreaterThanOrEqual(R);
      }
    }
    expect(turns).toBe(1);
    // ...and the verifier's air gate agrees: no turn-with-the-tool-down finding.
    expect(verified.findings.filter((f) => f.code === 'rotary-rapid-engaged')).toEqual([]);
  });

  it('zero lead-in and lead-out: the pass is a plunge at the start and a cut to the end', () => {
    const { ir } = runPipeline();
    for (const op of ir.operations) {
      const cutFeeds = op.moves.filter((m) => m.kind === 'feed');
      // The plunge at fromX, then one straight cut along X at the slot floor: no ramp in, no ramp
      // out, and the first cutting move is already at depth.
      expect(cutFeeds[0]!.x).toBe(JAW_CLEAR);
      expect(cutFeeds[0]!.z).toBe(R - DEPTH);
      const alongX = cutFeeds.filter((m) => m.z === R - DEPTH);
      expect(alongX.map((m) => [m.x, m.z])).toEqual([
        [JAW_CLEAR, R - DEPTH],
        [END_X, R - DEPTH],
      ]);
    }
  });

  it('pins the post’s feed ceiling: 1500 mm/min is refused by its exact sentence', () => {
    // The issue asks for a high feed. The post's ceiling is 1200: the first attempt at 1500 was
    // refused at the line it appears, and the sentence is pinned here rather than worked around.
    const refused = postZ1(generateIndexed(spec({ ...PARAMS, feed: 1500 })), ctx(), Z1);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.errors).toEqual([
      'move 3: feed 1500 mm/min is not in (0, 1200]',
      'move 9: feed 1500 mm/min is not in (0, 1200]',
    ]);
  });
});
