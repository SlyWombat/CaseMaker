/**
 * #966 — THE REAL SETUP DECISION. `buildModelPlanInputForGoal` (`workers/sim/engraveGenerate.ts`)
 * used to hardcode a single top-only `SetupSpec`, never calling `buildSetupSpecs` (#965's real
 * reach-aware top+bottom decision, `cam/model/setups.ts`). That meant a goal that geometrically
 * needs a second setup (no flat underside to rest the rest of the part on) still planned and
 * POSTED as `ok: true` with an incomplete, top-only plan — a silent-wrong-output bug, not a safe
 * refusal. `966-end-state`'s own acceptance spec (part 2, `goalEngineEndState966.spec.ts` on
 * `origin/966-end-state`) caught this with a UV-sphere fixture (`underside.kind: 'flipped-tabs'`,
 * no flat face anywhere): the same sphere, reused here (not reimplemented from scratch — same
 * triangle construction), drives the three cases below.
 *
 * THE MANAGER'S HARD REQUIREMENT, both BEFORE this fix and AFTER it: a goal that needs a second
 * setup must never post `ok: true` with only one setup's worth of programs. Before the fix that is
 * exactly what happened (case 1's "RED today" sub-case, run and confirmed below). After the fix,
 * `buildModelPlanInputForGoal` calls the real decision — and for THIS PARTICULAR sphere, the real,
 * CONFIRMED (by running the actual production code, not guessed) answer is a NAMED REFUSAL, not a
 * posted 2-setup plan: a bare sphere carries neither a through-hole pair nor a straight outline
 * edge for `registerSetupOrigin` (#965 registration) to anchor the flip on, so `planModelCam`
 * refuses by name rather than guessing a nominal origin. That is a CORRECT, pre-existing #965
 * refusal this fix does not touch — case 1 proves the fix turns "silently wrong" into "loudly
 * refuses," which is the whole point; case 2 proves the SAME thing through a different, deliberately
 * engineered mechanism (a bracket mount, where this module's own documented scope gap on
 * `documentXY`'s bottom-flip map fires) so the refusal path is shown from two independent causes,
 * not read as a fluke of one geometry.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { clearTargetObjectMeshCache } from '@/engine/import/targetObject';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import { buildModelPlanInputForGoal, type EngraveShopOpts } from '@/workers/sim/engraveGenerate';
import { planModelCam, type SetupSpec } from '@/engine/cnc/cam/model/plan';
import { buildSetupSpecs } from '@/engine/cnc/cam/model/setups';
import type { FeatureSource } from '@/engine/cnc/cam/model/features';
import type { ParsedMesh } from '@/engine/import/stlParser';
import type { MountSpec } from '@/engine/cnc/setups/types';

afterEach(() => {
  clearTargetObjectMeshCache();
  vi.restoreAllMocks();
  vi.doUnmock('@/engine/cnc/cam/model/plan');
  vi.resetModules();
});

// ── Fixture plumbing — the SAME plain STL-encoded sphere `966-end-state`'s own acceptance spec
// uses for its part 2 (reused, not reinvented): a UV sphere with no flat underside at all, so
// `buildSetupSpecs` (#965) genuinely decides it needs the flip, never a hand-picked override. ──
type V = [number, number, number];
type Tri = [V, V, V];

function stl(tris: readonly Tri[]): string {
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  let off = 84;
  for (const t of tris) {
    off += 12;
    for (const v of t) {
      dv.setFloat32(off, v[0], true);
      dv.setFloat32(off + 4, v[1], true);
      dv.setFloat32(off + 8, v[2], true);
      off += 12;
    }
    off += 2;
  }
  return Buffer.from(new Uint8Array(buf)).toString('base64');
}

function entry(key: string, tool: Tool): ToolLibraryEntry {
  return { key, tool: { ...tool, id: key, number: null }, provenance: 'test fixture' };
}

function jobFor(target: EngraveTargetObject, stock: { length: number; width: number; thickness: number }): EngraveJob {
  return {
    ...defaultEngraveJob(),
    labels: [],
    shapes: [],
    stock: { ...defaultEngraveJob().stock, ...stock },
    targetObject: target,
  };
}

const BALL: Tool = flatEndMill(2, { number: 1, id: 'ball-2', name: 'ball-2', shape: 'ball', typeText: 'Ball Nose' });
const FLAT: Tool = flatEndMill(3, { number: 2, id: 'flat-3', name: 'flat-3' });
const SHOP: EngraveShopOpts = { tools: [entry('inv:ball-2', BALL), entry('inv:flat-3', FLAT)] };

// A UV sphere, bottom at z 0 — `setups965.spec.ts`'s own fixture (same construction), chosen
// because it has no flat underside at all: `buildSetupSpecs` (the real #965 reach-aware top+bottom
// decision) answers TWO setups for it (confirmed in the sanity case below).
const SPHERE_R = 15;
function sphereTris(r: number, rings = 16, segs = 32): Tri[] {
  const at = (i: number, j: number): V => {
    const phi = (i / rings) * Math.PI;
    const theta = (j / segs) * 2 * Math.PI;
    return [r + r * Math.sin(phi) * Math.cos(theta), r + r * Math.sin(phi) * Math.sin(theta), r - r * Math.cos(phi)];
  };
  const tris: Tri[] = [];
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segs; j++) {
      const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1);
      tris.push([a, c, b], [a, d, c]); // outward winding, same convention goalFlipPlan.spec.ts uses
    }
  }
  return tris;
}
function sphereGoal(): EngraveTargetObject {
  return {
    id: 'goal-sphere-966', name: 'sphere-966.stl', format: 'stl', sha256: 'e'.repeat(64), data: stl(sphereTris(SPHERE_R)),
    size: { x: 2 * SPHERE_R, y: 2 * SPHERE_R, z: 2 * SPHERE_R }, position: { x: SPHERE_R, y: SPHERE_R, z: 0 }, rotation: 0, enabled: true, role: 'goal',
    // #898 — a full sphere has no flat bottom to rest on; `flipped-tabs` is the choice that offers
    // the flip to `buildSetupSpecs` at all ('flat' would exclude `bottom` by design, #898's rule).
    underside: { kind: 'flipped-tabs' },
  };
}

/** The sphere's raw triangles as a `FeatureSource`, for the direct `buildSetupSpecs` sanity check. */
function sphereFeatureSource(): FeatureSource {
  const tris = sphereTris(SPHERE_R);
  const positions = new Float32Array(tris.length * 9);
  let k = 0;
  for (const [a, b, c] of tris) for (const p of [a, b, c]) { positions[k++] = p[0]; positions[k++] = p[1]; positions[k++] = p[2]; }
  const indices = new Uint32Array(positions.length / 3);
  for (let i = 0; i < indices.length; i++) indices[i] = i;
  const triangles: ParsedMesh = { positions, indices, triangleCount: indices.length / 3, bbox: { min: [0, 0, 0], max: [2 * SPHERE_R, 2 * SPHERE_R, 2 * SPHERE_R] } };
  return { triangles };
}

const VISE: MountSpec = { kind: 'vise', viseOpeningMm: 120 };
const SPHERE_STOCK = { length: 2 * SPHERE_R, width: 2 * SPHERE_R, thickness: 2 * SPHERE_R };

// #966 — A HOLDOVER, NOW A PASSTHROUGH. There is no more flag to mock on: `generateGoalProgram`
// always plans through `cam/model`. Kept (rather than inlined at each call site) so this file's
// own diff stays small; every caller below is unaffected by the removal.
async function withModelCamFlagOn<T>(run: () => Promise<T>): Promise<T> {
  return run();
}

describe('#966 — buildModelPlanInputForGoal calls the real #965 setup decision', () => {
  it('sanity: this sphere+flipped-tabs goal genuinely needs two setups — buildSetupSpecs (#965) says so', () => {
    // The real #965 reach-aware decision, run directly on the sphere's own triangles — confirms
    // the fixture itself (not this issue's own code) is what demands a second setup.
    const { setups, plan } = buildSetupSpecs({
      geometry: sphereFeatureSource(),
      underside: 'flippedTabs',
      mount: VISE,
      stockSize: { x: 2 * SPHERE_R, y: 2 * SPHERE_R, z: 2 * SPHERE_R },
    });
    expect(setups).toHaveLength(2);
    expect(plan.sides.map((s) => s.faceUp)).toEqual(['top', 'bottom']);
  });

  it(
    'GREEN (was RED): buildModelPlanInputForGoal now calls the real decision instead of hardcoding one top setup',
    async () => {
      // Before #966-goal-setups: `input.setups` was hardcoded to length 1 for every goal,
      // regardless of mesh or `underside.kind` — confirmed by reverting this function's own diff
      // and rerunning this exact call (2026-11-04): `input.setups.length === 1`. After the fix,
      // the real `buildSetupSpecs` decision runs, and for this sphere it agrees with the sanity
      // case above: two setups, top then the flip.
      const job = jobFor(sphereGoal(), SPHERE_STOCK);
      const goal = job.targetObject!;
      const input = await buildModelPlanInputForGoal(job, goal, BALL, SHOP);
      expect(input.setups).toHaveLength(2);
      expect(input.setups[0]!.frame.up).toEqual([0, 0, 1]);
      expect(input.setups[1]!.frame.up).toEqual([0, 0, -1]);
    },
  );

  it(
    'CASE 1 — the seam no longer posts a silent single-setup ok:true for this sphere: it refuses, named, through planModelCam’s own #965 registration check',
    async () => {
      // These are the #966 seam's own two calls, in the same order `generateGoalProgram`
      // (engraveGenerate.ts) makes them — not a re-implementation, the literal production
      // functions. `input.setups` now has 2 entries (proven above); `planModelCam` must try to
      // register setup 2 against setup 0's own recognised geometry (#965 registration,
      // `registerSetupOrigin` in `cam/model/setups.ts`) before it can plan it.
      const job = jobFor(sphereGoal(), SPHERE_STOCK);
      const goal = job.targetObject!;
      const input = await buildModelPlanInputForGoal(job, goal, BALL, SHOP);
      expect(input.setups).toHaveLength(2);

      // CONFIRMED by running this exact call (2026-11-04): a bare UV sphere carries neither a
      // through-hole pair (it has no holes at all) nor a straight outline edge ≥ 15 mm (its own
      // silhouette is a circle, faceted into ~3 mm segments by this fixture's tessellation) for
      // `registerSetupOrigin` to anchor the flip on — so it throws the NAMED #965 registration
      // error rather than guessing a nominal [0, 0] origin. This is #965's own pre-existing,
      // correctly-functioning refusal (not something #966-goal-setups introduces): the point this
      // case proves is that the SEAM now actually reaches it, instead of never asking for a second
      // setup in the first place.
      await expect(planModelCam(input)).rejects.toThrow(/no locating features found for the vise flip \(#965 registration\)/);

      // The SAME thing, through the real seam end to end (`generateGoalProgram`, flag on): never
      // `ok: true` with a partial plan — a named refusal at stage 'cam', carrying the #965
      // registration message, not a bare stack trace.
      const result = await withModelCamFlagOn(async () => {
        const { generateGoalProgram: generateGoalProgramModelCam } = await import('@/workers/sim/engraveGenerate');
        return generateGoalProgramModelCam(job, goal, BALL, null, { shop: SHOP });
      });
      expect(result.ok).toBe(false);
      expect(result.stage).toBe('cam');
      expect(result.errors).toHaveLength(1);
      const message = result.errors[0]!.message;
      expect(message).toContain('cam/model seam (#966): planModelCam refused —');
      expect(message).toContain('#965 registration');
      expect(message).not.toMatch(/\n\s+at /); // a named finding, never a raw stack trace
      // Above all: never the old silent shape.
      expect(result.ok).not.toBe(true);
    },
      // TEMPORARY, #998 — C measured this exact fixture's own cost at 250–350 s, both
      // at this tip and at the base, against 28.7 s before the #965/#982 merges: a real,
      // open slowdown (C is bisecting it now), not load. Budget raised 90 s -> 600 s as a
      // holding measure; bring it back down with the #998 fix.
    600_000,
  );

  it(
    'CASE 2 — a second, independent refusal mechanism: a bracket mount cannot even BUILD the second setup, and that refuses by name too, never silently drops to one setup',
    async () => {
      // `frameForFace` (`cam/model/setups.ts`) states its own scope explicitly: the vise's bottom
      // flip is a half turn about X, which `documentXY` reproduces; a bracket/tape mount's own
      // bottom flip is a half turn about Y instead, which this module does NOT yet map — so it
      // throws, by name, rather than posting a silently-wrong document-frame map. This fires
      // during `buildModelPlanInputForGoal` itself (before `planModelCam` ever runs), which is
      // exactly the function #966-goal-setups changed — proving ITS OWN new call to
      // `buildSetupSpecs` propagates a genuine refusal rather than swallowing it.
      const job: EngraveJob = {
        ...jobFor(sphereGoal(), SPHERE_STOCK),
        workholding: { kind: 'bracket', bracket: { anchor: 1, variant: 'thin', clamps: [], source: 'default' } },
      };
      const goal = job.targetObject!;

      await expect(buildModelPlanInputForGoal(job, goal, BALL, SHOP)).rejects.toThrow(
        /a 'bottom' setup is only wired for a vise mount \(#965 stated scope\)/,
      );

      // The same thing, through the real seam: a named 'cam'-stage refusal, never `ok: true`.
      const result = await withModelCamFlagOn(async () => {
        const { generateGoalProgram: generateGoalProgramModelCam } = await import('@/workers/sim/engraveGenerate');
        return generateGoalProgramModelCam(job, goal, BALL, null, { shop: SHOP });
      });
      expect(result.ok).toBe(false);
      expect(result.stage).toBe('cam');
      expect(result.errors).toHaveLength(1);
      const message = result.errors[0]!.message;
      expect(message).toContain('cam/model seam (#966): could not build a ModelPlanInput');
      expect(message).toContain("a 'bottom' setup is only wired for a vise mount (#965 stated scope)");
      expect(message).not.toMatch(/\n\s+at /);
    },
      // TEMPORARY, #998 — C measured this exact fixture's own cost at 250–350 s, both
      // at this tip and at the base, against 28.7 s before the #965/#982 merges: a real,
      // open slowdown (C is bisecting it now), not load. Budget raised 90 s -> 600 s as a
      // holding measure; bring it back down with the #998 fix.
    600_000,
  );

  it(
    'the old test/e2e-only seam (setupsOverride) still wins unconditionally, byte-for-byte unchanged',
    async () => {
      // `multiSetup966.spec.ts`/`camModelSeam966.spec.ts` already depend on this seam to drive the
      // real posting path with a synthetic plan independent of any one mesh's own flip-plan
      // answer; this fix must not touch it.
      const job = jobFor(sphereGoal(), SPHERE_STOCK);
      const goal = job.targetObject!;
      const override: SetupSpec[] = [{ frame: { up: [0, 0, 1], stockTop: 0, stockBottom: -30 }, underside: 'flippedTabs' }];
      const input = await buildModelPlanInputForGoal(job, goal, BALL, SHOP, override);
      expect(input.setups).toBe(override);
      expect(input.setups).toHaveLength(1);
    },
  );
});
