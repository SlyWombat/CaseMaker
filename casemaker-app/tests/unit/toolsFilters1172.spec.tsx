// @vitest-environment jsdom
// #1172 item 2 — the bits list finds what is on screen, and its columns sort.
//
// Search already reads colour/shape/size/maker/place (#1172A). This pins the rest: shape and case
// colour filters, a Cuts column (the depth the record states), and the Tip / Cuts / Have headers
// sorting the rows. The fixtures are three owned bits, each different on every axis so an ordering
// cannot pass by accident; the default owned-only tier means the built-ins and catalogue cannot
// noise up the result.

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

function copy(id: string, condition: ToolCopy['condition'], colour: string): ToolCopy {
  return {
    id,
    condition,
    whereabouts: { kind: 'box', case: { colour, label: `${colour} base, clear tube` } },
    runtimeWarnMinutes: null,
    notes: null,
    runtimeMinutes: null,
  };
}

function item(opts: {
  id: string;
  tool: ReturnType<typeof flatEndMill>;
  copies: ToolCopy[];
  quantity?: number;
}): InventoryItem {
  return {
    id: opts.id,
    tool: opts.tool,
    origin: null,
    quantity: opts.quantity ?? opts.copies.length,
    codes: [],
    addedAt: '2026-11-01T09:00:00.000Z',
    notes: null,
    copies: opts.copies,
    colletFits: null,
  };
}

/** Three bits: flat 0.6 (12 deep, 1 good, yellow), ball 1.0 (4 deep, 2 good, yellow/red),
 *  flat 3.175 (15 deep, lost, red). */
const CORN = item({
  id: 'corn',
  tool: flatEndMill(0.6, { name: '0.6 mm corn', typeText: 'Corn Bit', fluteLength: 12 }),
  copies: [copy('corn-1', 'new', 'yellow')],
});
const BALL = item({
  id: 'ball',
  tool: flatEndMill(1, { name: '1 mm ball', typeText: 'Ball Nose', shape: 'ball', fluteLength: 4 }),
  copies: [copy('ball-1', 'new', 'yellow'), copy('ball-2', 'used', 'red')],
});
const LONG = item({
  id: 'long',
  tool: flatEndMill(3.175, { name: '3.175 mm flat, long', fluteLength: 15 }),
  copies: [copy('long-1', 'lost', 'red')],
});

function seed(): void {
  useToolRegistryStore.setState({ status: 'present', error: null, items: [CORN, BALL, LONG] });
  setInventoryEntries(
    [CORN, BALL, LONG].map((bit) => ({ key: `inv:${bit.id}`, tool: bit.tool, provenance: 'registered here' })),
  );
}

/** The drawn rows, in order. */
function rowOrder(): string[] {
  return screen
    .getAllByTestId(/^manage-tools-row-/)
    .map((row) => row.getAttribute('data-testid') ?? '')
    .filter((id) => id !== '');
}

beforeEach(() => {
  resetHouseStore();
  resetManageMode();
  resetRegistry();
  seed();
});

afterEach(() => {
  cleanup();
  resetRegistry();
  useToolRegistryStore.setState({ status: 'checking', items: [] });
});

describe('#1172 item 2 — shape and case-colour filters', () => {
  it('draws the Cuts column from the depth the record states', () => {
    render(<ToolsScope />);
    expect(screen.getByTestId('manage-tools-cuts-inv:corn').textContent).toContain('12');
    expect(screen.getByTestId('manage-tools-cuts-inv:ball').textContent).toContain('4');
    expect(screen.getByTestId('manage-tools-cuts-inv:long').textContent).toContain('15');
  });

  it('narrows to one shape, and back to all of them', () => {
    render(<ToolsScope />);
    fireEvent.change(screen.getByTestId('manage-filter-shape'), { target: { value: 'ball' } });
    expect(rowOrder()).toEqual(['manage-tools-row-inv:ball']);

    fireEvent.change(screen.getByTestId('manage-filter-shape'), { target: { value: '' } });
    expect(rowOrder()).toHaveLength(3);
  });

  it('narrows to the bits in a case colour, from every copy they hold', () => {
    render(<ToolsScope />);
    fireEvent.change(screen.getByTestId('manage-filter-case'), { target: { value: 'yellow' } });
    expect(rowOrder()).toEqual(['manage-tools-row-inv:corn', 'manage-tools-row-inv:ball']);

    fireEvent.change(screen.getByTestId('manage-filter-case'), { target: { value: 'red' } });
    expect(rowOrder()).toEqual(['manage-tools-row-inv:ball', 'manage-tools-row-inv:long']);
  });

  it('combines the two filters', () => {
    render(<ToolsScope />);
    fireEvent.change(screen.getByTestId('manage-filter-shape'), { target: { value: 'flat' } });
    fireEvent.change(screen.getByTestId('manage-filter-case'), { target: { value: 'red' } });
    expect(rowOrder()).toEqual(['manage-tools-row-inv:long']);
  });
});

describe('#1172 item 2 — Tip, Cuts and Have sort', () => {
  it('sorts by tip, both ways, and marks the header', () => {
    render(<ToolsScope />);
    fireEvent.click(screen.getByTestId('manage-sort-tip'));
    expect(rowOrder()).toEqual([
      'manage-tools-row-inv:corn',
      'manage-tools-row-inv:ball',
      'manage-tools-row-inv:long',
    ]);
    expect(screen.getByTestId('manage-sort-tip').closest('th')?.getAttribute('aria-sort')).toBe('ascending');

    fireEvent.click(screen.getByTestId('manage-sort-tip'));
    expect(rowOrder()).toEqual([
      'manage-tools-row-inv:long',
      'manage-tools-row-inv:ball',
      'manage-tools-row-inv:corn',
    ]);
    expect(screen.getByTestId('manage-sort-tip').closest('th')?.getAttribute('aria-sort')).toBe('descending');
  });

  it('sorts by cuts, the flute depth', () => {
    render(<ToolsScope />);
    fireEvent.click(screen.getByTestId('manage-sort-cuts'));
    expect(rowOrder()).toEqual([
      'manage-tools-row-inv:ball',
      'manage-tools-row-inv:corn',
      'manage-tools-row-inv:long',
    ]);
  });

  it('sorts by the pieces a job can use, lost last on an ascending sort', () => {
    render(<ToolsScope />);
    fireEvent.click(screen.getByTestId('manage-sort-have'));
    // corn 1 good, ball 2 good, long 0 (lost).
    expect(rowOrder()).toEqual([
      'manage-tools-row-inv:long',
      'manage-tools-row-inv:corn',
      'manage-tools-row-inv:ball',
    ]);
  });
});
