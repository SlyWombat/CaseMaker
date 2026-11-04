// #963 — the model plan's operator words. The tray's numbers are the ones the Makerables
// comparison used (#955), so a reader can hold the sentence against the card.

import { describe, expect, it } from 'vitest';
import {
  countPockets,
  featureSentence,
  linkingSentence,
  sequenceSentence,
  type PlanPocketLike,
} from '@/engine/cnc/engrave/planWords';

const pocket = (children: PlanPocketLike[] = []): PlanPocketLike => ({ children });

describe('#963 the plan, in the operator’s words', () => {
  it('counts a pocket’s nested pockets with its roots', () => {
    expect(countPockets([pocket([pocket(), pocket()]), pocket()])).toBe(4);
  });

  it('names the tray’s features the way the card lists them', () => {
    const sentence = featureSentence({
      pockets: Array.from({ length: 6 }, () => pocket()),
      contour: {},
      remainder: [{}],
    });
    expect(sentence).toBe('6 pockets, 1 outer contour, 1 curved region');
  });

  it('omits a zero count rather than printing it, and singularises one', () => {
    expect(featureSentence({ pockets: [pocket()], contour: {}, remainder: [] })).toBe(
      '1 pocket, 1 outer contour',
    );
    expect(featureSentence({ pockets: [], contour: {}, remainder: [{}] })).toBe(
      '1 outer contour, 1 curved region',
    );
  });

  it('states the sequence with its cost, and marks a pinned cutter', () => {
    expect(
      sequenceSentence(
        [
          { label: '⌀6 flat' },
          { label: '⌀3.175 flat' },
          { label: '⌀6 ball' },
          { label: '90° chamfer', pinned: true },
        ],
        47.6 * 60,
      ),
    ).toBe('⌀6 flat → ⌀3.175 flat → ⌀6 ball → 90° chamfer (pinned) — about 47 min 36 s');
  });

  it('says nothing for a sequence that chose nothing', () => {
    expect(sequenceSentence([], 0)).toBeNull();
  });

  it('states the linking facts, the air share to one decimal', () => {
    expect(linkingSentence({ rapidsCount: 384, hopsCount: 12, airFractionPct: 3.24 })).toBe(
      '384 rapids, 12 hops, 3.2 % of the cycle in air',
    );
    expect(linkingSentence({ rapidsCount: 1, hopsCount: 1, airFractionPct: 0 })).toBe(
      '1 rapid, 1 hop, 0 % of the cycle in air',
    );
    expect(linkingSentence({ rapidsCount: 7889, hopsCount: 0, airFractionPct: 43 })).toBe(
      '7,889 rapids, 0 hops, 43 % of the cycle in air',
    );
  });
});
