/**
 * #1193 — THE RUN'S CYCLE, OVER EVERY POSTED PROGRAM.
 *
 * The bench: a flip run's stated cycle was 9 826.29 s while its posted programs totalled 13 891 s
 * by their own `cycleSeconds` — the locating-hole program and the whole second setup were outside
 * the number, because it came from the FIRST side's plan. Rule (Manager, 2026-11-10): the run's
 * cycle covers every posted program (all setups, the locating program) plus the change prices
 * between consecutive programs; the flip's own time is not modelled and is stated as untimed. The
 * tradeoff line stays a PLAN comparison and says so.
 *
 * Red-first: the flip fixture below is a real two-side generation, and before this slice its
 * result carried no run total at all.
 */
import { describe, expect, it } from 'vitest';

import { BIT_CHANGE_RECOMMENDED } from '@/engine/cnc/cam/model/bitChange';
import { runCycleOf } from '@/engine/cnc/engrave/runTotals';
import { buildRunSheet, formatDuration } from '@/engine/cnc/engrave/runSheet';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { presetPartOnBoard } from '@/engine/cnc/sacrificial';
import { planFlipSetups } from '@/engine/cnc/engrave/goalFlipSetups';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import { engraveGenerate } from '@/workers/sim/engraveGenerate';
import { getToplevel } from '@/workers/geometry/ManifoldRuntime';
import { entry, FLAT3, stl } from './helpers/twoSetupBox966';

const FLAT_ENTRY: ToolLibraryEntry = entry('inv:flat-3', FLAT3);
const STOCK = { length: 80, width: 50, thickness: 20 };

type V = [number, number, number];
type Tri = [V, V, V];

function frustumTris(): Tri[] {
  const ring = (x: number, y: number, z: number): V[] => [
    [-x, -y, z],
    [x, -y, z],
    [x, y, z],
    [-x, y, z],
  ];
  const B = ring(20, 12, -20);
  const M = ring(30, 20, -10);
  const T = ring(16, 10, 0);
  const quad = (out: Tri[], a: V, b: V, c: V, d: V): void => {
    out.push([a, b, c], [a, c, d]);
  };
  const tris: Tri[] = [];
  quad(tris, B[3]!, B[2]!, B[1]!, B[0]!);
  quad(tris, T[0]!, T[1]!, T[2]!, T[3]!);
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    quad(tris, B[i]!, B[j]!, M[j]!, M[i]!);
    quad(tris, M[i]!, M[j]!, T[j]!, T[i]!);
  }
  return tris;
}

function frustumGoal(): EngraveTargetObject {
  return {
    id: 'frustum-cycle-1193',
    name: 'frustum.stl',
    format: 'stl',
    sha256: 'a'.repeat(64),
    data: stl(frustumTris()),
    size: { x: 60, y: 40, z: 20 },
    position: { x: 35, y: 25, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
  };
}

function jobForFrustum(): EngraveJob {
  return {
    ...defaultEngraveJob(),
    labels: [],
    shapes: [],
    stock: { ...defaultEngraveJob().stock, ...STOCK },
    sacrificial: presetPartOnBoard(),
    targetObject: frustumGoal(),
    workholding: { kind: 'bracket', bracket: { anchor: 1, variant: 'thin', clamps: [], source: 'default' } },
  };
}

describe('#1193 — the run total’s arithmetic', () => {
  it('counts every program and prices a change only where the cutter changes, from the program before it', () => {
    const rule = BIT_CHANGE_RECOMMENDED;
    const out = runCycleOf(
      [
        { seconds: 300, cutterKey: 'a', setupIndex: 1 },
        // 15 minutes — between the thresholds, so the change AFTER this one is on the rising step.
        { seconds: 900, cutterKey: 'a', setupIndex: 1 },
        { seconds: 300, cutterKey: 'b', setupIndex: 2 },
      ],
      rule,
      { setupCount: 2, flip: false },
    );
    expect(out).not.toBeNull();
    // Same cutter across the setup boundary: no change is priced there.
    expect(out!.changes).toBe(1);
    expect(out!.cuttingSeconds).toBe(1_500);
    expect(out!.changeSeconds).toBeGreaterThan(rule.attendedChangeSeconds);
    expect(out!.changeSeconds).toBeLessThan(rule.attendedChangeSeconds + rule.returnMinutes * 60);
    expect(out!.totalSeconds).toBeCloseTo(out!.cuttingSeconds + out!.changeSeconds, 6);
    expect(out!.programCount).toBe(3);
    expect(out!.setupCount).toBe(2);
    expect(out!.flip).toBe(false);
  });

  it('a locating program is a program like any other, and its own change is priced', () => {
    const out = runCycleOf(
      [
        { seconds: 600, cutterKey: 'a', setupIndex: 1 },
        { seconds: 120, cutterKey: 'bore', setupIndex: 1 },
        { seconds: 300, cutterKey: 'b', setupIndex: 2 },
      ],
      BIT_CHANGE_RECOMMENDED,
      { setupCount: 2, flip: true },
    );
    expect(out!.changes).toBe(2);
    expect(out!.cuttingSeconds).toBe(1_020);
    expect(out!.totalSeconds).toBeCloseTo(1_020 + out!.changeSeconds, 6);
    expect(out!.flip).toBe(true);
  });

  it('states nothing when there is no program with a cycle', () => {
    expect(runCycleOf([], BIT_CHANGE_RECOMMENDED, { setupCount: 1, flip: false })).toBeNull();
    expect(runCycleOf([{ seconds: 0, cutterKey: 'a', setupIndex: 1 }], BIT_CHANGE_RECOMMENDED, { setupCount: 1, flip: false })).toBeNull();
  });
});

describe('#1193 — a flip run’s own cycle, from its posts', () => {
  it('covers the locating program and the whole second setup, so it exceeds the first side’s plan', async () => {
    const job = jobForFrustum();
    const goal = job.targetObject!;
    const plan = planFlipSetups(job, goal, ['top', 'bottom'], [FLAT_ENTRY], {
      method: 'tabs-in-blank',
      axis: 'left-right',
    });
    if (!plan.ok) throw new Error(plan.reason);
    const sided: EngraveJob = { ...job, setups: plan.setups, targetObjects: plan.goals };
    const tl = await getToplevel();
    const result = await engraveGenerate(tl, sided, FLAT3, [], null, undefined, { tools: [FLAT_ENTRY] });
    expect(result.ok, result.errors.map((e) => e.message).join('; ')).toBe(true);

    // The seam states the run's cycle over EVERY posted program.
    const run = result.runCycle;
    expect(run, 'the result carries the run cycle').toBeTruthy();
    expect(run!.programCount).toBe(result.programs.length);
    const posted = result.programs.map((p) => p.cam?.estimatedSeconds ?? 0);
    expect(run!.cuttingSeconds).toBeCloseTo(
      posted.reduce((n, s) => n + s, 0),
      6,
    );
    expect(run!.setupCount).toBe(2);
    expect(run!.flip).toBe(true);
    // The old figure — the FIRST side's plan outcome — is short of the run by the locating
    // program and side 2, which is exactly the defect (#1193).
    expect(run!.totalSeconds).toBeGreaterThan(result.plan!.outcome!.cycleSeconds);
    // The locating program is IN the list this total counts.
    expect(result.programs.some((p) => p.locating === true)).toBe(true);

    // THE SHEET STATES THE SAME NUMBER — and the plan comparison that sits beside it says whose
    // cycle it is (the Manager's ruling: a plan comparison stays a plan comparison).
    const sheet = buildRunSheet(sided, result, null, new Date('2026-11-10T12:00:00.000Z'), undefined, {
      comparison: { kind: 'minor', ownedSeconds: result.plan!.outcome!.cycleSeconds, idealSeconds: result.plan!.outcome!.cycleSeconds - 60 },
    });
    const steps = sheet.sections.flatMap((section) => section.steps.map((step) => step.text));
    const runLineAt = steps.findIndex((text) => text.startsWith('The run’s cycle is'));
    const planLineAt = steps.findIndex((text) => text.includes('— the plans’ own cycle'));
    expect(runLineAt, 'the sheet states the run’s cycle').toBeGreaterThanOrEqual(0);
    expect(steps[runLineAt]).toContain(formatDuration(run!.totalSeconds));
    expect(steps[runLineAt]).toContain(`${run!.programCount} file`);
    expect(steps[runLineAt]).toContain('The flip itself is not timed.');
    expect(planLineAt, 'the plan comparison is labelled').toBeGreaterThan(runLineAt);
    expect(steps[planLineAt]).toContain('Setup 1’s plan: owned');
    expect(steps[planLineAt]).toContain(`owned ${formatDuration(result.plan!.outcome!.cycleSeconds)}`);
  }, 240_000);
});
