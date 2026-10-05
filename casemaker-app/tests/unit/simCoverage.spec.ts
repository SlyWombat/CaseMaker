// #243 — the run-derived half of the Simulate disclaimer. Pure: every branch runs here without a
// store or a worker, so the sentence a user reads is a function of data, not of prose.

import { describe, it, expect } from 'vitest';
import { coverageDisclaimer, type SimCoverageInput } from '@/components/panels/simCoverage';

const base: SimCoverageInput = {
  outcome: 'swept',
  fixtureLabels: [],
  sacrificialModelled: false,
  holderKnown: false,
  toolName: null,
  codes: [],
};

const text = (input: Partial<SimCoverageInput>): string => coverageDisclaimer({ ...base, ...input }).join(' ');

describe('coverageDisclaimer', () => {
  it('names the default setup’s blind spots: no fixture, an unmeasured collet nut', () => {
    const s = text({});
    expect(s).toContain('Checked: the tool against the stock.');
    expect(s).toContain('any fixture — none is modelled');
    expect(s).toContain('the collet nut, which this machine states no dimensions for');
    expect(s).toContain('the spindle body, head and gantry');
    expect(s).not.toContain('the sacrificial material');
  });

  it('names the obstacles it was given: fixture labels and sacrificial material', () => {
    const s = text({
      fixtureLabels: ['vise-jaw-front', 'vise-jaw-back'],
      sacrificialModelled: true,
      fixtureSource: 'default',
      holderKnown: true,
    });
    expect(s).toContain('the sacrificial material');
    expect(s).toContain('the modelled fixture (vise-jaw-front, vise-jaw-back)');
    expect(s).not.toContain('any fixture — none is modelled');
    expect(s).toContain('The modelled fixture is a shipped default, not a measurement.');
  });

  it('drops the collet-nut caveat when the machine states a holder', () => {
    const s = text({ holderKnown: true });
    expect(s).not.toContain('the collet nut');
  });

  it('names the tool whose shank length is unproven, from the run’s own code', () => {
    const s = text({ codes: ['holder-unproven'], toolName: '3 mm flat' });
    expect(s).toContain('the shank of “3 mm flat” above the cutter');
    expect(s).toContain('no shoulder or flute length');
  });

  it('says a path-only run checked nothing but the path', () => {
    const sentences = coverageDisclaimer({ ...base, outcome: 'path-only' });
    expect(sentences).toHaveLength(1);
    expect(sentences[0]).toContain('path-only');
    expect(sentences[0]).toContain('no fixture, holder or material geometry was checked');
  });

  it('says a refused run swept nothing', () => {
    const sentences = coverageDisclaimer({ ...base, outcome: 'refused' });
    expect(sentences).toHaveLength(1);
    expect(sentences[0]).toContain('Nothing was swept');
  });
});
