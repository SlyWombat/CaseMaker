// @vitest-environment jsdom
// #732 — the Makera match block in Manage › Tools. The maintainer decision is "suggest, then the
// operator confirms once and it is saved": so the list must not write on render, a single press is
// the confirmation, and what it writes is the Makera id ON the inventory row (`item.tool.id`).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MakeraMatch } from '@/components/manage/MakeraMatch';
import { resetRegistry, setRegistry } from '@/engine/cnc/toolRegistry';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { InventoryItem } from '@/platform/houseClient';
import { resetHouseStore, useHouseStore } from '@/store/houseStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const G_METAL = '112111313812';
const G_PLAIN = '112111313825';

const tool = (over: Partial<ToolLibraryEntry['tool']> & Pick<ToolLibraryEntry['tool'], 'name'>): ToolLibraryEntry['tool'] => ({
  number: null,
  id: null,
  typeText: 'Flat End',
  shape: 'flat',
  handleDiameter: 3.175,
  tipDiameter: 3.175,
  diameter: 3.175,
  cornerRadius: 0,
  angle: null,
  halfAngle: null,
  fluteLength: 12,
  shoulderLength: null,
  stickout: null,
  centreCutting: null,
  ...over,
});

const ENTRIES: readonly ToolLibraryEntry[] = [
  { key: 'cat:metal', tool: tool({ name: '3.175*12mm Flat End(Metal)', id: G_METAL }), provenance: `Makera catalogue ${G_METAL}` },
  { key: 'cat:plain', tool: tool({ name: '3.175*25mm Flat End', id: G_PLAIN, fluteLength: 25 }), provenance: `Makera catalogue ${G_PLAIN}` },
];

const ITEM: InventoryItem = {
  id: 'kz-o-flute-m-3-175-12',
  tool: tool({ name: 'Single Flute O-Flute Bit for Metal - 1/8" Shank 3.175mm * 12mm' }),
  origin: null,
  quantity: 2,
  codes: [{ symbology: 'qr', value: 'C1-BIT-O-FLUTE-M-3.175-12' }],
  addedAt: '2026-10-12T00:00:00.000Z',
  notes: 'Case: yellow.',
  copies: [],
  colletFits: null,
};

beforeEach(() => {
  resetHouseStore();
  resetRegistry();
  setRegistry(ENTRIES);
});
afterEach(() => {
  cleanup();
  resetRegistry();
});

describe('#732 the Makera match block', () => {
  it('suggests from the box code, and writes nothing until the operator confirms one', () => {
    const updateItem = vi.fn(async () => true);
    useHouseStore.setState({ updateItem });
    render(<MakeraMatch item={ITEM} />);

    const reading = screen.getByTestId('manage-makera-reading').textContent ?? '';
    expect(reading).toContain('C1-BIT-O-FLUTE-M-3.175-12');
    expect(reading).toContain('2 catalogue rows fit');
    // Looking at the list is not a match: the press is the confirmation.
    expect(updateItem).not.toHaveBeenCalled();
    expect((screen.getByTestId('manage-makera-confirm') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByTestId(`manage-makera-candidate-${G_METAL}`));
    expect((screen.getByTestId('manage-makera-confirm') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('manage-makera-confirm'));

    expect(updateItem).toHaveBeenCalledTimes(1);
    const saved = (updateItem.mock.calls[0] as unknown as [InventoryItem])[0];
    expect(saved.id).toBe(ITEM.id);
    expect(saved.tool.id).toBe(G_METAL);
    // The possession is untouched: a match changes the cutter's identity, not its count or notes.
    expect(saved.quantity).toBe(2);
    expect(saved.notes).toBe('Case: yellow.');
    expect(saved.codes).toEqual(ITEM.codes);
  });

  it('shows the same line first, and the other line is still offered', () => {
    render(<MakeraMatch item={ITEM} />);
    const metal = screen.getByTestId(`manage-makera-candidate-${G_METAL}`).closest('label');
    const plain = screen.getByTestId(`manage-makera-candidate-${G_PLAIN}`).closest('label');
    expect(metal?.textContent).toContain('same line');
    expect(plain).not.toBeNull();
    expect(metal!.compareDocumentPosition(plain!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows a confirmed id, and removing the match saves the row without one', () => {
    const updateItem = vi.fn(async () => true);
    useHouseStore.setState({ updateItem });
    render(<MakeraMatch item={{ ...ITEM, tool: { ...ITEM.tool, id: G_METAL } }} />);

    expect(screen.getByTestId('manage-makera-confirmed').textContent).toContain(G_METAL);
    expect(screen.getByTestId('manage-makera-confirmed').textContent).toContain('3.175*12mm Flat End(Metal)');
    // A confirmed row offers no second list to pick from.
    expect(screen.queryByTestId('manage-makera-confirm')).toBeNull();

    fireEvent.click(screen.getByTestId('manage-makera-clear'));
    const saved = (updateItem.mock.calls[0] as unknown as [InventoryItem])[0];
    expect(saved.tool.id).toBeNull();
  });

  it('shows a confirmed id even when the catalogue has no row for it any more', () => {
    render(<MakeraMatch item={{ ...ITEM, tool: { ...ITEM.tool, id: '112111399999' } }} />);
    expect(screen.getByTestId('manage-makera-confirmed').textContent).toContain('112111399999');
    expect(screen.getByTestId('manage-makera-confirmed').textContent).not.toContain('the catalogue lists it as');
  });

  it('says no row fits, and offers no confirm', () => {
    render(<MakeraMatch item={{ ...ITEM, codes: [], tool: { ...ITEM.tool, shape: 'ball', tipDiameter: 2, diameter: 2 } }} />);
    expect(screen.getByTestId('manage-makera-no-match')).toBeDefined();
    expect(screen.queryByTestId('manage-makera-confirm')).toBeNull();
  });

  it('says nothing can be suggested when the record states neither a code nor a shape', () => {
    render(<MakeraMatch item={{ ...ITEM, codes: [], tool: { ...ITEM.tool, shape: 'unknown', tipDiameter: null, diameter: null } }} />);
    expect(screen.getByTestId('manage-makera-no-evidence')).toBeDefined();
    expect(screen.queryByTestId('manage-makera-confirm')).toBeNull();
  });
});
