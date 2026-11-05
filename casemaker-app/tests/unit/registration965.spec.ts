/**
 * #965 registration — RED-FIRST coverage for `registerSetupOrigin` (`cam/model/setups.ts`): the
 * vise-flip setup's origin, computed from locating features recognised in BOTH setups' own
 * `FeatureTree`s, never assumed from the vise/rotation alone (`plan.ts`'s own #965 open-item note
 * this fills).
 *
 * Every fixture below is a hand-built `FeatureTree` (the same pattern `opsAcceptance959.spec.ts`'s
 * `syntheticTree*` helpers use) — no Manifold kernel needed, since `registerSetupOrigin` only
 * reads `FeatureTree.pockets`/`.contour`/`.frame`, never re-recognises geometry itself.
 *
 * Each hand-computed expectation is worked out in the comments beside its fixture, not asserted
 * blind: a reviewer can redo the arithmetic from the fixture's own numbers.
 */
import { describe, expect, it } from 'vitest';

import { documentXY, mapIRToDocument, registerSetupOrigin } from '@/engine/cnc/cam/model/setups';
import type { FeatureTree, PocketNode } from '@/engine/cnc/cam/model/features';
import type { ToolpathIR } from '@/engine/cnc/cam/ir';

const TOL: FeatureTree['report']['tolerances'] = {} as never;

/** An axis-aligned square of side `s`, centred at `(cx, cy)` — its area centroid is its centre. */
function square(cx: number, cy: number, s: number): [number, number][][] {
  const h = s / 2;
  return [[[cx - h, cy - h], [cx + h, cy - h], [cx + h, cy + h], [cx - h, cy + h]]];
}

function throughHole(id: string, cx: number, cy: number, s = 2): PocketNode {
  return {
    id,
    floorZ: -5,
    mouthZ: 0,
    open: false,
    through: true,
    region: square(cx, cy, s),
    floors: [], // #958's own rule: empty for a through node.
    islands: [],
    children: [],
    remainder: [],
    narrowest: s,
  };
}

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

describe('#965 registerSetupOrigin — (a) two through-holes', () => {
  // Setup 0 (top, up = [0, 0, 1] is the identity document map): two dowel-style through-holes,
  // document positions (5, 5) and (25, 15) — 22.36 mm apart, past MIN_HOLE_SEPARATION_MM (10).
  const tree0 = treeWith({
    up: [0, 0, 1],
    stockTop: 0,
    stockBottom: -10,
    pockets: [throughHole('dowel-left', 5, 5), throughHole('dowel-right', 25, 15)],
  });

  // Setup N (bottom, up = [0, 0, -1]): documentXY's own naive map is (x, -y). The SAME two
  // physical holes are placed in setup N's own LOCAL frame so that this naive map lands them 2 mm
  // off in X and 3 mm off in Y from where setup 0 says they really are — a deliberately NON-ZERO
  // registration offset, so the test proves the function actually computes a number from the
  // geometry rather than defaulting to [0, 0]. Local (x, y) is chosen as
  // (naiveDocX, -naiveDocY) where naiveDoc = trueDoc - offset(2, 3):
  //   dowel-left:  trueDoc (5, 5)   → naiveDoc (3, 2)   → local (3, -2)
  //   dowel-right: trueDoc (25, 15) → naiveDoc (23, 12) → local (23, -12)
  // Ids and list order are deliberately different from setup 0's, so a pass here proves the match
  // is positional, not id- or order-based.
  const treeN = treeWith({
    up: [0, 0, -1],
    stockTop: 10,
    stockBottom: -0,
    pockets: [throughHole('thru-1', 23, -12), throughHole('thru-2', 3, -2)],
  });

  it('computes the offset from the matched hole pair, not a nominal zero', () => {
    const registration = registerSetupOrigin(tree0, treeN);
    expect(registration.datum.basis).toBe('two-holes');
    expect(registration.offsetMm[0]).toBeCloseTo(2, 9);
    expect(registration.offsetMm[1]).toBeCloseTo(3, 9);
    if (registration.datum.basis === 'two-holes') {
      const ids = registration.datum.holes.map((h) => h.id).sort();
      expect(ids).toEqual(['dowel-left', 'dowel-right']);
      expect(registration.datum.separationMm).toBeCloseTo(Math.hypot(20, 10), 9);
    }
  });

  it('the computed offset, applied through documentXY, lands setup N back on setup 0\'s own document positions', () => {
    const registration = registerSetupOrigin(tree0, treeN);
    // dowel-right's local position in setup N is (23, -12); documentXY's naive map gives (23, 12);
    // the computed offset must correct that back to (25, 15) — setup 0's own truth.
    expect(documentXY(treeN.frame, 23, -12, registration.offsetMm)).toEqual([25, 15]);
  });
});

describe('#965 registerSetupOrigin — (b) one long straight edge, no holes', () => {
  // Setup 0: a plain 40 × 20 mm rectangle, no through-holes at all — the hole strategy cannot
  // even start (fewer than two holes), so this exercises the edge fallback on its own.
  const tree0 = treeWith({
    up: [0, 0, 1],
    stockTop: 0,
    stockBottom: -8,
    outline: [[[0, 0], [40, 0], [40, 20], [0, 20]]],
  });

  // Setup N: the SAME outline, but placed so the naive documentXY map is off by (1.5, -2) mm —
  // worked out the same way as the hole case above (naiveDoc = trueDoc − offset(1.5, −2),
  // local = (naiveDoc.x, −naiveDoc.y)):
  //   (0, 0)   → naiveDoc (−1.5, 2)  → local (−1.5, −2)
  //   (40, 0)  → naiveDoc (38.5, 2)  → local (38.5, −2)
  //   (40, 20) → naiveDoc (38.5, 22) → local (38.5, −22)
  //   (0, 20)  → naiveDoc (−1.5, 22) → local (−1.5, −22)
  const treeN = treeWith({
    up: [0, 0, -1],
    stockTop: 8,
    stockBottom: -0,
    outline: [[[-1.5, -2], [38.5, -2], [38.5, -22], [-1.5, -22]]],
  });

  it('falls back to the edge datum and computes its offset', () => {
    const registration = registerSetupOrigin(tree0, treeN);
    expect(registration.datum.basis).toBe('edge');
    expect(registration.offsetMm[0]).toBeCloseTo(1.5, 9);
    expect(registration.offsetMm[1]).toBeCloseTo(-2, 9);
    if (registration.datum.basis === 'edge') {
      expect(registration.datum.lengthMm).toBeCloseTo(40, 9);
      // The longest run — the two 40 mm edges beat the two 20 mm ones.
      expect(registration.datum.endpoints).toEqual([[0, 0], [40, 0]]);
    }
  });
});

describe('#965 registerSetupOrigin — (c) neither feature survives: refuses by name', () => {
  // A 5 × 5 mm outline (every edge under MIN_EDGE_LENGTH_MM = 15) with no through-holes at all —
  // too small to carry either kind of datum (the issue's own "too small or wrong shape" refusal
  // case, not a silent nominal/zero fallback).
  const tiny0 = treeWith({ up: [0, 0, 1], stockTop: 0, stockBottom: -3 });
  const tinyN = treeWith({ up: [0, 0, -1], stockTop: 3, stockBottom: -0 });

  it('throws the named #965 registration error instead of guessing an origin', () => {
    expect(() => registerSetupOrigin(tiny0, tinyN)).toThrow(/no locating features found for the vise flip \(#965 registration\)/);
  });

  it('one through-hole alone is not a pair, and a tiny outline is not an edge — still refuses', () => {
    const one0 = treeWith({ up: [0, 0, 1], stockTop: 0, stockBottom: -3, pockets: [throughHole('only-hole', 2, 2)] });
    const oneN = treeWith({ up: [0, 0, -1], stockTop: 3, stockBottom: -0, pockets: [throughHole('only-hole-n', 2, -2)] });
    expect(() => registerSetupOrigin(one0, oneN)).toThrow(/#965 registration/);
  });

  it('two holes present but too close together (< 10 mm) also refuses rather than anchoring on a weak pair', () => {
    // 3 mm apart in setup 0 — well under MIN_HOLE_SEPARATION_MM.
    const close0 = treeWith({
      up: [0, 0, 1],
      stockTop: 0,
      stockBottom: -3,
      pockets: [throughHole('a', 1, 1), throughHole('b', 4, 1)],
    });
    const closeN = treeWith({
      up: [0, 0, -1],
      stockTop: 3,
      stockBottom: -0,
      pockets: [throughHole('a-n', 1, -1), throughHole('b-n', 4, -1)],
    });
    expect(() => registerSetupOrigin(close0, closeN)).toThrow(/#965 registration/);
  });
});

describe('#965 documentXY / mapIRToDocument — the new offset parameter', () => {
  it('defaults to [0, 0], so every pre-#965 call site is unchanged', () => {
    expect(documentXY({ up: [0, 0, -1], stockTop: 0 }, 3, -4)).toEqual([3, 4]);
  });

  it('adds the offset after the rotation-only map', () => {
    expect(documentXY({ up: [0, 0, -1], stockTop: 0 }, 3, -4, [1, 2])).toEqual([4, 6]);
    expect(documentXY({ up: [0, 0, 1], stockTop: 0 }, 3, -4, [1, 2])).toEqual([4, -2]);
  });

  function ir(moves: { x: number; y: number; z: number }[]): ToolpathIR {
    return {
      frame: 'flat',
      tool: { shape: 'flat', id: 't', name: 't', number: 1 } as ToolpathIR['tool'],
      toolNumber: 1,
      spindleRpm: 10000,
      air: true,
      safeZ: 5,
      hopZ: 1,
      operations: [
        {
          number: 1,
          name: 'op',
          labelId: 'l',
          depth: 1,
          estimatedSeconds: 1,
          moves: moves.map((m) => ({ kind: 'feed' as const, x: m.x, y: m.y, z: m.z, f: 100 })),
        },
      ],
    };
  }

  it('is still the identity for the top setup with a zero offset (#965-setups own test, preserved)', () => {
    const top = ir([{ x: 1, y: 2, z: -1 }]);
    expect(mapIRToDocument(top, { up: [0, 0, 1], stockTop: 0 })).toBe(top);
  });

  it('applies a non-zero registration offset to a flipped setup\'s moves', () => {
    const bottom = ir([{ x: 1, y: 2, z: -3 }]);
    const mapped = mapIRToDocument(bottom, { up: [0, 0, -1], stockTop: 0 }, [0.5, -1]);
    expect(mapped.operations[0]!.moves[0]).toEqual({ kind: 'feed', x: 1.5, y: -3, z: -3, f: 100 });
  });
});
