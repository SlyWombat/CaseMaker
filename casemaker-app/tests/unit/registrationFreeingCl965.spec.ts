/**
 * #965 review finding, RED-FIRST: `oppositeSurfaceSafeDepthMm` must map setup N's own LOCAL
 * (x, y) into the document frame the SAME way the posted program does — through `documentXY`
 * with the SAME registration offset `mapIRToDocument` is given — or the freeing contour's safety
 * check and its own posted toolpath disagree about where a point actually is.
 *
 * `planModelCam`, end to end, can never exercise a genuinely NON-ZERO registration offset: both
 * setups recognise the SAME `ModelPlanInput.geometry`, related by `toSetupFrame`'s exact inverse
 * rotation, so `registerSetupOrigin` always finds offset [0, 0] on any consistent single mesh —
 * confirmed in this branch's own progress notes on #965. A real mounting shift is therefore the
 * ONE case this module exists to catch, and the ONE case no existing fixture can produce through
 * the real pipeline. This spec instead composes the real exported pieces directly — the same
 * `tree0`/`treeN` two-hole fixture `registration965.spec.ts` already proved produces a genuine,
 * worked offset of (2, 3) — to show the disagreement, and after the fix, that it is gone.
 */

import { describe, expect, it } from 'vitest';

import { documentXY, mapIRToDocument, registerSetupOrigin } from '../../src/engine/cnc/cam/model/setups';
import { oppositeSurfaceSafeDepthMm } from '../../src/engine/cnc/cam/model/plan';
import { profileOf, type DropCutterMesh } from '../../src/engine/cnc/cam/model/dropcutter';
import type { FeatureTree, PocketNode } from '../../src/engine/cnc/cam/model/features';
import type { ToolpathIR } from '../../src/engine/cnc/cam/ir';
import { flatEndMill, type Tool } from '../../src/engine/cnc/tool';

const TOL: FeatureTree['report']['tolerances'] = {} as never;

function square(cx: number, cy: number, s: number): [number, number][][] {
  const h = s / 2;
  return [[[cx - h, cy - h], [cx + h, cy - h], [cx + h, cy + h], [cx - h, cy + h]]];
}

function throughHole(id: string, cx: number, cy: number, s = 2): PocketNode {
  return {
    id, floorZ: -5, mouthZ: 0, open: false, through: true,
    region: square(cx, cy, s), floors: [], islands: [], children: [], remainder: [], narrowest: s,
  };
}

function treeWith(opts: { up: [number, number, number]; stockTop: number; stockBottom: number; pockets?: PocketNode[] }): FeatureTree {
  const outline: [number, number][][] = [[[0, 0], [5, 0], [5, 5], [0, 5]]];
  return {
    frame: { up: opts.up, stockTop: opts.stockTop, stockBottom: opts.stockBottom, partTop: opts.stockTop, partBottom: opts.stockBottom },
    levels: [],
    top: { z: opts.stockTop, floors: [], area: 0 },
    contour: { outline, area: 0, zTo: opts.stockBottom, frees: true, shoulders: [] },
    pockets: opts.pockets ?? [],
    rims: [], remainder: [], unreachable: [],
    report: { source: 'mesh', patches: 0, planarArea: 0, remainderArea: 0, tolerances: TOL, slivers: [], notes: [] },
  };
}

// EXACTLY `registration965.spec.ts`'s own (a) fixture: a genuine, worked, non-zero offset of
// (2, 3) — re-derived here, not re-invented, so the two specs can never silently disagree about
// what "a real offset" looks like.
const tree0 = treeWith({ up: [0, 0, 1], stockTop: 0, stockBottom: -10, pockets: [throughHole('dowel-left', 5, 5), throughHole('dowel-right', 25, 15)] });
const treeN = treeWith({ up: [0, 0, -1], stockTop: 10, stockBottom: 0, pockets: [throughHole('thru-1', 23, -12), throughHole('thru-2', 3, -2)] });

/** A STEP in world X at x = 10: z = 0 for x < 10, z = −10 for x >= 10 — chosen so that querying
 * at the SAME local point with vs without the registration offset applied lands on OPPOSITE
 * sides of the step, a 10 mm discrepancy impossible to mistake for numerical noise. */
function stepMesh(): DropCutterMesh {
  const M = 1000;
  const positions = new Float32Array([
    -M, -M, 0, 10, -M, 0, 10, M, 0,
    -M, -M, 0, 10, M, 0, -M, M, 0,
    10, -M, -10, M, -M, -10, M, M, -10,
    10, -M, -10, M, M, -10, 10, M, -10,
  ]);
  const indices = new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  return { positions, indices, triangleCount: 4 };
}

const probeFlat: Tool = flatEndMill(1, { number: 2, id: 'probe-flat-1', name: 'probe-flat-1' });
const profile = profileOf(probeFlat)!;

describe('#965 — oppositeSurfaceSafeDepthMm must agree with mapIRToDocument about where a point is', () => {
  const registration = registerSetupOrigin(tree0, treeN);
  const mesh = stepMesh();
  // A local point whose naive (no-offset) world X (9) and offset-corrected world X (11) sit on
  // OPPOSITE sides of the step at world X = 10.
  const LOCAL_X = 9;
  const LOCAL_Y = 0;

  it('the registration fixture really does produce a non-zero offset (sanity on the shared fixture)', () => {
    expect(registration.offsetMm[0]).toBeCloseTo(2, 9);
    expect(registration.offsetMm[1]).toBeCloseTo(3, 9);
  });

  it('the posted program places this local point at world (11, 3), not (9, 0)', () => {
    const ir: ToolpathIR = {
      frame: 'flat', tool: probeFlat, toolNumber: 2, spindleRpm: 12000, air: true, safeZ: 10, hopZ: 3,
      operations: [{ number: 1, name: 'probe', labelId: 'probe', depth: 1, depthPasses: 1, passStepMm: 1, moves: [{ kind: 'feed', x: LOCAL_X, y: LOCAL_Y, z: -1, f: 100 }], estimatedSeconds: 0 }],
    };
    const mapped = mapIRToDocument(ir, treeN.frame, registration.offsetMm);
    const move = mapped.operations[0]!.moves[0]!;
    expect([move.x, move.y]).toEqual(documentXY(treeN.frame, LOCAL_X, LOCAL_Y, registration.offsetMm));
    expect([move.x, move.y]).toEqual([11, 3]);
  });

  it('the freeing-cl safety check must read the surface at that SAME world point (11, 3), the far side of the step — not the near side at (9, 0)', () => {
    // The CORRECT answer, computed from first principles against the mesh directly: at world
    // (11, 3) the surface is at z = -10, so (per oppositeSurfaceSafeDepthMm's own formula)
    // d_max = surfaceWorldZ + stockTop - margin = -10 + 10 - margin = -margin — the cut is barely
    // allowed to touch the stock top at all, because the opposite setup already cut almost all
    // the way through there.
    const safe = oppositeSurfaceSafeDepthMm(treeN.frame, profile, mesh, LOCAL_X, LOCAL_Y, undefined, registration.offsetMm);
    expect(safe).not.toBeNull();
    expect(safe!).toBeLessThan(1); // near zero, not the near side's generous ~10
  });
});
