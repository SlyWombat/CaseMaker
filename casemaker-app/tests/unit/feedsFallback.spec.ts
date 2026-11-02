// The feeds fallback: a cutter the material's starting table has no row AT ITS DIAMETER for is
// cut on the nearest band of its kind, labelled "starting values for <material>, not measured for
// this cutter" — never refused while a row of that kind exists. Refused, and said plainly, only
// when the material has no row of that kind at any diameter (then Manage › Feeds is named).

import { describe, expect, it } from 'vitest';
import { feedsFor, type FeedCatalogueRow } from '@/engine/cnc/feeds';
import { flatEndMill } from '@/engine/cnc/tool';
import { Z1 } from '@/engine/cnc/machine';

/** The 30° × tip mm engraving bit — the V row's own kind. */
function vBit30(tip: number) {
  return flatEndMill(tip, {
    name: `Engraving bit 30 x ${tip}`,
    typeText: 'Engraving',
    shape: 'engraving',
    tipDiameter: tip,
    diameter: 3.175,
    halfAngle: 15,
    angle: 30,
  });
}

describe('the feeds fallback', () => {
  it('feeds a 6 mm flat in hardwood from the nearest band, labelled not measured for this cutter', () => {
    // Hardwood's flat rows stop at 3.2 mm: a 6 mm flat had no row and was refused.
    const res = feedsFor([], 'hardwood', flatEndMill(6), Z1);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.provenance).toContain('Starting values for hardwood, not measured for this cutter');
    expect(res.provenance).toContain('1.6–3.2 mm');
    // The row's numbers stand, and the diameter-dependent fields scale the way the table's do.
    expect(res.params.rpm).toBe(12000);
    expect(res.params.feed).toBe(400);
    expect(res.params.stepOver).toBeCloseTo(res.entry.params.stepOverFraction * 6, 9);
    expect(res.params.peck).toBeCloseTo(6, 9);
  });

  it('answers for an owned cutter whose catalogue rows are other materials', () => {
    // A ⌀0.6 cutter is below hardwood's finest flat band (0.8–1.6); its own Makera rows are
    // carbon-fibre and PCB. That is advice, not a veto on the material's starting values.
    const tool = flatEndMill(0.6, { id: '122111013890', name: 'owned 0.6 mm corn', typeText: 'Corn' });
    const rows: FeedCatalogueRow[] = [
      { cutterId: '122111013890', material: 'Carbon Fiber', rpm: 9000, feed: 300, plungeFeed: 100, stepDown: 0.3 } as FeedCatalogueRow,
    ];
    const res = feedsFor(rows, 'hardwood', tool, Z1);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.provenance).toContain('Starting values for hardwood, not measured for this cutter');
  });

  it('refuses only when no row of the kind exists, and names Manage › Feeds', () => {
    // The starting table has no V row for hardwood at any diameter.
    const res = feedsFor([], 'hardwood', vBit30(0.3), Z1);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain('no V-bit row for hardwood at any diameter');
    expect(res.reason).toContain('Manage › Feeds');
  });
});
