// @vitest-environment jsdom
// The Engrave panel (#205): add a label, a depth past the floor, the tool hint, the vise badge
// and buttons, and a refused override gating Generate. A fake preview client stands in for the
// worker (`setEngravePreviewClientLoader`); the pure `validateJob` and `feedsFor` are what the
// assertions below actually exercise.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EngravePanel } from '@/components/panels/EngravePanel';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import {
  setEngravePreviewClientLoader,
  useEngravePreviewStore,
  type EngravePreviewClient,
} from '@/store/engravePreviewStore';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A client that answers every request with "no new preview", which the panel must survive. */
const NO_PREVIEW: EngravePreviewClient = { engravePreview: async () => null };

const rows = (): HTMLElement[] => screen.queryAllByTestId(/^engrave-label-row-/);

beforeEach(() => {
  setEngravePreviewClientLoader(async () => NO_PREVIEW);
  act(() => {
    useEngraveJobStore.setState({ job: defaultEngraveJob() });
  });
  useEngravePreviewStore.getState().dispose(); // cancel any debounce the reset scheduled
});

afterEach(() => {
  cleanup();
  useEngravePreviewStore.getState().dispose();
  setEngravePreviewClientLoader(null);
});

describe('EngravePanel (#205)', () => {
  it('adds a label row when “Add label” is clicked', () => {
    render(<EngravePanel />);
    expect(rows()).toHaveLength(3);
    fireEvent.click(screen.getByTestId('engrave-add-label'));
    expect(rows()).toHaveLength(4);
  });

  it('marks a depth past the floor and shows the finding under that row', () => {
    render(<EngravePanel />);
    // 12 mm stock, 1 mm minimum floor -> at most 11 mm.
    expect(screen.getByTestId('engrave-label-maxdepth-0').textContent).toContain('11');
    expect(screen.queryByTestId('engrave-label-finding-0-depth-exceeds-stock')).toBeNull();

    fireEvent.change(screen.getByTestId('engrave-label-depth-0'), { target: { value: '11.5' } });
    expect(screen.getByTestId('engrave-label-finding-0-depth-exceeds-stock')).toBeTruthy();
    // …and Generate is gated on it.
    expect((screen.getByTestId('engrave-generate') as HTMLButtonElement).disabled).toBe(true);
  });

  it('updates the “strokes thinner than” hint when the tool changes', () => {
    render(<EngravePanel />);
    expect(screen.getByTestId('engrave-thin-strokes').textContent).toContain('1.0 mm');
    fireEvent.change(screen.getByTestId('engrave-tool'), { target: { value: 'flat-3.175x12-metal' } });
    expect(screen.getByTestId('engrave-thin-strokes').textContent).toContain('3.175 mm');
  });

  it('changes the vise badge from unmeasured defaults once the vise is saved', () => {
    render(<EngravePanel />);
    expect(screen.getByTestId('engrave-vise-badge').textContent).toMatch(/unmeasured/);
    fireEvent.click(screen.getByTestId('engrave-vise-save'));
    expect(screen.getByTestId('engrave-vise-badge').textContent).toMatch(/^saved/);
    expect(screen.getByTestId('engrave-vise-badge').textContent).not.toMatch(/unmeasured/);
  });

  it('shows a refused cutting override and disables Generate', () => {
    render(<EngravePanel />);
    expect((screen.getByTestId('engrave-generate') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId('engrave-feeds-refused')).toBeNull();

    // The 1.0 mm cutter has a 0.5 mm radius; a 2 mm step-over leaves an uncut spine (#191).
    fireEvent.change(screen.getByTestId('engrave-override-stepOver'), { target: { value: '2' } });
    expect(screen.getByTestId('engrave-feeds-refused').textContent).toContain('step-over');
    expect((screen.getByTestId('engrave-generate') as HTMLButtonElement).disabled).toBe(true);

    // Emptying the field clears the override, so the refusal (and the only way to undo it) must
    // have stayed on screen while it was refused.
    fireEvent.change(screen.getByTestId('engrave-override-stepOver'), { target: { value: '' } });
    expect(screen.queryByTestId('engrave-feeds-refused')).toBeNull();
    expect((screen.getByTestId('engrave-generate') as HTMLButtonElement).disabled).toBe(false);
  });
});
