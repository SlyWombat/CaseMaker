// @vitest-environment jsdom
/**
 * #1168 — THE BIT-CHANGE CARD. The facts are pure and tested without wasm; the card's render is
 * checked against the same facts, so the reading the operator gets and the assertions cannot
 * disagree. What the press does (checklist 'located' + the release action) is pinned here; the
 * posted bytes are pinned by the fake-machine e2e.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { CutBitChangeCard } from '@/components/panels/CutBitChangeCard';
import { bitChangeCardFacts } from '@/engine/cnc/engrave/bitChangeCard';
import { flatEndMill } from '@/engine/cnc/tool';
import { setRegistry } from '@/engine/cnc/toolRegistry';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { useToolRegistryStore } from '@/store/toolRegistryStore';
import type { ReleaseRecord } from '@/store/engraveReleaseStore';
import type { InventoryItem } from '@/platform/houseClient';

const AT = '2026-11-10T08:00:00.000Z';

function item(opts: {
  id: string;
  name: string;
  colour: string | null;
  quantity: number;
  notes: string | null;
  broken?: number;
}): InventoryItem {
  const copies = Array.from({ length: opts.quantity }, (_, i) => ({
    id: `${opts.id}-${i + 1}`,
    condition: i < (opts.broken ?? 0) ? 'broken' : 'new',
    whereabouts: { kind: 'box', case: opts.colour === null ? null : { colour: opts.colour, label: null } },
    runtimeWarnMinutes: null,
    notes: null,
    runtimeMinutes: null,
  }));
  return {
    id: opts.id,
    tool: flatEndMill(opts.name.startsWith('0.9') ? 0.9 : 0.6, { name: opts.name, typeText: 'Corn Bit' }),
    origin: null,
    quantity: opts.quantity,
    codes: [],
    addedAt: AT,
    notes: opts.notes,
    copies,
    colletFits: null,
  } as unknown as InventoryItem;
}

const YELLOW = item({ id: 'a', name: '0.6 mm corn', colour: 'yellow', quantity: 2, notes: 'box A · row 2' });
const RED = item({ id: 'b', name: '0.9 mm corn', colour: 'red', quantity: 2, notes: 'box B · row 2', broken: 1 });

function seed(items: InventoryItem[] = [YELLOW, RED]): void {
  setRegistry([
    { key: 'inv:a', tool: YELLOW.tool, provenance: 'e2e' },
    { key: 'inv:b', tool: RED.tool, provenance: 'e2e' },
  ]);
  useToolRegistryStore.setState({ items });
 }

function record(nextToolKey = 'inv:b', previousToolKey = 'inv:a'): ReleaseRecord {
  return {
    target: { host: '192.0.2.10', port: 2222 },
    jobId: 'job-1',
    jobName: 'tray',
    phase: 'bit-change',
    active: 1,
    next: 2,
    files: [
      {
        index: 1,
        total: 2,
        setupIndex: 1,
        setupId: 's1',
        toolKey: previousToolKey,
        filename: 'tray-p1.nc',
        hash: 'h1',
        nc: 'G0 X0 Y0\nM02\n',
        verify: null,
        done: true,
        upload: 'done',
        uploadNote: null,
      },
      {
        index: 2,
        total: 2,
        setupIndex: 1,
        setupId: 's1',
        toolKey: nextToolKey,
        filename: 'tray-p2.nc',
        hash: 'h2',
        nc: 'G0 X0 Y0\nM02\n',
        verify: null,
        done: false,
        upload: 'done',
        uploadNote: null,
      },
    ],
    job: { toolKey: previousToolKey, package: { hash: 'abc12345', programs: [] } },
  } as unknown as ReleaseRecord;
}

afterEach(() => {
  cleanup();
  setRegistry([]);
  useToolRegistryStore.setState({ items: [] });
  useEngraveJobStore.getState().reset();
});

describe('#1168 — the bit-change facts', () => {
  it('names the fit bit by its cap colour first, then its chips; the take-out bit the same way', () => {
    seed();
    const facts = bitChangeCardFacts(record(), useToolRegistryStore.getState().items);
    expect(facts.done).toBe(1);
    expect(facts.total).toBe(2);
    expect(facts.nextIndex).toBe(2);
    expect(facts.fit.colourWord).toBe('Red');
    expect(facts.fit.colourHex).not.toBeNull();
    expect(facts.fit.name).toBe('0.9 mm corn');
    // The shank is the tool's own fact; the place and the count are the inventory's.
    expect(facts.fit.chips).toEqual(['shank 3.175 mm', 'box B · row 2', '1 left']);
    expect(facts.takeOut?.colourWord).toBe('Yellow');
    expect(facts.takeOut?.name).toBe('0.6 mm corn');
    expect(facts.colletLine).toBe('The collet you have in stays.');
    expect(facts.facts).toContain('Program 1 finished');
    expect(facts.colourMissing).toBeNull();
    expect(facts.sameCutter).toBe(false);
  });

  it('a bit with no recorded colour is named in the hint, and nothing is guessed', () => {
    const bare = { ...item({ id: 'b', name: '0.9 mm corn', colour: null, quantity: 1, notes: null }), copies: [] } as unknown as InventoryItem;
    seed([YELLOW, bare]);
    const facts = bitChangeCardFacts(record(), useToolRegistryStore.getState().items);
    expect(facts.fit.colourWord).toBeNull();
    expect(facts.colourMissing).toEqual({ toolKey: 'inv:b', name: '0.9 mm corn' });
    // No place described and no copies to count: the only chip left is the tool's own shank.
    expect(facts.fit.chips.some((c) => c.includes('box'))).toBe(false);
    expect(facts.fit.chips.some((c) => c.includes('left'))).toBe(false);
  });

  it('the same cutter for consecutive programs is no change at all', () => {
    seed();
    expect(bitChangeCardFacts(record('inv:a', 'inv:a'), useToolRegistryStore.getState().items).sameCutter).toBe(true);
  });
});

describe('#1168 — the card', () => {
  it('shows the fit bit, the take-out bit, two ticks and one button disabled until both', () => {
    seed();
    render(<CutBitChangeCard record={record()} onConfirm={() => {}} />);
    expect(screen.getByTestId('cut-bit-change-header').textContent).toContain('1 of 2 done · bit change');
    expect(screen.getByTestId('cut-bit-change-fit-name').textContent).toContain('Red cap · 0.9 mm corn');
    expect(screen.getByTestId('cut-bit-change-swatch')).toBeTruthy();
    expect(screen.getByTestId('cut-bit-change-chips').textContent).toContain('box B · row 2');
    expect(screen.getByTestId('cut-bit-change-take-out').textContent).toContain('yellow cap · 0.6 mm corn');
    expect(screen.getByTestId('cut-bit-change-facts').textContent).toContain('Program 1 finished · head homed · spindle stopped');
    const go = screen.getByTestId('cut-bit-change-go') as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.click(screen.getByTestId('cut-bit-change-tick-in'));
    expect(go.disabled).toBe(true);
    fireEvent.click(screen.getByTestId('cut-bit-change-tick-hands'));
    expect(go.disabled).toBe(false);
    expect(go.textContent).toBe('Measure the bit and run program 2 of 2');
  });

  it('the press records the bit as located for this run, then calls the release action', () => {
    seed();
    const onConfirm = vi.fn();
    render(<CutBitChangeCard record={record()} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByTestId('cut-bit-change-tick-in'));
    fireEvent.click(screen.getByTestId('cut-bit-change-tick-hands'));
    fireEvent.click(screen.getByTestId('cut-bit-change-go'));
    const checklist = useEngraveJobStore.getState().job.cutterChecklist?.['abc12345'];
    expect(checklist?.['inv:b']?.state).toBe('located');
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('a missing colour shows the hint and its link, never a colour word', () => {
    const bare = { ...item({ id: 'b', name: '0.9 mm corn', colour: null, quantity: 1, notes: null }), copies: [] } as unknown as InventoryItem;
    seed([YELLOW, bare]);
    render(<CutBitChangeCard record={record()} onConfirm={() => {}} />);
    expect(screen.queryByTestId('cut-bit-change-swatch')).toBeNull();
    expect(screen.getByTestId('cut-bit-change-fit-name').textContent).not.toContain('cap');
    expect(screen.getByTestId('cut-bit-change-colour-missing').textContent).toContain('not recorded');
    expect(screen.getByTestId('cut-bit-change-colour-link').textContent).toContain('bit’s row');
  });

  it('renders nothing when the next program uses the same cutter', () => {
    seed();
    render(<CutBitChangeCard record={record('inv:a', 'inv:a')} onConfirm={() => {}} />);
    expect(screen.queryByTestId('cut-bit-change-card')).toBeNull();
  });
});
