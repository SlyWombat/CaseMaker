/**
 * #785 — the reach check: refused only on a KNOWN short reach, informed when none is recorded, and
 * turnable into a safe top-band cut with one choice.
 */
import { afterEach, describe, expect, it } from 'vitest';

// A localStorage shim, as the store barrel may be pulled in transitively by the dispatch path.
const backing = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => backing.get(k) ?? null,
  setItem: (k: string, v: string) => void backing.set(k, String(v)),
  removeItem: (k: string) => void backing.delete(k),
  clear: () => backing.clear(),
  key: (i: number) => [...backing.keys()][i] ?? null,
  get length() {
    return backing.size;
  },
} as Storage;

import { GOAL_BAND_CLEARANCE_MM, goalReachFindings, jobReachFindings, longestKnownReach, knownReach } from '@/engine/cnc/engrave/goalReach';
import { generateGoalProgram } from '@/workers/sim/engraveGenerate';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { clearTargetObjectMeshCache } from '@/engine/import/targetObject';
import { flatEndMill } from '@/engine/cnc/tool';
import type { Tool } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import { binaryStl } from './helpers/meshes';

afterEach(() => clearTargetObjectMeshCache());

const flat = (over: Partial<Tool> = {}): Tool => flatEndMill(3, { name: 'flat', ...over });
const catEntry = (id: string, flute: number): ToolLibraryEntry => ({
  key: `cat:${id}`,
  tool: flat({ id, name: `Makera ⌀3 flat (${id})`, fluteLength: flute }),
  provenance: 'test catalogue row',
});

let serial = 0;
function goal(depth: number, over: Partial<EngraveTargetObject> = {}): EngraveTargetObject {
  return {
    id: `g-${serial}`,
    name: 'tall.stl',
    format: 'stl',
    sha256: String(serial++).padStart(64, 'a'),
    data: 'AAAA',
    size: { x: 10, y: 10, z: depth },
    position: { x: 25, y: 25, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
    ...over,
  };
}

/** A binary STL ramp over 20×20 mm, its top falling to −K·20 in Z. */
type Tri = [[number, number, number], [number, number, number], [number, number, number]];
const DEPTH_MM = 30;
function rampTris(depthMm = DEPTH_MM): Tri[] {
  const k = depthMm / 20;
  const p = (x: number, y: number): [number, number, number] => [x, y, -k * x];
  return [
    [p(0, 0), p(20, 0), p(20, 20)],
    [p(0, 0), p(20, 20), p(0, 20)],
  ];
}
function rampGoal(over: Partial<EngraveTargetObject> = {}, depthMm = DEPTH_MM): EngraveTargetObject {
  return goal(depthMm, {
    data: Buffer.from(new Uint8Array(binaryStl(rampTris(depthMm)))).toString('base64'),
    size: { x: 20, y: 20, z: depthMm },
    position: { x: 25, y: 25, z: 0 },
    ...over,
  });
}

function tallJob(target: EngraveTargetObject): EngraveJob {
  return {
    ...defaultEngraveJob(),
    labels: [],
    shapes: [],
    stock: { ...defaultEngraveJob().stock, length: 50, width: 50, thickness: 150 },
    targetObject: target,
  };
}

describe('#785 — which reach is known', () => {
  it('a stated flute is the cutter’s own reach', async () => {
    expect(knownReach(flat({ fluteLength: 22 }), [])).toEqual({ mm: 22, source: 'stated', catalogueName: null });
  });

  it('the shoulder governs when stated — the engine’s one reach rule — and the flute is the fallback', async () => {
    expect(knownReach(flat({ fluteLength: 12, shoulderLength: 40 }), [])?.mm).toBe(40);
    expect(knownReach(flat({ fluteLength: 12, shoulderLength: null }), [])?.mm).toBe(12);
  });

  it('an unstated flute takes Makera’s catalogue number for the SAME cutter id, with its provenance', async () => {
    const copy = flat({ id: '112111313812', name: 'owned copy', fluteLength: null });
    const reach = knownReach(copy, [catEntry('112111313812', 12)]);
    expect(reach?.mm).toBe(12);
    expect(reach?.source).toBe('catalogue');
  });

  it('an unstated flute with no catalogue row — or no id to match one by — has no reach', async () => {
    expect(knownReach(flat({ fluteLength: null, id: null }), [catEntry('112', 12)])).toBeNull();
    expect(knownReach(flat({ fluteLength: null, id: '999' }), [catEntry('112', 12)])).toBeNull();
    // A non-catalogue tier is not the vendor's number.
    expect(knownReach(flat({ fluteLength: null, id: '112' }), [{ ...catEntry('112', 12), key: 'user:112' }])).toBeNull();
  });

  it('longestKnownReach ranks only the known ones and ignores the unknowns', async () => {
    const best = longestKnownReach(
      [flat({ fluteLength: null }), flat({ fluteLength: 22 }), flat({ fluteLength: 12 })],
      [],
    );
    expect(best?.reach.mm).toBe(22);
    expect(longestKnownReach([flat({ fluteLength: null })], [])).toBeNull();
  });
});

describe('#1037 — jobReachFindings on the M1 tray shape and a picture goal', () => {
  it('a 26 mm mesh goal with a 22 mm ball yields no error; a PNG goal was never judged here', () => {
    const job = tallJob(goal(26));
    const ball = flat({ fluteLength: 22 });
    const findings = jobReachFindings(job, ball, [ball], [], null);
    expect(findings.some((f) => f.severity === 'error')).toBe(false);
    expect(findings.some((f) => f.code === 'goal-reach-short')).toBe(false);
    // A picture is skipped before any depth judgement; its own refusal is the plan path's (#980).
    const pngJob = tallJob(goal(26, { format: 'png' }));
    expect(jobReachFindings(pngJob, ball, [ball], [], null)).toEqual([]);
  });
});

describe('#785 — the findings', () => {
  it('a known short reach is NOT a refusal for a MESH goal any more (#1037): the engine judges per feature', async () => {
    // The M1 tray's shape: a 26 mm mesh goal finished by a 22 mm ball that only cuts at 4.2 mm.
    // The whole-goal sentence was the wrong number for it, and it disabled Generate from the main
    // thread (the panel joins these findings) and refused the measured search.
    expect(goalReachFindings(goal(112), flat({ fluteLength: 22 }), [flat({ fluteLength: 22 })], [])).toEqual([]);
  });

  it('the catalogue-source sentence is gone with the refusal; the reach is still resolved for the band', async () => {
    const copy = flat({ id: '112', fluteLength: null });
    expect(goalReachFindings(goal(112), copy, [copy, flat({ fluteLength: 50 })], [catEntry('112', 12)])).toEqual([]);
  });

  it('cutWithinReach turns the refusal into the stated top-band cut', async () => {
    const findings = goalReachFindings(goal(112, { cutWithinReach: true }), flat({ fluteLength: 22 }), [], []);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('warning');
    expect(findings[0]?.code).toBe('goal-cut-top-band');
    expect(findings[0]?.message).toContain("only the stock's top 21 mm is cut");
    expect(findings[0]?.message).toContain('remaining 91 mm');
    expect(findings.some((f) => f.severity === 'error')).toBe(false);
  });

  it('an unrecorded reach is an INFO with the assumption stated, never a block', async () => {
    const findings = goalReachFindings(goal(112), flat({ fluteLength: null, id: null }), [], []);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('info');
    expect(findings[0]?.code).toBe('goal-reach-unrecorded');
    expect(findings[0]?.message).toContain("This cutter's reach is not recorded");
    expect(findings[0]?.message).toContain('the depth it can reach is unchecked');
    expect(findings[0]?.message).toContain('record its flute in Manage › Tools');
  });

  it('a goal sunk into the blank is judged by its LOWEST surface, and the sentence says both numbers', async () => {
    // 30 mm tall, its top 20 mm below the stock top: the cutter must go 50 mm down, not 30.
    const sunk = goal(30, { position: { x: 25, y: 25, z: -20 } });
    // #1037 — the whole-goal refusal is gone for a mesh goal; its lowest-surface number now lives
    // in the engine's own per-feature judgement.
    expect(goalReachFindings(sunk, flat({ fluteLength: 40 }), [], [])).toEqual([]);
    // A goal entirely ABOVE the blank needs nothing from this check.
    expect(goalReachFindings(goal(30, { position: { x: 25, y: 25, z: 40 } }), flat({ fluteLength: 4 }), [], [])).toEqual([]);
  });

  it('a goal within reach, a reference, a picture, a disabled target or no cutter posts nothing', async () => {
    expect(goalReachFindings(goal(20), flat({ fluteLength: 22 }), [], [])).toEqual([]);
    // Exactly at the reach is within it.
    expect(goalReachFindings(goal(22), flat({ fluteLength: 22 }), [], [])).toEqual([]);
    expect(goalReachFindings(goal(112, { role: 'reference' }), flat({ fluteLength: 22 }), [], [])).toEqual([]);
    expect(goalReachFindings(goal(112, { format: 'png' }), flat({ fluteLength: 22 }), [], [])).toEqual([]);
    expect(goalReachFindings(goal(112, { enabled: false }), flat({ fluteLength: 22 }), [], [])).toEqual([]);
    expect(goalReachFindings(goal(112), null, [], [])).toEqual([]);
  });

  it('the band clearance is the 1 mm the sentence and the sampler share', async () => {
    expect(GOAL_BAND_CLEARANCE_MM).toBe(1);
  });
});

describe('#785 — a rotary relief keeps its own judges', () => {
  it('a rod job posts no reach finding, whatever the goal’s local Z extent', async () => {
    const base = defaultEngraveJob();
    const rotary: EngraveJob = {
      ...base,
      stock: { ...base.stock, length: 100, width: 20, thickness: 20, shape: 'cylinder', diameter: 20 },
      workholding: { kind: 'rotary-chuck', rotary: { stickout: 60, gripDiameter: null, jawMode: 'reverse-inner', tailstock: false, source: 'test' } },
      targetObject: goal(18),
    };
    expect(jobReachFindings(rotary, flat({ fluteLength: 12 }), [flat({ fluteLength: 12 })], [], null)).toEqual([]);
  });
});

describe('#785 — Generate', () => {
  it('a region no finisher reaches is NOT finished and stated — the plan never posts with the holder in the part', async () => {
    // #1037 (6b's ruling) — the whole-goal refusal is gone from the model path: the engine assigns
    // cutters PER FEATURE, and a part it cannot free is a warning on the posted plan, never a
    // refusal (the #992 rule "the part isn't freed is a warning, never a silent property").
    // PNG/rotary keep their own refusal; this seam is the model path's.
    const target = rampGoal();
    const out = await generateGoalProgram(tallJob(target), target, flat({ fluteLength: 12 }), null, { shop: {} });
    // The old whole-goal verdict is gone from this path.
    expect(out.findings.some((f) => f.code === 'goal-reach-short')).toBe(false);
    // #1037 (6b's round three, the ruling) — WHAT THE PLAN DOES WITH THE 18 mm IT CANNOT REACH.
    // The rough is refused per region (`goal-rough-unreachable`, above) and the FINISH is judged
    // the same way: a finisher is assigned a region only if its usable length reaches the region's
    // floor, so the 12 mm-flute flat posts NO finish moves of the 30 mm region — the holder never
    // enters the part — and the skip is stated with its numbers.
    //
    // THIS FIXTURE HAS NOTHING ELSE TO CUT (one region, one cutter, no pocket, rim or contour):
    // with the finish skipped the plan posts no program at all, and the seam's existing no-program
    // refusal fires WITH the statement quoted — never a deep cut, never a silent success. A job
    // with other stages still posts the rest (test 1 of `trayReachGate1037.spec.ts`, ok true).
    expect(out.ok).toBe(false);
    expect(out.nc).toBeNull();
    const quoted = out.errors.map((e) => e.message).join('; ');
    expect(quoted).toContain('planned no program');
    expect(quoted).toContain('"curved-0": not finished');
    expect(quoted).toContain('floor 30 mm below the stock top');
    expect(quoted).toContain('usable length 12 mm');
    expect(quoted).toContain('no cutter in the set reaches it');
    const over = out.findings.find((f) => f.code === 'goal-finish-unreachable');
    expect(over?.severity).toBe('warning');
    expect(over?.message).toContain('"curved-0": not finished');
    expect(over?.message).toContain('floor 30 mm below the stock top');
    expect(over?.message).toContain('usable length 12 mm');
    expect(over?.message).toContain('no cutter in the set reaches it');
    expect(over?.message).toContain('longer-flute cutter');
    // This fixture is an open relief: its contour is synthetic, so no freeing cut is demanded and
    // `goal-not-freed` is rightly absent. The warning's own numbers (a real profile's floor and
    // the longest stated flute) are pinned on the M1 tray in `trayReachGate1037.spec.ts`.
    expect(out.findings.some((f) => f.code === 'goal-not-freed')).toBe(false);
  }, 120_000);

  it('cutWithinReach cuts the stock’s top band and says what is left', async () => {
    const target = rampGoal({ cutWithinReach: true });
    const tool = flat({ fluteLength: 12 });
    const out = await generateGoalProgram(tallJob(target), target, tool, null, { shop: {} });
    expect(out.ok, out.errors.map((e) => e.message).join('; ')).toBe(true);
    expect(out.nc).not.toBeNull();
    const warning = out.findings.find((f) => f.code === 'goal-cut-top-band');
    expect(warning?.severity).toBe('warning');
    expect(warning?.message).toContain("only the stock's top 11 mm is cut");
    // The program never goes deeper than the band: 12 mm reach − 1 mm clearance.
    const zs = [...(out.nc ?? '').matchAll(/Z(-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
    expect(Math.min(...zs)).toBeGreaterThanOrEqual(-11.001);
    expect(Math.min(...zs)).toBeLessThanOrEqual(-10.5);
    // "The sheet states the floor and what it leaves" via `out.surface3d?.notes` is deleted here,
    // not fixed: #966 triage — #1007, the model path attaches no surface3d/surface-facts report
    // at all. The #988 pin below states the SAME fact through the plan's own notes instead.

    // #988 pin — THE SAME CHOICE THROUGH THE ONE MODEL ENTRY. The seam carries the band into
    // `ModelPlanInput.setups[].bandMm` (reach 12 − 1 clearance = 11 mm) and the plan cuts the top
    // band instead of refusing on the contour's 150 mm demand. RED at the parent: `planModelCam`
    // threw 'no cutter sequence can be planned …'.
    {
      const { buildModelPlanInputForGoal } = await import('@/workers/sim/engraveGenerate');
      const { planModelCam } = await import('@/engine/cnc/cam/model/plan');
      // The model engine finishes a curved remainder with a ball; the OLD path needs none, so the
      // fixture's own set is the flat alone. Pass a ball beside it — the band is about the depth,
      // and a house that cannot plan the remainder at all is #982's no-flat/ball gap, not #988's.
      const ball: Tool = { ...flat({ fluteLength: 12, id: 'ball-12', name: 'ball-12' }), shape: 'ball', typeText: 'Ball Nose' };
      const modelInput = await buildModelPlanInputForGoal(tallJob(target), target, tool, {
        tools: [{ key: 'inv:ball-12', tool: ball, provenance: 'test fixture' }],
      });
      const modelOut = await planModelCam(modelInput);
      const programs = modelOut.perSetup.flatMap((s) => s.programs);
      expect(programs.length, 'no program was planned').toBeGreaterThan(0);
      const zs = programs.flatMap((p) => p.operations.flatMap((o) => o.moves.map((m) => m.z)));
      expect(Math.min(...zs), 'the band floor is −11').toBeGreaterThanOrEqual(-11.001);
      expect(Math.min(...zs), 'the plan must reach the band, not stop above it').toBeLessThanOrEqual(-10.5);
      expect(modelOut.perSetup.flatMap((s) => s.notes).join('\n')).toContain("Cut only the stock's top 11 mm");
    }
  }, 120_000);

  it('#988 — a STATED band (#888) is honoured through the model seam, measured from the goal top', async () => {
    // The goal's top sits 2 mm below the stock top; a stated 6 mm band (the old path's own datum —
    // "how deep ITS side cuts below the goal's own highest surface") therefore stops the cut 8 mm
    // below the STOCK top, and the seam must say so. RED before the fix: nothing was mapped at all.
    const target = rampGoal({ bandMm: 6, position: { x: 25, y: 25, z: -2 } });
    const tool = flat({ fluteLength: 60 });
    const ball: Tool = { ...flat({ fluteLength: 60, id: 'ball-988', name: 'ball-988' }), shape: 'ball', typeText: 'Ball Nose' };
    const { buildModelPlanInputForGoal } = await import('@/workers/sim/engraveGenerate');
    const { planModelCam } = await import('@/engine/cnc/cam/model/plan');
    const job = tallJob(target);
    const input = await buildModelPlanInputForGoal(job, target, tool, {
      tools: [{ key: 'inv:ball-988', tool: ball, provenance: 'test fixture' }],
    });
    expect(input.setups[0]!.bandMm, 'the stated band must reach the setups').toBeCloseTo(8, 6);
    const out = await planModelCam(input);
    const programs = out.perSetup.flatMap((s) => s.programs);
    expect(programs.length, 'no program was planned').toBeGreaterThan(0);
    const zs = programs.flatMap((p) => p.operations.flatMap((o) => o.moves.map((m) => m.z)));
    expect(Math.min(...zs), 'the band floor is −8 (6 below a goal top at −2)').toBeGreaterThanOrEqual(-8.001);
    expect(Math.min(...zs), 'the plan must reach the band').toBeLessThanOrEqual(-7.5);
    expect(out.perSetup.flatMap((s) => s.notes).join('\n')).toContain("Cut only the stock's top 8 mm");
  }, 120_000);

  it('an unrecorded reach does not stop Generate — the assumption is stated, the cut proceeds', async () => {
    const target = rampGoal();
    const out = await generateGoalProgram(tallJob(target), target, flat({ fluteLength: null, id: null }), null, { shop: {} });
    expect(out.ok, out.errors.map((e) => e.message).join('; ')).toBe(true);
    expect(out.nc).not.toBeNull();
    const note = out.findings.find((f) => f.code === 'goal-reach-unrecorded');
    expect(note?.severity).toBe('info');
    expect(out.findings.some((f) => f.code === 'goal-reach-short')).toBe(false);
  }, 120_000);

  // #785's own stage-reporting test ('#785 the goal CAM reports its stages, and the level and row
  // counts reach the end') is deleted here, not fixed: #966 dropped generateGoalProgram's
  // onProgress parameter entirely (it only ever threaded through to the retired heightfield
  // dispatch), and the stages it asserted ('sample'/'rough'/'finish' with "roughing level N of M"/
  // "finishing row N of M" labels) are that dispatch's own vocabulary, not planModelCam's. A
  // progress test for the model-cam path is new coverage, not a port of this one.

  // #966 triage — #1009 (the maintainer's ruling: no budgets). The memory-budget family —
  // `goal-program-too-big`, its suggested-pitch/step-down/split presses, and the three tests that
  // pinned them (#785's refusal-by-name, #888's split-press, #889's step-down-press) — is retired
  // with the removal: the emitter was already gone (deleted alongside the UI debris, #966), and
  // these three pins of it are deleted here rather than re-pinned, per the ruling. The fourth,
  // "#889 a deep goal at a fine grid plans," only asserted the finding's ABSENCE and needs no
  // change — it stays below.

  it('#889 a deep goal at a fine grid plans: a roughing level costs what it removes, not every cell', async () => {
    // The pre-#889 estimate was (levels + 1) × covered cells: 30 mm at a 0.15 mm step-down on a
    // 0.1 mm grid is 200 levels over ~81,000 cells, some 16 million moves, refused.
    const target = rampGoal({ surface: { gridPitchMm: 0.1, roughStepDownMm: 0.15 } }, 30);
    const out = await generateGoalProgram(tallJob(target), target, flat({ fluteLength: 40 }), null, { shop: {} });
    expect(out.ok, out.errors.map((e) => e.message).join('; ')).toBe(true);
    expect(out.cam!.cuttingMoves).toBeLessThan(200_000);
  }, 120_000);

  it('a goal within reach generates with no reach finding at all', async () => {
    const target = rampGoal({}, 8);
    const out = await generateGoalProgram(tallJob(target), target, flat({ fluteLength: 12 }), null, { shop: {} });
    expect(out.ok).toBe(true);
    expect(out.findings.some((f) => f.code.startsWith('goal-reach') || f.code === 'goal-cut-top-band')).toBe(false);
  }, 120_000);
});
