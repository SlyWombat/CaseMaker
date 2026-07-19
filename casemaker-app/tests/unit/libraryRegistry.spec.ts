import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { builtinBoards, getBuiltinBoard } from '@/library';
import { getBoard, listBoards, shadowedIdsForSource } from '@/library/registry';
import { listTemplates, findTemplateByBoardAcrossSources } from '@/library/templateRegistry';
import { useLibraryStore } from '@/store/libraryStore';
import { localBoardProfileSchema } from '@/library/schema';
import { createDefaultProject } from '@/store/projectStore';

/** Minimal valid board profile for import tests. */
function sampleBoard(id = 'my-test-board'): Record<string, unknown> {
  return {
    id,
    name: 'My Test Board',
    manufacturer: 'Test Bench',
    pcb: { size: { x: 40, y: 30, z: 1.6 } },
    mountingHoles: [{ id: 'h1', x: 3, y: 3, diameter: 2.5 }],
    components: [
      {
        id: 'usb',
        kind: 'usb-c',
        position: { x: 10, y: -1, z: 1.6 },
        size: { x: 9, y: 7.5, z: 3.2 },
        facing: '-y',
      },
    ],
    defaultStandoffHeight: 3,
    recommendedZClearance: 12,
  };
}

function resetLibrary(): void {
  const s = useLibraryStore.getState();
  for (const b of [...s.localBoards]) s.removeLocalBoard(b.id);
  for (const r of [...s.remoteSources]) s.removeRemoteSource(r.id);
}

beforeEach(resetLibrary);
afterEach(() => {
  resetLibrary();
  vi.unstubAllGlobals();
});

describe('builtin board discovery (import.meta.glob)', () => {
  it('loads every boards/*.json with unique ids', () => {
    expect(builtinBoards.length).toBeGreaterThanOrEqual(29);
    const ids = builtinBoards.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every builtin is marked builtin with a source URL', () => {
    for (const b of builtinBoards) {
      expect(b.builtin).toBe(true);
      expect(b.source && b.source.length).toBeTruthy();
    }
  });
});

describe('localBoardProfileSchema', () => {
  it('accepts a board without builtin flag and coerces builtin to false', () => {
    const parsed = localBoardProfileSchema.parse(sampleBoard());
    expect(parsed.builtin).toBe(false);
  });

  it('coerces builtin: true to false (imports cannot masquerade as bundled)', () => {
    const parsed = localBoardProfileSchema.parse({ ...sampleBoard(), builtin: true });
    expect(parsed.builtin).toBe(false);
  });
});

describe('libraryStore.addLocalBoard', () => {
  it('adds a valid board and reports soft warnings for missing provenance', () => {
    const result = useLibraryStore.getState().addLocalBoard(sampleBoard());
    expect(result.ok).toBe(true);
    expect(result.board?.id).toBe('my-test-board');
    expect(result.warnings.join(' ')).toMatch(/source URL/);
    expect(result.warnings.join(' ')).toMatch(/measurementMethod/);
    expect(useLibraryStore.getState().localBoards).toHaveLength(1);
  });

  it('rejects invalid profiles with a path-anchored error', () => {
    const bad = { ...sampleBoard(), pcb: { size: { x: -1, y: 30, z: 1.6 } } };
    const result = useLibraryStore.getState().addLocalBoard(bad);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/pcb/);
    expect(useLibraryStore.getState().localBoards).toHaveLength(0);
  });

  it('auto-renames on collision with a builtin id', () => {
    const result = useLibraryStore.getState().addLocalBoard(sampleBoard('rpi-4b'));
    expect(result.ok).toBe(true);
    expect(result.renamedFrom).toBe('rpi-4b');
    expect(result.board?.id).toBe('rpi-4b-2');
    // The builtin stays authoritative for its id.
    expect(getBoard('rpi-4b')).toBe(getBuiltinBoard('rpi-4b'));
  });

  it('auto-renames on collision with an existing local id', () => {
    const store = useLibraryStore.getState();
    expect(store.addLocalBoard(sampleBoard()).board?.id).toBe('my-test-board');
    expect(store.addLocalBoard(sampleBoard()).board?.id).toBe('my-test-board-2');
    expect(store.addLocalBoard(sampleBoard()).board?.id).toBe('my-test-board-3');
  });

  it('exportLocalBoard round-trips through addLocalBoard', () => {
    const store = useLibraryStore.getState();
    store.addLocalBoard(sampleBoard());
    const json = store.exportLocalBoard('my-test-board');
    expect(json).toBeTruthy();
    store.removeLocalBoard('my-test-board');
    const result = store.addLocalBoard(JSON.parse(json!));
    expect(result.ok).toBe(true);
    expect(result.board?.id).toBe('my-test-board');
  });
});

describe('registry resolution across sources', () => {
  it('createDefaultProject works with a locally-imported board', () => {
    useLibraryStore.getState().addLocalBoard(sampleBoard());
    const project = createDefaultProject('my-test-board');
    expect(project.board.clonedFrom).toBe('my-test-board');
    expect(project.board.pcb.size.x).toBe(40);
    // Auto-ports generated from the imported profile's components.
    expect(project.ports.length).toBeGreaterThan(0);
  });

  it('listBoards tags origins and keeps builtins first', () => {
    useLibraryStore.getState().addLocalBoard(sampleBoard());
    const entries = listBoards();
    expect(entries[0]?.origin.kind).toBe('builtin');
    const local = entries.find((e) => e.board.id === 'my-test-board');
    expect(local?.origin.kind).toBe('local');
  });
});

describe('remote sources', () => {
  const indexDoc = { name: 'Community Boards', boards: [sampleBoard('community-board')] };

  function stubFetch(payload: unknown, ok = true, status = 200): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok,
        status,
        text: async () => JSON.stringify(payload),
        json: async () => payload,
      })),
    );
  }

  it('addRemoteSource fetches, validates, and registers boards', async () => {
    stubFetch(indexDoc);
    const result = await useLibraryStore.getState().addRemoteSource('https://boards.example.com/index.json');
    expect(result.ok).toBe(true);
    expect(result.source?.label).toBe('Community Boards');
    expect(result.source?.boards).toHaveLength(1);
    expect(getBoard('community-board')?.name).toBe('My Test Board');
    const entry = listBoards().find((e) => e.board.id === 'community-board');
    expect(entry?.origin).toMatchObject({ kind: 'remote', sourceLabel: 'Community Boards' });
  });

  it('accepts a bare-array index document', async () => {
    stubFetch([sampleBoard('bare-array-board')]);
    const result = await useLibraryStore.getState().addRemoteSource('https://example.com/boards.json');
    expect(result.ok).toBe(true);
    expect(getBoard('bare-array-board')).toBeTruthy();
  });

  it('rejects invalid URLs, duplicate sources, and empty indexes', async () => {
    const store = useLibraryStore.getState();
    expect((await store.addRemoteSource('not a url')).ok).toBe(false);
    stubFetch({ boards: [] });
    expect((await store.addRemoteSource('https://example.com/empty.json')).ok).toBe(false);
    stubFetch(indexDoc);
    expect((await store.addRemoteSource('https://example.com/i.json')).ok).toBe(true);
    expect((await store.addRemoteSource('https://example.com/i.json')).ok).toBe(false);
  });

  it('reports HTTP failures without registering the source', async () => {
    stubFetch({}, false, 404);
    const result = await useLibraryStore.getState().addRemoteSource('https://example.com/missing.json');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/404/);
    expect(useLibraryStore.getState().remoteSources).toHaveLength(0);
  });

  it('disabled sources are excluded from resolution and listing', async () => {
    stubFetch(indexDoc);
    const { source } = await useLibraryStore.getState().addRemoteSource('https://example.com/i.json');
    useLibraryStore.getState().setRemoteSourceEnabled(source!.id, false);
    expect(getBoard('community-board')).toBeUndefined();
    expect(listBoards().some((e) => e.board.id === 'community-board')).toBe(false);
  });

  it('builtin/local ids shadow colliding remote boards', async () => {
    stubFetch({ boards: [sampleBoard('rpi-4b'), sampleBoard('community-board')] });
    await useLibraryStore.getState().addRemoteSource('https://example.com/i.json');
    // rpi-4b resolves to the builtin, and the remote copy is not listed.
    expect(getBoard('rpi-4b')).toBe(getBuiltinBoard('rpi-4b'));
    const rpiEntries = listBoards().filter((e) => e.board.id === 'rpi-4b');
    expect(rpiEntries).toHaveLength(1);
    expect(rpiEntries[0]?.origin.kind).toBe('builtin');
    expect(getBoard('community-board')).toBeTruthy();
  });

  it('skips invalid boards in an index but keeps the valid ones', async () => {
    stubFetch({ boards: [sampleBoard('good-board'), { id: 'broken' }] });
    const result = await useLibraryStore.getState().addRemoteSource('https://example.com/i.json');
    expect(result.ok).toBe(true);
    expect(result.source?.boards).toHaveLength(1);
    expect(result.source?.invalidCount).toBe(1);
  });

  it('shadowedIdsForSource reports remote ids hidden by higher tiers (#128)', async () => {
    stubFetch({ boards: [sampleBoard('rpi-4b'), sampleBoard('community-board')] });
    const { source } = await useLibraryStore.getState().addRemoteSource('https://example.com/i.json');
    expect(shadowedIdsForSource(source!.id)).toEqual(['rpi-4b']);
  });

  it('index templates[] register and resolve across sources (#126)', async () => {
    stubFetch({
      name: 'Community',
      boards: [sampleBoard('community-board')],
      templates: [
        {
          id: 'community-pod',
          name: 'Community pod',
          description: 'Snap pod for the community board.',
          estPrintMinutes: 30,
          boardId: 'community-board',
          casePatch: { joint: 'snap-fit' },
        },
        { id: 'broken-template' }, // invalid — dropped, counted
        {
          id: 'orphan-template',
          name: 'Orphan',
          description: 'References a board nobody has.',
          estPrintMinutes: 30,
          boardId: 'board-that-does-not-exist',
        },
      ],
    });
    const { source } = await useLibraryStore.getState().addRemoteSource('https://example.com/i.json');
    expect(source?.templates.map((t) => t.id)).toEqual(['community-pod', 'orphan-template']);
    expect(source?.invalidCount).toBe(1);

    const listed = listTemplates();
    // Community template listed after the bundled set; orphan filtered out
    // because its board doesn't resolve.
    expect(listed.some((t) => t.id === 'community-pod')).toBe(true);
    expect(listed.some((t) => t.id === 'orphan-template')).toBe(false);

    // Pick-a-board quickstart flow finds it, and building it runs the shared
    // patchCase path — snap catches seeded, not bypassed.
    const tpl = findTemplateByBoardAcrossSources('community-board');
    expect(tpl?.id).toBe('community-pod');
    const project = tpl!.build();
    expect(project.case.joint).toBe('snap-fit');
    expect(project.case.snapCatches!.length).toBeGreaterThan(0);
  });

  it('addLocalTemplate imports a spec, warns on unknown board, lists once board arrives', () => {
    const store = useLibraryStore.getState();
    const spec = {
      id: 'my-imported-pod',
      name: 'My imported pod',
      description: 'Snap pod from a JSON file.',
      estPrintMinutes: 25,
      boardId: 'my-test-board',
      casePatch: { joint: 'snap-fit' },
    };
    const result = store.addLocalTemplate(spec);
    expect(result.ok).toBe(true);
    expect(result.kind).toBe('template');
    // Board not present yet → warned, and hidden from the template list.
    expect(result.warnings.join(' ')).toMatch(/my-test-board/);
    expect(listTemplates().some((t) => t.id === 'my-imported-pod')).toBe(false);
    // Import the board → template appears with local provenance.
    store.addLocalBoard(sampleBoard());
    const listed = listTemplates().find((t) => t.id === 'my-imported-pod');
    expect(listed?.sourceLabel).toBe('your library');
    const project = listed!.build();
    expect(project.case.snapCatches!.length).toBeGreaterThan(0);
    useLibraryStore.getState().removeLocalTemplate('my-imported-pod');
    expect(useLibraryStore.getState().localTemplates).toHaveLength(0);
  });

  it('addLocalBoard warns about unrecognized fields instead of silently stripping (#129)', () => {
    const result = useLibraryStore
      .getState()
      .addLocalBoard({ ...sampleBoard(), futureFeatureField: { x: 1 } });
    expect(result.ok).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/futureFeatureField/);
  });
});
