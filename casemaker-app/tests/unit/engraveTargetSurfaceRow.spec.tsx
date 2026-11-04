// @vitest-environment jsdom
// #535/#963 — a goal mesh's operation controls on its row: the cutter, the stock to leave (the
// one surfacing number the operator still owns) with its default and source, the reset that
// returns it to the default, and the facts the last generated program reported. #963 — the
// engine's resolutions (step-down, step-overs, grid pitch, scallop/pencil passes) are NOT
// controls; the spec pins their absence.
//
// Rendered DIRECTLY, not through `EngravePanel`: the row is a controlled component, and what is
// worth pinning here is the patch each control sends (and the words it shows beside its defaults).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  EngraveTargetObjectRow,
  type ReliefRowFacts,
  type SurfaceDefaults,
} from '@/components/panels/EngraveTargetObjectRow';
import { resetEngraveRows } from '@/store/engraveRowStore';
import type { TargetObjectPatch } from '@/store/engraveJobStore';
import type { EngraveTargetObject } from '@/types/engraveJob';

beforeEach(() => {
  resetEngraveRows();
});

afterEach(() => {
  cleanup();
});

const GOAL: EngraveTargetObject = {
  id: 'tgt-1',
  name: 'bracket.stl',
  format: 'stl',
  sha256: 'a'.repeat(64),
  data: 'AAAA',
  size: { x: 40, y: 30, z: 6 },
  position: { x: 50, y: 30, z: 0 },
  rotation: 0,
  enabled: true,
  role: 'goal',
};

const DEFAULTS: SurfaceDefaults = {
  cutter: { key: 'ball-3.175', name: '3.175 mm ball', shape: 'ball' },
  cutters: [
    { key: 'ball-3.175', label: '3.175 mm ball' },
    { key: 'flat-3.175', label: '3.175 mm flat' },
  ],
  feeds: { stepDown: 0.5, stepOver: 0.8, typed: false },
  gridPitch: { value: 0.1, source: 'chosen' },
  stockToLeave: { value: 0.3, source: 'seeded' },
};


interface RowOptions {
  target?: Partial<EngraveTargetObject>;
  surface?: SurfaceDefaults | undefined;
  relief?: ReliefRowFacts | null;
}

/** Render the row; returns the callbacks so a test can read what a control sent. */
function row({ target = {}, surface = DEFAULTS, relief = null }: RowOptions = {}): {
  onChange: ReturnType<typeof vi.fn>;
  onRemove: ReturnType<typeof vi.fn>;
  onCutterChange: ReturnType<typeof vi.fn>;
} {
  const onChange = vi.fn<(patch: TargetObjectPatch) => void>();
  const onRemove = vi.fn();
  const onCutterChange = vi.fn<(key: string) => void>();
  render(
    <EngraveTargetObjectRow
      target={{ ...GOAL, ...target }}
      index={0}
      findings={[]}
      onChange={onChange}
      onRemove={onRemove}
      surface={surface}
      relief={relief}
      onCutterChange={onCutterChange}
    />,
  );
  return { onChange, onRemove, onCutterChange };
}

/** Open the row, then its Technical fold — the way a person reaches the controls. */
function openTechnical(): void {
  fireEvent.click(screen.getByTestId('engrave-target-expand-0'));
  fireEvent.click(screen.getByTestId('engrave-target-technical-0'));
}

describe('#535 the goal’s operation controls', () => {
  // #963 — THE RESOLUTIONS ARE THE ENGINE'S. A control for any of them would be a budget by
  // another name; the row states what the last program used instead (the report test below).
  it('offers no controls for the step-down, step-overs, grid pitch or finishing passes', () => {
    row({ target: { surface: { scallop: true, pencil: true, gridPitchMm: 0.2 } } });
    openTechnical();
    for (const testid of [
      'engrave-target-surface-roughStepDownMm-0',
      'engrave-target-surface-roughStepOverMm-0',
      'engrave-target-surface-finishStepOverMm-0',
      'engrave-target-surface-gridPitchMm-0',
      'engrave-target-surface-scallop-0',
      'engrave-target-surface-pencil-0',
      'engrave-target-surface-pencilCreaseDeg-0',
    ]) {
      expect(screen.queryByTestId(testid)).toBeNull();
    }
    // #966 — and so is the stock to leave: the engine owns it.
    expect(screen.queryByTestId('engrave-target-surface-stockToLeaveMm-0')).toBeNull();
  });

  it('names the cutter and states what its shape does to the finish', () => {
    row();
    openTechnical();
    const select = screen.getByTestId('engrave-target-surface-cutter-0') as HTMLSelectElement;
    expect(select.value).toBe('ball-3.175');
    const note = screen.getByTestId('engrave-target-surface-cutter-note-0').textContent ?? '';
    expect(note).toContain('One cutter cuts both passes');
    expect(note).toContain('ball');
  });

  // #963 — the edge break is `edgeBreak` now; the old name is mirrored while the pre-#966 engine
  // still reads it, and a value already stored under either name fills the box.
  it('a typed edge break writes edgeBreak and mirrors the old chamfer name', () => {
    const { onChange } = row();
    openTechnical();
    fireEvent.change(screen.getByTestId('engrave-target-chamfer-0'), { target: { value: '0.8' } });
    expect(onChange).toHaveBeenLastCalledWith({
      edgeBreak: { widthMm: 0.8 },
      chamfer: { widthMm: 0.8 },
    });
    cleanup();
    resetEngraveRows();
    row({ target: { chamfer: { widthMm: 0.6 } } });
    openTechnical();
    expect((screen.getByTestId('engrave-target-chamfer-0') as HTMLInputElement).value).toBe('0.6');
  });

  it('clearing the edge break removes both names', () => {
    const { onChange } = row({ target: { edgeBreak: { widthMm: 0.8 }, chamfer: { widthMm: 0.8 } } });
    openTechnical();
    fireEvent.change(screen.getByTestId('engrave-target-chamfer-0'), { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith({ edgeBreak: undefined, chamfer: undefined });
  });

  it('picking another cutter tells the panel, which owns the job’s cutter', () => {
    const { onCutterChange } = row();
    openTechnical();
    fireEvent.change(screen.getByTestId('engrave-target-surface-cutter-0'), {
      target: { value: 'flat-3.175' },
    });
    expect(onCutterChange).toHaveBeenLastCalledWith('flat-3.175');
  });

  it('a reference row has no Technical fold at all', () => {
    row({ target: { role: 'reference', surface: undefined }, surface: undefined });
    fireEvent.click(screen.getByTestId('engrave-target-expand-0'));
    expect(screen.queryByTestId('engrave-target-technical-0')).toBeNull();
  });
});

// #672 — a picture goal's relief map: the depth and its source, the direction, the placed width
// and the resolution the picture can actually hold.
describe('#672 the relief map', () => {
  const RELIEF: ReliefRowFacts = {
    pixels: { width: 512, height: 384 },
    depth: { value: 1.5, source: 'the CAM’s default' },
    typed: false,
    invert: false,
    gridPitch: { value: 0.1, source: 'seeded' },
    cutterDiameter: 1,
  };
  const PNG: Partial<EngraveTargetObject> = { format: 'png', size: { x: 40, y: 30, z: 1.5 } };

  it('prefills the depth from its default and says where that is', () => {
    row({ target: PNG, relief: RELIEF });
    openTechnical();
    const depth = screen.getByTestId('engrave-target-relief-depth-0') as HTMLInputElement;
    expect(depth.value).toBe('1.5');
    expect(screen.getByTestId('engrave-target-relief-depth-source-0').textContent).toContain(
      'the CAM’s default',
    );
    expect(screen.getByTestId('engrave-target-relief-invert-0')).toBeTruthy();
  });

  it('writes the depth (and the placed size) and the direction', () => {
    const { onChange } = row({ target: PNG, relief: RELIEF });
    openTechnical();
    fireEvent.change(screen.getByTestId('engrave-target-relief-depth-0'), { target: { value: '2.5' } });
    expect(onChange).toHaveBeenLastCalledWith({ relief: { maxDepthMm: 2.5 }, size: { x: 40, y: 30, z: 2.5 } });
    fireEvent.change(screen.getByTestId('engrave-target-relief-invert-0'), { target: { value: 'black' } });
    expect(onChange).toHaveBeenLastCalledWith({ relief: { invert: true } });
    fireEvent.change(screen.getByTestId('engrave-target-relief-invert-0'), { target: { value: 'white' } });
    expect(onChange).toHaveBeenLastCalledWith({ relief: { invert: undefined } });
  });

  it('rescales the width with the picture’s aspect', () => {
    const { onChange } = row({ target: PNG, relief: RELIEF });
    openTechnical();
    fireEvent.change(screen.getByTestId('engrave-target-relief-width-0'), { target: { value: '20' } });
    expect(onChange).toHaveBeenLastCalledWith({ size: { x: 20, y: 15, z: 1.5 } });
  });

  it('states the pixel pitch against the grid and the cutter', () => {
    row({ target: PNG, relief: RELIEF });
    openTechnical();
    const text = screen.getByTestId('engrave-target-relief-resolution-0').textContent ?? '';
    expect(text).toContain('512 × 384 px over 40 × 30 mm');
    expect(text).toContain('0.078 mm per pixel');
    expect(text).toContain('the grid samples at 0.1 mm');
    expect(text).toContain('the cutter is ⌀1 mm');
  });

  it('has no relief block on a mesh goal', () => {
    row({ target: {}, relief: null });
    openTechnical();
    expect(screen.queryByTestId('engrave-target-relief-0')).toBeNull();
  });
});
