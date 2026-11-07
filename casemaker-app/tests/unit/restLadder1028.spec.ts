/**
 * #1028 — THE LEFTOVER'S BALL, MEASURED BY THE RANK'S OWN QUANTITY (6b's six fields, the rank scope).
 *
 * The notched plate, ⌀6 owned and no catalogue: the rank's known numbers say the ⌀6 finish leaves
 * 2.424 mm over 21.39 % of the goal while a ⌀2 ball leaves 0.896 mm over 6.50 % (goalRestPass's own
 * measurement). The ladder measures the standard rungs ⌀0.5/1/1.5/2/3/4 with the SAME call the rank
 * makes for an owned ball (`planCurvedForTree` + `goalCoverage`), coarse → fine, and stops at the
 * first rung whose own leftover is under the shop's visibility thresholds. The named ball is the
 * LARGEST rung that takes it (a finer ball costs cycle for nothing); when none takes it, the finest
 * rung is named as a reduction. The ladder is never a plan candidate, runs only on demand
 * (`restLadder`), only on the owned plan, and never when a catalogue ball was measured.
 *
 * RED at main: nothing measures the rungs — `ladderRows` is absent and the statement keeps the
 * #1027 plain absence.
 */
import { describe, expect, it } from 'vitest';

import { planModelCam, type ModelPlanInput, type ModelPlanOutput } from '@/engine/cnc/cam/model/plan';
import { planTwoOutcomes } from '@/engine/cnc/cam/model/twoPlans';
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

/** The #1023 plate: 20 × 10 × 5 with a 6 mm-wide V notch, wound consistently. */
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
const BALL2: Tool = { ...flatEndMill(2), name: '2 mm ball nose', shape: 'ball', typeText: 'Ball', diameter: 2, cornerRadius: 1, fluteLength: 40 };
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
    id: 'goal-1023', name: 'notched plate', role: 'goal', enabled: true, format: 'stl',
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

async function plateInput(shop: Parameters<typeof buildModelPlanInputForGoal>[3], tool: Tool = BALL6): Promise<{ input: ModelPlanInput; target: EngraveTargetObject; job: EngraveJob }> {
  const target = goalTarget();
  const job = goalJob(target);
  const input = await buildModelPlanInputForGoal(job, target, tool, shop);
  return { input, target, job };
}

type LadderRowView = { diameterMm: number; leftoverShare: number; leftoverAboveMm: number; cycleSeconds: number };
function ladderRows(plan: ModelPlanOutput): LadderRowView[] | undefined {
  return (plan as unknown as { ladderRows?: LadderRowView[] }).ladderRows;
}

function statementOf(plan: ModelPlanOutput): { code: string; text: string } {
  const last = plan.perSetup.at(-1)!;
  const found = last.statements.find((s) => s.code === 'goal-rest-uncut' || s.code === 'goal-rest-pass');
  return { code: found?.code ?? '', text: found?.text ?? '' };
}

describe('#1028 the ladder measures the standard rungs beside the owned plan', () => {
  it('ladder ON, plate ⌀6 only: six rungs measured, the ⌀2 row at the rank\'s own numbers, monotone, and the sentence names a rung', async () => {
    const { input } = await plateInput({ tools: [], feeds: SHOP_FEEDS });
    const plan = await planModelCam(input, { restLadder: true });
    const rows = ladderRows(plan);
    expect(rows, 'the ladder measured no rung').toBeDefined();
    expect(rows!.length, 'the plate should measure every rung finer than ⌀6').toBe(6);
    // Coarse → fine (the fields' order), each finer rung's leftover never worse than the coarser.
    expect(rows!.map((r) => r.diameterMm)).toEqual([4, 3, 2, 1.5, 1, 0.5]);
    for (let i = 1; i < rows!.length; i++) {
      expect(rows![i]!.leftoverShare, `⌀${rows![i]!.diameterMm} is worse than the coarser rung`).toBeLessThanOrEqual(rows![i - 1]!.leftoverShare + 1e-9);
    }
    // The rank's known ⌀2 numbers (goalRestPass's own measurement): 6.50 %, 0.896 mm.
    const two = rows!.find((r) => r.diameterMm === 2)!;
    expect(two.leftoverShare * 100).toBeCloseTo(6.5, 1);
    expect(two.leftoverAboveMm).toBeCloseTo(0.896, 2);
    // The statement names a rung — the plate has no rung under 0.10 mm / 2 %, so the finest one is
    // named as a reduction, with the cycle's source stated.
    const st = statementOf(plan);
    expect(st.code).toBe('goal-rest-uncut');
    expect(st.text).toContain('standard size, not in this shop’s catalogue');
    expect(st.text).toMatch(/⌀\d+(\.\d+)? mm ball/);
    expect(st.text).toContain('estimated from the shop’s seeded bands');
  }, 180_000);

  it('ladder OFF (the default): the statement is the #1027 plain absence, byte-identical', async () => {
    const { input } = await plateInput({ tools: [], feeds: SHOP_FEEDS });
    const plan = await planModelCam(input);
    expect(ladderRows(plan), 'the ladder ran without being asked').toBeUndefined();
    const st = statementOf(plan);
    expect(st.text).toContain('none is configured for this shop (Manage → Tools)');
    expect(st.text).not.toContain('standard size');
  }, 180_000);

  it('the ⌀2 owned: goal-rest-pass and no ladder (a smaller owned ball ran)', async () => {
    const { input } = await plateInput({ tools: [{ key: 'user:ball-2-1028', tool: BALL2, provenance: 'test' }], feeds: SHOP_FEEDS });
    const plan = await planModelCam(input, { restLadder: true });
    expect(statementOf(plan).code).toBe('goal-rest-pass');
    expect(ladderRows(plan), 'the ladder ran although an owned ball took it').toBeUndefined();
  }, 180_000);

  it('a catalogue ball measured: the catalogue sentence, and the owned plan measured no ladder', async () => {
    const { input } = await plateInput({ tools: [], feeds: SHOP_FEEDS });
    const two = await planTwoOutcomes({ ...input, cutters: { house: input.cutters.house, catalogue: [BALL2] } }, { restLadder: true });
    expect(statementOf(two.owned).text).toContain('catalogue');
    expect(ladderRows(two.owned), 'the ladder ran although a catalogue ball was measured').toBeUndefined();
  }, 180_000);
});
