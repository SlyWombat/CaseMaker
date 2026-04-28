import { describe, it, expect, beforeEach } from 'vitest';
import { useProjectStore, createDefaultProject } from '@/store/projectStore';
import { boardProfileSchema } from '@/library/schema';

describe('Clone built-in board for editing (#38)', () => {
  beforeEach(() => {
    useProjectStore.getState().setProject(createDefaultProject('arduino-giga-r1-wifi'));
  });

  it('cloneBoardForEditing flips builtin → false and renames the id', () => {
    const before = useProjectStore.getState().project.board;
    expect(before.builtin).toBe(true);
    const beforeId = before.id;

    useProjectStore.getState().cloneBoardForEditing();

    const after = useProjectStore.getState().project.board;
    expect(after.builtin).toBe(false);
    expect(after.id).not.toBe(beforeId);
    expect(after.id.startsWith(`custom-${beforeId}-`)).toBe(true);
    expect(after.name.endsWith('(custom)')).toBe(true);
  });

  it('cloned board still satisfies the (non-builtin) schema', () => {
    useProjectStore.getState().cloneBoardForEditing();
    const board = useProjectStore.getState().project.board;
    expect(() => boardProfileSchema.parse(board)).not.toThrow();
  });

  it('cloning a built-in does not mutate the original library entry', () => {
    const beforeName = useProjectStore.getState().project.board.name;
    useProjectStore.getState().cloneBoardForEditing();
    // Reset to the library entry; it should still match its original name.
    useProjectStore.getState().setProject(createDefaultProject('arduino-giga-r1-wifi'));
    expect(useProjectStore.getState().project.board.name).toBe(beforeName);
  });

  it('cloneBoardForEditing on an already-custom board is a no-op', () => {
    useProjectStore.getState().cloneBoardForEditing();
    const id1 = useProjectStore.getState().project.board.id;
    useProjectStore.getState().cloneBoardForEditing();
    const id2 = useProjectStore.getState().project.board.id;
    expect(id2).toBe(id1);
  });

  it('patchBoardMeta updates editable metadata fields on a clone', () => {
    useProjectStore.getState().cloneBoardForEditing();
    useProjectStore.getState().patchBoardMeta({
      name: 'My Custom Giga',
      manufacturer: 'Acme',
      defaultStandoffHeight: 7,
      recommendedZClearance: 18,
      crossReference: 'https://example.com/datasheet.pdf',
      datasheetRevision: 'Rev A — 2026-01',
    });
    const b = useProjectStore.getState().project.board;
    expect(b.name).toBe('My Custom Giga');
    expect(b.manufacturer).toBe('Acme');
    expect(b.defaultStandoffHeight).toBe(7);
    expect(b.recommendedZClearance).toBe(18);
    expect(b.crossReference).toBe('https://example.com/datasheet.pdf');
    expect(b.datasheetRevision).toBe('Rev A — 2026-01');
  });

  it('patchBoardMeta is a no-op on built-in boards', () => {
    const before = useProjectStore.getState().project.board.defaultStandoffHeight;
    useProjectStore.getState().patchBoardMeta({ defaultStandoffHeight: 999 });
    expect(useProjectStore.getState().project.board.defaultStandoffHeight).toBe(before);
  });
});
