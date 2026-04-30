import { describe, it, expect } from 'vitest';
import { useProjectStore, createDefaultProject } from '@/store/projectStore';
import { parseProject, serializeProject } from '@/store/persistence';

describe('snap catch cantileverOn (#64)', () => {
  it('parsed snap catches default to cantileverOn: "lid" when omitted on disk', () => {
    const project = createDefaultProject('rpi-4b');
    useProjectStore.getState().setProject(project);
    useProjectStore.getState().patchCase({ joint: 'snap-fit' });
    const dirty = useProjectStore.getState().project;
    const stripped = JSON.parse(serializeProject(dirty));
    for (const c of stripped.case.snapCatches) delete c.cantileverOn;
    const reloaded = parseProject(JSON.stringify(stripped));
    for (const c of reloaded.case.snapCatches!) {
      expect(c.cantileverOn).toBe('lid');
    }
  });

  it('explicit cantileverOn: "case" round-trips through serialize / parse', () => {
    const project = createDefaultProject('rpi-4b');
    useProjectStore.getState().setProject(project);
    useProjectStore.getState().patchCase({ joint: 'snap-fit' });
    const id = useProjectStore.getState().project.case.snapCatches![0]!.id;
    useProjectStore.getState().patchSnapCatch(id, { cantileverOn: 'case' });
    const dirty = useProjectStore.getState().project;
    const round = parseProject(serializeProject(dirty));
    expect(round.case.snapCatches![0]!.cantileverOn).toBe('case');
  });

  it('patchSnapCatch writes cantileverOn through to the project state', () => {
    const project = createDefaultProject('rpi-4b');
    useProjectStore.getState().setProject(project);
    useProjectStore.getState().patchCase({ joint: 'snap-fit' });
    const id = useProjectStore.getState().project.case.snapCatches![0]!.id;
    useProjectStore.getState().patchSnapCatch(id, { cantileverOn: 'case' });
    expect(useProjectStore.getState().project.case.snapCatches![0]!.cantileverOn).toBe('case');
  });
});
