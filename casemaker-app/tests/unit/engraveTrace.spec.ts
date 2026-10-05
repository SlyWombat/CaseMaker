// Single-line engraving (#219): the trace model (`partPlan.traces`) and its CAM (`cam/trace.ts`).
//
// Geometric assertions are against CLOSED FORMS and against the input geometry — never against
// another run of the generator. The model tests (self-overlap, the swept region) run in plain
// Node; the swept-region AREA test needs the production CrossSection evaluator; the oracle test
// runs the real sweep through a `SimSession`, the same path the app uses.

import { describe, it, expect } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { generateTrace, type TracePaths } from '@/engine/cnc/cam/trace';
import { postZ1, type PostContext } from '@/engine/cnc/post/z1';
import type { CamMove } from '@/engine/cnc/cam/ir';
import type { Polygons } from '@/engine/cnc/cam/pocket';
import { flatEndMill } from '@/engine/cnc/tool';
import { Z1 } from '@/engine/cnc/machine';
import type { CutParams } from '@/engine/cnc/feeds';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { toSetup } from '@/engine/cnc/engrave/jobSetup';
import {
  toPartPlan,
  traceOperationName,
  tracePaths,
  traceSelfOverlapFindings,
  traceSelfOverlaps,
  traceSweptProfile,
} from '@/engine/cnc/engrave/partPlan';
import { createSimSession } from '@/workers/sim/session';
import { executeProfile } from '@/workers/geometry/evaluateOp';
import type { EngraveJob, EngraveLineItem } from '@/types/engraveJob';

type Pt = [number, number];

const TOOL = flatEndMill(1); // r = 0.5
const R = 0.5;
const PARAMS: CutParams = { rpm: 12000, feed: 500, plungeFeed: 200, stepDown: 0.4, stepOver: 0.4, air: false };
const CTX: PostContext = {
  jobName: 'trace',
  stock: { length: 100, width: 60, thickness: 12 },
  materialName: 'softwood',
  zDatum: 'probed-top-face',
  origin: 'topFrontLeft',
  camVersion: 'test',
};

function line(over: Partial<EngraveLineItem> & Pick<EngraveLineItem, 'points'>): EngraveLineItem {
  return {
    kind: 'line',
    id: 't',
    position: { x: 0, y: 0 },
    rotation: 0,
    depth: 1,
    enabled: true,
    closed: false,
    ...over,
  };
}

function trace(over: Partial<TracePaths> & Pick<TracePaths, 'paths' | 'closed'>): TracePaths {
  return { id: 't', name: 'Trace line', depth: 1, ...over };
}

type FeedMove = Extract<CamMove, { kind: 'feed' }>;

/** Feed moves that are PLUNGES: a feed immediately preceded by a rapid at the same X/Y. */
function plunges(moves: readonly CamMove[]): FeedMove[] {
  const out: FeedMove[] = [];
  for (let i = 1; i < moves.length; i++) {
    const m = moves[i]!;
    const p = moves[i - 1]!;
    if (m.kind === 'feed' && p.kind === 'rapid' && m.x === p.x && m.y === p.y) out.push(m);
  }
  return out;
}

/** Feed moves that TRAVEL: a feed whose predecessor is a feed (i.e. not a plunge). */
function travels(moves: readonly CamMove[]): FeedMove[] {
  const out: FeedMove[] = [];
  for (let i = 1; i < moves.length; i++) {
    const m = moves[i]!;
    if (m.kind === 'feed' && moves[i - 1]!.kind === 'feed') out.push(m);
  }
  return out;
}

/** Distinct cutting Z values, shallowest first. */
function feedZs(moves: readonly CamMove[]): number[] {
  const zs = new Set<number>();
  for (const m of moves) if (m.kind === 'feed') zs.add(Number(m.z.toFixed(6)));
  return [...zs].sort((a, b) => b - a);
}

function length(a: Pt, b: Pt): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function signedArea(pts: Pt[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i]!;
    const [x2, y2] = pts[(i + 1) % pts.length]!;
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

function pointInContour(p: Pt, contour: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = contour.length - 1; i < contour.length; j = i++) {
    const [xi, yi] = contour[i]!;
    const [xj, yj] = contour[j]!;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pointInPolygons(p: Pt, polys: Polygons): boolean {
  let inside = false;
  for (const c of polys) if (pointInContour(p, c)) inside = !inside;
  return inside;
}

/** The swept region of a trace, evaluated to polygons through the production evaluator. */
function sweptPolygons(paths: Pt[][], closed: boolean[], radius: number): Polygons {
  const cs = executeProfile(tl, traceSweptProfile(paths, closed, radius));
  const polygons = cs.toPolygons() as Polygons;
  cs.delete();
  return polygons;
}

describe('cam/trace (#219)', () => {
  it('a 20 mm line at depth 1, one pass: one plunge, one 20 mm feed, one retract', () => {
    const t = trace({ paths: [[[0, 0], [20, 0]]], closed: [false] });
    const ir = generateTrace([t], TOOL, { ...PARAMS, stepDown: 1 });

    expect(ir.operations).toHaveLength(1);
    const op = ir.operations[0]!;
    expect(op.name).toBe('[T1]Trace line 1.0mm');
    expect(op.labelId).toBe('t');
    expect(op.depth).toBe(1);

    expect(feedZs(op.moves)).toEqual([-1]);
    const plunge = plunges(op.moves);
    expect(plunge).toHaveLength(1);
    expect(plunge[0]!.f).toBe(PARAMS.plungeFeed);

    const trav = travels(op.moves);
    expect(trav).toHaveLength(1);
    expect(trav[0]!.f).toBe(PARAMS.feed);
    expect(length([0, 0], [trav[0]!.x, trav[0]!.y])).toBeCloseTo(20, 9);

    // Two rapids: the hop at the start (HOP_Z) and the retract at the end (HOP_Z), plus safeZ.
    const rapids = op.moves.filter((m) => m.kind === 'rapid');
    expect(rapids).toHaveLength(3);
    expect(rapids[0]!.z).toBe(ir.hopZ);
    expect(rapids[rapids.length - 1]!.z).toBe(ir.safeZ);
  });

  it('depth 1 at step-down 0.4 makes three passes, each with its own plunge', () => {
    const t = trace({ paths: [[[0, 0], [20, 0]]], closed: [false] });
    const op = generateTrace([t], TOOL, PARAMS).operations[0]!;
    expect(feedZs(op.moves)).toEqual([-0.4, -0.8, -1]);
    expect(plunges(op.moves)).toHaveLength(3);
    // Every travel is still the full 20 mm, once per pass.
    expect(travels(op.moves)).toHaveLength(3);
    for (const m of travels(op.moves)) expect(m.f).toBe(PARAMS.feed);
  });

  it('a closed square returns to its start with no mid-path retract', () => {
    const t = trace({
      paths: [[[0, 0], [10, 0], [10, 10], [0, 10]]],
      closed: [true],
      depth: 0.5,
    });
    const op = generateTrace([t], TOOL, { ...PARAMS, stepDown: 0.5 }).operations[0]!;

    const trav = travels(op.moves);
    // Four edges, the last closing back on the start point.
    expect(trav).toHaveLength(4);
    const start = plunges(op.moves)[0]!;
    let perimeter = 0;
    let prev: Pt = [start.x, start.y];
    for (const m of trav) {
      perimeter += length(prev, [m.x, m.y]);
      prev = [m.x, m.y];
    }
    expect(perimeter).toBeCloseTo(40, 9);
    expect(trav[trav.length - 1]!.x).toBeCloseTo(0, 9);
    expect(trav[trav.length - 1]!.y).toBeCloseTo(0, 9);

    // No rapid between the plunge and the closing feed: the ring is one continuous cut.
    const plungeIndex = op.moves.findIndex((m) => m.kind === 'feed');
    const closeIndex = op.moves.lastIndexOf(trav[trav.length - 1]!);
    const between = op.moves.slice(plungeIndex + 1, closeIndex);
    expect(between.some((m) => m.kind === 'rapid')).toBe(false);
  });

  it('nearest ordering starts with the trace closest to the origin', () => {
    const far = trace({ id: 'far', name: 'Far', paths: [[[50, 50], [60, 50]]], closed: [false] });
    const near = trace({ id: 'near', name: 'Near', paths: [[[2, 2], [8, 2]]], closed: [false] });
    const ir = generateTrace([far, near], TOOL, { ...PARAMS, stepDown: 1 });
    expect(ir.operations.map((o) => o.labelId)).toEqual(['near', 'far']);
    expect(ir.operations.map((o) => o.number)).toEqual([1, 2]);
  });
});

describe('trace model (#219)', () => {
  it('two parallel lines 0.8 mm apart with a 1 mm cutter self-overlap', () => {
    const a: Pt[] = [[0, 0], [0, 10]];
    const b: Pt[] = [[0.8, 0], [0.8, 10]];
    const overlaps = traceSelfOverlaps([a, b], [false, false], R);
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]!.distance).toBeCloseTo(0.8, 9);
    expect(overlaps[0]!.overlap).toBeCloseTo(0.2, 9);

    // 1.2 mm apart is clear: no overlap at r = 0.5.
    const far: Pt[] = [[1.2, 0], [1.2, 10]];
    expect(traceSelfOverlaps([a, far], [false, false], R)).toHaveLength(0);
  });

  it('checks non-adjacent segments of one path, skipping the ones that share a vertex', () => {
    // A "U": the two long legs (segments 0 and 2) are parallel and 0.8 mm apart, while 0-1 and
    // 1-2 share vertices and must not be reported.
    const u: Pt[] = [[0, 0], [0, 10], [0.8, 10], [0.8, 0]];
    const overlaps = traceSelfOverlaps([u], [false], R);
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]!.a.segment).toBe(0);
    expect(overlaps[0]!.b.segment).toBe(2);
  });

  it('raises a single trace-self-overlap warning per offending item', () => {
    const job = {
      traces: [line({ id: 'u', points: [[0, 0], [0, 10], [0.8, 10], [0.8, 0]] })],
    } as unknown as EngraveJob;
    const findings = traceSelfOverlapFindings(job, R);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.code).toBe('trace-self-overlap');
    expect(findings[0]!.severity).toBe('warning');
    expect(findings[0]!.labelId).toBe('u');

    const clear = {
      traces: [line({ id: 'c', points: [[0, 0], [0, 10], [1.2, 10], [1.2, 0]] })],
    } as unknown as EngraveJob;
    expect(traceSelfOverlapFindings(clear, R)).toHaveLength(0);
  });

  it("predicted region of an 'L' is rounded at the elbow, with the capsule's area", () => {
    const L: Pt[] = [[0, 0], [10, 0], [10, 10]];
    const polys = sweptPolygons([L], [false], R);

    // Steiner formula for the r-neighbourhood of an open curve: 2r·L + πr².
    const LEN = 20;
    const expected = 2 * R * LEN + Math.PI * R * R;
    const area = Math.abs(
      polys.reduce((sum, c) => sum + Math.abs(signedArea(c)), 0),
    );
    expect(area).toBeGreaterThan(expected * 0.98);
    expect(area).toBeLessThan(expected * 1.02);

    // Half-width r on a straight run.
    expect(pointInPolygons([5, 0.4], polys)).toBe(true);
    expect(pointInPolygons([5, 0.6], polys)).toBe(false);

    // The elbow at (10, 0): on the outer diagonal a point at distance 0.4 is cut, but one at
    // 0.6 is not — a mitered (square) corner would have included it.
    const diag = (d: number): Pt => [10 + d / Math.SQRT2, -d / Math.SQRT2];
    expect(pointInPolygons(diag(0.4), polys)).toBe(true);
    expect(pointInPolygons(diag(0.6), polys)).toBe(false);

    // The free ends are round caps of radius r.
    expect(pointInPolygons([-R + 0.1, 0], polys)).toBe(true);
    expect(pointInPolygons([-R - 0.1, 0], polys)).toBe(false);
  });

  it('toPartPlan keeps traces out of engraves and places a line by position/rotation', () => {
    const job: EngraveJob = {
      ...defaultEngraveJob(),
      labels: [],
      shapes: [],
      combined: [],
      traces: [
        line({ id: 'l1', points: [[0, 0], [10, 0]], position: { x: 5, y: 7 }, rotation: 0 }),
        line({ id: 'skip', points: [[0, 0], [1, 1]], enabled: false }),
        line({ id: 'gone', points: [[0, 0], [1, 1]], construction: true }),
      ],
    };
    const plan = toPartPlan(job);
    expect(plan.engraves).toHaveLength(0);
    expect(plan.traces.map((t) => t.id)).toEqual(['l1']);
    const paths = plan.traces[0]!.paths;
    expect(paths[0]![0]).toEqual([5, 7]);
    expect(paths[0]![1]).toEqual([15, 7]);

    // Rotation is about `position`: a 90° turn sends +x to +y.
    const rotated = tracePaths(line({ points: [[0, 0], [10, 0]], position: { x: 5, y: 7 }, rotation: 90 }));
    expect(rotated.paths[0]![1]![0]).toBeCloseTo(5, 9);
    expect(rotated.paths[0]![1]![1]).toBeCloseTo(17, 9);
  });

  it('a stroke label typesets to trace paths, and a blank one yields none', () => {
    const text = tracePaths({
      kind: 'stroke-label',
      id: 's',
      position: { x: 20, y: 20 },
      rotation: 0,
      depth: 1,
      enabled: true,
      text: 'H',
      font: 'hershey-simplex',
      size: 10,
    });
    expect(text.paths.length).toBeGreaterThan(0);
    expect(text.closed.every((c) => c === false)).toBe(true);
    // Centred on its bounding box at (20, 20): the strokes straddle the position.
    const xs = text.paths.flat().map((p) => p[0]);
    expect(Math.min(...xs)).toBeLessThan(20);
    expect(Math.max(...xs)).toBeGreaterThan(20);

    const blank = tracePaths({
      kind: 'stroke-label',
      id: 's',
      position: { x: 0, y: 0 },
      rotation: 0,
      depth: 1,
      enabled: true,
      text: '   ',
      font: 'hershey-simplex',
      size: 10,
    });
    expect(blank.paths).toHaveLength(0);
  });

  it('names a line operation with its point count and a stroke label with its text', () => {
    expect(traceOperationName(line({ points: [[0, 0], [1, 0], [2, 0]], closed: true }))).toBe(
      'Trace line (3 points, closed)',
    );
    expect(
      traceOperationName({
        kind: 'stroke-label',
        id: 's',
        position: { x: 0, y: 0 },
        rotation: 0,
        depth: 1,
        enabled: true,
        text: 'CASE',
        font: 'hershey-simplex',
        size: 8,
      }),
    ).toBe('Trace text "CASE"');
  });
});

describe('trace oracle (#219)', () => {
  const setup = toSetup(defaultEngraveJob(), Z1);

  /** Post a trace-only program, sweep it, and compare against a predicted swept region. */
  function report(program: TracePaths, predicted: { paths: Pt[][]; closed: boolean[] }): {
    ok: boolean;
    worst: { underCut: number; overCut: number };
  } {
    const ir = generateTrace([program], TOOL, { ...PARAMS, stepDown: 1 });
    const posted = postZ1(ir, CTX, Z1);
    if (!posted.ok) throw new Error(`post refused: ${JSON.stringify(posted.errors)}`);

    const session = createSimSession(tl);
    try {
      const loaded = session.load(posted.text, setup, TOOL, Z1.id);
      if (!loaded.ok) throw new Error(`load refused: ${JSON.stringify(loaded.diagnostics)}`);
      const cs = executeProfile(tl, traceSweptProfile(predicted.paths, predicted.closed, R));
      const polygons = cs.toPolygons() as Polygons;
      cs.delete();
      const oracle = session.oracle([{ depth: program.depth, polygons }]);
      return { ok: oracle.ok, worst: oracle.worst };
    } finally {
      session.dispose();
    }
  }

  const PATHS: Pt[][] = [[[10, 10], [30, 10]]];

  it('passes the program that cuts exactly the predicted trace', () => {
    const program = trace({ paths: PATHS, closed: [false] });
    const result = report(program, { paths: PATHS, closed: [false] });
    expect(result.ok).toBe(true);
    expect(result.worst.underCut).toBeLessThan(1e-3);
    expect(result.worst.overCut).toBeLessThan(1e-3);
  });

  it('fails when the program is shifted 0.5 mm from the prediction', () => {
    const shifted: Pt[][] = [[[10, 10.5], [30, 10.5]]];
    const program = trace({ paths: shifted, closed: [false] });
    const result = report(program, { paths: PATHS, closed: [false] });
    expect(result.ok).toBe(false);
    // Both sides of the comparison see the shift: half the stroke is left uncut, half overruns.
    expect(result.worst.underCut).toBeGreaterThan(1);
    expect(result.worst.overCut).toBeGreaterThan(1);
  });
});
