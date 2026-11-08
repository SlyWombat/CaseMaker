/**
 * #1092 — A POCKET FLOOR PLANE IS ONLY VALID WHERE THE GOAL HAS A SURFACE AT THAT Z.
 *
 * The elephant's j29 card plans a coverage rest at `pocket-0`'s floor (−26.104) straight across
 * the elephant's own body (goal surface −1.36): 18.03 % of the goal adjudicated cut-into, 24.75 mm
 * deep. The rest's region is the SIMULATED LEFTOVER — the cells the chain so far leaves above the
 * goal — and over the body that leftover exists precisely BECAUSE the shadow-bounded primary was
 * right to leave it: the design stands there. `planRestRegion` then called `pocket()` without the
 * `aboveMaterial` ceiling every other pocket call site passes (#966/#970), so its one floor-level
 * pass had no bound at all and cut the body down to the floor.
 *
 * THE FIXTURE is the elephant in miniature, built through the real Manifold kernel: a baseplate,
 * four legs and a slab over them — an inter-leg gap recognised as a pocket with its floor at the
 * baseplate's top, and the slab closing over that same footprint from above (the #966 table). The
 * slab's top is a gentle slope from −2 mm at the part's low edge to the stock top at the high edge
 * — one continuous top land, the elephant's own gently-sloped body — so the goal over the gap sits
 * well ABOVE the pocket's floor, and no pocket stage of the chain removes it.
 *
 * THE RULE, as the analyst stated it: a floor pass may cut a pocket floor's cell only where the
 * goal's own surface sits at or below that pass's level. The check below is exactly that: every
 * feed move at the pocket floor inside the part's interior must have the goal at or below the
 * floor's own Z — not sixteen millimetres above it.
 *
 * RED on 7a7bac78c: the coverage rest is chosen (it claims the whole gap as "recovered coverage")
 * and cuts the gap to −18.5 under a goal of −2..0. GREEN once the rest's floor pass is bounded by
 * the same design mesh the primary's is. The 2 mm inset keeps the freeing cut at the part's
 * OUTLINE (where there is no goal surface) out of this question; the pocket and rest passes all
 * sit well inside it.
 */
import { describe, expect, it } from 'vitest';

import { tl, type ManifoldInstance } from './helpers/manifoldExec';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import { buildModelPlanInputForGoal, type EngraveShopOpts } from '@/workers/sim/engraveGenerate';
import { planModelCam, type ModelPlanOutput } from '@/engine/cnc/cam/model/plan';
import type { ParsedMesh } from '@/engine/import/stlParser';

// ───────────────────────────────────────────────────────────────────────────────────────────
// THE PART — local mm: a 40 × 40 baseplate (Z 0–5), four 6 × 6 legs inset 2 mm (Z 5–20), and a
// slab whose underside is flat at Z 20 and whose top slopes from 21.5 (x = 0) to 23.5 (x = 40).
// `placeTarget` puts the turned box's TOP at `position.z`, so at position.z = 0 the design spans
// −23.5..0: baseplate top −18.5, slab top −2..0. The inter-leg gap is the ONE recognised pocket
// (its mouth is the part's top); the slab stands over ALL of it — #966's overhang.
// ───────────────────────────────────────────────────────────────────────────────────────────

const FOOT = 40;
const BASE_Z = 5;
const LEG_TOP_Z = 20;
const SLAB_LOW_TOP_Z = 21.5; // x = 0
const SLAB_HIGH_TOP_Z = 23.5; // x = FOOT — the part's own top
const LEG = 6;
const INSET = 2;
const PART_TOP = SLAB_HIGH_TOP_Z; // the placement shift: every local Z lands at z - PART_TOP
const GAP_FLOOR = BASE_Z - PART_TOP; // −18.5 in the work frame
const SLAB_SLOPE = (SLAB_HIGH_TOP_Z - SLAB_LOW_TOP_Z) / FOOT; // mm of rise per mm of x

function parsed(solid: ManifoldInstance): ParsedMesh {
  const m = solid.getMesh();
  const n = m.vertProperties.length / m.numProp;
  const positions = new Float32Array(n * 3);
  for (let v = 0; v < n; v++) for (let k = 0; k < 3; k++) positions[3 * v + k] = m.vertProperties[v * m.numProp + k]!;
  solid.delete();
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i++) {
    min[i % 3] = Math.min(min[i % 3]!, positions[i]!);
    max[i % 3] = Math.max(max[i % 3]!, positions[i]!);
  }
  return { positions, indices: Uint32Array.from(m.triVerts), triangleCount: m.triVerts.length / 3, bbox: { min, max } };
}

function buildPart(withEdgeSliver = false): ManifoldInstance {
  const baseplate = tl.Manifold.cube([FOOT, FOOT, BASE_Z], false);
  // The slab: flat underside at LEG_TOP_Z, sloped top — one continuous top land, no recess beside
  // a peak, so the inter-leg gap stays the only pocket the tree recognises.
  const slab = tl.Manifold.hull([
    [0, 0, LEG_TOP_Z], [FOOT, 0, LEG_TOP_Z], [FOOT, FOOT, LEG_TOP_Z], [0, FOOT, LEG_TOP_Z],
    [0, 0, SLAB_LOW_TOP_Z], [FOOT, 0, SLAB_HIGH_TOP_Z], [FOOT, FOOT, SLAB_HIGH_TOP_Z], [0, FOOT, SLAB_LOW_TOP_Z],
  ]);
  const legAt = (x: number, y: number): ManifoldInstance =>
    tl.Manifold.cube([LEG, LEG, LEG_TOP_Z - BASE_Z], false).translate([x, y, BASE_Z]);
  const legs = [
    legAt(INSET, INSET),
    legAt(FOOT - INSET - LEG, INSET),
    legAt(INSET, FOOT - INSET - LEG),
    legAt(FOOT - INSET - LEG, FOOT - INSET - LEG),
  ];
  const solid = legs.reduce((acc, leg) => acc.add(leg), baseplate.add(slab));
  if (!withEdgeSliver) return solid;
  // #1092 — THE BLOCK-5 SLIVER. A one-cell (0.1 mm) slot through the slab at y 20.0-20.1,
  // exposing the baseplate's top — a goal surface AT the pocket's floor, but 0.1 mm wide. It is
  // not a floor the cutter (⌀3.175, r 1.59) can rest on: no disc-sized box of floor cells exists
  // inside it. The sliver stands beside the slab's own top (the standing body, 16.9 mm above the
  // floor), and without the safe-spot rule it is a witness that keeps the body's cells in the
  // rest's region — the exact mechanism of j29's leftover 4.9 x 5.3 mm block.
  const slot = tl.Manifold.cube([FOOT, 0.1, SLAB_HIGH_TOP_Z - LEG_TOP_Z + 1], false).translate([0, 20, LEG_TOP_Z]);
  return solid.subtract(slot);
}

/** A binary STL from the mesh (the goal target's own committed-format path). */
function binaryStl(mesh: ParsedMesh): string {
  const tris = mesh.triangleCount;
  const buf = new ArrayBuffer(84 + tris * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris, true);
  let off = 84;
  for (let t = 0; t < tris; t++) {
    off += 12; // normal left zero — the parser reads the vertices
    for (let k = 0; k < 3; k++) {
      const v = mesh.indices[t * 3 + k]! * 3;
      dv.setFloat32(off, mesh.positions[v]!, true);
      dv.setFloat32(off + 4, mesh.positions[v + 1]!, true);
      dv.setFloat32(off + 8, mesh.positions[v + 2]!, true);
      off += 12;
    }
    off += 2;
  }
  return Buffer.from(new Uint8Array(buf)).toString('base64');
}

let serial = 0;
function goalOf(part: ParsedMesh): EngraveTargetObject {
  return {
    id: `rest-${serial}`,
    name: `rest-${serial++}.stl`,
    format: 'stl',
    sha256: serial.toString(16).padStart(64, 'e'),
    data: binaryStl(part),
    size: { x: FOOT, y: FOOT, z: PART_TOP },
    // The turned box's top at z = 0; the stock IS the part's footprint, so XY is 0..40.
    position: { x: FOOT / 2, y: FOOT / 2, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
  };
}

function jobOf(target: EngraveTargetObject): EngraveJob {
  return {
    ...defaultEngraveJob(),
    labels: [],
    shapes: [], // a PURE GOAL job, exactly j29's own shape
    stock: { ...defaultEngraveJob().stock, length: FOOT, width: FOOT, thickness: 30 },
    targetObject: target,
  };
}

/** Both flats are house tools; the ⌀3.175 is the coverage-rest candidate the chain may add. */
const FLAT6: Tool = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6', fluteLength: 30 });
const FLAT3175: Tool = flatEndMill(3.175, { number: 2, id: 'flat-3.175', name: 'flat-3.175', fluteLength: 30 });
const entry = (key: string, tool: Tool): ToolLibraryEntry => ({ key, tool: { ...tool, id: key, number: null }, provenance: 'test fixture' });
const SHOP: EngraveShopOpts = { tools: [entry('inv:flat-6', FLAT6), entry('inv:flat-3.175', FLAT3175)] };

/**
 * The design's own top at a placed (x, y) — the slab's sloped top, which is the goal's very
 * surface over the gap. `null` outside the part's footprint (open air, not the goal's question).
 */
function designTop(x: number, y: number): number | null {
  if (x < 0 || x > FOOT || y < 0 || y > FOOT) return null;
  return SLAB_LOW_TOP_Z + SLAB_SLOPE * x - PART_TOP; // −2 at x = 0 … 0 at x = 40
}

/**
 * Every feed move at the POCKET FLOOR, inside the part's interior (a 2 mm inset keeps the freeing
 * cut at the outline out of the question), that lies below the goal's own surface there. The
 * analyst's rule, literally: the floor plane is valid only where the goal is at or below it.
 */
function floorPassesBelowGoal(out: ModelPlanOutput, stockTop: number, marginMm: number): string[] {
  const bad: string[] = [];
  for (const setup of out.perSetup) {
    for (const ir of setup.programs) {
      for (const operation of ir.operations) {
        for (const m of operation.moves) {
          if (m.kind !== 'feed') continue;
          if (m.x < INSET || m.x > FOOT - INSET || m.y < INSET || m.y > FOOT - INSET) continue;
          const absZ = m.z + stockTop;
          // The pocket's own recognized floor level (the fixture's gap floor): -18.5. The rest's
          // floor pass is exactly this Z; the primary's skin/top passes are far above it.
          if (absZ > GAP_FLOOR + 0.01) continue;
          const top = designTop(m.x, m.y);
          if (top === null) continue;
          if (absZ < top - marginMm) {
            bad.push(
              `${operation.name} (${ir.tool.name || ir.tool.shape}) at (${m.x.toFixed(2)}, ${m.y.toFixed(2)}): ` +
                `floor pass z ${absZ.toFixed(3)} is ${(top - absZ).toFixed(3)} mm below the goal's own surface (${top.toFixed(3)})`,
            );
          }
        }
      }
    }
  }
  return bad;
}

describe('#1092 a pocket floor plane is only valid where the goal has a surface at that depth', () => {
  it('no floor pass cuts below the goal\'s own top inside the part', async () => {
    const part = parsed(buildPart());
    const goal = goalOf(part);
    const job = jobOf(goal);
    const input = await buildModelPlanInputForGoal(job, goal, FLAT6, SHOP, 'top');
    const out = await planModelCam(input);
    expect(out.perSetup.length).toBeGreaterThanOrEqual(1);
    // Sanity on the fixture: the pocket chain must actually plan the gap, or nothing could gouge
    // and the red would be vacuous.
    expect(out.perSetup[0]!.ops.some((op) => op.kind === 'pocket')).toBe(true);

    const bad: string[] = [];
    for (const setup of out.perSetup) {
      // A top setup only: the fixture's design top is stated in the document frame (#970's own
      // stated scope for a single top setup).
      const [ux, uy, uz] = setup.features.frame.up;
      if (!(ux === 0 && uy === 0 && uz === 1)) continue;
      bad.push(...floorPassesBelowGoal(out, setup.features.frame.stockTop, 0.01));
    }
    expect(bad, bad.slice(0, 20).join('\n')).toEqual([]);
  }, 180_000);

  it('a one-cell floor sliver is not a floor: the body beside it must not be cut', async () => {
    // The block-5 case in miniature: the sliver is AT the pass floor, so an at-or-below witness
    // test accepts it and keeps the standing body's cells in the rest's region (red on the
    // 4ba70606 rule); the safe-spot test requires a spot where the WHOLE disc rests on floor, and
    // a 0.1 mm slot has none (green on 6870107f).
    const part = parsed(buildPart(true));
    const goal = goalOf(part);
    const job = jobOf(goal);
    const input = await buildModelPlanInputForGoal(job, goal, FLAT6, SHOP, 'top');
    const out = await planModelCam(input);
    expect(out.perSetup.length).toBeGreaterThanOrEqual(1);
    const bad: string[] = [];
    for (const setup of out.perSetup) {
      const [ux, uy, uz] = setup.features.frame.up;
      if (!(ux === 0 && uy === 0 && uz === 1)) continue;
      bad.push(...floorPassesBelowGoal(out, setup.features.frame.stockTop, 0.01));
    }
    expect(bad, bad.slice(0, 20).join('\n')).toEqual([]);
  }, 180_000);
});
