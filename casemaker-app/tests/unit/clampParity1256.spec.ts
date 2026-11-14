/**
 * #1256 — `clamp.refuseFraction` IS ONE NUMBER FOR THE PICK AND THE CUT. A location that changes it
 * changes the measured pick's refusal and the generator's refusal the same way for the same cutter
 * (the #1237 defect is the pick and the cut disagreeing about a setting), and a location that
 * changes nothing leaves both exactly where they were.
 */
import { describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { materialRefusal } from '@/engine/cnc/engrave/cutterPlan';
import { engraveFeedsFor } from '@/engine/cnc/engrave/feeds';
import { candidateRefusals } from '@/engine/cnc/engrave/smartPick';
import { feedCatalogueRows, type FeedsEntry } from '@/engine/cnc/feeds';
import { CLAMP_REFUSE_FRACTION_FALLBACK, Z1 } from '@/engine/cnc/machine';
import { flatEndMill } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { ShopDefaults } from '@/platform/defaultsClient';

const set = (value: number): ShopDefaults =>
  ({ 'clamp.refuseFraction': { value, source: 'chosen', setAt: null, unit: null, note: null } }) as ShopDefaults;

const tool = flatEndMill(3.175);
const entry = { key: 'inv:flat-3175', tool, provenance: 'owned' } as ToolLibraryEntry;
/** The shop's own row for this cutter in softwood: a feed 20 % past the machine's ceiling. */
const table: FeedsEntry[] = [
  {
    material: 'softwood',
    minDiameter: 3,
    maxDiameter: 3.5,
    params: { rpm: 12000, feed: Z1.maxCutFeed * 1.2, plungeFeed: 200, stepDown: 1, stepOverFraction: 0.4, peckFraction: 0.25, air: false } as FeedsEntry['params'],
    status: 'measured',
    provenance: 'fixture — a row past the ceiling',
  },
];
const job = { ...defaultEngraveJob(), stock: { length: 60, width: 40, thickness: 6, material: 'softwood' as const } };
const catalogue = feedCatalogueRows();

/** What the pick says about the cutter, and what the cut says, under one settings map. */
function both(defaults: ShopDefaults | null): { pickRefuses: boolean; candidateRefuses: boolean; cutRefuses: boolean } {
  // The SAME settings map goes to the pick, the candidate list and the cut; nothing is passed apart from it.
  const pick = materialRefusal(job, entry, catalogue, defaults, null, table, { ownedVouches: true });
  const candidate = candidateRefusals(job, [entry], catalogue, defaults, null, table)[0]!;
  const cut = engraveFeedsFor({ feeds: table }, catalogue, defaults, job.stock.material, tool, Z1, undefined);
  return { pickRefuses: pick !== null, candidateRefuses: candidate.reason !== undefined && candidate.shapeOnly !== true && /refuses|ceiling|feed/.test(candidate.reason), cutRefuses: !cut.ok };
}

describe('#1256 clamp.refuseFraction — the pick and the cut agree', () => {
  it('at the recommendation (no location, or the seeded value) nothing moves, and pick and cut agree', () => {
    const none = both(null);
    expect(both(set(CLAMP_REFUSE_FRACTION_FALLBACK))).toEqual(none);
    expect(none.pickRefuses).toBe(none.cutRefuses);
  });

  it('a tighter band changes the pick’s refusal and the cut’s the same way for the same cutter', () => {
    const base = both(null);
    const tight = both(set(0.1));
    expect(tight.pickRefuses).toBe(tight.cutRefuses);
    expect(tight.candidateRefuses).toBe(tight.cutRefuses);
    // The setting must have moved the answer, or this test proves nothing.
    expect([tight.pickRefuses, tight.cutRefuses]).not.toEqual([base.pickRefuses, base.cutRefuses]);
  });
});
