// The layer stack (#178): the compiled badge sliced on the printer's real layer grid.
//
// Every number here is the make_badge.py default (the one-time oracle for the port, #167).
// The pocket's LOCATION never appears: the pocket tests find the shallow region by scanning
// the depth map the stack itself produced, which is the whole point of a geometric limit.

import { describe, it, expect } from 'vitest';

import { buildLayerStack, type LayerStack, type LayerStackPart } from '@/engine/cnc/layerStack';
import { pTranslate, rectProfile, roundedRect } from '@/engine/compiler/profile';
import { verifyProgram, type VerifyContext } from '@/engine/cnc/verify';
import { flatEndMill } from '@/engine/cnc/tool';
import { Z1 } from '@/engine/cnc/machine';
import { stubSetup } from '@/engine/cnc/setup';

import { tl } from './helpers/manifoldExec';

// make_badge.py defaults. PART frame: z = 0 is the back face (magnet pocket), z = thickness is
// the engraved face. `split` and the pocket's `zCeiling` are part-frame z; the stack flips them.
const WIDTH = 76.2; // 3 in
const HEIGHT = 38.1; // 1.5 in
const THICK = 3.81; // 0.15 in
const RADIUS = 3.175; // 0.125 in
const POCKET_L = 45;
const POCKET_W = 13;
const POCKET_D = 2.3;
const SPLIT = 3.0;
/** The nominal top-colour band, i.e. the colour boundary's depth below the engraved face. */
const NOMINAL_TOP_BAND = THICK - SPLIT; // 0.810

function badgePlan(): LayerStackPart {
  return {
    stock: {
      outline: roundedRect(WIDTH, HEIGHT, RADIUS),
      thickness: THICK,
      split: SPLIT,
      keepOuts: [
        {
          footprint: pTranslate([WIDTH / 2, HEIGHT / 2], rectProfile(POCKET_L, POCKET_W, true)),
          zCeiling: POCKET_D,
        },
      ],
    },
  };
}

/** Sample the depth map on a 1 mm grid, keeping only points that are inside the part. */
function depthStats(stack: LayerStack): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (let x = 1; x <= WIDTH - 1; x += 1) {
    for (let y = 1; y <= HEIGHT - 1; y += 1) {
      const d = stack.maxDepthAt(x, y);
      if (d > 0) {
        min = Math.min(min, d);
        max = Math.max(max, d);
      }
    }
  }
  return { min, max };
}

describe('layerStack (#178): the grid is real, not decorative', () => {
  it('colourBoundaryDepth sits on a layer boundary and rounds 0.810 to the grid', () => {
    const stack = buildLayerStack(tl, badgePlan(), 0.2);
    // It IS a boundary of the grid...
    expect(stack.boundaries.some((b) => Math.abs(b - stack.colourBoundaryDepth) < 1e-9)).toBe(true);
    // ...and at 0.2 mm layers 0.810 is NOT a multiple, so it reports the real 0.80.
    expect(stack.colourBoundaryDepth).toBeCloseTo(0.8, 9);
    expect(Math.abs(stack.colourBoundaryDepth - NOMINAL_TOP_BAND)).toBeGreaterThan(1e-6);
    stack.dispose();
  });

  it('reports the nominal 0.810 exactly when it lands on a layer line (0.27 mm layers)', () => {
    const stack = buildLayerStack(tl, badgePlan(), 0.27);
    expect(stack.colourBoundaryDepth).toBeCloseTo(NOMINAL_TOP_BAND, 9);
    stack.dispose();
  });

  it('a different layer height moves the boundary and the reported limits', () => {
    const fine = buildLayerStack(tl, badgePlan(), 0.2);
    const coarse = buildLayerStack(tl, badgePlan(), 0.3);
    expect(Math.abs(fine.colourBoundaryDepth - coarse.colourBoundaryDepth)).toBeGreaterThan(1e-6);
    const a = depthStats(fine);
    const b = depthStats(coarse);
    // The pocket's depth limit is quantised by the grid, so it moves with the layer height.
    expect(Math.abs(a.min - b.min)).toBeGreaterThan(1e-6);
    fine.dispose();
    coarse.dispose();
  });
});

describe('layerStack (#178): depth from the solid, no pocket special case', () => {
  it('maxDepthAt is shallower over the pocket footprint, by the pocket depth to within a layer', () => {
    const h = 0.2;
    const stack = buildLayerStack(tl, badgePlan(), h);
    const { min, max } = depthStats(stack);
    expect(min).toBeLessThan(max);
    // The difference IS the pocket's depth, quantised to the grid (within one layer).
    expect(Math.abs(max - min - POCKET_D)).toBeLessThanOrEqual(h);
    stack.dispose();
  });

  it('a point outside the badge outline has no depth', () => {
    const stack = buildLayerStack(tl, badgePlan(), 0.2);
    expect(stack.maxDepthAt(WIDTH + 5, HEIGHT / 2)).toBe(0);
    expect(stack.maxDepthAt(-5, -5)).toBe(0);
    expect(stack.maxDepthAt(WIDTH / 2, HEIGHT + 5)).toBe(0);
    stack.dispose();
  });

  it('index 0 is the engraved face: it spans the first layer height from depth 0', () => {
    const stack = buildLayerStack(tl, badgePlan(), 0.2, 0.25);
    expect(stack.layers[0]!.z0).toBe(0);
    expect(stack.layers[0]!.z1).toBeCloseTo(0.25, 9);
    expect(stack.layers[1]!.z0).toBeCloseTo(0.25, 9);
    expect(stack.boundaries[stack.boundaries.length - 1]).toBeCloseTo(THICK, 9);
    stack.dispose();
  });

  it('cuttableAt narrows as it descends past the pocket ceiling', () => {
    const stack = buildLayerStack(tl, badgePlan(), 0.2);
    const shallow = stack.cuttableAt(0.2);
    const deep = stack.cuttableAt(3.6);
    expect(shallow.area()).toBeGreaterThan(0);
    // The pocket has removed material by the time we are past its ceiling, and the shortfall
    // is exactly the pocket's footprint area — again from geometry, not a coordinate.
    expect(deep.area()).toBeLessThan(shallow.area());
    expect(shallow.area() - deep.area()).toBeCloseTo(POCKET_L * POCKET_W, 3);
    expect(stack.cuttableAt(0).isEmpty()).toBe(true);
    stack.dispose();
  });
});

describe('layerStack (#178): ownership and the verifier seam', () => {
  it('dispose frees the sections it owns, and repeated builds do not exhaust the heap', () => {
    const stack = buildLayerStack(tl, badgePlan(), 0.2);
    const section = stack.cuttableAt(1.0);
    expect(section.area()).toBeGreaterThan(0);
    stack.dispose();
    // The section was owned by the stack, so it is a dead handle now.
    expect(() => section.area()).toThrow();
    stack.dispose(); // idempotent
    for (let i = 0; i < 200; i++) buildLayerStack(tl, badgePlan(), 0.2).dispose();
  });

  it('feeds maxDepthAt to verifyProgram: past the pocket limit is refused, within it is not', () => {
    const h = 0.2;
    const stack = buildLayerStack(tl, badgePlan(), h);

    // Find a point the depth map itself reports as pocket-limited — the pocket's location is
    // never written in this test.
    let pocket: { x: number; y: number; depth: number } | null = null;
    for (let x = 1; x <= WIDTH - 1 && pocket === null; x += 1) {
      for (let y = 1; y <= HEIGHT - 1 && pocket === null; y += 1) {
        const d = stack.maxDepthAt(x, y);
        if (d > 0 && d < THICK - h) pocket = { x, y, depth: d };
      }
    }
    expect(pocket).not.toBeNull();
    const p = pocket!;

    const ctx: VerifyContext = {
      setup: stubSetup(
        { kind: 'prism', outline: roundedRect(WIDTH, HEIGHT, RADIUS), thickness: THICK },
        { kind: 'tape-down', contact: roundedRect(WIDTH, HEIGHT, RADIUS) },
        { startingTool: 1 },
        Z1,
      ),
      machine: Z1,
      tool: flatEndMill(1),
      depthLimit: (x, y) => stack.maxDepthAt(x, y),
      minRapidZ: 1,
    };

    const program = (z: number): string =>
      [
        'G90 G21',
        'T1 M6',
        'M7',
        'S12000 M3',
        `G0 X${p.x} Y${p.y}`,
        `G1 Z${z} F200`,
        `G1 X${p.x + 0.5}`,
        'M5',
        'M02',
      ].join('\n');

    const tooDeep = verifyProgram(program(-(p.depth + 0.5)), ctx);
    expect(tooDeep.ok).toBe(false);
    expect(tooDeep.findings.some((f) => f.code === 'cut-too-deep')).toBe(true);

    const withinLimit = verifyProgram(program(-(p.depth - 0.3)), ctx);
    expect(withinLimit.findings).toEqual([]);
    expect(withinLimit.ok).toBe(true);

    stack.dispose();
  });
});
