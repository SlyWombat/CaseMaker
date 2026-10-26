// @vitest-environment jsdom
// #535 — a goal mesh's operation controls on its row: the cutter, the four surface numbers with
// their defaults and sources, the reset that returns a number to its default, and the facts the
// last generated program reported.
//
// Rendered DIRECTLY, not through `EngravePanel`: the row is a controlled component, and what is
// worth pinning here is the patch each control sends (and the words it shows beside its defaults).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  EngraveTargetObjectRow,
  type SurfaceDefaults,
} from '@/components/panels/EngraveTargetObjectRow';
import type { GoalSurfaceFacts } from '@/engine/cnc/cam/surface3d';
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

const FACTS: GoalSurfaceFacts = {
  resolutionNote: 'sampled on a 0.1 mm grid',
  gridPitchMm: 0.1,
  gridCells: 120000,
  stepDownMm: 0.5,
  roughStepOverMm: 0.8,
  finishStepOverMm: 0.4,
  stockToLeaveMm: 0.3,
  roughingLayers: 6,
  notes: [],
};

interface RowOptions {
  target?: Partial<EngraveTargetObject>;
  surface?: SurfaceDefaults | undefined;
  surfaceFacts?: GoalSurfaceFacts | null;
}

/** Render the row; returns the callbacks so a test can read what a control sent. */
function row({ target = {}, surface = DEFAULTS, surfaceFacts = null }: RowOptions = {}): {
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
      surfaceFacts={surfaceFacts}
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
  it('shows the Technical fold on a goal row, and prefills each number from its default', () => {
    row();
    openTechnical();
    const stepDown = screen.getByTestId('engrave-target-surface-roughStepDownMm-0') as HTMLInputElement;
    expect(stepDown.value).toBe('0.5');
    expect(screen.getByTestId('engrave-target-surface-roughStepDownMm-source-0').textContent).toBe(
      'the feeds row',
    );
    expect((screen.getByTestId('engrave-target-surface-finishStepOverMm-0') as HTMLInputElement).value).toBe(
      '0.8',
    );
    expect((screen.getByTestId('engrave-target-surface-gridPitchMm-0') as HTMLInputElement).value).toBe('0.1');
    expect(screen.getByTestId('engrave-target-surface-gridPitchMm-source-0').textContent).toBe(
      'chosen for this shop',
    );
    expect((screen.getByTestId('engrave-target-surface-stockToLeaveMm-0') as HTMLInputElement).value).toBe(
      '0.3',
    );
    expect(screen.getByTestId('engrave-target-surface-stockToLeaveMm-source-0').textContent).toBe(
      'this shop’s seed',
    );
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

  it('a typed number sends its key and words itself typed; the reset sends undefined', () => {
    const { onChange } = row();
    openTechnical();
    const input = screen.getByTestId('engrave-target-surface-roughStepDownMm-0');
    fireEvent.change(input, { target: { value: '0.25' } });
    expect(onChange).toHaveBeenLastCalledWith({ surface: { roughStepDownMm: 0.25 } });

    // With a value stored, the word says who typed it and a reset appears; the reset is the
    // `undefined` patch that removes the key.
    cleanup();
    resetEngraveRows();
    const second = row({ target: { surface: { roughStepDownMm: 0.25 } } });
    openTechnical();
    expect(screen.getByTestId('engrave-target-surface-roughStepDownMm-source-0').textContent).toBe('typed');
    fireEvent.click(screen.getByTestId('engrave-target-surface-roughStepDownMm-reset-0'));
    expect(second.onChange).toHaveBeenLastCalledWith({ surface: { roughStepDownMm: undefined } });
  });

  it('clearing a box returns the number to its default', () => {
    const { onChange } = row({ target: { surface: { finishStepOverMm: 0.2 } } });
    openTechnical();
    fireEvent.change(screen.getByTestId('engrave-target-surface-finishStepOverMm-0'), {
      target: { value: '' },
    });
    expect(onChange).toHaveBeenLastCalledWith({ surface: { finishStepOverMm: undefined } });
  });

  it('picking another cutter tells the panel, which owns the job’s cutter', () => {
    const { onCutterChange } = row();
    openTechnical();
    fireEvent.change(screen.getByTestId('engrave-target-surface-cutter-0'), {
      target: { value: 'flat-3.175' },
    });
    expect(onCutterChange).toHaveBeenLastCalledWith('flat-3.175');
  });

  it('quotes the last generated program’s levels and grid, and nothing before a Generate', () => {
    row();
    openTechnical();
    expect(screen.queryByTestId('engrave-target-surface-report-0')).toBeNull();
    cleanup();
    resetEngraveRows();

    row({ surfaceFacts: FACTS });
    openTechnical();
    const report = screen.getByTestId('engrave-target-surface-report-0').textContent ?? '';
    expect(report).toContain('6 roughing layers');
    expect(report).toContain('0.5 mm step-down');
    expect(report).toContain('0.4 mm step-over');
    expect(report).toContain('0.3 mm');
    // The resolution sentence the engine produced, capitalised for the sentence position.
    expect(report).toContain('Sampled on a 0.1 mm grid');
  });

  it('a reference row has no Technical fold at all', () => {
    row({ target: { role: 'reference', surface: undefined }, surface: undefined });
    fireEvent.click(screen.getByTestId('engrave-target-expand-0'));
    expect(screen.queryByTestId('engrave-target-technical-0')).toBeNull();
  });
});
