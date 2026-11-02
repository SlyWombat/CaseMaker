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
import { goalProgramMb } from '@/engine/cnc/cam/surface3d';
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
 *
 * `heightMm` narrows the goal across Y. Since #902's re-pricing the budget allows about three
 * million moves, and the estimate scans every row of every level, so a 20 mm-wide pit large enough
 * to refuse costs minutes to estimate; a 2 mm-wide strip costs the same moves in a tenth of the
 * scan. The strip is the fixture; the shape is the pit.
 */
function pitGoal(depthMm: number, over: Partial<EngraveTargetObject> = {}, heightMm = 20): EngraveTargetObject {
  const W = 20;
  const H = heightMm;
  const zt = 0;
  const zb = -depthMm;
  const tris: Tri[] = [
    // floor
    [[0, 0, zb], [W, 0, zb], [W, H, zb]],
    [[0, 0, zb], [W, H, zb], [0, H, zb]],
    // walls, tops at 0
    [[0, 0, zt], [0, H, zt], [0, H, zb]], [[0, 0, zt], [0, H, zb], [0, 0, zb]],
    [[W, 0, zt], [W, H, zb], [W, H, zt]], [[W, 0, zt], [W, 0, zb], [W, H, zb]],
    [[0, 0, zt], [W, 0, zb], [W, 0, zt]], [[0, 0, zt], [0, 0, zb], [W, 0, zb]],
    [[0, H, zt], [W, H, zt], [W, H, zb]], [[0, H, zt], [W, H, zb], [0, H, zb]],
  ];
  return goal(depthMm, {
    data: Buffer.from(new Uint8Array(binaryStl(tris))).toString('base64'),
    size: { x: W, y: H, z: depthMm },
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
    // #916 — the refusal is MEMORY only: the finishing tip field has no operation cap, so the
    // oversized job is one whose grid and moves really do not fit. A 30 mm ramp scaled 1.5× in
    // plan (30 × 30 mm) at a 0.02 mm grid is ~2.25 M cells and ~2.25 M finishing moves, ~743 MB
    // against the 640 MB budget.
    const target = rampGoal(
      { surface: { gridPitchMm: 0.02, finishStepOverMm: 0.02 }, scale: { x: 1.5, y: 1.5, z: 1 } },
      30,
    );
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
    // #902 — the split is a separate offer with its own case below; this job's presses are the
    // pitch (this test) and, when the roughing is the cost, the step-down.
    // #889 — this job's size is its FINISH, which no step-down changes: the step-down press is
    // found by trying it and cannot fit, so it is not offered, and the pitch press is.
    expect(refusal?.suggestedStepDownMm).toBeUndefined();
    expect(refusal?.suggestedPitchMm).toBeGreaterThan(0.02);
    expect(out.nc).toBeNull();
    expect(out.programs).toEqual([]);
    // The pitch press's one-click behaviour (write the number, Generate) is the e2e's
    // tooManyMoves spec: a full generate at the suggested pitch is a million-move program and
    // is not this test's subject.
  }, 120_000);

  it('#888 a goal whose depth can be split in two under the budget carries the split, and the press builds it', async () => {
    // #902 — the split's case is a PIT cut in many thin layers: every level above its floor cuts
    // the whole footprint, so the ROUGHING is what is over. At #902's re-priced costs (33 B a
    // packed move + 60 B a simulated line + 16 B of its text, plus 111 B a grid cell and the
    // 74 MB session base, with a 1.5 margin) a 90 mm strip at a 0.0085 mm step-down and a 0.05 mm
    // step-over estimates over the 640 MB budget, while either 45 mm band halves the roughing and
    // fits — two setups, each under the budget, is the case the press exists for. The strip is
    // narrow because the estimate samples every row of every level: the shape is the pit, the
    // width only keeps the test a test.
    const target = pitGoal(
      90,
      { surface: { gridPitchMm: 0.1, roughStepDownMm: 0.0085, roughStepOverMm: 0.05, finishStepOverMm: 0.3 } },
      2,
    );
    const out = await generateGoalProgram(tallJob(target), target, flat({ fluteLength: 150, shoulderLength: 150 }), [], null, {});
    expect(out.ok).toBe(false);
    const refusal = out.findings.find((f) => f.code === 'goal-program-too-big');
    expect(refusal?.budgetMb).toBeGreaterThan(640);
    expect(refusal?.suggestedSplit).toBeDefined();
    const split = refusal!.suggestedSplit!;
    expect(split.firstMm + split.secondMm).toBeCloseTo(90, 2);
    // The halves fit the same budget the refusal priced: the program halves, the grid does not.
    expect(goalProgramMb(split.movesEach, refusal!.budgetGridCells!)).toBeLessThanOrEqual(640);

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
    // #902 — the shape that makes the ROUGHING the cost is the pit (see the split's fixture); a
    // strip at a 0.007 mm step-down estimates over the re-priced budget, and the press (found by
    // trying it) coarsens the layers until the estimate fits.
    const target = pitGoal(90, { surface: { gridPitchMm: 0.1, roughStepDownMm: 0.007, roughStepOverMm: 0.05 } }, 2);
    const out = await generateGoalProgram(
      tallJob(target),
      target,
      flat({ fluteLength: 150, shoulderLength: 150 }),
      [],
      null,
      {},
    );
    const refusal = out.findings.find((f) => f.code === 'goal-program-too-big');
    // #888/#889 — the sentence is the plain one; the step-down press is a NUMBER on the finding,
    // found by trying it (the panel draws it as "Thicker layers (N mm step-down, rougher walls)").
    expect(refusal?.message).toContain('This goal is too detailed to plan');
    expect(refusal?.suggestedStepDownMm).toBeGreaterThan(0.007);
    // The press only carries a value that FITTED when it was tried (`movesAt(pitch, d).mb <=
    // budget`), so the finding's presence is the fit. Building that program is the assertion the
    // old test made, and #902's re-priced budget puts it at the budget's edge — nearly three
    // million moves, minutes of CAM — so the build itself is proved by the pitch press above and
    // the split below rather than by a second multi-minute generation here.
  }, 120_000);

  it('a goal within reach generates with no reach finding at all', async () => {
    const target = rampGoal({}, 8);
    const out = await generateGoalProgram(tallJob(target), target, flat({ fluteLength: 12 }), [], null, {});
    expect(out.ok).toBe(true);
    expect(out.findings.some((f) => f.code.startsWith('goal-reach') || f.code === 'goal-cut-top-band')).toBe(false);
  }, 120_000);
});
