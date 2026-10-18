// @vitest-environment jsdom
// #500 — the Tools list row shows the cutter, not the import's bookkeeping.
//
// The second line used to print `InventoryItem.notes` verbatim: the label corpus's `Case: …`,
// `Makera …`, `Label CN: …`, the builder's `Metal line (-M-)` / `Two physical variants … (#381)`,
// and the operator's own "Back in its box (swapped out of the spindle …)". This pins the rule that
// the list line is the box code(s) alone, the full line sits in the hover title, and the notes are
// still reachable in the possession's own detail (the rail) — where they are edited.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ToolsScope } from '@/components/manage/ToolsScope';
import { resetHouseStore } from '@/store/houseStore';
import { resetManageMode } from '@/store/manageModeStore';
import { useToolRegistryStore } from '@/store/toolRegistryStore';
import { resetRegistry, setInventoryEntries } from '@/engine/cnc/toolRegistry';
import { flatEndMill } from '@/engine/cnc/tool';
import type { ToolCopy } from '@/engine/cnc/toolCondition';
import type { InventoryItem } from '@/platform/houseClient';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOTE =
  'Case: yellow. Makera C1-BIT-BALL-NOSE-1-4. Label CN: 球头刀 (ball-nose cutter). ' +
  'Metal line (-M-). Two physical variants under one code (#381): 2× yellow with collar. ' +
  'Back in its box (swapped out of the spindle 2026-10-12).';

const TOOL = flatEndMill(1, { name: '1 mm ball nose' });

const copy: ToolCopy = {
  id: 'c-1',
  condition: 'new',
  whereabouts: { kind: 'box', case: { colour: 'yellow', label: 'yellow base, clear tube' } },
  runtimeWarnMinutes: null,
  notes: null,
  runtimeMinutes: null,
};

const ITEM: InventoryItem = {
  id: 'inv-1',
  tool: TOOL,
  origin: null,
  quantity: 1,
  codes: [
    { symbology: 'qr', value: 'C1-BIT-BALL-NOSE-1-4' },
    { symbology: 'cn', value: 'C1-BIT-BALL-NOSE-1-4-CN' },
  ],
  addedAt: '2026-10-12T00:00:00.000Z',
  notes: NOTE,
  copies: [copy],
  colletFits: null,
};

function seed(item: InventoryItem): void {
  useToolRegistryStore.setState({ status: 'present', error: null, items: [item] });
  setInventoryEntries([{ key: `inv:${item.id}`, tool: item.tool, provenance: 'registered here' }]);
}

beforeEach(() => {
  resetHouseStore();
  resetManageMode();
});

afterEach(() => {
  cleanup();
  resetRegistry();
  useToolRegistryStore.setState({ status: 'checking', items: [] });
});

describe('#500 the Tools row shows cutter fields, not free-text notes', () => {
  it('draws the codes on the box and does not draw the inventory notes', () => {
    seed(ITEM);
    render(<ToolsScope />);

    const row = screen.getByTestId('manage-tools-row-inv:inv-1');
    // The code is structured data about the possession, and no column holds it.
    expect(row.textContent).toContain('C1-BIT-BALL-NOSE-1-4');
    expect(row.textContent).toContain('C1-BIT-BALL-NOSE-1-4-CN');
    // None of the import's bookkeeping or the operator's aside reaches the list line.
    expect(row.textContent).not.toContain('Case: yellow');
    expect(row.textContent).not.toContain('Label CN');
    expect(row.textContent).not.toContain('Metal line');
    expect(row.textContent).not.toContain('#381');
    expect(row.textContent).not.toContain('Back in its box');
  });

  it('keeps the whole code line in the hover title the cell ellipsizes', () => {
    seed(ITEM);
    render(<ToolsScope />);

    const small = screen.getByTestId('manage-tools-row-inv:inv-1').querySelector('.nm small');
    expect(small).not.toBeNull();
    expect(small!.getAttribute('title')).toBe(
      'QR C1-BIT-BALL-NOSE-1-4 · CN C1-BIT-BALL-NOSE-1-4-CN',
    );
    // The name has the same safety net when the column is narrower than the name.
    expect(
      screen.getByTestId('manage-tools-row-inv:inv-1').querySelector('.tbl__name')!.getAttribute('title'),
    ).toBe('1 mm ball nose');
  });

  it('still shows the notes in the possession detail when the row is picked', () => {
    seed(ITEM);
    render(<ToolsScope />);

    fireEvent.click(screen.getByTestId('manage-tools-row-inv:inv-1'));
    expect((screen.getByTestId('manage-item-notes') as HTMLInputElement).value).toBe(NOTE);
  });

  it('draws no second line when the cutter has no code — never the old placeholder', () => {
    seed({ ...ITEM, codes: [], notes: null });
    render(<ToolsScope />);

    const row = screen.getByTestId('manage-tools-row-inv:inv-1');
    expect(row.querySelector('.nm small')).toBeNull();
    expect(row.textContent).not.toContain('registered here');
  });

  it('draws no free-text provenance line on a definition row either', () => {
    // No inventory: the main list is just the shipped built-ins (status `present`, not `checking`).
    useToolRegistryStore.setState({ status: 'present', error: null, items: [] });
    render(<ToolsScope />);
    // `flat-3.175x12-metal`'s provenance names a sample .nc file — not row text (#500).
    const row = screen.getByTestId('manage-tools-row-flat-3.175x12-metal');
    expect(row.querySelector('.nm small')).toBeNull();
    expect(row.textContent).not.toContain('TopClamp');
  });
});
