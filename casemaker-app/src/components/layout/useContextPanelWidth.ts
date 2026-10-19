import { useCallback, useState } from 'react';

// Issue #558 — the right rail's width is now the operator's, not the fixed 360px column it has
// been since #93. The chosen width is persisted to localStorage and fed to `.app-main` as the CSS
// custom property `--context-panel-width`, so the grid column and the drag handle share ONE source
// of truth. The left rail is a fixed 320px column at desktop widths (it only becomes a drawer below
// 640px, #134), so the cap is expressed as "leave the viewport at least this much" rather than as a
// bare pixel ceiling that could push the grid past the shell on a narrow desktop.

const LS_KEY = 'casemaker.contextPanelWidth';

export const PANEL_DEFAULT_W = 360;
export const PANEL_MIN_W = 280;
export const PANEL_MAX_W = 640;
const SIDEBAR_W = 320;
const VIEWPORT_FLOOR_W = 200;

function windowWidth(): number {
  return typeof window === 'undefined' ? 1440 : window.innerWidth;
}

export function clampPanelWidth(width: number, winW = windowWidth()): number {
  // The panel may never be wider than the window minus the fixed left rail minus a floor for the
  // canvas, or the grid would overflow the shell at the narrowest shared width (1024 is the
  // rail/drawer edge, where this leaves the viewport exactly VIEWPORT_FLOOR_W).
  const maxForWindow = Math.max(PANEL_MIN_W, winW - SIDEBAR_W - VIEWPORT_FLOOR_W);
  return Math.min(PANEL_MAX_W, Math.max(PANEL_MIN_W, Math.min(width, maxForWindow)));
}

function readPersisted(): number {
  if (typeof localStorage === 'undefined') return PANEL_DEFAULT_W;
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw === null) return PANEL_DEFAULT_W;
    const n = Number(raw);
    return Number.isFinite(n) ? clampPanelWidth(n) : PANEL_DEFAULT_W;
  } catch {
    return PANEL_DEFAULT_W;
  }
}

export function useContextPanelWidth(): {
  width: number;
  resizeBy: (dx: number) => void;
} {
  const [width, setWidth] = useState<number>(readPersisted);

  const resizeBy = useCallback((dx: number) => {
    setWidth((prev) => {
      const next = clampPanelWidth(prev - dx);
      try {
        localStorage.setItem(LS_KEY, String(next));
      } catch {
        // Private mode or a full quota: the split still works for this session.
      }
      return next;
    });
  }, []);

  return { width, resizeBy };
}
