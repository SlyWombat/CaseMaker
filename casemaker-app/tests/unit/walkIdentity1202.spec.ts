/**
 * #1202 field 5 — THE WALKS' ROUTINE SHAPE.
 *
 * The cleaning pass and the air walk are files, and every job's file differs in its geometry. The
 * mark must still mean "this machine has never run this SEQUENCE": a raster over a different blank
 * is the same routine; a build that reorders or inserts a step is not. Geometry — rows, footprint,
 * sweep Z, the comment header — is deliberately outside the shape.
 */
import { describe, expect, it } from 'vitest';

import { cleanWalkFile, type CleanWalkInput, type CleanWalkStep } from '@/engine/cnc/engrave/cleanWalk';
import { walkRoutineIdentity } from '@/engine/cnc/engrave/walkIdentity';
import { flatEndMill } from '@/engine/cnc/tool';
import { Z1 } from '@/engine/cnc/machine';

const TOOL = flatEndMill(3.175, { number: 1, name: 'flat-3.175' });
const SETTINGS = { clearanceMm: 5, rowSpacingMm: 12 };
const base = (over: Partial<CleanWalkInput> = {}): CleanWalkInput => ({
  stock: { length: 160, width: 126 },
  obstacles: [],
  travelWorkZMm: 46,
  settings: SETTINGS,
  tool: TOOL,
  rapid: Z1.rapidEstimate,
  ...over,
});

const shapeOf = (routine: 'clean-walk' | 'air-walk', steps: readonly CleanWalkStep[]): string =>
  walkRoutineIdentity(routine, steps).shape;

function stepsOf(input: CleanWalkInput, mode: 'clean' | 'airwalk'): readonly CleanWalkStep[] {
  const r = cleanWalkFile(input, mode);
  if (!r.ok) throw new Error(r.reason);
  return r.steps;
}

describe('#1202 — a walk’s identity is its sequence, not its geometry', () => {
  it('the same cleaning pass over a different blank and row pitch is the same routine', () => {
    const big = stepsOf(base(), 'clean');
    const small = stepsOf(base({ stock: { length: 60, width: 40 }, settings: { clearanceMm: 5, rowSpacingMm: 8 } }), 'clean');
    expect([...big]).toEqual(['M811', 'raster', 'M812']);
    expect(shapeOf('clean-walk', big)).toBe(shapeOf('clean-walk', small));
  });

  it('the same air walk over a different blank is the same routine', () => {
    const big = stepsOf(base(), 'airwalk');
    const small = stepsOf(base({ stock: { length: 60, width: 40 } }), 'airwalk');
    expect([...big]).toEqual(['outline']);
    expect(shapeOf('air-walk', big)).toBe(shapeOf('air-walk', small));
  });

  it('a reordered or inserted step is a different routine — the acceptance’s double marks again', () => {
    const inOrder: CleanWalkStep[] = ['M811', 'raster', 'M812'];
    expect(shapeOf('clean-walk', inOrder)).not.toBe(shapeOf('clean-walk', ['M811', 'M812', 'raster']));
    expect(shapeOf('clean-walk', inOrder)).not.toBe(shapeOf('clean-walk', ['M811', 'raster', 'outline', 'M812']));
    expect(shapeOf('air-walk', ['outline'])).not.toBe(shapeOf('air-walk', ['outline', 'outline']));
  });
});
