// @vitest-environment jsdom
// Issue #197 §7 and §8 — the toolbar's zoom group (every mode) and its CNC layer toggles, which
// replace the case-only view modes and the X-ray toggle while a CNC section is open.

import { describe, it, expect, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ViewportToolbar } from '@/components/viewport/ViewportToolbar';
import { VIEWPORT_CAMERA_EVENT, type ViewportCameraCommand } from '@/components/viewport/viewportCamera';
import { useViewportStore } from '@/store/viewportStore';
import { DEFAULT_SIM_LAYERS, useSimStore } from '@/store/simStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LAYER_KEYS = ['removed', 'path', 'rapids', 'tool', 'fixture'] as const;

beforeEach(() => {
  cleanup();
  useViewportStore.setState({ activeSidebarSection: null, selection: null });
  useSimStore.setState({ status: 'idle', pathOnly: false, layers: DEFAULT_SIM_LAYERS });
});

describe('the zoom group (#197 §7)', () => {
  it('is present in the ordinary case view — it is not gated on the feature flag', () => {
    render(<ViewportToolbar />);
    expect(screen.getByTestId('viewport-zoom-in')).toBeDefined();
    expect(screen.getByTestId('viewport-zoom-out')).toBeDefined();
    expect(screen.getByTestId('viewport-fit')).toBeDefined();
  });

  it('is present in a CNC mode too', () => {
    useViewportStore.setState({ activeSidebarSection: 'cnc-sim' });
    render(<ViewportToolbar />);
    expect(screen.getByTestId('viewport-zoom-in')).toBeDefined();
    expect(screen.getByTestId('viewport-fit')).toBeDefined();
  });

  it('a click asks the camera to zoom in / out / fit', () => {
    const seen: ViewportCameraCommand[] = [];
    const on = (e: Event) => seen.push((e as CustomEvent<ViewportCameraCommand>).detail);
    window.addEventListener(VIEWPORT_CAMERA_EVENT, on);
    render(<ViewportToolbar />);
    fireEvent.click(screen.getByTestId('viewport-zoom-in'));
    fireEvent.click(screen.getByTestId('viewport-zoom-out'));
    fireEvent.click(screen.getByTestId('viewport-fit'));
    window.removeEventListener(VIEWPORT_CAMERA_EVENT, on);
    expect(seen).toEqual(['zoom-in', 'zoom-out', 'fit']);
  });

  it('+ / - and F reach the camera from the keyboard', () => {
    const seen: ViewportCameraCommand[] = [];
    const on = (e: Event) => seen.push((e as CustomEvent<ViewportCameraCommand>).detail);
    window.addEventListener(VIEWPORT_CAMERA_EVENT, on);
    render(<ViewportToolbar />);
    fireEvent.keyDown(window, { key: '+' });
    fireEvent.keyDown(window, { key: '=' }); // the unshifted key on most layouts
    fireEvent.keyDown(window, { key: '-' });
    fireEvent.keyDown(window, { key: 'F' });
    window.removeEventListener(VIEWPORT_CAMERA_EVENT, on);
    expect(seen).toEqual(['zoom-in', 'zoom-in', 'zoom-out', 'fit']);
  });

  it('does not steal the keys from a focused text field', () => {
    const seen: ViewportCameraCommand[] = [];
    const on = (e: Event) => seen.push((e as CustomEvent<ViewportCameraCommand>).detail);
    window.addEventListener(VIEWPORT_CAMERA_EVENT, on);
    render(
      <>
        <ViewportToolbar />
        <input data-testid="field" />
      </>,
    );
    screen.getByTestId('field').focus();
    fireEvent.keyDown(window, { key: '+' });
    window.removeEventListener(VIEWPORT_CAMERA_EVENT, on);
    expect(seen).toEqual([]);
  });
});

describe('the layer toggles (#197 §8)', () => {
  it('are absent, and the case-only groups present, outside a CNC mode', () => {
    render(<ViewportToolbar />);
    expect(screen.queryByTestId('viewport-layer-removed')).toBeNull();
    expect(screen.getByTestId('viewport-view-complete')).toBeDefined();
    expect(screen.getByTestId('viewport-render-toggle')).toBeDefined();
  });

  it('replace the view modes and the X-ray toggle in a CNC mode', () => {
    useViewportStore.setState({ activeSidebarSection: 'cnc-sim' });
    render(<ViewportToolbar />);
    for (const key of LAYER_KEYS) expect(screen.getByTestId(`viewport-layer-${key}`)).toBeDefined();
    expect(screen.queryByTestId('viewport-view-complete')).toBeNull();
    expect(screen.queryByTestId('viewport-render-toggle')).toBeNull();
  });

  it('are shown for a loaded simulation even after the section is switched away', () => {
    // The simulation still owns the viewport, so the case-only groups mean nothing.
    useSimStore.setState({ status: 'ready' });
    render(<ViewportToolbar />);
    expect(screen.getByTestId('viewport-layer-removed')).toBeDefined();
    expect(screen.queryByTestId('viewport-view-complete')).toBeNull();
  });

  it('toggle the sim store layer', () => {
    useViewportStore.setState({ activeSidebarSection: 'cnc-sim' });
    render(<ViewportToolbar />);
    const box = screen.getByTestId('viewport-layer-path') as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(useSimStore.getState().layers.path).toBe(false);
    fireEvent.click(box);
    expect(useSimStore.getState().layers.path).toBe(true);
  });
});
