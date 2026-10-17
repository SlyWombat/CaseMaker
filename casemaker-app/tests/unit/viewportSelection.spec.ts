import { describe, it, expect, beforeEach } from 'vitest';
import { useViewportStore } from '@/store/viewportStore';

/**
 * Issue #83 — host PCB / HAT in-viewport selection. Lives in viewportStore
 * so the SelectionPanel + keyboard nudge handler can subscribe without
 * threading prop drilling through the scene graph. Selection is
 * SESSION-SCOPED — never written to localStorage so a stale ID can't point
 * at a HAT placement that was deleted between sessions.
 */
describe('Issue #83 — viewport selection', () => {
  beforeEach(() => {
    useViewportStore.getState().setSelection(null);
    useViewportStore.setState({ activeSidebarSection: null });
  });

  it('default selection is null', () => {
    expect(useViewportStore.getState().selection).toBeNull();
  });

  it('setSelection({ kind: "host" }) updates state', () => {
    useViewportStore.getState().setSelection({ kind: 'host' });
    expect(useViewportStore.getState().selection).toEqual({ kind: 'host' });
  });

  it('setSelection({ kind: "hat", hatPlacementId }) carries the placement id', () => {
    useViewportStore
      .getState()
      .setSelection({ kind: 'hat', hatPlacementId: 'hat-123' });
    const sel = useViewportStore.getState().selection;
    expect(sel).not.toBeNull();
    if (!sel) return;
    expect(sel.kind).toBe('hat');
    if (sel.kind === 'hat') {
      expect(sel.hatPlacementId).toBe('hat-123');
    }
  });

  it('setSelection(null) clears the selection', () => {
    useViewportStore.getState().setSelection({ kind: 'host' });
    useViewportStore.getState().setSelection(null);
    expect(useViewportStore.getState().selection).toBeNull();
  });

  it('selection is NOT persisted to localStorage', () => {
    if (typeof localStorage === 'undefined') return; // skip in node env
    useViewportStore.getState().setSelection({ kind: 'host' });
    const raw = localStorage.getItem('casemaker.viewport');
    if (raw === null) {
      // Persistence hasn't fired (no other settable flag changed) — that
      // alone is proof selection didn't trigger a write. OK.
      return;
    }
    const parsed = JSON.parse(raw);
    expect(parsed.selection).toBeUndefined();
  });

  it('selection survives only in memory — re-reading the store after a setShowLid persist does not bring it back as a string keyed "selection"', () => {
    if (typeof localStorage === 'undefined') return;
    useViewportStore.getState().setSelection({
      kind: 'hat',
      hatPlacementId: 'h-keep-me-out-of-disk',
    });
    // Trigger a persisted write by toggling another field.
    useViewportStore.getState().setShowLid(false);
    const raw = localStorage.getItem('casemaker.viewport');
    expect(raw).not.toBeNull();
    expect(raw).not.toContain('h-keep-me-out-of-disk');
    // restore for other tests
    useViewportStore.getState().setShowLid(true);
  });
});

/**
 * Issue #441 — engrave items are selected from the engrave panel's own preview. That is the one
 * selection kind that MUST coexist with a sidebar section: clearing the section on selection
 * would unmount the panel (and its preview) whose row the click just opened.
 */
describe('Issue #441 — engrave-item selection and the right rail', () => {
  beforeEach(() => {
    useViewportStore.setState({ selection: null, activeSidebarSection: null });
  });

  it('carries the job item id', () => {
    useViewportStore.getState().setSelection({ kind: 'engrave-item', itemId: 'label-9' });
    expect(useViewportStore.getState().selection).toEqual({
      kind: 'engrave-item',
      itemId: 'label-9',
    });
  });

  it('keeps the engrave section open when the item is selected', () => {
    useViewportStore.getState().setActiveSidebarSection('cnc-engrave');
    useViewportStore.getState().setSelection({ kind: 'engrave-item', itemId: 'label-9' });
    expect(useViewportStore.getState().activeSidebarSection).toBe('cnc-engrave');
  });

  it('still clears the section for every other selection kind', () => {
    useViewportStore.getState().setActiveSidebarSection('cnc-engrave');
    useViewportStore.getState().setSelection({ kind: 'host' });
    expect(useViewportStore.getState().activeSidebarSection).toBeNull();
  });

  it('drops the engrave selection when its section is closed', () => {
    useViewportStore.getState().setActiveSidebarSection('cnc-engrave');
    useViewportStore.getState().setSelection({ kind: 'engrave-item', itemId: 'shape-2' });
    useViewportStore.getState().setActiveSidebarSection(null);
    expect(useViewportStore.getState().selection).toBeNull();
  });

  it('drops the engrave selection when another section opens', () => {
    useViewportStore.getState().setActiveSidebarSection('cnc-engrave');
    useViewportStore.getState().setSelection({ kind: 'engrave-item', itemId: 'shape-2' });
    useViewportStore.getState().setActiveSidebarSection('board');
    expect(useViewportStore.getState().selection).toBeNull();
  });

  it('clearing the selection (empty canvas) leaves the section open', () => {
    useViewportStore.getState().setActiveSidebarSection('cnc-engrave');
    useViewportStore.getState().setSelection({ kind: 'engrave-item', itemId: 'shape-2' });
    useViewportStore.getState().setSelection(null);
    expect(useViewportStore.getState().activeSidebarSection).toBe('cnc-engrave');
  });
});
