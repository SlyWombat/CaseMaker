import { describe, it, expect } from 'vitest';
import { listBuiltinBoardIds, getBuiltinBoard } from '@/library';

/**
 * Tracking which built-in boards have completed the per-board datasheet audit
 * (issue #22). Add an id to AUDITED_IDS once the manual audit lands and the
 * JSON profile carries `crossReference` and `measurementMethod`.
 */
const AUDITED_IDS: string[] = ['radxa-dragon-q8b'];

describe('Issue #22 — board library audit gate', () => {
  it('every built-in board has at least a source URL', () => {
    for (const id of listBuiltinBoardIds()) {
      const board = getBuiltinBoard(id)!;
      expect(board.source, `${id} missing source URL`).toBeTypeOf('string');
    }
  });

  it('audited boards (per AUDITED_IDS) carry crossReference and measurementMethod', () => {
    for (const id of AUDITED_IDS) {
      const board = getBuiltinBoard(id)!;
      expect(board.crossReference, `${id} missing crossReference`).toBeTypeOf('string');
      expect(
        board.measurementMethod,
        `${id} missing measurementMethod`,
      ).toMatch(/datasheet|open-source-cad|physical-measurement/);
    }
  });
});
