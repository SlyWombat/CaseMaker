import { useCallback, useState } from 'react';

/**
 * #1123-47 — THE LEFT RAIL COLLAPSES TO ITS ICONS, and remembers that per browser.
 *
 * Bench, 2026-11-10: "the left menu does not need to be shown most of the time and it can collapse
 * to just the icons". The state is display state only (the analyst's fields): it lives beside the
 * right panel's width in localStorage, never in the job, the fingerprint or a package. Default is
 * EXPANDED for a first visit; the phone drawer below 640 px is unchanged and has no control.
 */
export const SIDEBAR_LS_KEY = 'casemaker.sidebarCollapsed';

/** The collapsed rail's width, px — the icon column alone. */
export const SIDEBAR_COLLAPSED_W = 48;

function readPersisted(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    return localStorage.getItem(SIDEBAR_LS_KEY) === 'true';
  } catch {
    return false;
  }
}

export function useSidebarCollapsed(): {
  collapsed: boolean;
  toggle: () => void;
  expand: () => void;
} {
  const [collapsed, setCollapsed] = useState<boolean>(readPersisted);

  const write = useCallback((next: boolean) => {
    setCollapsed(next);
    try {
      localStorage.setItem(SIDEBAR_LS_KEY, String(next));
    } catch {
      // Private mode or a full quota: the rail still collapses for this session.
    }
  }, []);

  return {
    collapsed,
    toggle: useCallback(() => write(!collapsed), [collapsed, write]),
    expand: useCallback(() => write(false), [write]),
  };
}
