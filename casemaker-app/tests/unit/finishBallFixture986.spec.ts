/**
 * #986 — THE PRUNE'S ORDER AND ITS EARLY EXIT, pinned on a three-candidate part (C's review note
 * 1). The rank measures candidates FINE → COARSE and stops at the first one that fails to beat the
 * best, because leftover is monotone in the diameter on a reach-filtered set. This fixture makes
 * the skip VISIBLE: the ⌀6 candidate is in the set, the statement names the two candidates that
 * were measured, and the ⌀6 is absent — if the ordering or the break moved, the ⌀6 would appear.
 *
 * The part is #964's own `sloped` seed with a flat and three ball diameters added to the house, so
 * the candidate list has three members to order and prune.
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { buildRandomPart } from '../tools/randomParts';
import { buildBinaryStl } from '@/workers/export/stlBinary';
import { sampleGoalHeightfield } from '@/engine/cnc/engrave/goalHeightfield';
import { planModelCam, type ModelPlanInput } from '@/engine/cnc/cam/model/plan';
import { flatEndMill, type Tool } from '../../src/engine/cnc/tool';
import type { EngraveTargetObject } from '@/types/engraveJob';
import { NO_SHOP } from '../tools/noShop';

const flat6: Tool = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6', fluteLength: 30 });
// All three reach the part's deepest remainder (flute 30 mm), so all three are CANDIDATES;
// the prune is what decides how many are measured.
const ball2: Tool = { ...flatEndMill(2, { number: 3, id: 'ball-2', name: 'ball-2', fluteLength: 30 }), shape: 'ball', typeText: 'Ball Nose', fluteLength: 30 };
const ball4: Tool = { ...flatEndMill(4, { number: 4, id: 'ball-4', name: 'ball-4', fluteLength: 30 }), shape: 'ball', typeText: 'Ball Nose', fluteLength: 30 };
const ball6: Tool = { ...flatEndMill(6, { number: 5, id: 'ball-6', name: 'ball-6', fluteLength: 30 }), shape: 'ball', typeText: 'Ball Nose', fluteLength: 30 };

describe('#986 the prune’s order and early exit', () => {
  it('measures fine → coarse, stops at the first non-improvement, and the coarse candidate is visibly skipped', async () => {
    const part = buildRandomPart(1, 'sloped', tl);
    const stl = buildBinaryStl([{ positions: part.mesh.positions, indices: part.mesh.indices }]);
    const bytes = Buffer.from(stl);
    const target: EngraveTargetObject = {
      id: 'fixture-986',
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
    const input: ModelPlanInput = {
      geometry: { triangles: part.mesh },
      setups: [{ frame: { up: [0, 0, 1], stockTop: 0, stockBottom: -part.stock.thickness }, underside: 'flatOnStockBottom' }],
      stock: { length: part.stock.length, width: part.stock.width, thickness: part.stock.thickness, material: 'hardwood' },
      fixture: { mount: 'tape', envelope: null },
      cutters: { house: [flat6, ball2, ball4, ball6], catalogue: [] },
      tolerances: { finishMm: 0.01 },
      edgeBreak: { legMm: 0 },
      goal: sampleGoalHeightfield(target, { maxCells: NO_SHOP.goalMaxCells, pitchMm: 0.1, stockTopZ: 0 }),
    };
    const output = await planModelCam(input);
    const notes = output.perSetup.flatMap((s) => s.notes).join('\n');
    const rank = output.perSetup.flatMap((s) => s.notes).find((n) => n.startsWith('ball rank'));
    expect(rank, `no rank statement in the plan's notes:\n${notes}`).toBeDefined();
    // Fine → coarse: the ⌀2 is measured first and the ⌀4 second; the ⌀6 never appears because the
    // first non-improvement ends the search.
    expect(rank!).toMatch(/measured 2 candidate\(s\)/);
    expect(rank!).toContain('⌀2.00 mm ball-2');
    expect(rank!).toContain('⌀4.00 mm ball-4');
    expect(rank!).not.toContain('⌀6.00 mm ball-6');
    // And the win is the first measured candidate on the monotone premise.
    expect(rank!).toContain('Chosen: ball-2');
  }, 240_000);
});
