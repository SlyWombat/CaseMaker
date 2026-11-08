/**
 * #1076 — THE RANK REPORTS, SO THE WATCHDOG IS NOT STARVED. On the tray bottom the CAM's progress
 * went silent from `features` to the first chain step for 125 s — the ball rank, which measures
 * every candidate with a FULL plan — and the ideal plan (a larger house, more candidates) crossed
 * the client's 180 s window. One tick per candidate measurement keeps the window alive; the
 * measurement itself is unchanged.
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { buildRandomPart } from '../tools/randomParts';
import { buildBinaryStl } from '@/workers/export/stlBinary';
import { sampleGoalHeightfield } from '@/engine/cnc/engrave/goalHeightfield';
import { planModelCam, type ModelPlanInput } from '@/engine/cnc/cam/model/plan';
import type { ModelPlanProgress } from '@/engine/cnc/cam/model/types';
import { flatEndMill, type Tool } from '../../src/engine/cnc/tool';
import type { EngraveTargetObject } from '@/types/engraveJob';

const flat6: Tool = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6' });
const ball2: Tool = { ...flatEndMill(2, { number: 3, id: 'ball-2', name: 'ball-2' }), shape: 'ball', typeText: 'Ball Nose', fluteLength: 30 };
const ball4: Tool = { ...flatEndMill(4, { number: 4, id: 'ball-4', name: 'ball-4' }), shape: 'ball', typeText: 'Ball Nose', fluteLength: 30 };
const ball6: Tool = { ...flatEndMill(6, { number: 5, id: 'ball-6', name: 'ball-6' }), shape: 'ball', typeText: 'Ball Nose', fluteLength: 30 };

function slopedInput(): ModelPlanInput {
  const part = buildRandomPart(1, 'sloped', tl);
  const stl = buildBinaryStl([{ positions: part.mesh.positions, indices: part.mesh.indices }]);
  const bytes = Buffer.from(stl);
  const target: EngraveTargetObject = {
    id: 'fixture-1076',
    name: 'sloped',
    format: 'stl',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    data: bytes.toString('base64'),
    size: { x: part.stock.length, y: part.stock.width, z: part.stock.thickness },
    position: { x: 0, y: 0, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
  };
  return {
    geometry: { triangles: part.mesh },
    setups: [{ frame: { up: [0, 0, 1], stockTop: 0, stockBottom: -part.stock.thickness }, underside: 'flatOnStockBottom' }],
    stock: { length: part.stock.length, width: part.stock.width, thickness: part.stock.thickness, material: 'hardwood' },
    fixture: { mount: 'tape', envelope: null },
    cutters: { house: [flat6, ball2, ball4, ball6], catalogue: [] },
    tolerances: { finishMm: 0.01 },
    edgeBreak: { legMm: 0 },
    goal: sampleGoalHeightfield(target, { pitchMm: 0.1, stockTopZ: 0 }),
  };
}

describe('#1076 the rank reports progress per candidate', () => {
  it('one tick per candidate measurement, between the features tick and the chain', async () => {
    const ticks: ModelPlanProgress[] = [];
    await planModelCam(slopedInput(), { onProgress: (p) => ticks.push(p) });
    const ops = ticks.map((t) => t.op);
    expect(ops, 'the plan reported nothing').toContain('features');
    // The #986 fixture measures two candidates (⌀2 and ⌀4); each reports before its measurement,
    // at the rank's own fraction (0.35 — the chain's candidate ticks are 0.4).
    const rankTicks = ticks.filter((t) => t.op === 'sequence' && t.fraction === 0.35);
    expect(rankTicks.length, `rank ticks: ${JSON.stringify(ops)}`).toBeGreaterThanOrEqual(2);
    // They arrive after the features tick, before the plan's linking end.
    const first = ticks.findIndex((t) => t.op === 'sequence' && t.fraction === 0.35);
    expect(first).toBeGreaterThan(ops.indexOf('features'));
    expect(ops.indexOf('linking')).toBeGreaterThan(first);
  }, 240_000);
});
