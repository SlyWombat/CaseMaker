// Issue #558 — the right rail's width clamp. The panel grows/shrinks by deltas from a drag, so the
// clamp is the only thing between a wide panel and a grid that overflows the shell at the narrowest
// shared width (1024px, the rail/drawer edge). Pins the floor, the ceiling, and the window-derived
// cap that leaves the viewport a floor.

import { describe, it, expect } from 'vitest';

import {
  clampPanelWidth,
  PANEL_DEFAULT_W,
  PANEL_MIN_W,
  PANEL_MAX_W,
} from '@/components/layout/useContextPanelWidth';

describe('#558 — context panel width clamp', () => {
  it('passes the default through unchanged', () => {
    expect(clampPanelWidth(PANEL_DEFAULT_W)).toBe(PANEL_DEFAULT_W);
  });

  it('floors at the minimum', () => {
    expect(clampPanelWidth(0)).toBe(PANEL_MIN_W);
    expect(clampPanelWidth(100)).toBe(PANEL_MIN_W);
  });

  it('caps at the absolute maximum on a wide window', () => {
    expect(clampPanelWidth(9999, 1920)).toBe(PANEL_MAX_W);
  });

  it('caps to leave the viewport a floor at the rail/drawer edge', () => {
    // 1024 - 320 (left rail) - 200 (viewport floor) = 504 max panel at the narrowest shared width.
    expect(clampPanelWidth(640, 1024)).toBe(504);
  });

  it('falls back to the minimum when the window cannot share at all', () => {
    // 800 - 320 - 200 = 280, and the floor wins over a starved canvas.
    expect(clampPanelWidth(640, 800)).toBe(PANEL_MIN_W);
  });

  it('lets an in-range value through untouched', () => {
    expect(clampPanelWidth(400, 1440)).toBe(400);
  });
});
