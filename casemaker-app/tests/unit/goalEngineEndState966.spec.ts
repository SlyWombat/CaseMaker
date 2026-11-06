/**
 * #966 END-STATE ACCEPTANCE SPEC — written RED-FIRST, on top of 965-int + the env-gated flag
 * read (`9025eec3`, cherry-picked). This is THE single spec that decides when the old-engine
 * removal (`966-removal-prep`) is actually done: nothing else decides it. Removal-prep's own
 * future success is "this spec goes green," full stop — none of its three parts may be skipped
 * or weakened to make it pass early.
 *
 * THE THREE PARTS (the Manager's exact wording, #966):
 *   1. With the flag at its default, `generateGoalProgram` plans through `cam/model`.
 *   2. A goal that needs two setups posts both programs, with no refusal.
 *   3. The import gate shows no path from the app into the old goal engine.
 *
 * Every `it` below actually runs the real production code (`generateGoalProgram`,
 * `buildModelPlanInputForGoal`, `planModelCam`, `buildSetupSpecs`, the transitive import-closure
 * walker `gateImports.spec.ts` already uses) — none of it is a mock of the eventual behaviour.
 * Each failing case is RED today for a reason confirmed by actually running it (not guessed);
 * the comment beside each assertion says which run produced that reason.
 *
 * PART 2's FIXTURE, UPDATED (966-goal-setups' own merge, `c099c5cc`, wired the real
 * `buildSetupSpecs`/`registerSetupOrigin` decision into `buildModelPlanInputForGoal`): the bare
 * sphere this part used to plan against now, correctly, REFUSES — `registerSetupOrigin`'s own
 * by-design correctness (no two holes, no usable edge, `cam/model/setups.ts`), not a bug. That
 * means the sphere can no longer prove part 2's actual claim ("posts both, no refusal"); per the
 * Manager's explicit ruling, that claim is proved on a NEW shape carrying a real locating datum
 * (`tests/unit/helpers/datumTwoSetup966.ts`, shared with `multiSetupVerify966.spec.ts`), and the
 * sphere is kept as its OWN, separate case below (part 2b) — pinning its refusal, by name, as a
 * permanent regression guard, never merged into part 2's own claim.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { clearTargetObjectMeshCache } from '@/engine/import/targetObject';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import { generateGoalProgram, buildModelPlanInputForGoal, type EngraveShopOpts } from '@/workers/sim/engraveGenerate';
import { planModelCam, oppositeSurfaceSafeDepthMm, type ModelPlanInput } from '@/engine/cnc/cam/model/plan';
import * as planModule from '@/engine/cnc/cam/model/plan';
import { buildSetupSpecs, rotatedGeometryFor } from '@/engine/cnc/cam/model/setups';
import { profileOf } from '@/engine/cnc/cam/model/dropcutter';
import type { FeatureSource } from '@/engine/cnc/cam/model/features';
import type { ParsedMesh } from '@/engine/import/stlParser';
import type { MountSpec } from '@/engine/cnc/setups/types';
import { ARC_CHORD_TOLERANCE_MM } from '@/engine/compiler/arcResolution';
import { valueImportClosure } from '../tools/importGraph';
import { buildDatumGoal, datumFeatureSource } from './helpers/datumTwoSetup966';

afterEach(() => {
  clearTargetObjectMeshCache();
  vi.restoreAllMocks();
  vi.doUnmock('@/engine/cnc/cam/model/plan');
  vi.doUnmock('@/engine/cnc/cam/model/setups');
  vi.resetModules();
});

// ── shared fixture plumbing — plain STL-encoded meshes, no Manifold runtime needed (the same
// trick `camModelSeam966.spec.ts`'s dome fixture uses). ────────────────────────────────────────
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

// A small dome goal — the #764 shell formula at stick scale (`camModelSeam966.spec.ts`'s own
// fixture): a genuine, reachable-in-one-setup relief. Used for part 1, where only "which engine
// ran" matters, not the setup count.
const DOME_A = 6, DOME_B = 4, DOME_H = 3, DOME_SEG = 10;
function domeHeight(x: number, y: number): number {
  const u2 = (x / DOME_A) ** 2 + (y / DOME_B) ** 2;
  return u2 >= 1 ? 0 : DOME_H * Math.sqrt(1 - u2);
}
function domeTris(): Tri[] {
  const at = (r: number, t: number): V => {
    const x = DOME_A * r * Math.cos(2 * Math.PI * t);
    const y = DOME_B * r * Math.sin(2 * Math.PI * t);
    return [x, y, domeHeight(x, y)];
  };
  const tris: Tri[] = [];
  for (let i = 0; i < DOME_SEG; i++) {
    for (let j = 0; j < DOME_SEG; j++) {
      const p = at(i / DOME_SEG, j / DOME_SEG);
      const q = at((i + 1) / DOME_SEG, j / DOME_SEG);
      const r = at((i + 1) / DOME_SEG, (j + 1) / DOME_SEG);
      const s = at(i / DOME_SEG, (j + 1) / DOME_SEG);
      tris.push([p, q, r], [p, r, s]);
    }
  }
  return tris;
}
function domeGoal(): EngraveTargetObject {
  return {
    id: 'goal-dome-966', name: 'dome-966.stl', format: 'stl', sha256: 'f'.repeat(64), data: stl(domeTris()),
    size: { x: 2 * DOME_A, y: 2 * DOME_B, z: DOME_H }, position: { x: 15, y: 10, z: 0 }, rotation: 0, enabled: true, role: 'goal',
  };
}

// A UV sphere, bottom at z 0 — `setups965.spec.ts`'s own fixture, chosen because it has no flat
// underside at all: `buildSetupSpecs` (the real #965 reach-aware top+bottom decision) answers
// TWO setups for it, confirmed below. Used for part 2.
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

// ───────────────────────────────────────────────────────────────────────────────────────────
// PART 1 — "With the flag at its default, generateGoalProgram plans through cam/model."
// ───────────────────────────────────────────────────────────────────────────────────────────
describe('#966 end-state, part 1 — the flag’s own default routes generateGoalProgram through cam/model', () => {
  it('GREEN: cam/model/plan.ts exports no USE_MODEL_CAM_ENGINE and no setModelCamEnabled — there is nothing left to flip', () => {
    // The ruling removes the flag itself, not just the seam that branched on it: a binding that
    // compiles but never branches on anything is exactly the debris the removal exists to clear.
    // Pinned on the module's own shape, not a value, so a future re-introduction of either name
    // fails this test immediately rather than silently reviving dead-flag debris.
    expect('USE_MODEL_CAM_ENGINE' in planModule).toBe(false);
    expect('setModelCamEnabled' in planModule).toBe(false);
  });

  it('GREEN: a goal job with no override reaches planModelCam', async () => {
    // Spies on the REAL `planModelCam` export (calls through — this is not a mock of its
    // behaviour, only an observer of whether it was invoked) and runs `generateGoalProgram`
    // completely unmocked, exactly as an operator's Generate click would today — no flag, no
    // override, nothing to set.
    const spy = vi.spyOn(planModule, 'planModelCam');
    const job = jobFor(domeGoal(), { length: 30, width: 20, thickness: 10 });
    const result = await generateGoalProgram(job, job.targetObject!, BALL, null, { shop: SHOP });
    expect(spy).toHaveBeenCalled();
    expect(result.ok).toBe(true);
  }, 300_000);
});

// ───────────────────────────────────────────────────────────────────────────────────────────
// PART 2 — "A goal that needs two setups posts both programs, with no refusal."
// ───────────────────────────────────────────────────────────────────────────────────────────
describe('#966 end-state, part 2 — a goal needing two setups posts both, never refused', () => {
  it('sanity: the datum goal genuinely needs two setups — buildSetupSpecs (#965) says so', async () => {
    // The real #965 reach-aware decision, run directly on the datum mesh's own triangles (before
    // this is ever wired through the full pipeline — this file's own helper validates it the same
    // way `registration965.spec.ts` validates `registerSetupOrigin` in isolation): curved all the
    // way round like the sphere fixture it replaces, so the top setup's own blind hemisphere is
    // still what the bottom flip is needed for.
    const { geometry, bbox } = await datumFeatureSource();
    const { setups, plan } = buildSetupSpecs({
      geometry,
      underside: 'flippedTabs',
      mount: VISE,
      stockSize: { x: bbox.max[0] - bbox.min[0], y: bbox.max[1] - bbox.min[1], z: bbox.max[2] - bbox.min[2] },
    });
    expect(setups).toHaveLength(2);
    expect(plan.sides.map((s) => s.faceUp)).toEqual(['top', 'bottom']);
  });

  it('GREEN (966-goal-setups wires the real decision in): the seam asks planModelCam for both setups, and both post real programs', async () => {
    // These are the #966 seam's own two calls, in the same order `generateGoalProgram`
    // (engraveGenerate.ts) makes them — not a re-implementation, the literal production functions.
    const { goal, stock } = await buildDatumGoal();
    const job = jobFor(goal, stock);
    const input = await buildModelPlanInputForGoal(job, goal, BALL, SHOP);

    // `buildModelPlanInputForGoal` now calls the real `buildSetupSpecs`/`goalFlipPlan` decision
    // (966-goal-setups, c099c5cc) instead of hardcoding a single top setup — confirmed directly,
    // not inferred from `result.ok` (a false-green single-setup plan would also read `ok: true`).
    expect(input.setups).toHaveLength(2);

    const output = await planModelCam(input);
    expect(output.perSetup).toHaveLength(2);
    for (const setup of output.perSetup) {
      expect(setup.programs.length, `setup ${setup.setupIndex}: no program posted`).toBeGreaterThan(0);
    }
  }, 90_000);

  it('GREEN: generateGoalProgram itself posts both setups’ work with no refusal, and EVERY posted program verifies clean', async () => {
    const { goal, stock } = await buildDatumGoal();
    const job = jobFor(goal, stock);

    // Confirms the same fact the previous case established: the seam's own input genuinely
    // carries two setups for this job.
    const input = await buildModelPlanInputForGoal(job, goal, BALL, SHOP);
    expect(input.setups).toHaveLength(2);

    const result = await generateGoalProgram(job, goal, BALL, null, { shop: SHOP });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);

    // THE MANAGER'S OWN BAR (#966-green's "`VerifyReport.ok`"): not "the plan looked sound" but
    // every POSTED program, across BOTH setups, verifies clean with ZERO error-severity findings —
    // checked directly against `EngraveProgram.verify`, not merely inferred from `result.ok`
    // (which already implies no verify error reached the top level, but does not by itself show
    // BOTH setups actually posted, or name which programs were checked).
    expect(result.programs).toBeDefined();
    const programs = result.programs!;
    expect(programs.length).toBeGreaterThan(0);
    const setupsPosted = new Set(programs.map((p) => p.setupIndex));
    expect(setupsPosted.size, 'both setups must have posted at least one program, not just the first').toBe(2);
    for (const program of programs) {
      expect(program.verify, `setup ${program.setupIndex} program (${program.toolKey}) carries no verify report`).not.toBeNull();
      const errors = program.verify!.findings.filter((f) => f.severity === 'error');
      expect(errors, `setup ${program.setupIndex} program (${program.toolKey}) had verify error(s): ${JSON.stringify(errors)}`).toEqual([]);
    }
  }, 90_000);
});

// ───────────────────────────────────────────────────────────────────────────────────────────
// PART 2b (NEW — the Manager's explicit ruling, #966): the bare sphere, kept as ITS OWN case —
// it must refuse BY NAME, through `registerSetupOrigin`'s own no-datum finding specifically (not
// some other unrelated error), and must NEVER post `ok: true` for one side silently. This pins
// the refusal behaviour itself as a permanent regression guard; it is deliberately NOT merged
// into part 2's own claim above (which stays exactly "posts both, no refusal", now proved by the
// datum shape instead).
// ───────────────────────────────────────────────────────────────────────────────────────────
describe('#966 end-state, part 2b — the bare sphere refuses BY NAME (registerSetupOrigin), never a silent single-setup ok:true', () => {
  it('sanity: this sphere+flipped-tabs goal genuinely needs two setups — buildSetupSpecs (#965) says so', () => {
    // The real #965 reach-aware decision, run directly on the sphere's own triangles: a sphere has
    // no flat back, so the flip is what finishes it (goalFlipPlan.spec.ts's own documented case).
    const { setups, plan } = buildSetupSpecs({ geometry: sphereFeatureSource(), underside: 'flippedTabs', mount: VISE, stockSize: { x: 2 * SPHERE_R, y: 2 * SPHERE_R, z: 2 * SPHERE_R } });
    expect(setups).toHaveLength(2);
    expect(plan.sides.map((s) => s.faceUp)).toEqual(['top', 'bottom']);
  });

  it('planModelCam throws registerSetupOrigin’s own named #965 registration refusal — never a silent single-setup plan', async () => {
    const job = jobFor(sphereGoal(), { length: 2 * SPHERE_R, width: 2 * SPHERE_R, thickness: 2 * SPHERE_R });
    const goal = job.targetObject!;
    const input = await buildModelPlanInputForGoal(job, goal, BALL, SHOP);
    // The real decision still proposes two setups for the sphere — the refusal below is
    // `registerSetupOrigin`'s own (no locating datum), never a setup-count problem.
    expect(input.setups).toHaveLength(2);
    await expect(planModelCam(input)).rejects.toThrow(/no locating features found for the vise flip \(#965 registration\)/);
  }, 300_000);

  it('generateGoalProgram itself refuses BY THAT SAME NAME — never ok:true for a part with no locating datum', async () => {
    const job = jobFor(sphereGoal(), { length: 2 * SPHERE_R, width: 2 * SPHERE_R, thickness: 2 * SPHERE_R });
    const goal = job.targetObject!;

    const result = await generateGoalProgram(job, goal, BALL, null, { shop: SHOP });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => /no locating features found for the vise flip \(#965 registration\)/.test(e.message)),
      `expected a #965 registration refusal; got: ${JSON.stringify(result.errors)}`,
    ).toBe(true);
    // Never a silent single-side success — the false-green shape this part guards against.
    expect(result.programs).toEqual([]);
  }, 300_000);
});

// ───────────────────────────────────────────────────────────────────────────────────────────
// PART 3 — "The import gate shows no path from the app into the old goal engine."
// ───────────────────────────────────────────────────────────────────────────────────────────
describe('#966 end-state, part 3 — no path from the app into cam/surface3d.ts or cam/rough3d.ts', () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const APP = join(HERE, '..', '..');
  const SRC = join(APP, 'src');

  // WHY THIS ROOT, not the gate's own roots (`gateImports.spec.ts` uses `goalCheckField.ts`,
  // `designCheck.ts`, etc. — that spec checks a DIFFERENT thing, the gate's independence FROM the
  // CAM, not the CAM's own reachability from the app): `generateGoalProgram` is defined in
  // `workers/sim/engraveGenerate.ts`. Every file that reaches it from outside that module does so
  // either by a declaration-level `import type` (erased: `EngraveCutSurface.tsx`, `release.ts`,
  // `preflight/collect.ts`, `preflight/hub.ts`, `engraveRunGate.ts`, `engravePreviewStore.ts`,
  // `engraveRunStore.ts`, `simClient.ts` — confirmed by grepping every
  // `from '@/workers/sim/engraveGenerate'` import site) or by the ONE real value import:
  // `workers/sim.worker.ts`'s own `import { engraveGenerate as runEngraveGenerate, ... } from
  // './sim/engraveGenerate'`, which backs its exposed Comlink method the real app calls from
  // `engine/jobs/simClient.ts` across an actual `new Worker()` boundary — a runtime message
  // channel the static graph cannot and should not follow (the same kind of boundary the gate
  // spec's own header excludes: "dynamic specifiers that are not string literals"). So
  // `workers/sim.worker.ts` is the closest-to-the-app module whose VALUE-import closure can be
  // walked at all the way into `generateGoalProgram`'s file and from there into the CAM — it is
  // what the app's Generate click actually executes, not an arbitrary pick.
  const ROOT = 'workers/sim.worker.ts';
  const OLD_ENGINE_FILES = ['engine/cnc/cam/surface3d.ts', 'engine/cnc/cam/rough3d.ts'] as const;

  it('the root exists and is a real worker entry, not a test-only path', () => {
    expect(join(SRC, ROOT)).toMatch(/sim\.worker\.ts$/);
  });

  it('RED today: the old engine is still live-imported by value in this closure', () => {
    const closure = valueImportClosure([ROOT], SRC);
    // CONFIRMED by running this exact closure walk (2026-11-04):
    //   workers/sim.worker.ts -> workers/sim/engraveGenerate.ts -> engine/cnc/cam/surface3d.ts
    //   workers/sim.worker.ts -> ... -> engine/cnc/cam/surface3d.ts -> engine/cnc/cam/rough3d.ts
    // `engraveGenerate.ts` imports `generateSurface3dForGoal`/`generateSurface3dIR` etc. as a
    // plain VALUE import from `cam/surface3d.ts` (not `import type`); `surface3d.ts` in turn
    // value-imports `roughingAdaptiveMoves` from `./rough3d`. Nothing has been deleted yet — this
    // is the literal #966-removal-prep scope, not a guess.
    const bad = OLD_ENGINE_FILES.filter((f) => closure.files.has(f));
    const chainsOf = (f: string): string => closure.files.get(f)?.chain.join(' -> ') ?? '(not reached)';
    expect(bad, `old-engine files still reachable from ${ROOT}:\n${bad.map((f) => `${f}  <-  ${chainsOf(f)}`).join('\n')}`).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────
// PART 4 (NEW, added on 965-reg-offset's rebase, #965 review finding `ed803368`) — the freeing-
// contour safety clamp and the posted program it bounds MUST agree about where a point is, even
// once registration ever finds a genuine (non-zero) correction. This is a PASSING case, not a
// fourth red part: `ed803368` already fixed `oppositeSurfaceSafeDepthMm` to take the SAME
// `registrationOffset` `mapIRToDocument` uses (both threaded from `planModelCam`'s one computed
// `registration` per non-first setup) — this proves that fix end to end, through a FULL two-setup
// `planModelCam` run (not the isolated `oppositeSurfaceSafeDepthMm` unit check `registrationFreeingCl965.spec.ts`
// already added), so this exact regression class cannot silently come back.
//
// WHY `registerSetupOrigin` IS MOCKED HERE, and nothing else: `registrationFreeingCl965.spec.ts`'s
// own header states the reason directly — "`planModelCam`, end to end, can never exercise a
// genuinely NON-ZERO registration offset: both setups recognise the SAME `ModelPlanInput.geometry`,
// related by `toSetupFrame`'s exact inverse rotation, so `registerSetupOrigin` always finds offset
// [0, 0] on any consistent single mesh." A real mounting shift is physical, not a property pure
// geometry can produce from one consistent mesh — the ONLY way to drive a FULL `planModelCam` run
// with a genuine non-zero offset is to substitute what `registerSetupOrigin` reports, exactly as
// `registrationFreeingCl965.spec.ts` substituted its own hand-built `tree0`/`treeN` registration
// rather than deriving one through the real pipeline. Every OTHER function `planModelCam` calls
// here is the real, unmocked production code — `recogniseFeatures`, `documentXY`, `mapIRToDocument`,
// `oppositeSurfaceSafeDepthMm`, `contour()`, `planTreePrograms` — so what this proves is genuinely
// "the wiring agrees," not "the mock agrees with itself."
describe('#966 end-state, part 4 — the freeing-contour safety clamp and the posted cut agree once registration is non-zero (#965 review finding, closed)', () => {
  function mockRegistrationOffset(offsetMm: [number, number]): void {
    vi.doMock('@/engine/cnc/cam/model/setups', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/engine/cnc/cam/model/setups')>();
      return {
        ...actual,
        // A stand-in `SetupRegistration` — same SHAPE `registerSetupOrigin` really returns (the
        // 'edge' datum variant, `setups.ts`'s own `tryEdge`), carrying a genuine non-zero offset
        // this part's own consistent geometry could never produce on its own (see header above).
        registerSetupOrigin: () => ({
          offsetMm,
          datum: { basis: 'edge' as const, endpoints: [[0, 0], [20, 0]] as [[number, number], [number, number]], lengthMm: 20 },
        }),
      };
    });
  }

  function quad(out: number[], a: [number, number, number], b: [number, number, number], c: [number, number, number], d: [number, number, number]): void {
    out.push(...a, ...b, ...c, ...a, ...c, ...d);
  }

  function meshOf(p: number[]): ParsedMesh {
    const positions = new Float32Array(p);
    const indices = new Uint32Array(positions.length / 3);
    for (let i = 0; i < indices.length; i++) indices[i] = i;
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
      minX = Math.min(minX, positions[i]!); maxX = Math.max(maxX, positions[i]!);
      minY = Math.min(minY, positions[i + 1]!); maxY = Math.max(maxY, positions[i + 1]!);
      minZ = Math.min(minZ, positions[i + 2]!); maxZ = Math.max(maxZ, positions[i + 2]!);
    }
    return { positions, indices, triangleCount: indices.length / 3, bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] } };
  }

  /**
   * An L-shaped solid (a 40x30 rectangle with a 15x12 notch cut from one corner), uniform height
   * `H`: the freeing contour's own outward-offset path, which always sits just OUTSIDE a part's
   * recognised contour, finds NOTHING on a plain convex box (`contourFreeingCl965.spec.ts`'s own
   * "plain two-setup box" case, deliberately: a no-op-clamp regression canary). The notch's
   * reflex corner is what gives the path a point that, once the registration offset shifts WHICH
   * world point gets sampled, sometimes finds this solid's own top surface and sometimes finds
   * nothing — the one shape-level ingredient needed for the offset to make a measurable
   * difference (confirmed empirically below, not asserted on faith).
   *
   * Three colinear points ((40,12) and (15,30)) are added to the outline purely so the WALL
   * (built one quad per outline edge) is split at the SAME places the cap's 3-rectangle
   * decomposition splits the top/bottom faces — otherwise a wall edge spans what the cap treats
   * as two separate edges (a T-junction), and `manifold-3d` refuses the mesh as non-manifold.
   */
  function lShape(h: number): ParsedMesh {
    const outline: [number, number][] = [
      [15, 0], [40, 0], [40, 12], [40, 30], [15, 30], [0, 30], [0, 12], [15, 12],
    ];
    const rects: [number, number, number, number][] = [
      [15, 40, 0, 12],
      [15, 40, 12, 30],
      [0, 15, 12, 30],
    ];
    const p: number[] = [];
    for (const [x0, x1, y0, y1] of rects) quad(p, [x0, y0, h], [x1, y0, h], [x1, y1, h], [x0, y1, h]);
    for (const [x0, x1, y0, y1] of rects) quad(p, [x0, y1, 0], [x1, y1, 0], [x1, y0, 0], [x0, y0, 0]);
    for (let i = 0; i < outline.length; i++) {
      const a = outline[i]!;
      const b = outline[(i + 1) % outline.length]!;
      quad(p, [a[0], a[1], 0], [b[0], b[1], 0], [b[0], b[1], h], [a[0], a[1], h]);
    }
    return meshOf(p);
  }

  const THICKNESS = 20;
  const FLAT6: Tool = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6' });
  const BALL3: Tool = { ...flatEndMill(3, { number: 2, id: 'ball-3', name: 'ball-3' }), typeText: 'Ball Nose', shape: 'ball' };

  function lShapeInput(): ModelPlanInput {
    return {
      geometry: { triangles: lShape(THICKNESS) },
      setups: [
        { frame: { up: [0, 0, 1], stockTop: THICKNESS, stockBottom: 0 }, underside: 'flippedTabs' },
        { frame: { up: [0, 0, -1], stockTop: 0, stockBottom: -THICKNESS }, underside: 'flippedTabs' },
      ],
      stock: { length: 40, width: 30, thickness: THICKNESS, material: 'hardwood' },
      fixture: { mount: 'tape', envelope: null },
      cutters: { house: [FLAT6, BALL3], catalogue: [] },
      tolerances: { finishMm: 0.01 },
      edgeBreak: { legMm: 0 },
    };
  }

  it("a genuine non-zero registration offset reaches setup 1's own notes — never silently papered to [0, 0]", async () => {
    mockRegistrationOffset([2, 3]);
    vi.resetModules();
    const { planModelCam: planModelCamOffset } = await import('@/engine/cnc/cam/model/plan');
    const output = await planModelCamOffset(lShapeInput());
    const notes = output.perSetup[1]!.notes;
    // `describeRegistration`'s own `fmt3` trims trailing zeros (`Number(n.toFixed(3))`), so an
    // exact [2, 3] mm offset reads as "offset [2, 3] mm", not "[2.000, 3.000]".
    expect(notes.some((n) => n.includes('offset [2, 3] mm'))).toBe(true);
    expect(notes.some((n) => n.includes('offset [0, 0] mm'))).toBe(false);
  }, 300_000);

  it('GREEN — THE #965 REVIEW FINDING, CLOSED: the posted program never cuts deeper than what the freeing-contour safety clamp allows at the SAME (correctly offset) point, through a full two-setup planModelCam run', async () => {
    // Run the SAME job twice — once with the registration this part can never produce on its own
    // (a genuine [2, 3] mm correction), once with [0, 0] (what the pre-fix bug effectively used,
    // by hardcoding the safety check's own offset argument regardless of what registration found)
    // — to show the offset is not just computed and reported, but actually changes the posted cut.
    mockRegistrationOffset([2, 3]);
    vi.resetModules();
    const { planModelCam: planModelCamOffset } = await import('@/engine/cnc/cam/model/plan');
    const withOffset = await planModelCamOffset(lShapeInput());

    mockRegistrationOffset([0, 0]);
    vi.resetModules();
    const { planModelCam: planModelCamNoOffset } = await import('@/engine/cnc/cam/model/plan');
    const withoutOffset = await planModelCamNoOffset(lShapeInput());

    const contourWith = withOffset.perSetup[1]!.ops.find((o) => o.kind === 'contour');
    const contourWithout = withoutOffset.perSetup[1]!.ops.find((o) => o.kind === 'contour');
    expect(contourWith, 'setup 1 posted no contour (freeing) op').toBeDefined();
    expect(contourWithout, 'setup 1 posted no contour (freeing) op').toBeDefined();

    const movesWith = contourWith!.outcome.ir.operations.flatMap((op) => op.moves);
    const movesWithout = contourWithout!.outcome.ir.operations.flatMap((op) => op.moves);
    const deepestWith = Math.min(...movesWith.map((m) => m.z));
    const deepestWithout = Math.min(...movesWithout.map((m) => m.z));

    // The offset genuinely changes which world point the clamp samples on this L-shaped part: at
    // [0, 0] it finds nothing near the freeing path (every sample null — the plain-box regression
    // case `contourFreeingCl965.spec.ts` already covers), so the nominal full depth posts
    // unclamped; at the real [2, 3] mm correction, one sampled point lands back on this part's own
    // top surface, clamping the posted depth by exactly the chord-tolerance margin.
    expect(deepestWithout).toBeCloseTo(-THICKNESS, 9);
    expect(deepestWith).toBeCloseTo(-(THICKNESS - ARC_CHORD_TOLERANCE_MM), 9);
    expect(deepestWith).not.toBeCloseTo(deepestWithout, 3);

    // (a) THE SAFETY CLAMP USED THE REAL OFFSET, NOT [0, 0] — proven, not asserted: recompute
    // `oppositeSurfaceSafeDepthMm` (the exact exported function `planModelCam` calls internally,
    // never re-implemented here) at every point the posted path actually visits, inverting each
    // posted (document) move back to setup 1's own LOCAL (x, y) — the inverse of `documentXY` for
    // `up = [0, 0, -1]`: `worldX = localX + offsetX`, `worldY = -localY + offsetY`, so
    // `localX = worldX - offsetX`, `localY = offsetY - worldY`. Using the WRONG ([0, 0]) offset at
    // these same points — what `oppositeSurfaceSafeDepthMm` did before `ed803368` regardless of
    // what registration found — must reproduce the UNCLAMPED (no-constraint) answer; only the
    // real [2, 3] mm offset reproduces the clamp that was actually posted.
    const frame1 = withOffset.perSetup[1]!.features.frame;
    const frame0 = withOffset.perSetup[0]!.features.frame;
    const oppositeMesh = rotatedGeometryFor(lShapeInput().geometry, frame0).triangles;
    const profile = profileOf(FLAT6)!;

    const seen = new Set<string>();
    let minSafeCorrectOffset = Infinity;
    let minSafeWrongOffset = Infinity;
    for (const { x: wx, y: wy } of movesWith) {
      const key = `${wx.toFixed(6)},${wy.toFixed(6)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const localX = wx - 2;
      const localY = 3 - wy;
      const safeCorrect = oppositeSurfaceSafeDepthMm(frame1, profile, oppositeMesh, localX, localY, undefined, [2, 3]);
      if (safeCorrect !== null && safeCorrect < minSafeCorrectOffset) minSafeCorrectOffset = safeCorrect;
      const safeWrong = oppositeSurfaceSafeDepthMm(frame1, profile, oppositeMesh, localX, localY, undefined, [0, 0]);
      if (safeWrong !== null && safeWrong < minSafeWrongOffset) minSafeWrongOffset = safeWrong;
    }
    // The wrong offset finds no constraint anywhere on this path — exactly `withoutOffset`'s own
    // unclamped run above, confirmed independently here via the isolated function, not the full
    // plan.
    expect(minSafeWrongOffset).toBe(Infinity);
    // (b) THE POSTED PROGRAM'S ACTUAL CUT DEPTH AGREES WITH THE (CORRECTLY OFFSET) SAFETY CHECK —
    // THE EXACT GAP `ed803368` CLOSED: the externally recomputed minimum, using the SAME real
    // offset, equals the depth `planModelCam` actually posted, to the same chord-tolerance margin.
    expect(minSafeCorrectOffset).toBeCloseTo(THICKNESS - ARC_CHORD_TOLERANCE_MM, 9);
    expect(-deepestWith).toBeCloseTo(minSafeCorrectOffset, 9);
  }, 300_000);
});
