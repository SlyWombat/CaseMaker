import { describe, it, expect } from 'vitest';
import { builtinBoards } from '@/library';
import { boardProfileSchema, builtinBoardProfileSchema } from '@/library/schema';

describe('board library', () => {
  it('contains at least one built-in board', () => {
    expect(builtinBoards.length).toBeGreaterThan(0);
  });

  it('every built-in board passes the strict schema (requires source URL)', () => {
    for (const b of builtinBoards) {
      expect(() => builtinBoardProfileSchema.parse(b)).not.toThrow();
    }
  });

  it('every built-in board has at least 3 mounting holes', () => {
    for (const b of builtinBoards) {
      expect(b.mountingHoles.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('rejects a board missing a source URL when strict-validated', () => {
    const partial = {
      id: 'foo',
      name: 'Foo',
      manufacturer: 'Test',
      pcb: { size: { x: 50, y: 50, z: 1.6 } },
      mountingHoles: [{ id: 'h1', x: 5, y: 5, diameter: 2.5 }],
      components: [],
      defaultStandoffHeight: 3,
      recommendedZClearance: 5,
      builtin: true,
    };
    expect(() => boardProfileSchema.parse(partial)).not.toThrow();
    expect(() => builtinBoardProfileSchema.parse(partial)).toThrow();
  });
});
