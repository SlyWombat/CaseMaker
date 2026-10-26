// #243 — the run-derived half of the Simulate disclaimer. Pure: every branch runs here without a
// store or a worker, so the sentence a user reads is a function of data, not of prose.

import { describe, it, expect } from 'vitest';
import { coverageDisclaimer, type SimCoverageInput } from '@/components/panels/simCoverage';

const base: SimCoverageInput = {
  outcome: 'swept',
  fixtureLabels: [],
  sacrificialModelled: false,
  toolName: null,
  codes: [],
};

const text = (input: Partial<SimCoverageInput>): string => coverageDisclaimer({ ...base, ...input }).join(' ');

describe('coverageDisclaimer', () => {
  it('names the default setup’s blind spots: no fixture, and no nut until the run asks for one', () => {
    const s = text({});
    expect(s).toContain('Checked: the tool against the stock.');
    expect(s).toContain('any fixture — none is modelled');
    expect(s).toContain('the spindle body, head and gantry');
    expect(s).not.toContain('the sacrificial material');
    // #314 — the Z1's nut is unmeasured, and that alone is no longer a blind spot: the sweep
    // raises the code only where the nut could matter, and this run raised nothing.
    expect(s).not.toContain('the collet nut');
  });

  it('prints the comparison band as a §4 figure, trailing zeros dropped (#691)', () => {
    const s = text({ oracleBand: 0.1 });
    expect(s).toContain('band is 0.1 mm');
    expect(s).not.toContain('0.100');
  });

  it('names the obstacles it was given: fixture labels and sacrificial material', () => {
    const s = text({
      fixtureLabels: ['vise-jaw-front', 'vise-jaw-back'],
      sacrificialModelled: true,
      fixtureSource: 'default',
    });
    expect(s).toContain('the sacrificial material');
    expect(s).toContain('the modelled fixture (vise-jaw-front, vise-jaw-back)');
    expect(s).not.toContain('any fixture — none is modelled');
    expect(s).toContain('The modelled fixture is a shipped default.');
  });

  // #314 — the sentence is named from the run, like the shank caveat below it: the sweep raises
  // `holder-vs-fixture-unproven` only when an obstacle rises above the stock top with the nut's
  // size unstated. A vise job — the ordinary job — cannot reach that, so it says nothing.
  it('reports the collet nut only when the run needed the check and could not make it', () => {
    const needed = text({ codes: ['holder-vs-fixture-unproven'] });
    expect(needed).toContain('the collet nut, which this machine states no dimensions for');

    const viseJob = text({});
    expect(viseJob).not.toContain('the collet nut');
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
