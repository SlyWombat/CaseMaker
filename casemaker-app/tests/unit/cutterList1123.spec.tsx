// @vitest-environment jsdom
/**
 * #1123 item 5 — ONE CUTTER LIST, AS ROWS.
 *
 * The bench note: on the Job panel the same cutters printed twice — under "Cutter ·" in the Job
 * block and again as the Cutter group's summary — as one paragraph of "⌀6 mm flat end · 25 mm
 * flute · …". The maintainer: "for a user a paragraph of them is not as useful as a checklist".
 * The promoted interactive checklist is #1127; this is the visible half item 5 keeps: ONE list,
 * one row per DISTINCT cutter in program order, each naming the program numbers it serves, and the
 * Job block's Cutter line collapsing to a count ("2 cutters — see the list").
 *
 * The rows never render a registry key (#930/#690b): the display name only, with the tier word
 * when two cutters share a name (#1051).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { CutterList, postedCuttersFor } from '@/components/panels/CutterList';
import { flatEndMill } from '@/engine/cnc/tool';
import { resetRegistry, setInventoryEntries, setRegistry } from '@/engine/cnc/toolRegistry';

afterEach(() => {
  cleanup();
  resetRegistry();
});

const FLAT = (name: string, d: number, flute?: number) => flatEndMill(d, { name, ...(flute === undefined ? {} : { fluteLength: flute }) });
/** A real ball-nose tool — the display name comes from the SHAPE, never the record's own name. */
const BALL = (name: string, d: number, flute: number) => ({ ...flatEndMill(d, { name, fluteLength: flute }), shape: 'ball' as const, typeText: 'Ball Nose' });
const program = (toolKey: string) => ({ toolKey }) as never;

describe('#1123 item 5 — one cutter list, one row per distinct cutter in program order', () => {
  it('lists each cutter once, in cut order, with the programs it serves', () => {
    setInventoryEntries([
      { key: 'inv:flat-6', provenance: 'test', tool: FLAT('6 mm flat end', 6, 25) },
      { key: 'inv:ball-3', provenance: 'test', tool: BALL('3.175 mm ball', 3.175, 22) },
    ]);
    const cutters = postedCuttersFor([
      program('inv:flat-6'),
      program('inv:flat-6'),
      program('inv:ball-3'),
      program('inv:flat-6'),
    ]);
    expect(cutters.map((c) => c.programs)).toEqual([[1, 2, 4], [3]]);
    expect(cutters[0]!.name).toContain('⌀ 6 mm flat end');
    expect(cutters[1]!.name).toContain('ball');
  });

  it('renders one row per cutter with its program list and display name — no keys, no paragraph', () => {
    setInventoryEntries([
      { key: 'inv:flat-6', provenance: 'test', tool: FLAT('6 mm flat end', 6, 25) },
      { key: 'inv:ball-3', provenance: 'test', tool: FLAT('3.175 mm ball', 3.175, 22) },
    ]);
    const cutters = postedCuttersFor([program('inv:flat-6'), program('inv:ball-3'), program('inv:flat-6')]);
    render(<CutterList cutters={cutters} />);
    const rows = screen.getAllByTestId('engrave-cutter-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('p01, p03');
    expect(rows[0]!.textContent).toContain('⌀ 6 mm flat end');
    expect(rows[1]!.textContent).toContain('p02');
    for (const row of rows) expect(row.textContent).not.toContain('inv:');
  });

  it('says the tier when two cutters share a display name, and only then (#1051)', () => {
    setRegistry([{ key: 'cat:abc', provenance: 'test', tool: FLAT('O-flute', 3.175, 25) }]);
    setInventoryEntries([{ key: 'inv:kz', provenance: 'test', tool: FLAT('O-flute', 3.175, 25) }]);
    const cutters = postedCuttersFor([program('inv:kz'), program('cat:abc')]);
    render(<CutterList cutters={cutters} />);
    const rows = screen.getAllByTestId('engrave-cutter-row');
    expect(rows[0]!.textContent).toContain('(inventory)');
    expect(rows[1]!.textContent).toContain('(catalogue)');
  });

  it('draws nothing when no run has posted cutters', () => {
    const { container } = render(<CutterList cutters={[]} />);
    expect(container.innerHTML).toBe('');
  });
});
