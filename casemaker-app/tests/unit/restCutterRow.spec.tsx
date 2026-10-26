// @vitest-environment jsdom
// #667 — the region row's rest pair: the disclosure that names the choice, the chip on the row's
// one line, the cutters it offers (smaller flats only, never a V-bit or a drill), and the sentence
// that says the pass is measured from the first program's simulated stock.
//
// Rendered DIRECTLY, not through `EngravePanel`: the row is a controlled component, and what is
// worth pinning here is what it shows and the one value it sends.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EngraveShapeRow } from '@/components/panels/EngraveShapeRow';
import type { RestChoice } from '@/components/panels/RestCutterControl';
import { resetEngraveRows } from '@/store/engraveRowStore';
import type { EngraveRectShape } from '@/types/engraveJob';

beforeEach(() => {
  resetEngraveRows();
});

afterEach(() => {
  cleanup();
});

const RECT: EngraveRectShape = {
  kind: 'rect',
  id: 'shape-1',
  position: { x: 50, y: 30 },
  rotation: 0,
  width: 30,
  height: 20,
  cornerRadius: 0,
  depth: 1.5,
  enabled: true,
};

function rest(over: Partial<RestChoice> = {}): RestChoice {
  return {
    rough: { key: 'flat-3.175', name: '3.175 mm flat end', diameter: 3.175 },
    roughIsV: false,
    options: [
      { key: 'flat-1.0', name: '1 mm flat end', diameter: 1 },
      { key: 'flat-2.0', name: '2 mm flat end', diameter: 2 },
    ],
    restKey: null,
    setupNumber: null,
    chip: null,
    onPick: vi.fn(),
    ...over,
  };
}

function draw(choice: RestChoice | null): ReturnType<typeof vi.fn> {
  const onPick = vi.fn<(key: string | null) => void>();
  render(
    <EngraveShapeRow
      shape={RECT}
      index={0}
      maxDepth={10}
      findings={[]}
      rest={choice === null ? null : { ...choice, onPick }}
      onChange={vi.fn()}
      onRemove={vi.fn()}
    />,
  );
  return onPick;
}

/** Open the row the way a person does: press the chevron on the line. */
function openRow(): void {
  fireEvent.click(screen.getByTestId('engrave-shape-expand-0'));
}

describe('#667 the rest pair on a region row', () => {
  it('says "Finish the corners with a smaller cutter" and offers only the given smaller cutters', () => {
    draw(rest());
    openRow();
    const details = screen.getByTestId('engrave-shape-rest-0');
    expect(details.textContent).toContain('Finish the corners with a smaller cutter');
    const select = screen.getByTestId('engrave-shape-rest-select-0') as HTMLSelectElement;
    expect(select.value).toBe('');
    const options = [...select.options].map((o) => o.textContent);
    expect(options[0]).toContain('none — one cutter cuts this job');
    expect(options).toEqual([
      expect.stringContaining('none — one cutter cuts this job'),
      '1 mm flat end — ⌀1 mm',
      '2 mm flat end — ⌀2 mm',
    ]);
    // The default is one cutter; the sentence says what the rest pass would read.
    expect(screen.getByTestId('engrave-shape-rest-note-0').textContent).toContain(
      'measured from the first program’s simulated stock',
    );
  });

  it('picking a cutter sends its key; picking none sends null', () => {
    const onPick = draw(rest());
    openRow();
    const select = screen.getByTestId('engrave-shape-rest-select-0');
    fireEvent.change(select, { target: { value: 'flat-1.0' } });
    expect(onPick).toHaveBeenLastCalledWith('flat-1.0');
    fireEvent.change(select, { target: { value: '' } });
    expect(onPick).toHaveBeenLastCalledWith(null);
  });

  it('chips the pair on the one line and names the setup when the job stores more than one', () => {
    draw(rest({ restKey: 'flat-1.0', chip: 'rest ⌀1 mm', setupNumber: 2 }));
    expect(screen.getByTestId('engrave-shape-rest-chip-0').textContent).toBe('rest ⌀1 mm');
    openRow();
    expect(screen.getByTestId('engrave-shape-rest-note-0').textContent).toContain('Setup 2’s second cutter');
  });

  it('a V-bit rough cutter says the rest bit flat-bottoms the groove', () => {
    draw(rest({ rough: { key: 'v-30', name: '30° V-bit', diameter: 6 }, roughIsV: true, restKey: 'flat-1.0' }));
    openRow();
    expect(screen.getByTestId('engrave-shape-rest-note-0').textContent).toContain('flat-bottoms the groove');
  });

  it('with no rough cutter the control says to choose one and cannot write a pair', () => {
    draw(rest({ rough: null }));
    openRow();
    expect((screen.getByTestId('engrave-shape-rest-select-0') as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getByTestId('engrave-shape-rest-note-0').textContent).toContain(
      'Choose the job’s cutter first',
    );
  });

  it('with no smaller cutter it says so rather than offering an empty menu', () => {
    draw(rest({ options: [] }));
    openRow();
    expect(screen.getByTestId('engrave-shape-rest-note-0').textContent).toContain('No smaller flat cutter');
  });

  it('a row with no rest data draws neither the disclosure nor the chip', () => {
    draw(null);
    openRow();
    expect(screen.queryByTestId('engrave-shape-rest-0')).toBeNull();
    expect(screen.queryByTestId('engrave-shape-rest-chip-0')).toBeNull();
  });
});
