// #966 — the two-setup analytic box fixture, factored out of `multiSetup966.spec.ts` so
// `multiSetupVerify966.spec.ts` (and any future #966 spec) drives the SAME geometry through
// `generateGoalProgram` rather than forking a second copy of the same triangle/STL/job-building
// logic. Nothing here is new: it is `multiSetup966.spec.ts`'s own helpers, moved verbatim.
//
// The box is the SAME 40 × 30 × 20 part `contourFreeingCl965.spec.ts`'s own section C already
// proves `planModelCam` plans end to end for two setups (registration via the edge datum, the
// freeing contour's opposite-surface clamp) — not a new, unproven shape.
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import type { EngraveShopOpts } from '@/workers/sim/engraveGenerate';
import type { SetupSpec } from '@/engine/cnc/cam/model/plan';
import { stl } from './meshes';

type V = [number, number, number];
type Tri = [V, V, V];

function quad(out: Tri[], a: V, b: V, c: V, d: V): void {
  out.push([a, b, c], [a, c, d]);
}

/** A closed box `L × W × T`, centred in XY, top at local Z 0 — `setups965.spec.ts`'s own `box`
 * helper, re-centred. */
export function boxTris(l: number, w: number, t: number): Tri[] {
  const x0 = -l / 2, x1 = l / 2, y0 = -w / 2, y1 = w / 2, z0 = -t, z1 = 0;
  const tris: Tri[] = [];
  quad(tris, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
  quad(tris, [x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0]);
  quad(tris, [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
  quad(tris, [x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]);
  quad(tris, [x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]);
  quad(tris, [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]);
  return tris;
}

/** Binary STL encoder — `camModelSeam966.spec.ts`'s own helper, unchanged. */
export function boxTarget(id: string, l: number, w: number, t: number): EngraveTargetObject {
  return {
    id,
    name: `${id}.stl`,
    format: 'stl',
    sha256: 'f'.repeat(64),
    data: stl(boxTris(l, w, t)),
    size: { x: l, y: w, z: t },
    position: { x: l / 2, y: w / 2, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
  };
}

export function jobFor(target: EngraveTargetObject, l: number, w: number, t: number): EngraveJob {
  return {
    ...defaultEngraveJob(),
    labels: [],
    shapes: [],
    stock: { ...defaultEngraveJob().stock, length: l, width: w, thickness: t },
    targetObject: target,
  };
}

export function entry(key: string, tool: Tool): ToolLibraryEntry {
  return { key, tool: { ...tool, id: key, number: null }, provenance: 'test fixture' };
}

// 3 mm, not 6 — hardwood's compiled fallback feeds table tops out at 3.2 mm (`feeds.ts`'s own
// rows); the MODEL engine's `resolvedCutParams` has an explicit flat-proxy substitution for a
// cutter outside that table (`cam/model/plan.ts`'s own header note), but the OLD heightfield path
// this spec's "flag off" case also exercises does not, so a 6 mm cutter refuses there with no
// feeds at all — picking a covered diameter keeps BOTH paths green on their own terms.
export const FLAT3: Tool = flatEndMill(3, { number: 1, id: 'flat-3', name: 'flat-3' });
export const SHOP: EngraveShopOpts = { tools: [entry('inv:flat-3', FLAT3)] };

/** Setup 0 (top) + setup 1 (bottom, the vise flip) — the placed mesh's own top at Z 0, bottom at
 * `-T`, the SAME convention `buildModelPlanInputForGoal`'s own single-setup default uses, just
 * supplied twice (`frameForFace`'s own formula for `stockTopZ = 0`: bottom's `stockTop` is the
 * thickness, `stockBottom` is `-stockTopZ`, numerically 0). */
export function twoSetups(t: number): SetupSpec[] {
  return [
    { frame: { up: [0, 0, 1], stockTop: 0, stockBottom: -t }, underside: 'flippedTabs' },
    { frame: { up: [0, 0, -1], stockTop: t, stockBottom: -0 }, underside: 'flippedTabs' },
  ];
}

export { stl };
