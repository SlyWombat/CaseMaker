// #243 — the run-derived half of the Simulate disclaimer. Pure: every branch runs here without a
// store or a worker, so the sentence a user reads is a function of data, not of prose.

import { describe, it, expect } from 'vitest';
import { coverageDisclaimer, type SimCoverageInput, type SimSweptProgram } from '@/components/panels/simCoverage';

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

  // #724 W7 — a rotary job's workholding is the map's two keep-out bands. The sweep models no
  // solid for them, so the facts say which check DOES stand instead of naming a vise that is not
  // on the machine — and the blind-spot line must not then claim the workholding is unchecked.
  it('states a rotary job’s keep-out bands instead of a modelled vise fixture', () => {
    const s = text({ rotaryBands: { jawsMm: 3, tailstockMm: 10, tailstock: true } });
    expect(s).toContain('Checked: the tool against the stock.');
    expect(s).toContain('The jaws and the tailstock are checked as keep-out bands on the map');
    expect(s).toContain('the first 3 mm of the stick-out at the jaws');
    expect(s).toContain('the last 10 mm at the free end');
    expect(s).toContain('the findings and the verifier refuse a cut into them');
    expect(s).not.toContain('the modelled fixture');
    expect(s).not.toContain('any fixture — none is modelled');

    // No tailstock: one band, one check, and the sentence says only that.
    const noTail = text({ rotaryBands: { jawsMm: 3, tailstockMm: 10, tailstock: false } });
    expect(noTail).toContain('The jaws are checked as a keep-out band on the map — the first 3 mm');
    expect(noTail).not.toContain('the last 10 mm');
    expect(noTail).not.toContain('the tailstock');

    // A stick-out under the jaws' keep-out: the clamped figure, and no tailstock band (#724 W7
    // review) — the sentence never names a band longer than the stock.
    const shortRod = text({ rotaryBands: { jawsMm: 2, tailstockMm: 0, tailstock: false } });
    expect(shortRod).toContain('the first 2 mm of the stick-out');
    expect(shortRod).not.toContain('the first 3 mm');
    expect(shortRod).not.toContain('the tailstock');
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

// #744 — THE COVERAGE SENTENCE SPEAKS FOR THE RUN, NOT ITS FIRST FILE. Every program is swept in cut
// order on the stock the earlier ones left; a program the column engine cannot seed is re-swept from
// the blank and named; a walk that stopped says where, and never presents the rest as checked. The
// oracle's comparison is program 1's alone. A single-program caller's output is unchanged.
describe('#744 coverageDisclaimer — a run of several programs', () => {
  const swept = (label: string, over: Partial<SimSweptProgram> = {}): SimSweptProgram => ({
    label,
    outcome: 'swept',
    engine: 'exact',
    errorCount: 0,
    ...over,
  });

  it('states every program in cut order, each on the stock the earlier ones left', () => {
    const s = text({
      programs: [
        swept('the facing pass (fly-22)'),
        swept('program 1 (flat-1)'),
        swept('program 2 (inv:drill-2)', { engine: 'column' }),
      ],
      expectedPrograms: 3,
    });
    expect(s).toContain(
      'Checked: all 3 programs in the run — the facing pass (fly-22), program 1 (flat-1) and program 2 (inv:drill-2) — in cut order, each on the stock the earlier programs left, against the stock.',
    );
    // The sampled engine is named per program, not attributed to the whole run.
    expect(s).toContain('The material was swept by the sampled column engine for program 2 (inv:drill-2)');
    expect(s).toContain('Not checked:');
  });

  it('names every program the simulator could not seed, and why its result is narrower', () => {
    const s = text({
      programs: [
        swept('program 1 (flat-1)'),
        swept('program 2 (inv:drill-2)', { engine: 'column', fromBlank: true }),
      ],
      expectedPrograms: 2,
    });
    expect(s).toContain(
      'Swept from the blank: program 2 (inv:drill-2) — its engine cannot start from the material the earlier programs left, so its result covers its own cuts only.',
    );
  });

  it('names the programs whose cutters were not seeded together', () => {
    const s = text({
      programs: [
        swept('program 1 (flat-1)'),
        swept('program 2 (inv:drill-2)', { engine: 'column', fromBlank: true }),
        swept('the facing pass (fly-22)', { engine: 'column', fromBlank: true }),
      ],
      expectedPrograms: 3,
    });
    expect(s).toContain(
      'Swept from the blank: program 2 (inv:drill-2) and the facing pass (fly-22) — their engines cannot start from the material the earlier programs left, so each result covers its own cuts only.',
    );
  });

  it('never claims the whole run when the walk stopped part-way', () => {
    const s = text({
      programs: [
        swept('program 1 (flat-1)'),
        swept('program 2 (flat-4)', { errorCount: 2 }),
      ],
      expectedPrograms: 3,
    });
    expect(s).toContain(
      "Checked: 1 of the run's 3 programs — program 1 (flat-1) — in cut order, each on the stock the earlier programs left, against the stock.",
    );
    expect(s).toContain(
      'The run stopped at program 2 (flat-4) — its sweep reported 2 errors — so the program after it was not checked.',
    );
    expect(s).not.toContain('Checked: all');
  });

  it('says nothing was checked when the first program stopped the walk', () => {
    const s = text({
      programs: [swept('program 1 (flat-4)', { errorCount: 1 })],
      expectedPrograms: 2,
    });
    expect(s).not.toContain('Checked:');
    expect(s).toContain(
      'The run stopped at program 1 (flat-4) — its sweep reported an error — so the program after it was not checked.',
    );
  });

  it('scopes the oracle comparison to program 1', () => {
    const s = text({
      oracleBand: 0.1,
      programs: [swept('program 1 (flat-1)'), swept('program 2 (flat-4)')],
      expectedPrograms: 2,
    });
    expect(s).toContain('band is 0.1 mm');
    expect(s).toContain('The comparison covers program 1 only: the later programs have no predicted regions to compare.');
  });

  it('names the program whose cutter has an unmeasured shank, not program 1’s tool', () => {
    const s = text({
      codes: ['holder-unproven'],
      toolName: '3 mm flat',
      programs: [
        swept('program 1 (flat-1)'),
        swept('program 2 (flat-4)', { codes: ['holder-unproven'] }),
      ],
      expectedPrograms: 2,
    });
    expect(s).toContain('the shank of the cutter in program 2 (flat-4)');
    expect(s).not.toContain('“3 mm flat”');
  });

  it('keeps a one-program run’s sentences byte-for-byte', () => {
    const flat = coverageDisclaimer(base);
    const listed = coverageDisclaimer({
      ...base,
      programs: [swept('program 1 (flat-1)')],
      expectedPrograms: 1,
    });
    expect(listed).toEqual(flat);
    // And a list with no expected count is its own length, so it is one program too.
    expect(coverageDisclaimer({ ...base, programs: [swept('program 1 (flat-1)')] })).toEqual(flat);
  });
});
