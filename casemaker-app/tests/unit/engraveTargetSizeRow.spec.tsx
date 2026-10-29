// @vitest-environment jsdom
// #722 — a mesh target's size on the blank: the width/length/height fields write ONE scale
// (aspect locked by default, unlockable), the percent field, Fit to the stock, and the reset.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EngraveTargetObjectRow } from '@/components/panels/EngraveTargetObjectRow';
import { resetEngraveRows } from '@/store/engraveRowStore';
import type { TargetObjectPatch } from '@/store/engraveJobStore';
import type { EngraveTargetObject } from '@/types/engraveJob';

beforeEach(() => resetEngraveRows());
afterEach(() => cleanup());

const MESH: EngraveTargetObject = {
  id: 'tgt-1',
  name: 'big.stl',
  format: 'stl',
  sha256: 'a'.repeat(64),
  data: 'AAAA',
  size: { x: 200, y: 100, z: 40 },
  position: { x: 10, y: 10, z: 0 },
  rotation: 0,
  enabled: true,
  role: 'goal',
};
const STOCK = { length: 76, width: 38, thickness: 10, edgeMargin: 1 };

function renderRow(target: Partial<EngraveTargetObject> = {}) {
  const onChange = vi.fn<(patch: TargetObjectPatch) => void>();
  render(
    <EngraveTargetObjectRow
      target={{ ...MESH, ...target }}
      index={0}
      onChange={onChange}
      onRemove={() => undefined}
      findings={[]}
      stock={STOCK}
    />,
  );
  // The row's editor sits in its fold; open it so the fields are in the document.
  fireEvent.click(screen.getByTestId('engrave-target-expand-0'));
  return onChange;
}

describe('#722 — the mesh size controls', () => {
  it('states the placed size and the file size', () => {
    renderRow({ scale: { x: 0.5, y: 0.5, z: 0.5 } });
    expect(screen.getByTestId('engrave-target-size-note-0').textContent).toBe(
      'On the blank it is 100 × 50 × 20 mm — 50 % of the file’s 200 × 100 × 40 mm.',
    );
    expect((screen.getByTestId('engrave-target-size-x-0') as HTMLInputElement).value).toBe('100');
    expect((screen.getByTestId('engrave-target-scale-0') as HTMLInputElement).value).toBe('50');
  });

  it('a width typed with the aspect locked scales every direction', () => {
    const onChange = renderRow();
    fireEvent.change(screen.getByTestId('engrave-target-size-x-0'), { target: { value: '50' } });
    expect(onChange).toHaveBeenLastCalledWith({ scale: { x: 0.25, y: 0.25, z: 0.25 } });
  });

  it('unlocked, a height stretches Z only', () => {
    const onChange = renderRow({ scale: { x: 0.25, y: 0.25, z: 0.25 } });
    fireEvent.click(screen.getByTestId('engrave-target-aspect-0'));
    fireEvent.change(screen.getByTestId('engrave-target-size-z-0'), { target: { value: '20' } });
    expect(onChange).toHaveBeenLastCalledWith({ scale: { x: 0.25, y: 0.25, z: 0.5 } });
  });

  it('a stretched scale says so and shows no single percent', () => {
    renderRow({ scale: { x: 0.25, y: 0.25, z: 0.5 } });
    expect((screen.getByTestId('engrave-target-scale-0') as HTMLInputElement).value).toBe('');
    expect(screen.getByTestId('engrave-target-size-note-0').textContent).toContain(
      'stretched: 25 % × 25 % × 50 %',
    );
  });

  it('Fit to the stock writes the largest uniform scale and centres the object, top at the top face', () => {
    const onChange = renderRow();
    fireEvent.click(screen.getByTestId('engrave-target-fit-0'));
    expect(onChange).toHaveBeenLastCalledWith({
      scale: { x: 0.25, y: 0.25, z: 0.25 },
      position: { x: 38, y: 19, z: 0 },
    });
  });

  it('the reset goes back to the file size; at 100 % there is no reset', () => {
    const onChange = renderRow({ scale: { x: 0.5, y: 0.5, z: 0.5 } });
    fireEvent.click(screen.getByTestId('engrave-target-scale-reset-0'));
    expect(onChange).toHaveBeenLastCalledWith({ scale: null });
    cleanup();
    renderRow();
    expect(screen.queryByTestId('engrave-target-scale-reset-0')).toBeNull();
  });

  it('a picture keeps its own width field and gets no mesh size controls', () => {
    renderRow({ format: 'png' });
    expect(screen.queryByTestId('engrave-target-size-0')).toBeNull();
  });
});

describe('#722 review — the row', () => {
  it('a stretched object loads unlocked, so a width keeps the stretch', () => {
    const onChange = renderRow({ scale: { x: 0.25, y: 0.25, z: 0.5 } });
    expect((screen.getByTestId('engrave-target-aspect-0') as HTMLInputElement).checked).toBe(false);
    fireEvent.change(screen.getByTestId('engrave-target-size-x-0'), { target: { value: '100' } });
    expect(onChange).toHaveBeenLastCalledWith({ scale: { x: 0.5, y: 0.25, z: 0.5 } });
  });

  it('Fit is disabled, with its reason, when the margins leave no room', () => {
    const onChange = vi.fn<(patch: TargetObjectPatch) => void>();
    render(
      <EngraveTargetObjectRow
        target={MESH}
        index={0}
        onChange={onChange}
        onRemove={() => undefined}
        findings={[]}
        stock={{ ...STOCK, edgeMargin: 19 }}
      />,
    );
    fireEvent.click(screen.getByTestId('engrave-target-expand-0'));
    const fit = screen.getByTestId('engrave-target-fit-0') as HTMLButtonElement;
    expect(fit.disabled).toBe(true);
    expect(fit.title).toBe('The blank less its edge margin leaves no room to fit the object.');
  });
});
