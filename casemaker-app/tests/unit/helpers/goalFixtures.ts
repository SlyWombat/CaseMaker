/**
 * #1180 S2 — THE SUITE'S SHARED GOAL FIXTURES.
 *
 * `slopedInput` was copied into three specs with two differences (the target id and the house
 * cutters); the #966 and notched-plate tool constants were copied with byte-identical bodies. They
 * live here once. Constants are shared ONLY where the objects are byte-identical — a job's program
 * and mesh pins depend on the tool objects exactly as each spec wrote them, so a value that differs
 * per file stays local to that file.
 */
import { createHash } from 'node:crypto';

import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { buildBinaryStl } from '@/workers/export/stlBinary';
import { sampleGoalHeightfield } from '@/engine/cnc/engrave/goalHeightfield';
import type { ModelPlanInput } from '@/engine/cnc/cam/model/plan';
import type { EngraveTargetObject } from '@/types/engraveJob';
import { buildRandomPart } from '../../tools/randomParts';
import { tl } from './manifoldExec';
import { NO_SHOP } from '../../tools/noShop';

/** The #966 cluster's ball: ⌀2, catalogue-shaped, numbered 1. */
export const BALL_2_Q966: Tool = flatEndMill(2, { number: 1, id: 'ball-2', name: 'ball-2', shape: 'ball', typeText: 'Ball Nose' });

/**
 * The #966 cluster's flat: ⌀3, numbered 2, flute 30 (#1195 — the freeing cut needs a STATED
 * reaching flute; an unstated record now leaves the pinned contour with no candidate).
 */
export const FLAT_3_Q966: Tool = flatEndMill(3, { number: 2, id: 'flat-3', name: 'flat-3', fluteLength: 30 });

/** The notched plate's ⌀6 ball — no stated flute. */
export const BALL6_NOTCHED: Tool = { ...flatEndMill(6), name: '6 mm ball nose', shape: 'ball', typeText: 'Ball', diameter: 6, cornerRadius: 3 };

/** The notched plate's ⌀2 ball with a STATED 10 mm flute so it reaches the 4.5 mm notch. */
export const BALL2_NOTCHED: Tool = { ...flatEndMill(2), name: '2 mm ball nose', shape: 'ball', typeText: 'Ball', diameter: 2, cornerRadius: 1, fluteLength: 10 };

/** The same balls with the 40 mm flute the later notched-plate specs state. */
export const BALL6_NOTCHED_LONG: Tool = { ...BALL6_NOTCHED, fluteLength: 40 };
export const BALL2_NOTCHED_LONG: Tool = { ...BALL2_NOTCHED, fluteLength: 40 };

/** The house the #1076/#1054 sloped fixture plans with: ⌀6 flat + ⌀2/4/6 balls, all flute 30. */
export const SLOPED_HOUSE: Tool[] = [
  // #1195 — the flat states its flute too: it is the cutter that frees the part.
  flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6', fluteLength: 30 }),
  { ...flatEndMill(2, { number: 3, id: 'ball-2', name: 'ball-2' }), shape: 'ball', typeText: 'Ball Nose', fluteLength: 30 },
  { ...flatEndMill(4, { number: 4, id: 'ball-4', name: 'ball-4' }), shape: 'ball', typeText: 'Ball Nose', fluteLength: 30 },
  { ...flatEndMill(6, { number: 5, id: 'ball-6', name: 'ball-6' }), shape: 'ball', typeText: 'Ball Nose', fluteLength: 30 },
];

/**
 * #986's `sloped` goal as a plan input. `targetId` is the file's own fixture id (the pins are per
 * spec); `house` is the cutter set that file plans with.
 */
export function slopedInput(targetId: string, house: Tool[] = SLOPED_HOUSE): ModelPlanInput {
  const part = buildRandomPart(1, 'sloped', tl);
  const stlBytes = buildBinaryStl([{ positions: part.mesh.positions, indices: part.mesh.indices }]);
  const bytes = Buffer.from(stlBytes);
  const target: EngraveTargetObject = {
    id: targetId,
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
    cutters: { house, catalogue: [] },
    tolerances: { finishMm: 0.01 },
    edgeBreak: { legMm: 0 },
    goal: sampleGoalHeightfield(target, { maxCells: NO_SHOP.goalMaxCells, pitchMm: 0.1, stockTopZ: 0 }),
  };
}
