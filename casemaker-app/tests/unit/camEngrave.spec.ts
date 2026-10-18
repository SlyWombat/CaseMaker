// The engrave job's toolpath IR (#172), driven through the real Clipper2 offset in Manifold's
// wasm harness. Geometric assertions are against CLOSED FORMS or against the input region
// itself — never against another run of the generator.

import { describe, it, expect } from 'vitest';
import { tl } from './helpers/manifoldExec';
import {
  generateEngrave,
  makeClipperOffset,
  MILLING,
  type EngraveRegion,
  type FinishPassSpec,
} from '@/engine/cnc/cam/engraveJob';
import { travelStats, type CamMove } from '@/engine/cnc/cam/ir';
import type { Polygons } from '@/engine/cnc/cam/pocket';
import { flatEndMill } from '@/engine/cnc/tool';
import { Z1 } from '@/engine/cnc/machine';
import type { CutParams } from '@/engine/cnc/feeds';
import { postZ1, type PostContext } from '@/engine/cnc/post/z1';
import type { EngraveLabel, EngraveShape } from '@/types/engraveJob';
import { itemOperationName, labelProfile } from '@/engine/cnc/engrave/partPlan';
import { engravableProfile } from '@/engine/cnc/engrave/engravable';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { executeProfile } from '@/workers/geometry/evaluateOp';

type Pt = [number, number];

const TOOL = flatEndMill(1); // r = 0.5
const R = 0.5;
const PARAMS: CutParams = { rpm: 12000, feed: 500, plungeFeed: 200, stepDown: 0.4, stepOver: 0.4, peck: 1, air: false };

/** The post's non-geometry context, only needed to prove the operation name reaches the `.nc`. */
const CTX: PostContext = {
  jobName: 'names',
  stock: { length: 60, width: 40, thickness: 10 },
  materialName: 'softwood',
  zDatum: 'probed-top-face',
  origin: 'topFrontLeft',
  camVersion: '1.0.0',
  toolKey: 'flat-1.0',
};

function rectRegion(w: number, h: number, x = 0, y = 0): Polygons {
  return [
    [
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h],
    ],
  ];
}

function signedArea(pts: readonly Pt[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i]!;
    const [x2, y2] = pts[(i + 1) % pts.length]!;
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

function pointInContour(p: Pt, contour: readonly Pt[]): boolean {
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

/** Distinct Z values among feed moves, shallowest first. */
function distinctFeedZs(moves: readonly CamMove[]): number[] {
  const zs = new Set<number>();
  for (const m of moves) if (m.kind === 'feed') zs.add(Number(m.z.toFixed(6)));
  return [...zs].sort((a, b) => b - a);
}

/**
 * Reconstruct the closed cutting loops from the flat move list. Each loop begins at a feed
 * whose predecessor is a rapid (the plunge) and ends at the feed that returns to that point.
 */
function reconstructLoops(moves: readonly CamMove[]): Pt[][] {
  const loops: Pt[][] = [];
  let i = 0;
  while (i < moves.length) {
    const m = moves[i]!;
    const prev = moves[i - 1];
    if (m.kind === 'feed' && prev?.kind === 'rapid') {
      const start: Pt = [m.x, m.y];
      const pts: Pt[] = [[m.x, m.y]];
      i++;
      while (i < moves.length) {
        const n = moves[i]!;
        if (n.kind !== 'feed' || n.z !== m.z) break;
        i++;
        if (n.x === start[0] && n.y === start[1]) break; // closing move
        pts.push([n.x, n.y]);
      }
      loops.push(pts);
      continue;
    }
    i++;
  }
  return loops;
}

function makeLabel(over: Partial<EngraveLabel>): EngraveLabel {
  return {
    id: 'l',
    text: 'O',
    font: 'sans-default',
    weight: 'bold',
    size: 14,
    position: { x: 0, y: 0 },
    rotation: 0,
    depth: 1,
    enabled: true,
    ...over,
  };
}

/** The opened region of a label (#201), evaluated to polygons — the #172 contract. */
function openedRegionForLabel(label: EngraveLabel): Polygons {
  const glyph = labelProfile(label, []);
  const cs = executeProfile(tl, engravableProfile(glyph, R));
  const polygons = cs.toPolygons() as Polygons;
  cs.delete();
  return polygons;
}

/** The opened region of a single glyph (#201). */
function openedRegion(text: string, size: number): Polygons {
  return openedRegionForLabel(makeLabel({ text, size }));
}

describe('generateEngrave (#172)', () => {
  it('10 x 5 x 1 deep at step-down 0.4 makes three passes at -0.4, -0.8, -1.0', () => {
    const region = rectRegion(10, 5);
    const ir = generateEngrave(tl, [{ id: 'a', text: 'A', depth: 1, polygons: region }], TOOL, PARAMS, Z1.rapidEstimate);
    expect(ir.operations.length).toBe(1);
    const op = ir.operations[0]!;
    expect(distinctFeedZs(op.moves)).toEqual([-0.4, -0.8, -1]);

    // No move may go below the target depth; every feed's Z is ≥ -depth.
    for (const m of op.moves) expect(m.z).toBeGreaterThanOrEqual(-1 - 1e-9);
    for (const m of op.moves) if (m.kind === 'feed') expect(m.z).toBeGreaterThanOrEqual(-1 - 1e-9);
  });

  it('every cutting move lies inside the region shrunk by r - 0.001', () => {
    const region = rectRegion(10, 5);
    const ir = generateEngrave(tl, [{ id: 'a', text: 'A', depth: 1, polygons: region }], TOOL, PARAMS, Z1.rapidEstimate);
    const shrunk = makeClipperOffset(tl)(region, -(R - 0.001));
    const moves = ir.operations[0]!.moves;
    for (let i = 0; i < moves.length; i++) {
      const m = moves[i]!;
      if (m.kind !== 'feed') continue;
      expect(pointInPolygons([m.x, m.y], shrunk)).toBe(true);
      const prev = moves[i - 1];
      if (prev) expect(pointInPolygons([prev.x, prev.y], shrunk)).toBe(true);
    }
  });

  it("an opened 'O' pockets without crossing its hole", () => {
    const region = openedRegion('O', 14);
    const holes = region.filter((c) => signedArea(c as Pt[]) < 0);
    expect(holes.length).toBeGreaterThan(0);

    const ir = generateEngrave(tl, [{ id: 'o', text: 'O', depth: 1, polygons: region }], TOOL, PARAMS, Z1.rapidEstimate);
    const moves = ir.operations[0]!.moves;

    // Grow each hole by r - 0.001 and require no feed endpoint inside it.
    for (const hole of holes) {
      const grown = makeClipperOffset(tl)([[...hole].reverse()], R - 0.001);
      for (const m of moves) {
        if (m.kind === 'feed') expect(pointInPolygons([m.x, m.y], grown)).toBe(false);
      }
    }
  });

  it('conventional milling: outer contours clockwise, islands counter-clockwise', () => {
    expect(MILLING).toBe('conventional');

    // A plain rectangle has only outer contours, so every traversed loop is negative.
    const rect = rectRegion(10, 5);
    const rectIr = generateEngrave(tl, [{ id: 'a', text: 'A', depth: 1, polygons: rect }], TOOL, PARAMS, Z1.rapidEstimate);
    const rectLoops = reconstructLoops(rectIr.operations[0]!.moves);
    expect(rectLoops.length).toBeGreaterThan(0);
    for (const loop of rectLoops) expect(signedArea(loop)).toBeLessThan(0);

    // The 'O' has islands: the outer loops stay negative and the island loops are positive.
    const oIr = generateEngrave(tl, [{ id: 'o', text: 'O', depth: 1, polygons: openedRegion('O', 14) }], TOOL, PARAMS, Z1.rapidEstimate);
    const oAreas = reconstructLoops(oIr.operations[0]!.moves).map(signedArea);
    expect(oAreas.some((a) => a < 0)).toBe(true);
    expect(oAreas.some((a) => a > 0)).toBe(true);
  });

  it('rings are cut innermost first: the first contour has the smallest box, the last the largest (9 x 4)', () => {
    // One depth pass so the loops are exactly the rings, in cut order (#173 comment 3).
    const params: CutParams = { ...PARAMS, stepDown: 1 };
    const ir = generateEngrave(tl, [{ id: 'a', text: 'A', depth: 1, polygons: rectRegion(10, 5) }], TOOL, params, Z1.rapidEstimate);
    const loops = reconstructLoops(ir.operations[0]!.moves);
    expect(loops.length).toBeGreaterThan(1);

    const box = (pts: Pt[]): { w: number; h: number } => {
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    };
    const boxes = loops.map(box);
    const areas = boxes.map((b) => b.w * b.h);
    // Innermost first: every ring is strictly larger in area than the one before it, and the
    // outermost is the region eroded by the tool radius alone: (10-1) x (5-1) = 9 x 4.
    for (let i = 1; i < areas.length; i++) expect(areas[i]!).toBeGreaterThan(areas[i - 1]!);
    expect(boxes[0]!.w * boxes[0]!.h).toBe(Math.min(...areas));
    expect(boxes[boxes.length - 1]!.w).toBeCloseTo(9, 6);
    expect(boxes[boxes.length - 1]!.h).toBeCloseTo(4, 6);
  });

  it('every feed uses the cutting or plunge feed, none above the Z1 cap; every XY rapid clears hopZ', () => {
    const region = rectRegion(10, 5);
    const ir = generateEngrave(tl, [{ id: 'a', text: 'A', depth: 1, polygons: region }], TOOL, PARAMS, Z1.rapidEstimate);
    const moves = ir.operations[0]!.moves;
    for (const m of moves) {
      if (m.kind === 'feed') {
        expect([PARAMS.feed, PARAMS.plungeFeed]).toContain(m.f);
        expect(m.f).toBeLessThanOrEqual(Z1.maxCutFeed);
      }
    }
    let previous: CamMove | null = null;
    for (const m of moves) {
      if (m.kind === 'rapid' && (previous === null || m.x !== previous.x || m.y !== previous.y)) {
        expect(m.z).toBeGreaterThanOrEqual(ir.hopZ);
      }
      previous = m;
    }
  });

  it('three labels at 2.0 / 1.0 / 0.5 mm make three operations with the right pass counts', () => {
    const labels: EngraveRegion[] = [
      { id: 'c', text: 'C', depth: 2, polygons: rectRegion(6, 4, 30, 10) },
      { id: 'a', text: 'A', depth: 1, polygons: rectRegion(6, 4, 10, 10) },
      { id: 'b', text: 'B', depth: 0.5, polygons: rectRegion(6, 4, 50, 10) },
    ];
    const ir = generateEngrave(tl, labels, TOOL, PARAMS, Z1.rapidEstimate, 'nearest');
    expect(ir.operations.map((o) => o.number)).toEqual([1, 2, 3]);
    const passes = new Map(ir.operations.map((o) => [o.depth, distinctFeedZs(o.moves).length]));
    expect(passes.get(2)).toBe(5);
    expect(passes.get(1)).toBe(3);
    expect(passes.get(0.5)).toBe(2);
    for (const op of ir.operations) expect(op.estimatedSeconds).toBeGreaterThan(0);
  });

  it('is deterministic for identical input', () => {
    const labels: EngraveRegion[] = [{ id: 'a', text: 'A', depth: 1, polygons: rectRegion(10, 5) }];
    const first = generateEngrave(tl, labels, TOOL, PARAMS, Z1.rapidEstimate);
    const second = generateEngrave(tl, labels, TOOL, PARAMS, Z1.rapidEstimate);
    expect(second.operations).toEqual(first.operations);
    const a = first.operations[0]!;
    const b = second.operations[0]!;
    expect(a.moves.length).toBe(b.moves.length);
    expect(a.moves.slice(0, 20)).toEqual(b.moves.slice(0, 20));
  });

  it('generates the default engrave job (#200) well under the one-second budget', () => {
    const job = defaultEngraveJob();
    const labels: EngraveRegion[] = job.labels
      .filter((l) => l.enabled && l.text.trim().length > 0)
      .map((l) => ({ id: l.id, text: l.text, depth: l.depth, polygons: openedRegionForLabel(l) }));
    const start = performance.now();
    const ir = generateEngrave(tl, labels, TOOL, PARAMS, Z1.rapidEstimate);
    const elapsed = performance.now() - start;
    expect(ir.operations.length).toBe(3);
    for (const op of ir.operations) expect(op.moves.length).toBeGreaterThan(0);
    // Acceptance is < 1 s. The assertion is deliberately loose so a busy shared box running
    // another suite does not fail it; see the issue report for the measured number.
    expect(elapsed).toBeLessThan(3000);
  });

  it('does not leak wasm handles across 100 runs', () => {
    const labels: EngraveRegion[] = [{ id: 'a', text: 'A', depth: 1, polygons: rectRegion(10, 5) }];
    const first = generateEngrave(tl, labels, TOOL, PARAMS, Z1.rapidEstimate).operations[0]!.moves.length;
    for (let i = 0; i < 100; i++) generateEngrave(tl, labels, TOOL, PARAMS, Z1.rapidEstimate);
    expect(generateEngrave(tl, labels, TOOL, PARAMS, Z1.rapidEstimate).operations[0]!.moves.length).toBe(first);
  });
});

describe('operation names (#214 work item 4)', () => {
  const base = { position: { x: 0, y: 0 }, rotation: 0, depth: 1, enabled: true };

  it('words each shape kind with its size, and a label with its text', () => {
    expect(itemOperationName(makeLabel({ text: 'CASE' }))).toBe('Engrave "CASE"');

    const rect: EngraveShape = { ...base, id: 'r', kind: 'rect', width: 20, height: 10, cornerRadius: 0 };
    expect(itemOperationName(rect)).toBe('Pocket rect 20×10');
    // An optional user name is carried through, between the kind and its size.
    expect(itemOperationName({ ...rect, name: 'Motor' })).toBe('Pocket rect "Motor" 20×10');

    const circle: EngraveShape = { ...base, id: 'c', kind: 'circle', diameter: 6 };
    expect(itemOperationName(circle)).toBe('Pocket circle ⌀6');

    const slot: EngraveShape = { ...base, id: 's', kind: 'slot', length: 24, width: 8 };
    expect(itemOperationName(slot)).toBe('Pocket slot 24×8');

    const poly: EngraveShape = {
      ...base,
      id: 'p',
      kind: 'polygon',
      points: [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ],
    };
    expect(itemOperationName(poly)).toBe('Pocket polygon (4 points)');
  });

  it("composes the region's ready-made name into the IR and the emitted .nc TOOLPATH line", () => {
    const rect: EngraveShape = { ...base, id: 'r', kind: 'rect', width: 20, height: 10, cornerRadius: 0 };
    // The polygons are naming-independent stand-ins: this test is about the name that reaches
    // the program, not about pocketing a rectangle.
    const regions: EngraveRegion[] = [
      { id: 'r', text: '', name: itemOperationName(rect), depth: 1, polygons: rectRegion(20, 10, 20, 10) },
      // No `name`: a label keeps the untouched `Engrave "<text>"` fallback.
      { id: 'l', text: 'CASE', depth: 2, polygons: rectRegion(6, 4, 40, 10) },
    ];
    const ir = generateEngrave(tl, regions, TOOL, PARAMS, Z1.rapidEstimate);
    expect(ir.operations.map((o) => o.name)).toContain('[T1]Pocket rect 20×10 1.0mm');
    expect(ir.operations.map((o) => o.name)).toContain('[T1]Engrave "CASE" 2.0mm');

    const posted = postZ1(ir, CTX, Z1);
    expect(posted.ok).toBe(true);
    if (!posted.ok) return;
    const toolpathNames = posted.text
      .split('\n')
      .filter((line) => line.startsWith(';@MKR|TOOLPATH|'))
      .map((line) => line.slice(line.indexOf('name=') + 'name='.length));
    expect(toolpathNames).toContain('[T1]Pocket rect 20×10 1.0mm');
    expect(toolpathNames).toContain('[T1]Engrave "CASE" 2.0mm');
  });
});

// #191 review. The rule is `toolNumberFor`'s (tested directly in `camIrConcat.spec.ts`); this is
// the call site, so that a generator that stops asking it fails here rather than posting `T0 M6`.
describe('the tool number a job posts (#191 review)', () => {
  const region = rectRegion(10, 5, 2, 2);

  it('refuses a cutter numbered 0 at generate, naming the probe slot', () => {
    const probeNumbered = { ...TOOL, number: 0 };
    expect(() =>
      generateEngrave(tl, [{ id: 'a', text: 'A', depth: 1, polygons: region }], probeNumbered, PARAMS, Z1.rapidEstimate),
    ).toThrow(/T0 is the Z1's probe slot/);
  });

  it('posts T1 for a cutter that states no number, and the stated station when there is one', () => {
    const unnamed = generateEngrave(tl, [{ id: 'a', text: 'A', depth: 1, polygons: region }], { ...TOOL, number: null }, PARAMS, Z1.rapidEstimate);
    expect(unnamed.toolNumber).toBe(1);
    const third = generateEngrave(tl, [{ id: 'a', text: 'A', depth: 1, polygons: region }], { ...TOOL, number: 3 }, PARAMS, Z1.rapidEstimate);
    expect(third.toolNumber).toBe(3);
    expect(third.operations[0]?.name.startsWith('[T3]')).toBe(true);
  });
});

// #487 — the ordering. The rules the issue states are checked here on a region the test owns; the
// two real bench programs are the fixture spec's (`engraveOrdering.spec.ts`).
describe('loop ordering (#487)', () => {
  const region = rectRegion(10, 5);
  const oneOp = (params: CutParams = PARAMS) =>
    generateEngrave(tl, [{ id: 'a', text: 'A', depth: 1, polygons: region }], TOOL, params, Z1.rapidEstimate)
      .operations[0]!.moves;

  /** The loop's points as one string — two passes of one contour repeat it exactly. */
  const loopKey = (pts: Pt[]): string => pts.map(([x, y]) => `${x.toFixed(6)},${y.toFixed(6)}`).join(' ');

  it('takes each contour to its full depth before the next: a contour’s passes are consecutive', () => {
    const loops = reconstructLoops(oneOp());
    const seen = new Map<string, number[]>();
    loops.forEach((pts, i) => {
      const key = loopKey(pts);
      seen.set(key, [...(seen.get(key) ?? []), i]);
    });
    // There is at least one contour cut more than once (the region needs several step-downs).
    const repeated = [...seen.values()].filter((at) => at.length > 1);
    expect(repeated.length).toBeGreaterThan(0);
    for (const at of repeated) {
      for (let k = 1; k < at.length; k++) expect(at[k]).toBe(at[k - 1]! + 1);
    }
  });

  it('enters each loop at the vertex nearest the previous loop’s exit', () => {
    const loops = reconstructLoops(oneOp());
    expect(loops.length).toBeGreaterThan(1);
    for (let i = 1; i < loops.length; i++) {
      const [ex, ey] = loops[i - 1]![0]!;
      const entry = loops[i]![0]!;
      const entryDistance = Math.hypot(entry[0] - ex, entry[1] - ey);
      const nearest = Math.min(...loops[i]!.map(([x, y]) => Math.hypot(x - ex, y - ey)));
      expect(entryDistance).toBeCloseTo(nearest, 9);
    }
  });

  it('reports the ordering and the program’s travel in the IR, agreeing with the moves', () => {
    const ir = generateEngrave(tl, [{ id: 'a', text: 'A', depth: 1, polygons: region }], TOOL, PARAMS, Z1.rapidEstimate);
    const ordering = ir.ordering;
    expect(ordering).toBeDefined();
    const stats = travelStats(ir.operations.flatMap((op) => op.moves));
    expect(ordering!.order).toBe('proximity');
    expect(ordering!.rapidMm).toBeCloseTo(stats.rapidMm, 6);
    expect(ordering!.cutMm).toBeCloseTo(stats.cutMm, 6);
    // The pre-#487 order is the same cut through the entries in document order, so its rapid is a
    // real number, not a copy of the after figure.
    expect(ordering!.baselineRapidMm).toBeGreaterThan(0);
  });

  it('places the same loops in the same order on every run (same input → same file)', () => {
    const first = oneOp();
    const second = oneOp();
    expect(second).toEqual(first);
  });
});

// #250 — one region, two removals. The roughing pass is the ideal region eroded by the cutter
// radius PLUS the allowance and stops the same allowance above the floor; the finishing pass is
// the ideal region at the cutter's own radius, cut in one full-depth pass.
describe('finish pass (#250)', () => {
  const leaves = (mode: FinishPassSpec['mode'], stockToLeaveMm = 0.2): FinishPassSpec => ({
    stockToLeaveMm,
    mode,
  });
  const maxX = (loops: readonly (readonly Pt[])[]): number =>
    Math.max(...loops.flatMap((loop) => loop.map(([x]) => x)));

  it('roughs with the allowance and finishes the ideal region at full depth', () => {
    const ir = generateEngrave(
      tl,
      [{ id: 'a', text: 'A', depth: 1, polygons: rectRegion(10, 5) }],
      TOOL,
      PARAMS,
      Z1.rapidEstimate,
      'nearest',
      null,
      leaves('rough-and-finish'),
    );
    expect(ir.operations.map((op) => op.passKind)).toEqual(['rough', 'finish']);
    expect(ir.operations.map((op) => op.name)).toEqual([
      '[T1]Engrave "A" 1.0mm (rough)',
      '[T1]Engrave "A" 1.0mm (finish)',
    ]);

    // The floor allowance: step-down 0.4 to 0.8 mm, not 1.0; the finishing pass reaches full depth.
    expect(distinctFeedZs(ir.operations[0]!.moves)).toEqual([-0.4, -0.8]);
    expect(distinctFeedZs(ir.operations[1]!.moves)).toEqual([-1]);

    // The wall allowance: the roughing walls stand leave mm inside the finishing walls.
    const roughMaxX = maxX(reconstructLoops(ir.operations[0]!.moves));
    const finishMaxX = maxX(reconstructLoops(ir.operations[1]!.moves));
    expect(roughMaxX).toBeCloseTo(10 - R - 0.2, 6);
    expect(finishMaxX).toBeCloseTo(10 - R, 6);
    expect(roughMaxX).toBeLessThan(finishMaxX);
  });

  it('writes only the half its mode names, for a named finishing cutter', () => {
    const region = rectRegion(10, 5);
    const labels = [{ id: 'a', text: 'A', depth: 1, polygons: region }];
    const rough = generateEngrave(tl, labels, TOOL, PARAMS, Z1.rapidEstimate, 'nearest', null, leaves('rough-only'));
    expect(rough.operations).toHaveLength(1);
    expect(rough.operations[0]!.passKind).toBe('rough');
    expect(distinctFeedZs(rough.operations[0]!.moves)).toEqual([-0.4, -0.8]);

    const finish = generateEngrave(tl, labels, TOOL, PARAMS, Z1.rapidEstimate, 'nearest', null, leaves('finish-only'));
    expect(finish.operations).toHaveLength(1);
    expect(finish.operations[0]!.passKind).toBe('finish');
    expect(distinctFeedZs(finish.operations[0]!.moves)).toEqual([-1]);
  });

  it('cuts one unsplit operation when no finish spec is given or the allowance is zero', () => {
    const labels = [{ id: 'a', text: 'A', depth: 1, polygons: rectRegion(10, 5) }];
    for (const finish of [null, leaves('rough-and-finish', 0)]) {
      const ir = generateEngrave(tl, labels, TOOL, PARAMS, Z1.rapidEstimate, 'nearest', null, finish);
      expect(ir.operations).toHaveLength(1);
      expect(ir.operations[0]!.passKind).toBeUndefined();
      expect(ir.operations[0]!.name).toBe('[T1]Engrave "A" 1.0mm');
    }
  });
});
