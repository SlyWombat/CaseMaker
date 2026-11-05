/**
 * #966 — STANDALONE REGRESSION SPEC: every program a multi-setup goal posts passes the REAL
 * verifier, end to end, with zero findings at the established bar. `multiSetup966.spec.ts`
 * already checks this inline, folded into its own broader "the plan carries the full
 * `ModelPlanOutput`" assertions; this file pulls that one claim out on its own so a future change
 * to the verifier (`src/engine/cnc/verify.ts`), to `postFor`, or to the multi-setup posting loop
 * in `generateGoalProgram` (`src/workers/sim/engraveGenerate.ts`) is caught here specifically,
 * not only as a side effect of a bigger spec's failure.
 *
 * WHAT "casemaker verify" ACTUALLY IS. There is no `casemaker verify` subcommand — `dispatch.ts`'s
 * own `USAGE` lists `cut`/`export`/`location`/`readback`/`machine` and nothing named `verify`. The
 * real verifier is `verifyProgram` (`src/engine/cnc/verify.ts`), and the codebase has exactly one
 * convention for calling it on a posted program: `postFor(mill)(ir, ctx, vacuum)` immediately
 * followed by `verifyProgram(posted.text, verifyCtx)` — the SAME pairing `facingProgram`,
 * `generateOneProgram`, `scripts/lib/casemaker/verifiedProgram.ts`'s `prepareVerifiedProgram`
 * (the body of `casemaker machine upload`'s own gate, #395), and `machineCommand.ts`'s receipt
 * printer all use. `generateGoalProgram`'s multi-setup posting loop (#966, this round) already
 * calls that SAME pairing for every one of its `SetupPlan.programs[]` entries and attaches the
 * resulting `VerifyReport` to `EngraveProgram.verify` — so reading `result.programs[i].verify`
 * here IS reading the real verifier's report on the real posted text, not a stand-in.
 *
 * There is, deliberately, no deeper CLI-level call to make instead: `casemaker cut`'s own
 * `engraveGenerate` → `generateGoalProgram` call never passes `modelSetupsOverride` (no production
 * caller does — see `multiSetup966.spec.ts`'s own header note), so a multi-setup goal cannot be
 * reached through the CLI today at all. This spec drives the exact same test-only seam
 * `multiSetup966.spec.ts` uses, because that is the only way to reach `planModelCam` with more
 * than one setup until #966-goal-setups lands `buildModelPlanInputForGoal`'s real setup decision.
 *
 * THE ZERO-FINDINGS BAR, STATED EXPLICITLY. `966-green`'s own bar (`camModelSeam966.spec.ts`,
 * both ROUND 1 and ROUND 2) is "zero ERROR-severity findings", not "zero findings of any
 * severity" — `verify.ts`'s own `VerifyReport.ok` is defined exactly that way
 * (`findings.every(f => f.severity !== 'error')`; the only two severities `VerifyFinding` has are
 * `'error'` and `'warning'`). This spec matches that SAME bar, not a stricter one: it asserts
 * `program.verify.ok === true` (equivalent to "no error-severity finding") for every posted
 * program, exactly as `multiSetup966.spec.ts`'s own ROUND 3 case already does by filtering on
 * `severity === 'error'`.
 *
 * THE SPHERE CASE, IMPLEMENTED (not the TODO's own guess at the shape): `966-goal-setups` has
 * since landed `buildModelPlanInputForGoal`'s real `buildSetupSpecs`/`registerSetupOrigin`
 * decision (`c099c5cc`) — run against a bare UV sphere, that decision correctly REFUSES (no two
 * holes, no usable edge for the vise-flip registration to anchor on, `cam/model/setups.ts`'s own
 * by-design correctness). So the sphere case below is a REFUSAL assertion, not a verify
 * assertion — there is nothing posted to verify once the plan itself refuses. The claim this
 * file's own header promises ("every program a multi-setup goal posts passes the real verifier")
 * is instead proved on a SECOND, NEW case: the same datum-bearing shape
 * `goalEngineEndState966.spec.ts`'s own part 2 uses (`tests/unit/helpers/datumTwoSetup966.ts`,
 * shared rather than forked a third time) — curved all the way round like the sphere (so it
 * genuinely needs the flip too), but carrying one real, un-mirrored locating edge
 * `registerSetupOrigin` finds in both setups, so it posts both setups' programs instead of
 * refusing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearTargetObjectMeshCache } from '@/engine/import/targetObject';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import { generateGoalProgram, buildModelPlanInputForGoal, type EngraveShopOpts } from '@/workers/sim/engraveGenerate';
import { planModelCam, setModelCamEnabled } from '@/engine/cnc/cam/model/plan';
// The box fixture is `multiSetup966.spec.ts`'s own — factored into a shared helper so this spec
// drives the SAME geometry instead of forking a second copy of the fixture logic.
import { boxTarget, jobFor, FLAT3, SHOP, twoSetups } from './helpers/twoSetupBox966';
// The datum fixture is `goalEngineEndState966.spec.ts`'s own part 2 helper — shared, not forked a
// third time (this file's own header).
import { buildDatumGoal } from './helpers/datumTwoSetup966';

afterEach(() => {
  clearTargetObjectMeshCache();
  setModelCamEnabled(false);
  vi.restoreAllMocks();
  vi.doUnmock('@/engine/cnc/cam/model/plan');
  vi.resetModules();
});

// ── The bare sphere — the SAME triangle construction `goalEngineEndState966.spec.ts`'s and
// `goalSetups966.spec.ts`'s own part 2 fixtures use, reused by copy (their own established
// convention: each #966 spec carries its own copy of this plain STL encoder rather than share a
// module across issues that do not otherwise depend on each other). Curved all the way round, no
// flat underside anywhere, so `buildSetupSpecs` genuinely decides it needs the flip — and, having
// neither a through-hole pair nor a usable straight edge, `registerSetupOrigin` genuinely refuses
// it (#965 registration), never a guessed nominal origin. ──
type V3 = [number, number, number];
type Tri3 = [V3, V3, V3];

function sphereStl(tris: readonly Tri3[]): string {
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

const SPHERE_R = 15;
function sphereTris(r: number, rings = 16, segs = 32): Tri3[] {
  const at = (i: number, j: number): V3 => {
    const phi = (i / rings) * Math.PI;
    const theta = (j / segs) * 2 * Math.PI;
    return [r + r * Math.sin(phi) * Math.cos(theta), r + r * Math.sin(phi) * Math.sin(theta), r - r * Math.cos(phi)];
  };
  const tris: Tri3[] = [];
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segs; j++) {
      const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1);
      tris.push([a, c, b], [a, d, c]);
    }
  }
  return tris;
}
function sphereGoal(): EngraveTargetObject {
  return {
    id: 'goal-sphere-verify966', name: 'sphere-verify966.stl', format: 'stl', sha256: 'e'.repeat(64), data: sphereStl(sphereTris(SPHERE_R)),
    size: { x: 2 * SPHERE_R, y: 2 * SPHERE_R, z: 2 * SPHERE_R }, position: { x: SPHERE_R, y: SPHERE_R, z: 0 }, rotation: 0, enabled: true, role: 'goal',
    underside: { kind: 'flipped-tabs' },
  };
}

function entry(key: string, tool: Tool): ToolLibraryEntry {
  return { key, tool: { ...tool, id: key, number: null }, provenance: 'test fixture' };
}

function jobForGoal(target: EngraveTargetObject, stock: { length: number; width: number; thickness: number }): EngraveJob {
  return {
    ...defaultEngraveJob(),
    labels: [],
    shapes: [],
    stock: { ...defaultEngraveJob().stock, ...stock },
    targetObject: target,
  };
}

const BALL: Tool = flatEndMill(2, { number: 1, id: 'ball-2', name: 'ball-2', shape: 'ball', typeText: 'Ball Nose' });
const FLAT: Tool = flatEndMill(3, { number: 2, id: 'flat-3-datum', name: 'flat-3-datum' });
const DATUM_SHOP: EngraveShopOpts = { tools: [entry('inv:ball-2', BALL), entry('inv:flat-3-datum', FLAT)] };

describe('#966 — every program a multi-setup goal posts passes the real verifier end to end', () => {
  it('two-setup box: every posted program, both setups, carries a VerifyReport with zero error-severity findings', async () => {
    setModelCamEnabled(true);
    const L = 40, W = 30, T = 20;
    const job = jobFor(boxTarget('goal-966-verify-box', L, W, T), L, W, T);
    const result = await generateGoalProgram(job, job.targetObject!, FLAT3, [], null, SHOP, undefined, undefined, twoSetups(T));

    expect(result.errors, result.errors.map((e) => `${e.stage}: ${e.message}`).join('\n')).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.stage).toBe('done');

    // Non-vacuous: both setups actually posted programs — otherwise the loop below would pass
    // trivially on a single-setup run and this spec would not be proving what it claims to.
    expect(result.programs.length).toBeGreaterThan(0);
    const setupIndexes = [...new Set(result.programs.map((p) => p.setupIndex))].sort();
    expect(setupIndexes).toEqual([1, 2]);

    // THE ACTUAL ASSERTION. Every posted program, across BOTH setups, has an `nc` body and a
    // `VerifyReport` (never null — #535's "null only on a surface program", which this multi-setup
    // 2.5D path never produces), and that report's own `ok` says "no error-severity finding" —
    // the SAME bar #966-green established, stated here as `verify.ok`, not re-derived differently.
    for (const program of result.programs) {
      const label = `setup ${program.setupIndex}/${program.toolKey}`;
      expect(program.nc, `${label}: no posted text`).toBeTruthy();
      expect(program.verify, `${label}: no verify report`).not.toBeNull();
      const errors = program.verify!.findings.filter((f) => f.severity === 'error');
      expect(errors, `${label}: ${errors.map((e) => e.message).join('; ')}`).toEqual([]);
      expect(program.verify!.ok, `${label}: verify.ok should agree with "no error-severity finding"`).toBe(true);
    }
  }, 90_000);

  // IMPLEMENTED (966-goal-setups landed `buildModelPlanInputForGoal`'s real setup decision,
  // `c099c5cc`): a bare sphere genuinely needs two setups (`buildSetupSpecs` says so, below), but
  // carries neither a through-hole pair nor a usable straight edge for `registerSetupOrigin` to
  // anchor the vise-flip registration on — so it REFUSES, by name, rather than posting a silent
  // single-side `ok: true`. A refusal-assertion, not a verify-assertion: nothing is posted to
  // verify once the plan itself refuses.
  it('two-setup SPHERE goal: refuses BY NAME through registerSetupOrigin — never a silent single-setup ok:true', async () => {
    const job = jobForGoal(sphereGoal(), { length: 2 * SPHERE_R, width: 2 * SPHERE_R, thickness: 2 * SPHERE_R });
    const goal = job.targetObject!;
    const input = await buildModelPlanInputForGoal(job, goal, BALL, DATUM_SHOP);
    // The real decision still proposes two setups — the refusal below is `registerSetupOrigin`'s
    // own (no locating datum), never a setup-count problem.
    expect(input.setups).toHaveLength(2);
    await expect(planModelCam(input)).rejects.toThrow(/no locating features found for the vise flip \(#965 registration\)/);

    setModelCamEnabled(true);
    const result = await generateGoalProgram(job, goal, BALL, [], null, DATUM_SHOP);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => /no locating features found for the vise flip \(#965 registration\)/.test(e.message)),
      `expected a #965 registration refusal; got: ${JSON.stringify(result.errors)}`,
    ).toBe(true);
    // Never the false-green shape this case guards against.
    expect(result.programs).toEqual([]);
  }, 90_000);

  // NEW (the Manager's ruling, #966): the datum-bearing shape proves what the sphere above cannot
  // — a goal that genuinely needs two setups, carries a real locating datum, and posts EVERY
  // program across BOTH setups with zero error-severity findings, through the REAL
  // `buildModelPlanInputForGoal` decision (no `modelSetupsOverride` test seam).
  it('two-setup DATUM goal: every posted program, both setups, carries a VerifyReport with zero error-severity findings', async () => {
    setModelCamEnabled(true);
    const { goal, stock } = await buildDatumGoal();
    const job = jobForGoal(goal, stock);
    const input = await buildModelPlanInputForGoal(job, goal, BALL, DATUM_SHOP);
    expect(input.setups).toHaveLength(2);

    const result = await generateGoalProgram(job, goal, BALL, [], null, DATUM_SHOP);

    expect(result.errors, result.errors.map((e) => `${e.stage}: ${e.message}`).join('\n')).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.stage).toBe('done');

    // Non-vacuous: both setups actually posted programs.
    expect(result.programs.length).toBeGreaterThan(0);
    const setupIndexes = [...new Set(result.programs.map((p) => p.setupIndex))].sort();
    expect(setupIndexes).toEqual([1, 2]);

    for (const program of result.programs) {
      const label = `setup ${program.setupIndex}/${program.toolKey}`;
      expect(program.nc, `${label}: no posted text`).toBeTruthy();
      expect(program.verify, `${label}: no verify report`).not.toBeNull();
      const errors = program.verify!.findings.filter((f) => f.severity === 'error');
      expect(errors, `${label}: ${errors.map((e) => e.message).join('; ')}`).toEqual([]);
      expect(program.verify!.ok, `${label}: verify.ok should agree with "no error-severity finding"`).toBe(true);
    }
  }, 90_000);
});
