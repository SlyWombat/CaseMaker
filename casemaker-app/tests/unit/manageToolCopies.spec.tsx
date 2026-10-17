// @vitest-environment jsdom
// #415 — the copies editor in Manage › Tools: a copy is described (condition, where it is), the
// collet fits ticked, and the item saved with both; undescribed copies say "no condition set".

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ToolCopies } from '@/components/manage/ToolCopies';
import type { InventoryItem } from '@/platform/houseClient';
import { resetHouseStore, useHouseStore } from '@/store/houseStore';
import { resetLocationStore, useLocationStore } from '@/store/locationStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ITEM: InventoryItem = {
  id: 'inv-1',
  tool: {
    number: null, id: null, name: '2 mm flat', typeText: 'Flat End', shape: 'flat', handleDiameter: 3.175,
    tipDiameter: 2, diameter: 2, cornerRadius: 0, angle: null, halfAngle: null, fluteLength: null,
    shoulderLength: null, stickout: null, centreCutting: null,
  },
  origin: null,
  quantity: 2,
  codes: [],
  addedAt: '2026-10-15T00:00:00.000Z',
  notes: null,
  copies: [],
  colletFits: null,
};

beforeEach(() => {
  resetHouseStore();
  resetLocationStore();
  useLocationStore.setState({
    status: 'present',
    location: {
      kind: 'casemaker-location', schemaVersion: 1, id: 'loc-1', name: 'My shop', createdAt: 'x', migratedFrom: null,
      unreadableMachines: [],
      machines: [{
        id: 'm-1', profileId: 'Z1', name: 'Makera_Z1_000000', serial: null, firmware: null, address: null,
        calibration: null, fixtures: null, margins: null, power: null, wasteboard: null, finishedPrograms: [], updatedAt: 'x',
      }],
    },
  });
});
afterEach(cleanup);

describe('#415 the copies editor', () => {
  it('describes a copy as in the machine and worn, ticks the collet fit, and saves both', () => {
    const updateItem = vi.fn(async () => true);
    useHouseStore.setState({ updateItem });
    render(<ToolCopies item={ITEM} />);
    expect(screen.getByTestId('manage-copies-undescribed').textContent).toContain('2 copies have no condition set');
    expect(screen.getByTestId('manage-collet-state').textContent).toContain('Not stated');

    fireEvent.click(screen.getByTestId('manage-copy-add'));
    fireEvent.change(screen.getByTestId('manage-copy-condition-0'), { target: { value: 'worn' } });
    fireEvent.change(screen.getByTestId('manage-copy-where-0'), { target: { value: 'm-1' } });
    fireEvent.click(screen.getByTestId('manage-collet-m-1'));
    fireEvent.click(screen.getByTestId('manage-copies-save'));

    expect(updateItem).toHaveBeenCalledTimes(1);
    const saved = (updateItem.mock.calls[0] as unknown as [InventoryItem])[0];
    expect(saved.copies).toEqual([
      expect.objectContaining({ condition: 'worn', whereabouts: { kind: 'machine', machineId: 'm-1' } }),
    ]);
    expect(saved.colletFits).toEqual(['m-1']);
  });

  it('cannot describe more copies than are owned', () => {
    render(<ToolCopies item={{ ...ITEM, quantity: 1 }} />);
    fireEvent.click(screen.getByTestId('manage-copy-add'));
    expect((screen.getByTestId('manage-copy-add') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('#415 review — the editor’s edges', () => {
  it('shows a copy in a machine this location does not hold as that machine, not as "in its box"', () => {
    const item = {
      ...ITEM,
      copies: [{ id: 'c1', condition: 'used' as const, whereabouts: { kind: 'machine' as const, machineId: 'm-gone' }, runtimeWarnMinutes: null, notes: null, runtimeMinutes: null }],
    };
    render(<ToolCopies item={item} />);
    const where = screen.getByTestId('manage-copy-where-0') as HTMLSelectElement;
    expect(where.value).toBe('m-gone');
    expect(where.selectedOptions[0]?.textContent).toContain('m-gone (not in this location)');
  });

  it('collet fits can go back to "not stated"', () => {
    const updateItem = vi.fn(async () => true);
    useHouseStore.setState({ updateItem });
    render(<ToolCopies item={{ ...ITEM, colletFits: ['m-1'] }} />);
    fireEvent.click(screen.getByTestId('manage-collet-unstate'));
    expect(screen.getByTestId('manage-collet-state').textContent).toContain('Not stated');
    fireEvent.click(screen.getByTestId('manage-copies-save'));
    expect((updateItem.mock.calls[0] as unknown as [InventoryItem])[0].colletFits).toBeNull();
  });

  it('takes an override below one minute', () => {
    const updateItem = vi.fn(async () => true);
    useHouseStore.setState({ updateItem });
    render(<ToolCopies item={ITEM} />);
    fireEvent.click(screen.getByTestId('manage-copy-add'));
    fireEvent.change(screen.getByTestId('manage-copy-warn-0'), { target: { value: '0.5' } });
    fireEvent.click(screen.getByTestId('manage-copies-save'));
    expect((updateItem.mock.calls[0] as unknown as [InventoryItem])[0].copies[0]?.runtimeWarnMinutes).toBe(0.5);
  });
});

describe('#491 — the case on a boxed copy', () => {
  it('records the colour and the label, and “not set” condition saves as null', () => {
    const updateItem = vi.fn(async () => true);
    useHouseStore.setState({ updateItem });
    render(<ToolCopies item={ITEM} />);
    fireEvent.click(screen.getByTestId('manage-copy-add'));

    // A copy added only to say which case it lives in states no condition — it is not "new".
    expect((screen.getByTestId('manage-copy-condition-0') as HTMLSelectElement).value).toBe('');
    // The label cannot be typed before there is a colour to attach it to.
    expect((screen.getByTestId('manage-copy-case-label-0') as HTMLInputElement).disabled).toBe(true);

    fireEvent.change(screen.getByTestId('manage-copy-case-0'), { target: { value: 'yellow' } });
    fireEvent.change(screen.getByTestId('manage-copy-case-label-0'), { target: { value: 'yellow base, clear tube' } });
    fireEvent.click(screen.getByTestId('manage-copies-save'));

    const saved = (updateItem.mock.calls[0] as unknown as [InventoryItem])[0];
    expect(saved.copies).toEqual([
      expect.objectContaining({
        condition: null,
        whereabouts: { kind: 'box', case: { colour: 'yellow', label: 'yellow base, clear tube' } },
      }),
    ]);
  });

  it('shows a recorded case back, and forgets it when the copy moves to a machine', () => {
    const item = {
      ...ITEM,
      copies: [
        {
          id: 'c1',
          condition: 'used' as const,
          whereabouts: {
            kind: 'box' as const,
            case: { colour: 'green', label: 'green lid' },
          },
          runtimeWarnMinutes: null,
          notes: null,
          runtimeMinutes: null,
        },
      ],
    };
    render(<ToolCopies item={item} />);
    expect((screen.getByTestId('manage-copy-case-0') as HTMLInputElement).value).toBe('green');
    expect((screen.getByTestId('manage-copy-case-label-0') as HTMLInputElement).value).toBe('green lid');

    fireEvent.change(screen.getByTestId('manage-copy-where-0'), { target: { value: 'm-1' } });
    // A machine copy is not in a case: the fields go, and the union carries no case.
    expect(screen.queryByTestId('manage-copy-case-0')).toBeNull();
    expect(screen.queryByTestId('manage-copy-case-label-0')).toBeNull();
  });
});
