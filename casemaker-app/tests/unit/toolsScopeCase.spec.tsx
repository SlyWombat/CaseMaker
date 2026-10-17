// @vitest-environment jsdom
// #491 — the Tools table's Case column: one swatch per DISTINCT case among a possession's copies,
// the count beside them, and the not-applicable dot when no copy states a case. A colour outside the
// palette is drawn as an outline, not a guessed paint chip.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ToolsScope } from '@/components/manage/ToolsScope';
import { resetHouseStore } from '@/store/houseStore';
import { resetManageMode } from '@/store/manageModeStore';
import { useToolRegistryStore } from '@/store/toolRegistryStore';
import { resetRegistry, setInventoryEntries } from '@/engine/cnc/toolRegistry';
import { flatEndMill } from '@/engine/cnc/tool';
import type { ToolCopy } from '@/engine/cnc/toolCondition';
import type { InventoryItem } from '@/platform/houseClient';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TOOL = flatEndMill(2, { name: '2 mm flat' });

const copy = (id: string, where: ToolCopy['whereabouts']): ToolCopy => ({
  id,
  condition: 'new',
  whereabouts: where,
  runtimeWarnMinutes: null,
  notes: null,
  runtimeMinutes: null,
});

const ITEM = (copies: ToolCopy[]): InventoryItem => ({
  id: 'inv-1',
  tool: TOOL,
  origin: null,
  quantity: 2,
  codes: [{ symbology: 'qr', value: 'C1-BIT-2.0' }],
  addedAt: '2026-10-17T00:00:00.000Z',
  notes: null,
  copies,
  colletFits: null,
});

function seed(item: InventoryItem): void {
  useToolRegistryStore.setState({ status: 'present', error: null, items: [item] });
  setInventoryEntries([{ key: 'inv:inv-1', tool: TOOL, provenance: 'registered here' }]);
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

describe('#491 the Tools table’s case column', () => {
  it('draws one swatch per distinct case, with the count beside them', () => {
    seed(
      ITEM([
        copy('a', { kind: 'box', case: { colour: 'yellow', label: 'yellow base, clear tube' } }),
        copy('b', { kind: 'box', case: { colour: 'orange', label: null } }),
      ]),
    );
    render(<ToolsScope />);

    const cell = screen.getByTestId('manage-tools-case-inv:inv-1');
    expect(cell.querySelectorAll('[data-case]')).toHaveLength(2);
    expect(screen.getByTestId('manage-tools-case-swatch-yellow').getAttribute('title')).toBe(
      'yellow base, clear tube',
    );
    expect(screen.getByTestId('manage-tools-case-swatch-orange').getAttribute('title')).toBe(
      'orange case',
    );
    expect(cell.textContent).toContain('2 copies: yellow, orange');
  });

  it('draws no swatch when no copy states a case — the dot, never a guessed colour', () => {
    seed(ITEM([copy('a', { kind: 'box' }), copy('b', { kind: 'box', case: null })]));
    render(<ToolsScope />);

    const cell = screen.getByTestId('manage-tools-case-inv:inv-1');
    expect(cell.querySelectorAll('[data-case]')).toHaveLength(0);
    expect(cell.textContent).toBe('·');
  });

  it('outlines a colour outside the palette rather than inventing a paint chip', () => {
    seed(ITEM([copy('a', { kind: 'box', case: { colour: 'magenta', label: null } })]));
    render(<ToolsScope />);

    const swatch = screen.getByTestId('manage-tools-case-swatch-magenta');
    expect(swatch.getAttribute('data-case')).toBe('magenta');
    expect(swatch.style.background).toBe('transparent');
    expect(swatch.style.border).toContain('dashed');
  });
});
