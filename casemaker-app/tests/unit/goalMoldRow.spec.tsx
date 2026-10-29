// @vitest-environment jsdom
// #721 — the goal row's choice: make the part, or a mold of it. 'item' is stored as no key.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EngraveTargetObjectRow } from '@/components/panels/EngraveTargetObjectRow';
import { resetEngraveRows } from '@/store/engraveRowStore';
import type { TargetObjectPatch } from '@/store/engraveJobStore';
import type { EngraveTargetObject } from '@/types/engraveJob';

beforeEach(() => resetEngraveRows());
afterEach(() => cleanup());

const GOAL: EngraveTargetObject = {
  id: 'tgt-1',
  name: 'dome.stl',
  format: 'stl',
  sha256: 'c'.repeat(64),
  data: 'AAAA',
  size: { x: 10, y: 10, z: 5 },
  position: { x: 50, y: 30, z: 0 },
  rotation: 0,
  enabled: true,
  role: 'goal',
};

function renderRow(target: Partial<EngraveTargetObject> = {}) {
  const onChange = vi.fn<(patch: TargetObjectPatch) => void>();
  render(<EngraveTargetObjectRow target={{ ...GOAL, ...target }} index={0} onChange={onChange} onRemove={() => undefined} findings={[]} />);
  fireEvent.click(screen.getByTestId('engrave-target-expand-0'));
  return onChange;
}

describe('#721 — the goal row says what it makes', () => {
  it('offers the part and the mold, and writes the choice', () => {
    const onChange = renderRow();
    const select = screen.getByTestId('engrave-target-goal-mode-0') as HTMLSelectElement;
    expect(select.value).toBe('item');
    fireEvent.change(select, { target: { value: 'mold' } });
    expect(onChange).toHaveBeenLastCalledWith({ goalMode: 'mold' });
  });

  it('a mold row says so, with its depth in mm; back to the part clears the key', () => {
    const onChange = renderRow({ goalMode: 'mold' });
    expect(screen.getByText(/made as a MOLD: its shape is cut as a cavity to cast it in, 5 mm deep/)).toBeTruthy();
    fireEvent.change(screen.getByTestId('engrave-target-goal-mode-0'), { target: { value: 'item' } });
    expect(onChange).toHaveBeenLastCalledWith({ goalMode: undefined });
  });

  it('a reference and a picture have no such choice', () => {
    renderRow({ role: 'reference' });
    expect(screen.queryByTestId('engrave-target-goal-mode-0')).toBeNull();
    cleanup();
    renderRow({ format: 'png' });
    expect(screen.queryByTestId('engrave-target-goal-mode-0')).toBeNull();
  });
});
