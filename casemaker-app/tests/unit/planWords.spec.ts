// #963 — the model plan's operator words. The fixture is the tray's plan (#955): its counts and
// clock are the ones the Makerables card used, so a reader can hold the sentence against the card.

import { describe, expect, it } from 'vitest';
import {
  countPockets,
  featureSentence,
  linkingSentence,
  progressWords,
  sequenceSentence,
  type PlanPocketLike,
} from '@/engine/cnc/engrave/planWords';
import { fixtureSetupPlan } from './fixtures/setupPlan';

const pocket = (children: PlanPocketLike[] = []): PlanPocketLike => ({ children });

describe('#963 the plan, in the operator’s words', () => {
  it('counts a pocket’s nested pockets with its roots', () => {
    expect(countPockets([pocket([pocket(), pocket()]), pocket()])).toBe(4);
  });

  it('names the tray’s features the way the card lists them', () => {
    const plan = fixtureSetupPlan();
    expect(featureSentence(plan.features)).toBe('6 pockets, 1 outer contour, 1 curved region');
  });

  it('omits a zero count rather than printing it, and singularises one', () => {
    expect(featureSentence({ pockets: [pocket()], contour: {}, remainder: [] })).toBe(
      '1 pocket, 1 outer contour',
    );
    expect(featureSentence({ pockets: [], contour: {}, remainder: [{}] })).toBe(
      '1 outer contour, 1 curved region',
    );
  });

  it('states the sequence at each cutter’s own cost and the total, and marks a pinned cutter', () => {
    const plan = fixtureSetupPlan();
    plan.sequence[3] = { ...plan.sequence[3]!, pinned: true };
    expect(
      sequenceSentence(
        plan.sequence.map((s, i) => ({ label: ['⌀6 flat', '⌀3.175 flat', '⌀6 ball', '90° chamfer'][i]!, cost: s.cost, pinned: s.pinned })),
        plan.totalCostSeconds,
      ),
    ).toBe(
      '⌀6 flat (18 min) → ⌀3.175 flat (11 min) → ⌀6 ball (15 min) → 90° chamfer (3 min, pinned) — about 47 min 30 s',
    );
  });

  it('says nothing for a sequence that chose nothing', () => {
    expect(sequenceSentence([], 0)).toBeNull();
  });

  it('states the linking facts, the air share to one decimal', () => {
    const plan = fixtureSetupPlan();
    expect(linkingSentence(plan.linking)).toBe('384 rapids, 12 hops, 3.2 % of the cycle in air');
    expect(linkingSentence({ rapidsCount: 1, hopsCount: 1, airFractionPct: 0 })).toBe(
      '1 rapid, 1 hop, 0 % of the cycle in air',
    );
    expect(linkingSentence({ rapidsCount: 7889, hopsCount: 0, airFractionPct: 43 })).toBe(
      '7,889 rapids, 0 hops, 43 % of the cycle in air',
    );
  });

  it('names the stage the plan is in, with its percentage', () => {
    expect(progressWords({ setupIndex: 0, op: 'features', fraction: 0.4 })).toBe('Recognising the features — 40 %');
    expect(progressWords({ setupIndex: 0, op: 'finish', fraction: 0.8 })).toBe('Finishing — 80 %');
    expect(progressWords({ setupIndex: 1, op: 'linking', fraction: 1 })).toBe('Joining the passes — 100 %');
  });
});
