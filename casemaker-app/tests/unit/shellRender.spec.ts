// Issue #163 — X-ray / Solid shading toggle.
import { describe, it, expect, beforeEach } from 'vitest';

// The unit suite runs on node, where localStorage does not exist — and the
// store deliberately no-ops when it is absent. Stub it so the persistence
// path is actually exercised rather than silently skipped. Must be installed
// BEFORE the store module is imported, since it reads localStorage at module
// load to hydrate.
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
} as Storage;

const { useViewportStore } = await import('@/store/viewportStore');

describe('shell render mode (#163)', () => {
  beforeEach(() => {
    localStorage.clear();
    useViewportStore.getState().setShellRender('xray');
  });

  it('defaults to xray — the default must reveal interior geometry, not flatter it', () => {
    // #162 shipped a board resting on nothing partly because the viewport
    // could not show the case interior at all. A control nobody turns is no
    // substitute for a default that tells the truth.
    expect(useViewportStore.getState().shellRender).toBe('xray');
  });

  it('switches to solid and back', () => {
    useViewportStore.getState().setShellRender('solid');
    expect(useViewportStore.getState().shellRender).toBe('solid');
    useViewportStore.getState().setShellRender('xray');
    expect(useViewportStore.getState().shellRender).toBe('xray');
  });

  it('persists the choice to localStorage', () => {
    useViewportStore.getState().setShellRender('solid');
    const raw = localStorage.getItem('casemaker.viewport');
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!).shellRender).toBe('solid');
  });

  it('does not leak session-only state into localStorage alongside it', () => {
    // savePersisted uses an explicit allowlist (#83); setShellRender passes
    // `{ ...get(), ... }` like every other setter, so guard the invariant.
    useViewportStore.getState().setSelection({ kind: 'host' });
    useViewportStore.getState().setShellRender('solid');
    const parsed = JSON.parse(localStorage.getItem('casemaker.viewport')!);
    expect(parsed.selection).toBeUndefined();
    expect(parsed.hiddenParts).toBeUndefined();
    expect(parsed.shellRender).toBe('solid');
  });
});
