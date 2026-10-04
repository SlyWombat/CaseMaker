// @vitest-environment jsdom
// The Engrave panel (#205): add a label, a depth past the floor, the tool hint, the vise badge
// and buttons, and a refused override gating Generate. A fake preview client stands in for the
// worker (`setEngravePreviewClientLoader`); the pure `validateJob` and `feedsFor` are what the
// assertions below actually exercise.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EngravePanel } from '@/components/panels/EngravePanel';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { useSettingsStore } from '@/store/settingsStore';
import {
  setEngravePreviewClientLoader,
  useEngravePreviewStore,
  type EngravePreviewClient,
} from '@/store/engravePreviewStore';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { presetJawStrips } from '@/engine/cnc/sacrificial';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A client that answers every request with "no new preview", which the panel must survive. */
const NO_PREVIEW: EngravePreviewClient = { engravePreview: async () => null };

const rows = (): HTMLElement[] => screen.queryAllByTestId(/^engrave-label-row-/);

beforeEach(() => {
  setEngravePreviewClientLoader(async () => NO_PREVIEW);
  useSettingsStore.getState().resetSettings();
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

// #214 work item 5: the "Add label" button became an "Add" menu with the five kinds. The label
// entry keeps the historic id so the pre-#214 flow is still one click.
describe('EngravePanel — the Add menu (#214)', () => {
  it('offers all five kinds, and a rectangle adds a rect row with its own editor', () => {
    render(<EngravePanel />);
    for (const kind of ['label', 'rect', 'circle', 'slot', 'polygon']) {
      expect(screen.getByTestId(`engrave-add-${kind}`)).toBeTruthy();
    }

    fireEvent.click(screen.getByTestId('engrave-add-rect'));
    const job = useEngraveJobStore.getState().job;
    expect(job.shapes).toHaveLength(1);
    expect(job.shapes[0]!.kind).toBe('rect');
    expect(screen.getByTestId('engrave-shape-row-0')).toBeTruthy();
    expect(screen.getByTestId('engrave-shape-width-0')).toBeTruthy();
    expect(screen.getByTestId('engrave-shape-height-0')).toBeTruthy();
  });

  it('gives each shape kind its own editor fields', () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-add-circle'));
    expect(screen.getByTestId('engrave-shape-diameter-0')).toBeTruthy();

    fireEvent.click(screen.getByTestId('engrave-add-slot'));
    expect(screen.getByTestId('engrave-shape-length-1')).toBeTruthy();
    expect(screen.getByTestId('engrave-shape-width-1')).toBeTruthy();

    fireEvent.click(screen.getByTestId('engrave-add-polygon'));
    expect(screen.getByTestId('engrave-shape-points-2')).toBeTruthy();

    expect(useEngraveJobStore.getState().job.shapes.map((s) => s.kind)).toEqual([
      'circle',
      'slot',
      'polygon',
    ]);
  });

  it('reports a self-intersecting polygon under its row and gates Generate', () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-add-polygon'));
    fireEvent.change(screen.getByTestId('engrave-shape-points-0'), {
      target: { value: '-5, -5\n5, 5\n5, -5\n-5, 5' },
    });
    expect(screen.getByTestId('engrave-shape-finding-0-polygon-self-intersecting')).toBeTruthy();
    expect((screen.getByTestId('engrave-generate') as HTMLButtonElement).disabled).toBe(true);
  });
});

// #213 §5: the Sacrificial material section — presets, the source badge and "Save as my setup".
describe('EngravePanel — sacrificial material (#213)', () => {
  it('starts with no sacrificial material and a "none" badge', () => {
    render(<EngravePanel />);
    expect(screen.getByTestId('engrave-sac-badge').textContent).toMatch(/none/);
    expect(screen.queryByTestId('engrave-sac-under-thickness')).toBeNull();
  });

  it('applies "Part on a larger board" as a saved setup', () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-sac-preset-board'));
    expect(screen.getByTestId('engrave-sac-badge').textContent).toMatch(/^saved/);
    expect((screen.getByTestId('engrave-sac-under') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('engrave-sac-under-thickness') as HTMLInputElement).value).toBe('12');
    expect((screen.getByTestId('engrave-sac-under-overhang-left') as HTMLInputElement).value).toBe('10');

    const job = useEngraveJobStore.getState().job;
    expect(job.sacrificial.under?.overhang.left).toBe(10);
    expect(job.sacrificial.source).toBe('saved');
  });

  it('applies "Strips between the jaws" as left and right flush strips', () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-sac-preset-strips'));
    expect((screen.getByTestId('engrave-sac-side-left') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('engrave-sac-side-right') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('engrave-sac-side-front') as HTMLInputElement).checked).toBe(false);

    const job = useEngraveJobStore.getState().job;
    expect(job.sacrificial.sides.left).toEqual({ thickness: 6, height: 'flush' });
    expect(job.sacrificial.sides.right).toEqual({ thickness: 6, height: 'flush' });
    expect(job.sacrificial.under).toBeNull();
  });

  it('turning the board on creates a saved setup whose numbers can be edited', () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-sac-under'));
    expect(screen.getByTestId('engrave-sac-badge').textContent).toMatch(/^saved/);
    fireEvent.change(screen.getByTestId('engrave-sac-under-thickness'), { target: { value: '8' } });
    expect(useEngraveJobStore.getState().job.sacrificial.under?.thickness).toBe(8);
  });

  it('"Save as my setup" stores the setup in settings fixtures', () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-sac-preset-strips'));
    fireEvent.click(screen.getByTestId('engrave-sac-save'));
    expect(useSettingsStore.getState().fixtures.sacrificial).toEqual(
      useEngraveJobStore.getState().job.sacrificial,
    );
  });

  it('shows a front strip without a board as an error finding', () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-sac-side-front'));
    expect(screen.getByTestId('engrave-finding-side-strip-unsupported')).toBeTruthy();
    expect((screen.getByTestId('engrave-generate') as HTMLButtonElement).disabled).toBe(true);
  });

  it('a new job starts from the setup saved in settings fixtures', () => {
    render(<EngravePanel />);
    act(() => {
      useSettingsStore.getState().setSacrificial(presetJawStrips());
      useEngraveJobStore.getState().reset();
    });
    expect(useEngraveJobStore.getState().job.sacrificial).toEqual(presetJawStrips());
    // …and it is shown, so the seam is wired to the UI, not just the store.
    expect((screen.getByTestId('engrave-sac-side-left') as HTMLInputElement).checked).toBe(true);
  });
});
