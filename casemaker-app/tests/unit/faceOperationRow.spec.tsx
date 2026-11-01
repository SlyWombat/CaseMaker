// @vitest-environment jsdom
// #833 — a face's row offers the flat picker's three operations ON that face, and lists the cuts
// already there. Text waits for its words; a pocket and a hole seed at sizes the cutter can cut.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FaceOperationRow } from '@/components/panels/FaceOperationRow';
import type { EngraveFaceItem, EngraveFaceOp } from '@/types/engraveJob';

afterEach(cleanup);

const flatFace: EngraveFaceOp = { id: 'f', kind: 'flat', a: 30, depth: 1 };

function renderRow(face: EngraveFaceOp = flatFace, items: EngraveFaceItem[] = []) {
  const onAdd = vi.fn();
  const onRemoveItem = vi.fn();
  render(
    <FaceOperationRow
      face={{ ...face, items }}
      index={0}
      radiusMm={10}
      lengthMm={30}
      cutterDiameterMm={3.175}
      onChange={vi.fn()}
      onRemove={vi.fn()}
      onAddItem={onAdd}
      onRemoveItem={onRemoveItem}
    />,
  );
  return { onAdd, onRemoveItem };
}

describe('#833 a face operation’s row', () => {
  it('offers Engrave text, Pocket and Hole on the face', () => {
    renderRow();
    expect(screen.getByTestId('engrave-face-add-text-0')).toBeDefined();
    expect(screen.getByTestId('engrave-face-add-pocket-0')).toBeDefined();
    expect(screen.getByTestId('engrave-face-add-hole-0')).toBeDefined();
  });

  it('adds a pocket at a size the cutter can cut, centred on the face', () => {
    const { onAdd } = renderRow();
    fireEvent.click(screen.getByTestId('engrave-face-add-pocket-0'));
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ kind: 'pocket', x: 15, y: 0, width: 6.35, height: 6.35 }));
  });

  it('adds a hole at the job cutter’s diameter, and a text only once it has words', () => {
    const { onAdd } = renderRow();
    fireEvent.click(screen.getByTestId('engrave-face-add-hole-0'));
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ kind: 'hole', diameter: 3.175 }));

    fireEvent.click(screen.getByTestId('engrave-face-add-text-0'));
    const add = screen.getByTestId('engrave-face-text-add-0') as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('engrave-face-text-words-0'), { target: { value: 'HI' } });
    expect(add.disabled).toBe(false);
    fireEvent.click(add);
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ kind: 'text', text: 'HI' }));
  });

  it('lists the cuts on the face, and removes one', () => {
    const item: EngraveFaceItem = { id: 'i1', kind: 'pocket', x: 15, y: 0, depth: 1, width: 6, height: 4 };
    const { onRemoveItem } = renderRow(flatFace, [item]);
    expect(screen.getByTestId('engrave-face-item-0-i1').textContent).toContain('Pocket 6 × 4 mm');
    fireEvent.click(screen.getByTestId('engrave-face-item-remove-0-i1'));
    expect(onRemoveItem).toHaveBeenCalledWith('i1');
  });

  it('a cross-hole has no face to add cuts to', () => {
    renderRow({ id: 'h', kind: 'cross-hole', a: 0, diameter: 3.175 });
    expect(screen.queryByTestId('engrave-face-add-0')).toBeNull();
  });
});
