// @vitest-environment jsdom
/**
 * #1082 — THE FLIP ROW'S SIDE-2 STOCK, by the operator's press. The vendor method cuts the FREED
 * PART on side 2, so the row offers that box (derived from side 1's extents) and states it on the
 * setup only when pressed — or names and clears a stated one. Nothing is written without the press.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { FlipChoice } from '@/components/panels/FlipChoice';
import { flipOrientation } from '@/engine/cnc/engrave/flipChoice';
import type { JobSetup } from '@/types/engraveJob';

afterEach(() => cleanup());

const VENDOR: JobSetup = {
  id: 'setup-2',
  orientation: flipOrientation('left-right'),
  mount: { kind: 'bracket' },
  itemIds: [],
  tools: [],
  flip: { method: 'free-then-flip', axis: 'left-right' },
};
const OFFER = { length: 106, width: 136, thickness: 25 };

describe('#1082 the flip row’s side-2 stock', () => {
  it('offers the freed part’s box and states it on the setup when pressed', () => {
    const onReplace = vi.fn();
    render(<FlipChoice n={2} setup={VENDOR} editable stock={{ length: 120, width: 160 }} derivedStock={OFFER} onReplace={onReplace} />);
    const line = screen.getByTestId('engrave-setup-stock-2');
    expect(line.textContent).toContain('106 × 136 × 25');
    expect(line.textContent).toContain('derived from side 1’s cut extents');
    fireEvent.click(screen.getByTestId('engrave-setup-stock-use-2'));
    expect(onReplace).toHaveBeenCalledWith(expect.objectContaining({ stock: { ...OFFER, provenance: 'stated' } }));
  });

  it('names a stated stock with its provenance and clears it', () => {
    const onReplace = vi.fn();
    const stated = { ...VENDOR, stock: { ...OFFER, provenance: 'stated' as const } };
    render(<FlipChoice n={2} setup={stated} editable stock={{ length: 120, width: 160 }} derivedStock={OFFER} onReplace={onReplace} />);
    expect(screen.getByTestId('engrave-setup-stock-2').textContent).toContain('(stated)');
    fireEvent.click(screen.getByTestId('engrave-setup-stock-clear-2'));
    expect(onReplace).toHaveBeenCalledWith(expect.objectContaining({ stock: undefined }));
  });

  it('a setup with no vendor method says nothing about a stock', () => {
    const frame = { ...VENDOR, flip: { method: 'tabs-in-blank' as const, axis: 'left-right' as const } };
    render(<FlipChoice n={2} setup={frame} editable stock={{ length: 120, width: 160 }} derivedStock={OFFER} onReplace={() => {}} />);
    expect(screen.queryByTestId('engrave-setup-stock-2')).toBeNull();
  });
});
