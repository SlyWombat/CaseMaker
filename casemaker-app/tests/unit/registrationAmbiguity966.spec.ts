/**
 * #966 — `registerSetupOrigin`'s edge/hole-matching path (`cam/model/setups.ts`) can pair a
 * symmetric part's MIRROR-TWIN features (two edges, or two+ holes, that map onto each other under
 * the vise-flip's half-turn) and pass its own per-candidate consistency check while returning a
 * PHYSICALLY WRONG offset — confirmed concretely on a "lying cylinder" part: before this fix,
 * `registerSetupOrigin` silently returned `[0, -20]` instead of the true `[0, 0]`.
 *
 * THE MECHANISM: the original `tryEdge` picked only the SINGLE longest outline run in each tree
 * (`Array.prototype.reduce`, first-encountered wins on a tie) and checked only that ONE edge's own
 * two endpoints agreed with each other about the offset. Two parallel edges of identical length
 * (the lying cylinder's long sides) tie exactly; whichever one each tree's own reduce happened to
 * land on need not be the SAME physical edge, and pairing the wrong two (tree0's bottom edge
 * against setup N's top edge) is ALSO a rigid translation — both endpoints shift by the same
 * amount — so it passes the original check too, just with the WRONG amount (the full edge-to-edge
 * spacing, not the real mounting offset).
 *
 * THE FIX: `candidateOutlineRuns` keeps EVERY qualifying run, not only the longest, and every
 * surviving candidate pairing must now also pass `outlineMatches` — does the candidate offset,
 * cast over the WHOLE recognised outline (every vertex, not just the one edge's two endpoints),
 * reproduce `tree0`'s own outline exactly, as a set? This is provably decisive, not one more
 * heuristic: translating a finite point set by a non-zero vector moves its own centroid, so at
 * most one offset can make one finite set equal another set-for-set. The "rest of the outline" is
 * therefore a genuine second datum whenever the outline has more than the two points a single
 * candidate edge supplies, and it is what lets the lying-cylinder case RESOLVE to `[0, 0]`
 * outright, rather than merely refusing. `tryHolePair` gets the analogous whole-dataset check
 * (every OTHER matched hole, not just the chosen pair, must also agree) for the hole-pair path's
 * own class of the same bug (a periodic/evenly-spaced hole row — part 3 below).
 *
 * Every hand-computed expectation below is worked out in the comments beside its fixture, and
 * cross-checked against a direct run of the PRE-FIX code (see this PR's own notes) — not asserted
 * blind.
 */
import { describe, expect, it } from 'vitest';

import { registerSetupOrigin } from '@/engine/cnc/cam/model/setups';
import type { FeatureTree, PocketNode } from '@/engine/cnc/cam/model/features';

const TOL: FeatureTree['report']['tolerances'] = {} as never;

function treeWith(opts: {
  up: [number, number, number];
  stockTop: number;
  stockBottom: number;
  pockets?: PocketNode[];
  outline?: [number, number][][];
}): FeatureTree {
  const outline = opts.outline ?? [[[0, 0], [5, 0], [5, 5], [0, 5]]];
  return {
    frame: { up: opts.up, stockTop: opts.stockTop, stockBottom: opts.stockBottom, partTop: opts.stockTop, partBottom: opts.stockBottom },
    levels: [],
    top: { z: opts.stockTop, floors: [], area: 0 },
    contour: { outline, area: 0, zTo: opts.stockBottom, frees: true, shoulders: [] },
    pockets: opts.pockets ?? [],
    rims: [],
    remainder: [],
    unreachable: [],
    report: { source: 'mesh', patches: 0, planarArea: 0, remainderArea: 0, tolerances: TOL, slivers: [], notes: [] },
  };
}

function square(cx: number, cy: number, s: number): [number, number][][] {
  const h = s / 2;
  return [[[cx - h, cy - h], [cx + h, cy - h], [cx + h, cy + h], [cx - h, cy + h]]];
}
function throughHole(id: string, cx: number, cy: number, s = 2): PocketNode {
  return { id, floorZ: -5, mouthZ: 0, open: false, through: true, region: square(cx, cy, s), floors: [], islands: [], children: [], remainder: [], narrowest: s };
}

describe('#966 registerSetupOrigin — part 1: the lying-cylinder mirror-twin-edge repro', () => {
  // Approximated as a 40 x 20 rectangle: two long (40 mm) edges at document y = -10 and y = +10,
  // tied in length — each the OTHER's mirror twin under the flip's Y-negation. Setup N's own
  // local outline is recognised as the LITERAL SAME ring tree0 has — exactly as plausible a
  // reading of a perfectly mirror-symmetric footprint as tree0's own (there is no feature on this
  // footprint to tell the recognizer which "copy" it is looking at).
  const tree0 = treeWith({
    up: [0, 0, 1],
    stockTop: 0,
    stockBottom: -20,
    outline: [[[0, -10], [40, -10], [40, 10], [0, 10]]],
  });
  const treeN = treeWith({
    up: [0, 0, -1],
    stockTop: 20,
    stockBottom: 0,
    outline: [[[0, -10], [40, -10], [40, 10], [0, 10]]],
  });

  it('resolves to the TRUE offset [0, 0] — PRE-FIX this silently returned [0, -20]', () => {
    const registration = registerSetupOrigin(tree0, treeN);
    expect(registration.datum.basis).toBe('edge');
    expect(registration.offsetMm[0]).toBeCloseTo(0, 9);
    expect(registration.offsetMm[1]).toBeCloseTo(0, 9);
  });
});

describe('#966 registerSetupOrigin — part 2: a DIFFERENT symmetry — a point-symmetric parallelogram', () => {
  // P0=(0,0), P1=(36,12), P2=(40,-8), P3=(4,-20): a non-rectangular parallelogram, point-symmetric
  // about its own centroid (180-degree rotational symmetry, NOT a mirror reflection) — the
  // task's own suggested "different symmetry" case. Its two long sides (P0P1 and P3P2, both
  // ~37.95 mm) are parallel and tied in length, the same tie structure as part 1's rectangle, but
  // on slanted, non-axis-aligned edges. PRE-FIX this returned the self-consistent-but-wrong
  // [-4, 20] instead of the true [0, 0] (confirmed by direct run against the pre-fix code).
  const tree0 = treeWith({
    up: [0, 0, 1],
    stockTop: 0,
    stockBottom: -20,
    outline: [[[0, 0], [36, 12], [40, -8], [4, -20]]],
  });
  const treeN = treeWith({
    up: [0, 0, -1],
    stockTop: 20,
    stockBottom: 0,
    outline: [[[4, 20], [40, 8], [36, -12], [0, 0]]],
  });

  it('resolves to the TRUE offset [0, 0] — PRE-FIX this silently returned [-4, 20]', () => {
    const registration = registerSetupOrigin(tree0, treeN);
    expect(registration.offsetMm[0]).toBeCloseTo(0, 9);
    expect(registration.offsetMm[1]).toBeCloseTo(0, 9);
  });
});

describe('#966 registerSetupOrigin — part 3: the hole-pair path\'s OWN class of the bug — a periodic hole row', () => {
  // Three holes, evenly spaced 20 mm apart in a line — tree0 (document truth): H1=(0,0),
  // H2=(20,0), H3=(40,0). The TRUE physical offset is (10, 0) -- exactly HALF the hole spacing --
  // which makes the "shift by one hole" WRONG correspondence tie, in raw distance, with the
  // correct one inside `matchHoles`' own greedy nearest-neighbour step. Local holes are listed
  // out of tree0's own order (L2 first) so the array-order tie-break picks the wrong candidate
  // first for H1, exactly reproducing the mismatch found by direct run against the pre-fix code
  // (which returned the self-consistent-but-wrong [-10, 0]).
  //
  // Two holes alone CANNOT carry this bug (see `setups.ts`'s own #966 header note for the proof:
  // two distinct points related by one assumed global translation admit at most one
  // self-consistent correspondence) — it needs three or more, evenly spaced, which is exactly why
  // this is a genuinely DIFFERENT failure mode from part 1/2's edge case, not a retread of it.
  const tree0 = treeWith({
    up: [0, 0, 1],
    stockTop: 0,
    stockBottom: -10,
    pockets: [throughHole('H1', 0, 0), throughHole('H2', 20, 0), throughHole('H3', 40, 0)],
  });
  const treeN = treeWith({
    up: [0, 0, -1],
    stockTop: 10,
    stockBottom: 0,
    pockets: [throughHole('L2', 10, 0), throughHole('L1', -10, 0), throughHole('L3', 30, 0)],
  });

  it('never returns the wrong [-10, 0] — refuses by name instead (matchHoles’ own greedy pick is globally wrong here, so there is no surviving candidate to resolve to the true [10, 0] either)', () => {
    expect(() => registerSetupOrigin(tree0, treeN)).toThrow(/#965 registration/);
    // Confirm it is specifically the safe refusal, never a return of [-10, 0] or any other number.
    try {
      registerSetupOrigin(tree0, treeN);
      expect.fail('expected registerSetupOrigin to throw');
    } catch (e) {
      expect((e as Error).message).not.toMatch(/-10/);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Property-based coverage: many random symmetric / near-symmetric / asymmetric rectangles and
// hole rows, each with an INDEPENDENTLY KNOWN true answer (constructed, not inferred), asserting
// registerSetupOrigin either returns that EXACT true offset or throws a named #965/#966 error —
// never a plausible-but-wrong number. Deterministic (seeded) so a failure is reproducible.
// ---------------------------------------------------------------------------------------------

/** mulberry32 — tiny deterministic PRNG, no external dependency needed for this seeded sweep. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A rectangle outline, document XY, x in [0, L], y in [-H/2, H/2] -- a MIRROR-TWIN-EDGE-PRONE
 * shape whenever `H >= MIN_EDGE_LENGTH_MM` too (both long AND short edges then tie with their own
 * opposite number): the SAME tie structure the real bug needs, swept across many dimensions.
 */
function rectangleOutline(l: number, h: number): [number, number][] {
  return [[0, -h / 2], [l, -h / 2], [l, h / 2], [0, h / 2]];
}

/**
 * Builds setup N's own LOCAL outline such that documentXY(treeN.frame, x, y) + trueOffset lands
 * EXACTLY on tree0's own document point, preserving vertex order (the physically correct case:
 * the SAME mesh boundary, traced the same way around, just really shifted by `trueOffset`).
 */
function trueLocalOutline(doc: readonly (readonly [number, number])[], trueOffset: readonly [number, number]): [number, number][] {
  return doc.map(([x, y]) => [x - trueOffset[0], trueOffset[1] - y] as [number, number]);
}

describe('#966 registerSetupOrigin — property: random rectangles (symmetric and asymmetric), many true offsets', () => {
  const rnd = mulberry32(0x965966);
  const TRIALS = 400;

  for (let trial = 0; trial < TRIALS; trial++) {
    const l = 20 + rnd() * 100; // 20..120 mm
    const h = 16 + rnd() * 104; // 16..120 mm -- always clears MIN_EDGE_LENGTH_MM (15), maximising tie pressure
    // True offset: zero about a third of the time (the exact tie-prone case the bug needs), a
    // small nonzero shift otherwise (the realistic "part didn't reseat perfectly" case).
    const trueOffset: [number, number] = rnd() < 0.33 ? [0, 0] : [(rnd() - 0.5) * 30, (rnd() - 0.5) * 30];

    const doc = rectangleOutline(l, h);
    const tree0 = treeWith({ up: [0, 0, 1], stockTop: 0, stockBottom: -h, outline: [doc] });
    const treeN = treeWith({
      up: [0, 0, -1],
      stockTop: h,
      stockBottom: 0,
      outline: [trueLocalOutline(doc, trueOffset)],
    });

    it(`trial ${trial}: L=${l.toFixed(2)} H=${h.toFixed(2)} trueOffset=[${trueOffset[0].toFixed(2)}, ${trueOffset[1].toFixed(2)}]`, () => {
      let registration;
      try {
        registration = registerSetupOrigin(tree0, treeN);
      } catch (e) {
        expect((e as Error).message).toMatch(/#965 registration|#966 registration/);
        return;
      }
      // NEVER a plausible-but-wrong offset: must be exactly the constructed true one.
      expect(registration.offsetMm[0]).toBeCloseTo(trueOffset[0], 6);
      expect(registration.offsetMm[1]).toBeCloseTo(trueOffset[1], 6);
    });
  }
});

describe('#966 registerSetupOrigin — property: random evenly-spaced hole rows, many spacings and offsets', () => {
  const rnd = mulberry32(0x1120966);
  const TRIALS = 150;

  for (let trial = 0; trial < TRIALS; trial++) {
    const spacing = 12 + rnd() * 40; // 12..52 mm -- clears MIN_HOLE_SEPARATION_MM (10) between adjacent holes
    const holeCount = 2 + Math.floor(rnd() * 3); // 2, 3, or 4 holes
    // True offset along the row: sometimes the exact "half spacing" tie point the bug needs,
    // sometimes a generic fraction, sometimes zero.
    const trueOffsetX = rnd() < 0.3 ? spacing / 2 : rnd() < 0.5 ? 0 : (rnd() - 0.5) * spacing;
    const trueOffset: [number, number] = [trueOffsetX, (rnd() - 0.5) * 10];

    const doc: [number, number][] = Array.from({ length: holeCount }, (_, i) => [i * spacing, 0]);
    const local = doc.map(([x, y]) => [x - trueOffset[0], trueOffset[1] - y] as [number, number]);

    const tree0 = treeWith({
      up: [0, 0, 1],
      stockTop: 0,
      stockBottom: -10,
      pockets: doc.map(([x, y], i) => throughHole(`H${i}`, x, y)),
    });
    const treeN = treeWith({
      up: [0, 0, -1],
      stockTop: 10,
      stockBottom: 0,
      // Deliberately listed in REVERSE order -- stresses matchHoles' own array-order tie-break
      // the same way the hand-built part-3 repro does, instead of only ever matching the lucky
      // order.
      pockets: local.map(([x, y], i) => throughHole(`L${i}`, x, y)).reverse(),
    });

    it(`trial ${trial}: holes=${holeCount} spacing=${spacing.toFixed(2)} trueOffset=[${trueOffset[0].toFixed(2)}, ${trueOffset[1].toFixed(2)}]`, () => {
      let registration;
      try {
        registration = registerSetupOrigin(tree0, treeN);
      } catch (e) {
        expect((e as Error).message).toMatch(/#965 registration|#966 registration/);
        return;
      }
      expect(registration.offsetMm[0]).toBeCloseTo(trueOffset[0], 6);
      expect(registration.offsetMm[1]).toBeCloseTo(trueOffset[1], 6);
    });
  }
});
