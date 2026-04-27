import { describe, it, expect } from 'vitest';
import {
  axisLockForFacing,
  snapToGrid,
  nudgeVectorsForFacing,
  portBounds,
  clampPortPosition,
} from '@/engine/portConstraints';
import { getBuiltinBoard } from '@/library';

describe('port drag constraints', () => {
  it('-y facing locks Y axis only', () => {
    const lock = axisLockForFacing('-y');
    expect(lock.lockX).toBe(false);
    expect(lock.lockY).toBe(true);
    expect(lock.lockZ).toBe(false);
  });

  it('+x facing locks X axis only', () => {
    const lock = axisLockForFacing('+x');
    expect(lock.lockX).toBe(true);
    expect(lock.lockY).toBe(false);
    expect(lock.lockZ).toBe(false);
  });

  it('+z facing locks Z axis only', () => {
    const lock = axisLockForFacing('+z');
    expect(lock.lockZ).toBe(true);
    expect(lock.lockX).toBe(false);
    expect(lock.lockY).toBe(false);
  });

  it('snapToGrid quantizes to 0.5mm', () => {
    expect(snapToGrid(2.7, 0.5)).toBe(2.5);
    expect(snapToGrid(2.8, 0.5)).toBe(3.0);
    expect(snapToGrid(0, 0.5)).toBe(0);
    expect(snapToGrid(-0.7, 0.5)).toBe(-0.5);
  });

  it('snapToGrid leaves value unchanged when grid <= 0', () => {
    expect(snapToGrid(2.7, 0)).toBe(2.7);
    expect(snapToGrid(2.7, -1)).toBe(2.7);
  });

  it('nudgeVectorsForFacing routes arrow keys onto wall-perpendicular axes', () => {
    const south = nudgeVectorsForFacing('-y');
    expect(south.ArrowLeft).toEqual([-1, 0, 0]);
    expect(south.ArrowRight).toEqual([1, 0, 0]);
    expect(south.ArrowUp).toEqual([0, 0, 1]);
    expect(south.ArrowDown).toEqual([0, 0, -1]);

    const east = nudgeVectorsForFacing('+x');
    expect(east.ArrowLeft).toEqual([0, -1, 0]);
    expect(east.ArrowUp).toEqual([0, 0, 1]);
  });

  it('clampPortPosition keeps the port within board bounds', () => {
    const board = getBuiltinBoard('rpi-4b')!;
    const port = board.components.find((c) => c.facing === '-y')!;
    const portPlacement = {
      id: 'x',
      sourceComponentId: port.id,
      kind: port.kind,
      position: { x: port.position.x, y: port.position.y, z: port.position.z },
      size: { x: port.size.x, y: port.size.y, z: port.size.z },
      facing: '-y' as const,
      cutoutMargin: 0.5,
      locked: false,
      enabled: true,
    };
    const bounds = portBounds(board, portPlacement);
    const tooFar = clampPortPosition({ x: 10000, y: 0, z: 0 }, bounds);
    expect(tooFar.x).toBeLessThanOrEqual(bounds.maxX);
    const tooNeg = clampPortPosition({ x: -10000, y: 0, z: 0 }, bounds);
    expect(tooNeg.x).toBeGreaterThanOrEqual(bounds.minX);
  });
});
