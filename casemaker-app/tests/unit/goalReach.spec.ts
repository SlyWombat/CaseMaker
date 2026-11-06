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
import type { EngraveProgress } from '@/workers/sim/engraveGenerate';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { clearTargetObjectMeshCache } from '@/engine/import/targetObject';
import { flatEndMill } from '@/engine/cnc/tool';
import type { Tool } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';

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
function binaryStl(tris: Tri[]): ArrayBuffer {
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
  return buf;
}
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

/**
 * #888/#889 — THE SPLIT'S GOAL: an open-top box (a pit). Its topmost surface at every interior
 * cell is the FLOOR, so each roughing level above it cuts the whole footprint — the one shape that
 * makes a goal's ROUGHING, rather than its finish, over the budget. A ramp cannot: each level cuts
 * only the sliver where it crosses that Z.
 */
function pitGoal(depthMm: number, over: Partial<EngraveTargetObject> = {}): EngraveTargetObject {
  const W = 20;
  const zt = 0;
  const zb = -depthMm;
  const tris: Tri[] = [
    // floor
    [[0, 0, zb], [W, 0, zb], [W, W, zb]],
    [[0, 0, zb], [W, W, zb], [0, W, zb]],
    // walls, tops at 0
    [[0, 0, zt], [0, W, zt], [0, W, zb]], [[0, 0, zt], [0, W, zb], [0, 0, zb]],
    [[W, 0, zt], [W, W, zb], [W, W, zt]], [[W, 0, zt], [W, 0, zb], [W, W, zb]],
    [[0, 0, zt], [W, 0, zb], [W, 0, zt]], [[0, 0, zt], [0, 0, zb], [W, 0, zb]],
    [[0, W, zt], [W, W, zt], [W, W, zb]], [[0, W, zt], [W, W, zb], [0, W, zb]],
  ];
  return goal(depthMm, {
    data: Buffer.from(new Uint8Array(binaryStl(tris))).toString('base64'),
    size: { x: W, y: W, z: depthMm },
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

describe('#785 — the findings', () => {
  it('a known short reach REFUSES with the numbers and the four fixes', async () => {
    const [f] = goalReachFindings(goal(112), flat({ fluteLength: 22 }), [flat({ fluteLength: 22 })], []);
    expect(f?.severity).toBe('error');
    expect(f?.code).toBe('goal-reach-short');
    expect(f?.targetId).toBe('g-0');
    expect(f?.goalBandMm).toBe(21);
    expect(f?.message).toContain('112 mm deep');
    expect(f?.message).toContain('your longest reach is 22 mm');
    expect(f?.message).toContain('Scale the goal to 22 mm or less');
    expect(f?.message).toContain('cut it from both sides');
    expect(f?.message).toContain('choose a longer cutter');
    expect(f?.message).toContain('cut just the top 21 mm');
  });

  it('names the catalogue as the source, and the house’s longer cutter when the chosen one is not it', async () => {
    const copy = flat({ id: '112', fluteLength: null });
    const [f] = goalReachFindings(goal(112), copy, [copy, flat({ fluteLength: 50 })], [catEntry('112', 12)]);
    expect(f?.message).toContain("this cutter reaches 12 mm (Makera's catalogue)");
    expect(f?.message).toContain('your longest reach is 50 mm');
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
    const [f] = goalReachFindings(sunk, flat({ fluteLength: 40 }), [], []);
    expect(f?.severity).toBe('error');
    expect(f?.message).toContain('30 mm deep');
    expect(f?.message).toContain('its lowest surface 50 mm below the stock top');
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
    expect(jobReachFindings(rotary, flat({ fluteLength: 12 }), [flat({ fluteLength: 12 })], [])).toEqual([]);
  });
});

describe('#785 — Generate', () => {
  it('refuses a known-short reach EARLY: the sentence, no CAM, no program', async () => {
    const target = rampGoal();
    const out = await generateGoalProgram(tallJob(target), target, flat({ fluteLength: 12 }), [], null, {});
    expect(out.ok).toBe(false);
    expect(out.stage).toBe('findings');
    const refusal = out.findings.find((f) => f.code === 'goal-reach-short');
    expect(refusal?.severity).toBe('error');
    expect(refusal?.message).toContain('30 mm deep');
    expect(out.nc).toBeNull();
    expect(out.cam).toBeNull();
    expect(out.programs).toEqual([]);
  }, 120_000);

  it('cutWithinReach cuts the stock’s top band and says what is left', async () => {
    const target = rampGoal({ cutWithinReach: true });
    const tool = flat({ fluteLength: 12 });
    const out = await generateGoalProgram(tallJob(target), target, tool, [], null, {});
    expect(out.ok, out.errors.map((e) => e.message).join('; ')).toBe(true);
    expect(out.nc).not.toBeNull();
    const warning = out.findings.find((f) => f.code === 'goal-cut-top-band');
    expect(warning?.severity).toBe('warning');
    expect(warning?.message).toContain("only the stock's top 11 mm is cut");
    // The program never goes deeper than the band: 12 mm reach − 1 mm clearance.
    const zs = [...(out.nc ?? '').matchAll(/Z(-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
    expect(Math.min(...zs)).toBeGreaterThanOrEqual(-11.001);
    expect(Math.min(...zs)).toBeLessThanOrEqual(-10.5);
    // The sheet states the floor and what it leaves.
    expect(out.surface3d?.notes.some((n) => n.includes("Cut only the stock's top 11 mm"))).toBe(true);

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
    const out = await generateGoalProgram(tallJob(target), target, flat({ fluteLength: null, id: null }), [], null, {});
    expect(out.ok, out.errors.map((e) => e.message).join('; ')).toBe(true);
    expect(out.nc).not.toBeNull();
    const note = out.findings.find((f) => f.code === 'goal-reach-unrecorded');
    expect(note?.severity).toBe('info');
    expect(out.findings.some((f) => f.code === 'goal-reach-short')).toBe(false);
  }, 120_000);

  it('#785 the goal CAM reports its stages, and the level and row counts reach the end', async () => {
    const target = rampGoal({}, 8);
    const events: EngraveProgress[] = [];
    const out = await generateGoalProgram(tallJob(target), target, flat({ fluteLength: 12 }), [], null, {}, (p) => events.push(p));
    expect(out.ok).toBe(true);
    const stages = events.map((e) => e.stage);
    // `prepare` is the top-level `engraveGenerate`'s first event; the goal program itself starts
    // at the sampling it owns.
    for (const stage of ['sample', 'rough', 'finish', 'post', 'done'] as const) {
      expect(stages, `the run must report ${stage}`).toContain(stage);
    }
    const rough = events.filter((e) => e.stage === 'rough');
    expect(rough.length).toBeGreaterThan(1);
    expect(rough.at(-1)?.done).toBe(rough.at(-1)?.total);
    expect(rough.at(-1)?.label).toMatch(/^roughing level \d+ of \d+$/);
    const finish = events.filter((e) => e.stage === 'finish');
    expect(finish.at(-1)?.done).toBe(finish.at(-1)?.total);
    expect(finish.at(-1)?.label).toMatch(/^finishing row \d+ of \d+$/);
  });

  it('#785 a goal whose program would exceed the stated memory budget is refused by name, with the numbers', async () => {
    // #889 — a fine grid alone no longer costs a level per cell (a level costs what it removes,
    // and the ramp's rows merge), so the oversized job is a finish at a 0.02 mm step-over too.
    const target = rampGoal({ surface: { gridPitchMm: 0.02, finishStepOverMm: 0.02 } }, 30);
    const out = await generateGoalProgram(tallJob(target), target, flat({ fluteLength: 40 }), [], null, {});
    expect(out.ok).toBe(false);
    expect(out.stage).toBe('findings');
    const refusal = out.findings.find((f) => f.code === 'goal-program-too-big');
    expect(refusal?.severity).toBe('error');
    // #888/#889 — the sentence is the operator's (the goal, the pitch and the depth); moves, MB
    // and the budget ride the finding's own fields (the panel's Technical line).
    expect(refusal?.message).toContain('This goal is too detailed to plan at 0.02 mm in one go');
    expect(refusal?.message).toContain('30 mm deep');
    expect(refusal?.message).not.toContain('moves');
    expect(refusal?.budgetMoves).toBeGreaterThan(0);
    expect(refusal?.budgetCells).toBeGreaterThan(0);
    expect(refusal?.budgetMb).toBeGreaterThan(640);
    expect(refusal?.budgetLimitMb).toBe(640);
    expect(refusal?.budgetPitchMm).toBeCloseTo(0.02, 4);
    // The feeds row's own step-down, as the solver resolved it — 0.6 mm for a 3 mm flat in the
    // default blank's material (hardwood since #879; it was softwood's 1.0 before).
    expect(refusal?.budgetStepDownMm).toBeCloseTo(0.6, 6);
    // No two-band split fits a goal this large — 30 mm deep over a fine grid is over the budget
    // even at half the depth — so the finding offers no split and the panel draws no press.
    expect(refusal?.suggestedSplit).toBeUndefined();
    // #889 — this job's size is its FINISH, which no step-down changes: the step-down press is
    // found by trying it and cannot fit, so it is not offered, and the pitch press is.
    expect(refusal?.suggestedStepDownMm).toBeUndefined();
    expect(refusal?.suggestedPitchMm).toBeGreaterThan(0.02);
    expect(out.nc).toBeNull();
    expect(out.programs).toEqual([]);

    // #785 follow-up — the suggested pitch IS the one-click fix: written onto the goal's grid, the
    // same job generates.
    const pitched = { ...target, surface: { ...(target.surface ?? {}), gridPitchMm: refusal!.suggestedPitchMm } };
    const retry = await generateGoalProgram(tallJob(pitched), pitched, flat({ fluteLength: 40 }), [], null, {});
    expect(retry.ok, retry.errors.map((e) => e.message).join('; ')).toBe(true);
    expect(retry.findings.some((f) => f.code === 'goal-program-too-big')).toBe(false);
    // #945 — the retry succeeds at the suggested (coarser, still large) pitch, so it runs the real
    // finish + the overcut guard's now-wider per-cell candidate search; that costs real wall time
    // at this job's move count, past the old 120 s bound.
  }, 400_000);

  it('#888 a goal whose depth can be split in two under the budget carries the split, and the press builds it', async () => {
    // #889 — a roughing level costs what it removes and merges into one move per row, so a ramp
    // no longer reaches the budget in one program. The split's case is a PIT: every level above its
    // floor cuts the whole footprint, so 90 mm at a 0.1 mm step-down and a 0.04 mm step-over is
    // about a million roughing moves (~1 082 MB, over the 640 MB budget) while each 45 mm band is
    // ~517 000 moves (~543 MB) — two setups, each under the budget, is exactly the case the press
    // exists for.
    const target = pitGoal(90, {
      surface: { gridPitchMm: 0.1, roughStepDownMm: 0.1, roughStepOverMm: 0.04, finishStepOverMm: 0.3 },
    });
    const out = await generateGoalProgram(tallJob(target), target, flat({ fluteLength: 150, shoulderLength: 150 }), [], null, {});
    expect(out.ok).toBe(false);
    const refusal = out.findings.find((f) => f.code === 'goal-program-too-big');
    expect(refusal?.budgetMb).toBeGreaterThan(640);
    expect(refusal?.suggestedSplit).toBeDefined();
    const split = refusal!.suggestedSplit!;
    expect(split.firstMm + split.secondMm).toBeCloseTo(90, 2);
    expect((split.movesEach * 1100) / (1024 * 1024)).toBeLessThanOrEqual(640);

    // The press's machinery: two setups, each side's goal carrying its band, the second side the
    // stock turned over. (No drill is owned here, so the hold states no pins — the setups and
    // bands are the claim.)
    const { splitGoalForBudget } = await import('@/engine/cnc/engrave/goalFlipSetups');
    const built = splitGoalForBudget(tallJob(target), target, split, []);
    expect(built.ok, built.ok ? '' : built.reason).toBe(true);
    if (!built.ok) return;
    expect(built.setups).toHaveLength(2);
    expect(built.goals).toHaveLength(2);
    expect(built.goals[0]!.bandMm).toBeCloseTo(split.firstMm, 6);
    expect(built.goals[1]!.bandMm).toBeCloseTo(split.secondMm, 6);
    expect(built.goals[0]!.setupId).toBe(built.setups[0]!.id);
    expect(built.goals[1]!.setupId).toBe(built.setups[1]!.id);
  }, 120_000);

  it('#889 a deep goal at a fine grid plans: a roughing level costs what it removes, not every cell', async () => {
    // The pre-#889 estimate was (levels + 1) × covered cells: 30 mm at a 0.15 mm step-down on a
    // 0.1 mm grid is 200 levels over ~81,000 cells, some 16 million moves, refused.
    const target = rampGoal({ surface: { gridPitchMm: 0.1, roughStepDownMm: 0.15 } }, 30);
    const out = await generateGoalProgram(tallJob(target), target, flat({ fluteLength: 40 }), [], null, {});
    expect(out.ok, out.errors.map((e) => e.message).join('; ')).toBe(true);
    expect(out.findings.some((f) => f.code === 'goal-program-too-big')).toBe(false);
    expect(out.cam!.cuttingMoves).toBeLessThan(200_000);
  }, 120_000);

  it('#889 a step-down too fine for the budget is refused, and the step-down press is the one that fits', async () => {
    const target = rampGoal({ surface: { gridPitchMm: 0.1, roughStepDownMm: 0.002 } }, 30);
    const out = await generateGoalProgram(tallJob(target), target, flat({ fluteLength: 40 }), [], null, {});
    const refusal = out.findings.find((f) => f.code === 'goal-program-too-big');
    // #888/#889 — the sentence is the plain one; the step-down press is a NUMBER on the finding,
    // found by trying it (the panel draws it as "Thicker layers (N mm step-down, rougher walls)").
    expect(refusal?.message).toContain('This goal is too detailed to plan');
    expect(refusal?.suggestedStepDownMm).toBeGreaterThan(0.002);
    const stepped = { ...target, surface: { ...(target.surface ?? {}), roughStepDownMm: refusal!.suggestedStepDownMm } };
    const retry = await generateGoalProgram(tallJob(stepped), stepped, flat({ fluteLength: 40 }), [], null, {});
    expect(retry.ok, retry.errors.map((e) => e.message).join('; ')).toBe(true);
    // #945 — same reason as the test above: the retry's real finish + overcut guard pass at this
    // job's move count needs more than the old 120 s bound now.
  }, 400_000);

  it('a goal within reach generates with no reach finding at all', async () => {
    const target = rampGoal({}, 8);
    const out = await generateGoalProgram(tallJob(target), target, flat({ fluteLength: 12 }), [], null, {});
    expect(out.ok).toBe(true);
    expect(out.findings.some((f) => f.code.startsWith('goal-reach') || f.code === 'goal-cut-top-band')).toBe(false);
  }, 120_000);
});
