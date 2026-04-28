import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  buildBoardPlaceholderGroup,
  placeholderBounds,
} from '@/engine/scene/boardPlaceholder';
import { getBuiltinBoard, listBuiltinBoardIds } from '@/library';

describe('Board placeholder mesh', () => {
  it('produces a Group with at least one PCB child + one mesh per component', () => {
    const giga = getBuiltinBoard('arduino-giga-r1-wifi')!;
    const group = buildBoardPlaceholderGroup(giga);
    expect(group).toBeInstanceOf(THREE.Group);
    const meshChildren = group.children.filter((c) => c.name.startsWith('component:'));
    expect(meshChildren.length).toBe(giga.components.length);
    expect(group.children.find((c) => c.name === 'pcb')).toBeTruthy();
  });

  it('PCB is sized to pcb.size and centered at (sx/2, sy/2, sz/2)', () => {
    const board = getBuiltinBoard('rpi-4b')!;
    const group = buildBoardPlaceholderGroup(board);
    const pcb = group.children.find((c) => c.name === 'pcb') as THREE.Mesh;
    const geom = pcb.geometry as THREE.BoxGeometry;
    expect(geom.parameters.width).toBeCloseTo(board.pcb.size.x);
    expect(geom.parameters.height).toBeCloseTo(board.pcb.size.y);
    expect(geom.parameters.depth).toBeCloseTo(board.pcb.size.z);
    expect(pcb.position.x).toBeCloseTo(board.pcb.size.x / 2);
    expect(pcb.position.y).toBeCloseTo(board.pcb.size.y / 2);
  });

  it('placeholderBounds includes the tallest +z component', () => {
    const giga = getBuiltinBoard('arduino-giga-r1-wifi')!;
    const bounds = placeholderBounds(giga);
    const tallest = giga.components.reduce(
      (m, c) => Math.max(m, c.position.z + c.size.z),
      giga.pcb.size.z,
    );
    expect(bounds.max.z).toBeCloseTo(tallest);
  });

  it('every built-in board produces a placeholder without throwing', () => {
    for (const id of listBuiltinBoardIds()) {
      const b = getBuiltinBoard(id)!;
      expect(() => buildBoardPlaceholderGroup(b)).not.toThrow();
    }
  });

  it('honours transform.origin offset', () => {
    const board = getBuiltinBoard('arduino-uno-r3')!;
    const group = buildBoardPlaceholderGroup(board, {
      origin: { x: 2.5, y: 2.5, z: 6.6 },
    });
    expect(group.position.x).toBeCloseTo(2.5);
    expect(group.position.y).toBeCloseTo(2.5);
    expect(group.position.z).toBeCloseTo(6.6);
  });
});
