import { describe, it, expect, beforeEach } from 'vitest';
import { useViewportStore } from '@/store/viewportStore';

describe('port selection routing (#94 Phase 4b)', () => {
  beforeEach(() => {
    useViewportStore.setState({ selection: null });
  });

  it("setSelection({ kind: 'port', portId }) updates state", () => {
    useViewportStore.getState().setSelection({ kind: 'port', portId: 'usb-c-1' });
    const s = useViewportStore.getState().selection;
    expect(s).toEqual({ kind: 'port', portId: 'usb-c-1' });
  });

  it("setSelection(null) clears port selection", () => {
    useViewportStore.getState().setSelection({ kind: 'port', portId: 'usb-c-1' });
    useViewportStore.getState().setSelection(null);
    expect(useViewportStore.getState().selection).toBeNull();
  });

  it("port selection coexists with the existing host/hat kinds (no breakage of #83)", () => {
    useViewportStore.getState().setSelection({ kind: 'host' });
    expect(useViewportStore.getState().selection).toEqual({ kind: 'host' });
    useViewportStore
      .getState()
      .setSelection({ kind: 'hat', hatPlacementId: 'h1' });
    expect(useViewportStore.getState().selection).toEqual({
      kind: 'hat',
      hatPlacementId: 'h1',
    });
    useViewportStore.getState().setSelection({ kind: 'port', portId: 'p1' });
    expect(useViewportStore.getState().selection).toEqual({
      kind: 'port',
      portId: 'p1',
    });
  });

  it("port selection is session-scoped — does NOT persist to localStorage", () => {
    if (typeof localStorage === 'undefined') return;
    useViewportStore.getState().setSelection({ kind: 'port', portId: 'p1' });
    // Selection writes shouldn't trigger savePersisted (matches #83 invariant).
    const raw = localStorage.getItem('casemaker.viewport');
    if (raw) {
      const parsed = JSON.parse(raw);
      expect(parsed.selection).toBeUndefined();
    }
  });
});
