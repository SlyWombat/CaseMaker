// @vitest-environment jsdom
// #1123 item 10 — a reload returns to the open project and job, not the door.
//
// The record is one localStorage value written while the CNC workspace is active. These are the
// red-first behaviours: (1) restore puts the Job panel (or the Cut step) back on screen; (2) a
// record for another job is not applied; (3) the record exists for the operator's real reload and
// is cleared when they deliberately go back to the door.
import { beforeEach, describe, expect, it } from 'vitest';
import { useProjectStore } from '@/store/projectStore';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { useViewportStore } from '@/store/viewportStore';
import { resetCncMode, useCncModeStore } from '@/store/cncModeStore';
import { serializeProject } from '@/store/projectFile';
import {
  WORKSPACE_KEY,
  clearWorkspaceSession,
  readWorkspaceSession,
  restoreWorkspaceSession,
  startWorkspaceSession,
  writeWorkspaceSession,
  type WorkspaceSession,
} from '@/store/workspaceSession';

const job = () => useEngraveJobStore.getState().job;

function seeded(over: Partial<WorkspaceSession> = {}): WorkspaceSession {
  return {
    v: 1,
    jobId: job().id,
    mode: 'cut',
    section: 'cnc-engrave',
    projectText: serializeProject(useProjectStore.getState().project),
    savedAt: '2026-11-09T16:00:00.000Z',
    ...over,
  };
}

beforeEach(() => {
  localStorage.clear();
  resetCncMode();
  useViewportStore.setState({ activeSidebarSection: null });
  // The page a reload starts on: the default project behind the door.
  useProjectStore.setState({ project: useProjectStore.getState().project, welcomeMode: true });
});

describe('#1123 item 10 — the open CNC job survives a reload', () => {
  it('restores the project and job into the CNC Job panel (Design) or the Cut step', () => {
    localStorage.setItem(WORKSPACE_KEY, JSON.stringify(seeded({ mode: 'cut' })));
    expect(restoreWorkspaceSession()).toBe(true);
    expect(useProjectStore.getState().welcomeMode).toBe(false);
    expect(useViewportStore.getState().activeSidebarSection).toBe('cnc-engrave');
    expect(useCncModeStore.getState()).toMatchObject({ mode: 'cut', jobId: job().id });
  });

  it('restores the saved project document, not just the mode', () => {
    const saved = { ...useProjectStore.getState().project, name: 'the case from before the reload' };
    localStorage.setItem(WORKSPACE_KEY, JSON.stringify(seeded({ projectText: serializeProject(saved) })));
    restoreWorkspaceSession();
    expect(useProjectStore.getState().project.name).toBe('the case from before the reload');
  });

  it('does not restore a record whose job is not the open job', () => {
    localStorage.setItem(WORKSPACE_KEY, JSON.stringify(seeded({ jobId: 'some-other-job' })));
    expect(restoreWorkspaceSession()).toBe(false);
    expect(useProjectStore.getState().welcomeMode).toBe(true);
    expect(useViewportStore.getState().activeSidebarSection).toBeNull();
  });

  it('a corrupt record is ignored, and never throws', () => {
    localStorage.setItem(WORKSPACE_KEY, '{not json');
    expect(restoreWorkspaceSession()).toBe(false);
    expect(useProjectStore.getState().welcomeMode).toBe(true);
  });

  it('writes the record while the CNC workspace is active and the mode changes', () => {
    // The real app reached CNC through the wizard, which flips welcomeMode off.
    useProjectStore.setState({ welcomeMode: false });
    const stop = startWorkspaceSession();
    useViewportStore.getState().setActiveSidebarSection('cnc-engrave');
    // The panel syncs the mode with its job; a bare show() leaves jobId null and writes Design.
    useCncModeStore.setState({ mode: 'cut', jobId: job().id });
    useEngraveJobStore.setState({ job: { ...job(), name: 'renamed after the record' } });
    const record = readWorkspaceSession();
    expect(record).not.toBeNull();
    expect(record).toMatchObject({ jobId: job().id, mode: 'cut', section: 'cnc-engrave' });
    expect(record!.projectText).toContain('"name"');
    stop();
  });

  it('clears the record when the operator goes back to the door or leaves CNC', () => {
    useProjectStore.setState({ welcomeMode: false });
    const stop = startWorkspaceSession();
    useViewportStore.getState().setActiveSidebarSection('cnc-engrave');
    expect(readWorkspaceSession()).not.toBeNull();
    useProjectStore.getState().showWelcome();
    expect(readWorkspaceSession()).toBeNull();

    useProjectStore.setState({ welcomeMode: false });
    useViewportStore.getState().setActiveSidebarSection('cnc-engrave');
    expect(readWorkspaceSession()).not.toBeNull();
    useViewportStore.getState().setActiveSidebarSection('case');
    expect(readWorkspaceSession()).toBeNull();
    stop();
  });

  it('clearWorkspaceSession removes the record', () => {
    useProjectStore.setState({ welcomeMode: false });
    useViewportStore.getState().setActiveSidebarSection('cnc-engrave');
    writeWorkspaceSession();
    clearWorkspaceSession();
    expect(localStorage.getItem(WORKSPACE_KEY)).toBeNull();
  });
});
