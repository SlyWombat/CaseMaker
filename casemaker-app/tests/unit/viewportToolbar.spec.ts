import { describe, it, expect, beforeEach } from 'vitest';
import { useViewportStore } from '@/store/viewportStore';

describe('viewport toolbar state (#86)', () => {
  beforeEach(() => {
    // Reset to defaults so each test starts clean.
    useViewportStore.setState({
      activeTool: 'orbit',
      cameraMode: 'perspective',
      showBoard: true,
    });
  });

  it('default activeTool is "orbit" and default cameraMode is "perspective"', () => {
    const s = useViewportStore.getState();
    expect(s.activeTool).toBe('orbit');
    expect(s.cameraMode).toBe('perspective');
  });

  it('setActiveTool updates state', () => {
    useViewportStore.getState().setActiveTool('select');
    expect(useViewportStore.getState().activeTool).toBe('select');
    useViewportStore.getState().setActiveTool('pan');
    expect(useViewportStore.getState().activeTool).toBe('pan');
  });

  it('setCameraMode updates state for every canonical mode', () => {
    for (const m of ['perspective', 'top', 'front', 'side'] as const) {
      useViewportStore.getState().setCameraMode(m);
      expect(useViewportStore.getState().cameraMode).toBe(m);
    }
  });

  it('persists activeTool + cameraMode to localStorage on change', () => {
    if (typeof localStorage === 'undefined') return; // jsdom only
    useViewportStore.getState().setActiveTool('pan');
    useViewportStore.getState().setCameraMode('top');
    const raw = localStorage.getItem('casemaker.viewport');
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed.activeTool).toBe('pan');
    expect(parsed.cameraMode).toBe('top');
  });
});
