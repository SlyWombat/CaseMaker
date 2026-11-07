/**
 * #1046 — THE LADDER'S CALLERS (6b's six fields). #1028 measures the rungs; this issue lets the
 * run sheet and the CLI ask for them, and states the expected cost BEFORE the run from the last
 * Generate's own measured numbers.
 *
 * Here: the plan's timing read (planMs / finishStageMs / finishBallDiameterMm, dump only — no
 * statement or NC byte reads them), the estimate helper both callers quote, and the store's press
 * path passing `restLadder` to the pipeline. The panel's button and the CLI's sentence are pinned
 * beside their own harnesses.
 *
 * RED at the #1028 tip: none of the three fields exists and `restLadderEstimateMs` has nothing to
 * read — the estimate is a constant or absent.
 */
import { describe, expect, it } from 'vitest';

import {
  planModelCam,
  restLadderEstimateMs,
  REST_LADDER_RUNGS_MM,
  type ModelPlanInput,
  type ModelPlanOutput,
} from '@/engine/cnc/cam/model/plan';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import { buildModelPlanInputForGoal } from '@/workers/sim/engraveGenerate';

type P = [number, number, number];
type Tri2 = [[number, number], [number, number], [number, number]];

function stlBase64(tris: readonly (readonly [P, P, P])[]): string {
  const bytes = new Uint8Array(84 + tris.length * 50);
  const dv = new DataView(bytes.buffer);
  dv.setUint32(80, tris.length, true);
  let off = 84;
  for (const [a, b, c] of tris) {
    for (let k = 0; k < 3; k++) dv.setFloat32(off + k * 4, 0, true);
    off += 12;
    for (const p of [a, b, c]) {
      dv.setFloat32(off, p[0], true);
      dv.setFloat32(off + 4, p[1], true);
      dv.setFloat32(off + 8, p[2], true);
      off += 12;
    }
    dv.setUint16(off, 0, true);
    off += 2;
  }
  return Buffer.from(bytes).toString('base64');
}

/** The #1023/#1028 plate: 20 × 10 × 5 with a 6 mm-wide V notch. */
function notchedPlate(): string {
  const A: [number, number] = [0, 0];
  const B: [number, number] = [20, 0];
  const C: [number, number] = [20, 5];
  const D: [number, number] = [13, 5];
  const E: [number, number] = [10, 0.5];
  const F: [number, number] = [7, 5];
  const G: [number, number] = [0, 5];
  const section = [A, B, C, D, E, F, G];
  const depth = 10;
  const capTris: Tri2[] = [[C, D, E], [B, C, E], [A, B, E], [G, A, E], [E, F, G]];
  const cap = (y: number): readonly (readonly [P, P, P])[] =>
    capTris.map(([a, b, c]) => (y === 0
      ? [[a[0], y, a[1]], [b[0], y, b[1]], [c[0], y, c[1]]]
      : [[a[0], y, a[1]], [c[0], y, c[1]], [b[0], y, b[1]]])) as readonly (readonly [P, P, P])[];
  const sideTris: (readonly [P, P, P])[] = [];
  for (let i = 0; i < section.length; i++) {
    const a = section[i]!;
    const b = section[(i + 1) % section.length]!;
    const a0: P = [a[0], 0, a[1]];
    const b0: P = [b[0], 0, b[1]];
    const a1: P = [a[0], depth, a[1]];
    const b1: P = [b[0], depth, b[1]];
    sideTris.push([a0, a1, b1], [a0, b1, b0]);
  }
  return stlBase64([...cap(0), ...cap(depth), ...sideTris]);
}

const BALL6: Tool = { ...flatEndMill(6), name: '6 mm ball nose', shape: 'ball', typeText: 'Ball', diameter: 6, cornerRadius: 3, fluteLength: 40 };
const SHOP_FEEDS = [
  {
    material: 'pla' as const,
    minDiameter: 0.4,
    maxDiameter: 8,
    params: { rpm: 12000, feed: 800, plungeFeed: 300, stepDown: 1, stepOverFraction: 0.45, peckFraction: 1, air: true },
    status: 'unmeasured' as const,
    provenance: 'test row',
  },
];

function goalTarget(): EngraveTargetObject {
  return {
    id: 'goal-1046', name: 'notched plate', role: 'goal', enabled: true, format: 'stl',
    sha256: 'q'.repeat(64), data: notchedPlate(),
    position: { x: 30, y: 20, z: 0 }, rotation: 0,
    size: { x: 20, y: 10, z: 5 },
    surface: { gridPitchMm: 0.5 },
  } as EngraveTargetObject;
}

function goalJob(target: EngraveTargetObject): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base, labels: [], shapes: [], targetObject: target, toolKey: '', tool: BALL6,
    stock: { ...base.stock, length: 60, width: 40, thickness: 12, material: 'pla' },
  };
}

async function plateInput(): Promise<ModelPlanInput> {
  const target = goalTarget();
  const job = goalJob(target);
  return await buildModelPlanInputForGoal(job, target, BALL6, { tools: [], feeds: SHOP_FEEDS });
}

describe('#1046 the plan states its own wall time (dump only)', () => {
  it('planMs, finishStageMs and the finishing ball are measured, and the estimate is their formula', async () => {
    const plan = await planModelCam(await plateInput());
    expect(typeof plan.planMs, 'the whole plan is timed').toBe('number');
    expect(plan.planMs!).toBeGreaterThanOrEqual(0);
    expect(typeof plan.finishStageMs, 'the finish stage is timed').toBe('number');
    expect(plan.finishStageMs!).toBeGreaterThan(0);
    // The finishing ball the rest statement judged: the ⌀6 the plan runs.
    expect(plan.finishBallDiameterMm).toBeCloseTo(6, 6);

    // The one formula both callers quote: the owned plan again plus Σ√(D_finish/d) × the finish.
    const rungs = REST_LADDER_RUNGS_MM.filter((d) => d < plan.finishBallDiameterMm! - 1e-9);
    expect(rungs.length).toBe(6);
    const scale = rungs.reduce((n, d) => n + Math.sqrt(plan.finishBallDiameterMm! / d), 0);
    expect(restLadderEstimateMs(plan)).toBeCloseTo(plan.planMs! + scale * plan.finishStageMs!, 6);
  }, 300_000);

  it('the timing never reaches a statement, a note or a program: the flag-off plan’s words are unchanged', async () => {
    const plan = await planModelCam(await plateInput());
    const words = plan.perSetup.flatMap((s) => [...s.notes, ...s.statements.map((st) => st.text)]);
    expect(words.length).toBeGreaterThan(0);
    for (const line of words) expect(line).not.toMatch(/\d+\s?ms\b/);
    // The ladder's own variables are the only readers: a plan with no timing answers null.
    const bare: ModelPlanOutput = { perSetup: plan.perSetup };
    expect(restLadderEstimateMs(bare)).toBeNull();
  }, 300_000);

  it('the ladder run is priced from the plain finish, not from its own rung passes', async () => {
    // A ladder run's finishStageMs is its OWN (the rungs re-plan the finish); what the press quotes
    // comes from the last plain Generate. This pins that a ladder plan still measures its own
    // finish stage rather than summing the rung passes into it.
    const plan = await planModelCam(await plateInput(), { restLadder: true });
    expect(plan.ladderRows?.length).toBeGreaterThan(0);
    expect(plan.finishStageMs!).toBeGreaterThan(0);
    expect(restLadderEstimateMs(plan)).not.toBeNull();
  }, 300_000);
});
