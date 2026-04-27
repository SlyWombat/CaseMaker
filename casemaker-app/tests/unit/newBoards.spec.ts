import { describe, it, expect } from 'vitest';
import { listBuiltinBoardIds, getBuiltinBoard } from '@/library';
import { compileProject } from '@/engine/compiler/ProjectCompiler';
import { createDefaultProject } from '@/store/projectStore';

describe('Marketing gap #12 — expanded board library', () => {
  const newIds = [
    'rpi-pico',
    'teensy-41',
    'jetson-nano-b01',
    'beaglebone-black',
    'microbit-v2',
    'm5stack-core2',
  ];

  it('all 6 new boards are registered as built-ins', () => {
    const ids = listBuiltinBoardIds();
    for (const id of newIds) expect(ids).toContain(id);
  });

  it('each new board profile compiles into a valid BuildPlan', () => {
    for (const id of newIds) {
      const project = createDefaultProject(id);
      const plan = compileProject(project);
      expect(plan.nodes.map((n) => n.id)).toEqual(['shell', 'lid']);
    }
  });

  it('each new board has a datasheet source URL', () => {
    for (const id of newIds) {
      const board = getBuiltinBoard(id)!;
      expect(typeof board.source).toBe('string');
      expect(board.source!.length).toBeGreaterThan(10);
    }
  });
});
