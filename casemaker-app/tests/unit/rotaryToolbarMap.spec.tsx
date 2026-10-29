// @vitest-environment jsdom
// #716 review — in the Map the camera is the map's own top-down frame, so the toolbar says Top and
// the generic presets are disabled with a reason; Stock hands them back.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import type { EngraveJob } from '@/types/engraveJob';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { useRotaryViewStore } from '@/store/rotaryViewStore';
import { useViewportStore } from '@/store/viewportStore';
import { ViewportToolbar } from '@/components/viewport/ViewportToolbar';

const CAMERAS = ['perspective', 'top', 'front', 'side'] as const;

function dowelJob(): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    stock: { length: 100, width: 20, thickness: 20, material: 'pla', shape: 'cylinder', diameter: 20 },
    workholding: {
      kind: 'rotary-chuck',
      rotary: { jawDiameter: null, stickout: 85, gripDiameter: null, jawMode: 'reverse-inner', tailstock: true, source: 'test' },
    },
    labels: [],
    shapes: [],
  } as EngraveJob;
}

function cameraButton(id: string): HTMLButtonElement {
  return screen.getByTestId(`viewport-camera-${id}`) as HTMLButtonElement;
}

describe('#716 the map’s camera mode in the toolbar', () => {
  beforeEach(() => {
    cleanup();
    useViewportStore.setState({ activeSidebarSection: 'cnc-engrave', cameraMode: 'perspective' });
    useRotaryViewStore.getState().reset();
    useEngraveJobStore.setState({ job: dowelJob() });
  });
  afterEach(() => {
    useViewportStore.setState({ activeSidebarSection: null, cameraMode: 'perspective' });
    useEngraveJobStore.setState({ job: defaultEngraveJob() });
    useRotaryViewStore.getState().reset();
  });

  it('reads Top as the view and disables the presets with a reason', () => {
    render(<ViewportToolbar />);
    expect(cameraButton('top').getAttribute('aria-checked')).toBe('true');
    for (const id of CAMERAS) {
      expect(cameraButton(id).disabled, id).toBe(true);
      expect(cameraButton(id).title).toContain('fixed top-down frame');
    }
  });

  it('ignores the 1–4 camera keys while the map holds the frame', () => {
    render(<ViewportToolbar />);
    fireEvent.keyDown(window, { key: '3' });
    expect(useViewportStore.getState().cameraMode).toBe('perspective');
  });

  it('hands the presets back in the Stock view', () => {
    useRotaryViewStore.getState().setDesign('stock');
    render(<ViewportToolbar />);
    for (const id of CAMERAS) expect(cameraButton(id).disabled, id).toBe(false);
    expect(cameraButton('perspective').getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(window, { key: '2' });
    expect(useViewportStore.getState().cameraMode).toBe('top');
  });

  it('keeps a flat job’s toolbar exactly as it was', () => {
    useEngraveJobStore.setState({ job: defaultEngraveJob() });
    render(<ViewportToolbar />);
    for (const id of CAMERAS) expect(cameraButton(id).disabled, id).toBe(false);
    expect(cameraButton('perspective').getAttribute('aria-checked')).toBe('true');
  });
});
