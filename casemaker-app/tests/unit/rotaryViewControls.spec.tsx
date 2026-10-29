// @vitest-environment jsdom
// #716 — Map | Stock is app chrome: the read-out and the switch, and nothing for a flat job.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import type { EngraveJob } from '@/types/engraveJob';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { useRotaryViewStore } from '@/store/rotaryViewStore';
import { RotaryViewControls } from '@/components/viewport/RotaryViewControls';

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

describe('#716 Map | Stock', () => {
  beforeEach(() => {
    useRotaryViewStore.getState().reset();
    useEngraveJobStore.setState({ job: dowelJob() });
  });
  afterEach(() => {
    useRotaryViewStore.getState().reset();
    useEngraveJobStore.setState({ job: defaultEngraveJob() });
  });

  it('reads the stock and switches between the map and the wrapped stock', () => {
    render(<RotaryViewControls />);
    expect(screen.getByTestId('rotary-view-readout').textContent).toBe('⌀20 · around 62.832 mm');
    expect(screen.getByTestId('rotary-view-map').getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByTestId('rotary-view-stock'));
    expect(useRotaryViewStore.getState().design).toBe('stock');
    expect(screen.getByTestId('rotary-view-stock').getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByTestId('rotary-view-map'));
    expect(useRotaryViewStore.getState().design).toBe('map');
    expect(screen.getByTestId('rotary-view-map').getAttribute('aria-pressed')).toBe('true');
  });

  it('renders nothing for a flat job', () => {
    useEngraveJobStore.setState({ job: defaultEngraveJob() });
    render(<RotaryViewControls />);
    expect(screen.queryByTestId('rotary-view-controls')).toBeNull();
  });
});
