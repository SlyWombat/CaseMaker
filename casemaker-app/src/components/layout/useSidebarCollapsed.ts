import { useCallback, useSyncExternalStore } from 'react';

/**
 * #1123-47 — THE LEFT RAIL COLLAPSES TO ITS ICONS, and remembers that per browser.
 *
 * Bench, 2026-11-10: "the left menu does not need to be shown most of the time and it can collapse
 * to just the icons". The state is display state only (the analyst's fields): it lives beside the
 * right panel's width in localStorage, never in the job, the fingerprint or a package. Default is
 * EXPANDED for a first visit; the phone drawer below 640 px is unchanged and has no control.
 *
 * #1123-47 e2e review — ONE STORE, NOT ONE COPY PER CALL SITE. The choice has two readers: the rail
 * that paints the icons, and `AppShell`, which sets `--sidebar-width` for the grid column. A
 * hook-local `useState` gave each call site its own copy, so the rail painted as icons while the
 * column stayed 320 px and the canvas never widened. Reading localStorage through
 * `useSyncExternalStore` gives both readers the one persisted value and makes a write reach both.
 */
export const SIDEBAR_LS_KEY = 'casemaker.sidebarCollapsed';

/** The collapsed rail's width, px — the icon column alone. */
export const SIDEBAR_COLLAPSED_W = 48;

/** Where the choice lives when storage refuses (private mode, a full quota): one module value, so
 *  the two readers still agree within the session. */
let memoryFallback: boolean | null = null;

function readPersisted(): boolean {
  try {
    const stored = localStorage.getItem(SIDEBAR_LS_KEY);
    if (stored !== null) return stored === 'true';
  } catch {
    // fall through to the session's own value
  }
  return memoryFallback ?? false;
}

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function write(next: boolean): void {
  memoryFallback = next;
  try {
    localStorage.setItem(SIDEBAR_LS_KEY, String(next));
  } catch {
    // Private mode or a full quota: the rail still collapses for this session.
  }
  for (const listener of listeners) listener();
}

export function useSidebarCollapsed(): {
  collapsed: boolean;
  toggle: () => void;
  expand: () => void;
} {
  const collapsed = useSyncExternalStore(subscribe, readPersisted, readPersisted);

  return {
    collapsed,
    toggle: useCallback(() => write(!readPersisted()), []),
    expand: useCallback(() => write(false), []),
  };
}
