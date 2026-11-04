/**
 * #961 — ONE `SequenceDemand` CANNOT SERVE THE TRAY'S REAL FEATURE SPREAD. Raised on #956/#961
 * (E's run 6621584766: 6 tray pockets, 16 organizer pockets, narrowest 0.68–1.11 mm, "fits
 * neither house flat"), for C to answer — not resolved here.
 *
 * `candidateSequences` assigns ONE primary (+ rest) flat to every feature in `demand.features` at
 * once (`regionIds: pocketFeatures.map(f => f.id)`), and a primary must pass `openingRefusal`
 * against ALL of them together. The tray's real pocket spread (A's #958 pinned numbers, 6620460283)
 * mixes 70.4x12.8 slots and 3.6x7.5 channels with ~1 mm features — no single flat (house ⌀6/⌀3.175,
 * or a larger catalogue one) can be primary for a ~1 mm feature, and a flat under ~1 mm as PRIMARY
 * for the whole part would blow the 3x stop rule on the big features. `it.fails` pins this as a
 * genuine gap, not a bug in this spec: the moment C's picker serves a demand like this, this case
 * starts passing and should be promoted to `it`.
 */

import { describe, expect, it } from 'vitest';

import { candidateSequences, type CutterCandidates, type SequenceDemand } from '@/engine/cnc/cam/model/sequence';
import { flatEndMill } from '@/engine/cnc/tool';

const FLAT6 = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6' });
const FLAT3175 = flatEndMill(3.175, { number: 2, id: 'flat-3.175', name: 'flat-3.175' });

// A's #958 pinned numbers (6620460283), as SequenceFeature-shaped demand: the 6.00 slots
// (70.4 x 12.8 bbox, so minOpeningMm ~12.8), the 3.00 channels (3.6 x 7.5, minOpeningMm ~3.6), and
// the six 0.60 pockets (E's run measured these at 0.87-1.03 mm narrowest).
const TRAY_DEMAND: SequenceDemand = {
  features: [
    { id: 'slot', kind: 'pocket', minOpeningMm: 12.8, depthMm: 6 },
    { id: 'channel', kind: 'pocket', minOpeningMm: 3.6, depthMm: 3 },
    { id: 'tiny-1', kind: 'pocket', minOpeningMm: 0.95, depthMm: 0.6 },
  ],
};

const HOUSE: CutterCandidates = { house: [FLAT6, FLAT3175], catalogue: [] };

describe('#961 the tray demand, as one SequenceDemand', () => {
  it.fails('a single demand spanning 12.8 mm slots down to a ~1 mm pocket has no candidate sequence (raised for C, #956/#961)', () => {
    const candidates = candidateSequences(TRAY_DEMAND, HOUSE);
    // Today: []. The moment C's picker can serve a feature this narrow (without making it the
    // WHOLE part's primary cutter), this assertion starts passing — promote to `it`.
    expect(candidates.length).toBeGreaterThan(0);
  });

  it('removing the ~1 mm feature lets the same two house flats serve the rest (confirms the demand shape, not the picker, is the limit)', () => {
    const withoutTiny: SequenceDemand = { features: TRAY_DEMAND.features.filter((f) => f.id !== 'tiny-1') };
    const candidates = candidateSequences(withoutTiny, HOUSE);
    expect(candidates.length).toBeGreaterThan(0);
  });
});
