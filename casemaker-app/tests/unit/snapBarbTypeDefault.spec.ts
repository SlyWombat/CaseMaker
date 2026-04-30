import { describe, it, expect } from 'vitest';
import { defaultSnapCatchesForCase } from '@/engine/compiler/snapCatches';
import { useProjectStore, createDefaultProject } from '@/store/projectStore';
import { parseProject, serializeProject } from '@/store/persistence';

describe('snap catch barbType has explicit default (#78)', () => {
  it('defaultSnapCatchesForCase emits barbType on every catch', () => {
    const proj = createDefaultProject('rpi-4b');
    useProjectStore.getState().setProject(proj);
    const catches = defaultSnapCatchesForCase(proj.board, proj.case);
    expect(catches.length).toBeGreaterThan(0);
    for (const c of catches) {
      expect(c.barbType).toBeDefined();
      expect(c.barbType).toBe('hook');
    }
  });

  it("loading a serialized project with missing barbType fills 'hook' on parse", () => {
    // Synthesize a serialized project with barbType deliberately absent on
    // every catch — this is the on-disk shape from before #78.
    const proj = createDefaultProject('rpi-4b');
    useProjectStore.getState().setProject(proj);
    useProjectStore.getState().patchCase({ joint: 'snap-fit' });
    const dirty = useProjectStore.getState().project;
    const stripped = JSON.parse(serializeProject(dirty));
    for (const c of stripped.case.snapCatches) delete c.barbType;
    const reloaded = parseProject(JSON.stringify(stripped));
    expect(reloaded.case.snapCatches!.length).toBeGreaterThan(0);
    for (const c of reloaded.case.snapCatches!) {
      expect(c.barbType).toBe('hook');
    }
  });
});
