/**
 * #964 — THE SEVEN-LINE SCORER'S RULES (plan v2 §3).
 *
 * These tests are the rule book: one case per line, the exact boundary each line allows, and the
 * two honest non-answers — an unreferenced card (no vendor program beside ours, never a pass) and
 * a line whose input was not measured (cut-into before a checker adjudicates it, and the
 * posted-as-filed line with no record). The scorer is pure arithmetic over measured numbers; this
 * spec does not touch an engine, a mesh or a vendor file, so it runs in T1-lite in milliseconds.
 */

import { describe, expect, it } from 'vitest';

import { PLAN_V2_RULES, scoreSevenLines, type ProgramScore, type SevenLineCard } from '../tools/sevenLines';

const VENDOR = (over: Partial<ProgramScore> = {}): ProgramScore => ({
  label: 'Makera Studio',
  coverage: 0.995,
  cutInto: {
    adjudicatedFraction: 0,
    edgeBreakFraction: 0.0366,
    wallNotScoredFraction: 0.003,
    shadowNotScoredFraction: 0.0245,
    rawFraction: 0.0685,
    maxMm: 0.45,
  },
  cycleSeconds: 47.6 * 60,
  toolChanges: 0,
  headerTimeSeconds: 47.6 * 60,
  vendorHolding: "Makera's own: bare bed, tape-down",
  airFraction: 0.15,
  rapidsPer1000FeedLines: 8,
  cutters: 4,
  cuttersOwned: null,
  postsAsFiled: null,
  ...over,
});

const OURS = (over: Partial<ProgramScore> = {}): ProgramScore => ({
  label: 'Case Maker',
  coverage: 0.99,
  cutInto: {
    adjudicatedFraction: 0,
    edgeBreakFraction: 0,
    wallNotScoredFraction: 0,
    shadowNotScoredFraction: 0,
    rawFraction: 0.001,
    maxMm: 0.05,
  },
  cycleSeconds: 45 * 60,
  toolChanges: 0,
  headerTimeSeconds: null,
  airFraction: 0.2,
  rapidsPer1000FeedLines: 10,
  cutters: 3,
  cuttersOwned: true,
  postsAsFiled: { ok: true, holding: 'vise', pitchMm: 0.1 },
  ...over,
});

const score = (ours: ProgramScore = OURS(), vendor: ProgramScore | null = VENDOR(), rules?: Record<string, number>): SevenLineCard =>
  scoreSevenLines({ card: 'tray70-top', ours, vendor, ...(rules === undefined ? {} : { rules }) });

const line = (card: SevenLineCard, key: string) => {
  const found = card.lines.find((l) => l.key === key);
  if (found === undefined) throw new Error(`no line ${key}`);
  return found;
};

describe('#964 the seven lines — a card that passes', () => {
  it('scores a good card as seven passing lines, in plan order', () => {
    const card = score();
    expect(card.referenced).toBe(true);
    expect(card.pass).toBe(true);
    expect(card.failing).toEqual([]);
    expect(card.lines.map((l) => l.key)).toEqual([
      'coverage',
      'cutInto',
      'cycle',
      'air',
      'rapids',
      'cutters',
      'postsAsFiled',
    ]);
    expect(card.lines.map((l) => l.number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(card.sentence).toContain('Passes the seven lines');
    expect(line(card, 'cycle').goalMet).toBe(true);
  });

  it('prints both sides in the units the page uses', () => {
    const card = score();
    expect(line(card, 'coverage').ours).toBe('99.00 %');
    expect(line(card, 'coverage').vendor).toBe('99.50 %');
    expect(line(card, 'cycle').ours).toBe('45.0 min');
    expect(line(card, 'air').ours).toBe('20.00 %');
    expect(line(card, 'cutters').ours).toBe('3');
    expect(line(card, 'postsAsFiled').ours).toContain('vise');
  });
});

describe('#964 line 1 — coverage ≥ vendor − 1 point and ≥ 95 %', () => {
  it('passes exactly at vendor − 1 point', () => {
    const card = score(OURS({ coverage: 0.985 }));
    expect(line(card, 'coverage').state).toBe('pass');
  });

  it('fails a tenth of a point below the allowance', () => {
    const card = score(OURS({ coverage: 0.9849 }));
    expect(line(card, 'coverage').state).toBe('fail');
    expect(line(card, 'coverage').note).toContain('trails the vendor');
  });

  it('fails below the shop pass line even when the vendor is no better', () => {
    const card = score(OURS({ coverage: 0.9 }), VENDOR({ coverage: 0.9 }));
    expect(line(card, 'coverage').state).toBe('fail');
    expect(line(card, 'coverage').note).toContain('pass line');
  });

  it('reads the pass line from the caller’s rule (the shop default)', () => {
    expect(PLAN_V2_RULES.passCoverage).toBe(0.95);
    const card = score(OURS({ coverage: 0.96 }), VENDOR(), { passCoverage: 0.97 });
    expect(line(card, 'coverage').state).toBe('fail');
    expect(line(card, 'coverage').rule).toContain('97.00 %');
  });

  it('STATES the line when the card carries no coverage measurement — never zero', () => {
    const card = score(OURS({ coverage: null }));
    expect(line(card, 'coverage').state).toBe('stated');
    expect(line(card, 'coverage').ours).toBe('not measured');
    expect(card.pass).toBe(false);
  });
});

describe('#964 line 2 — cut-into at the 0.1 mm floor, exclusions printed', () => {
  it('passes zero after edge break, wall cells and wall shadow are excluded, and prints them', () => {
    const card = score(
      OURS({
        cutInto: {
          adjudicatedFraction: 0,
          edgeBreakFraction: 0.0366,
          wallNotScoredFraction: 0.003,
          shadowNotScoredFraction: 0.0245,
          rawFraction: 0.0685,
          maxMm: 0.45,
        },
      }),
    );
    expect(line(card, 'cutInto').state).toBe('pass');
    expect(line(card, 'cutInto').note).toContain('edge break');
    expect(line(card, 'cutInto').note).toContain('wall cells');
    expect(line(card, 'cutInto').note).toContain('wall shadow');
    expect(line(card, 'cutInto').ours).toContain('3.66 %');
  });

  it('fails any judged share above the floor — a gouge away from a wall is still a gouge', () => {
    const card = score(
      OURS({
        cutInto: {
          adjudicatedFraction: 0.001,
          edgeBreakFraction: 0.0366,
          wallNotScoredFraction: 0.003,
          shadowNotScoredFraction: 0.0245,
          rawFraction: 0.07,
          maxMm: 0.45,
        },
      }),
    );
    expect(line(card, 'cutInto').state).toBe('fail');
    expect(line(card, 'cutInto').note).toContain('0.10 %');
  });

  it('STATES the line when the checker has not applied the rule — never a default zero', () => {
    const card = score(
      OURS({
        cutInto: {
          adjudicatedFraction: null,
          edgeBreakFraction: null,
          wallNotScoredFraction: null,
          shadowNotScoredFraction: null,
          rawFraction: 0.0685,
          maxMm: 23,
        },
      }),
    );
    expect(line(card, 'cutInto').state).toBe('stated');
    expect(line(card, 'cutInto').note).toContain('not applied');
    expect(card.pass).toBe(false);
  });

  it('names the 0.1 mm floor in the rule', () => {
    expect(line(score(), 'cutInto').rule).toContain('0.1 mm floor');
  });
});

describe('#964 line 3 — cycle ≤ 2× the vendor’s, goal 1.25×', () => {
  it('passes exactly at 2×', () => {
    const card = score(OURS({ cycleSeconds: 2 * VENDOR().cycleSeconds }));
    expect(line(card, 'cycle').state).toBe('pass');
    expect(line(card, 'cycle').goalMet).toBe(false);
  });

  it('fails one second over 2×', () => {
    const card = score(OURS({ cycleSeconds: 2 * VENDOR().cycleSeconds + 1 }));
    expect(line(card, 'cycle').state).toBe('fail');
    expect(line(card, 'cycle').note).toContain('2.');
  });

  it('marks the 1.25× goal when met', () => {
    const card = score(OURS({ cycleSeconds: 1.25 * VENDOR().cycleSeconds }));
    expect(line(card, 'cycle').goalMet).toBe(true);
    expect(line(card, 'cycle').note).toContain('goal');
  });

  it('counts manual bit changes as real machine time on both sides', () => {
    // Equal cutting time; ours needs 40 changes, the vendor none — the changes take it past 2×.
    const card = score(OURS({ toolChanges: 40 }), VENDOR({ cycleSeconds: 45 * 60, toolChanges: 0 }));
    const cycle = line(card, 'cycle');
    expect(cycle.state).toBe('fail');
    expect(cycle.oursValue).toBe(45 * 60 + 40 * 91.4);
    expect(cycle.note).toContain('bit changes');
    // The same change count on both sides leaves the comparison unchanged.
    const level = score(OURS({ toolChanges: 40 }), VENDOR({ cycleSeconds: 45 * 60, toolChanges: 40 }));
    expect(line(level, 'cycle').state).toBe('pass');
  });

  it('never uses Makera’s header TIME as the reference — it is a printed fact', () => {
    // The vendor's own file costs 60 min under our estimator but its header claims 10 min.
    // Our 60 min cutting is level with the file; judged against the header it would be 6×.
    const card = score(OURS({ cycleSeconds: 60 * 60 }), VENDOR({ cycleSeconds: 60 * 60, headerTimeSeconds: 10 * 60 }));
    const cycle = line(card, 'cycle');
    expect(cycle.state).toBe('pass');
    expect(cycle.vendorValue).toBe(60 * 60);
    expect(cycle.note).toContain('header TIME');
    expect(cycle.note).toContain('10.0 min');
  });
});

describe('#964 line 4 — air fraction ≤ vendor + 10 points', () => {
  it('passes exactly at +10 points', () => {
    const card = score(OURS({ airFraction: 0.25 }), VENDOR({ airFraction: 0.15 }));
    expect(line(card, 'air').state).toBe('pass');
  });

  it('fails a hundredth of a point above', () => {
    const card = score(OURS({ airFraction: 0.2501 }), VENDOR({ airFraction: 0.15 }));
    expect(line(card, 'air').state).toBe('fail');
  });
});

describe('#964 line 5 — rapids per 1,000 feed lines ≤ 2×', () => {
  it('passes exactly at 2×', () => {
    const card = score(OURS({ rapidsPer1000FeedLines: 16 }), VENDOR({ rapidsPer1000FeedLines: 8 }));
    expect(line(card, 'rapids').state).toBe('pass');
  });

  it('fails above 2×', () => {
    const card = score(OURS({ rapidsPer1000FeedLines: 16.01 }), VENDOR({ rapidsPer1000FeedLines: 8 }));
    expect(line(card, 'rapids').state).toBe('fail');
  });

  it('passes only zero against a vendor file with none', () => {
    expect(line(score(OURS({ rapidsPer1000FeedLines: 0 }), VENDOR({ rapidsPer1000FeedLines: 0 })), 'rapids').state).toBe('pass');
    expect(line(score(OURS({ rapidsPer1000FeedLines: 1 }), VENDOR({ rapidsPer1000FeedLines: 0 })), 'rapids').state).toBe('fail');
  });
});

describe('#964 line 6 — cutters ≤ vendor + 1, owned for a bench card', () => {
  it('passes at vendor + 1', () => {
    const card = score(OURS({ cutters: 5 }), VENDOR({ cutters: 4 }));
    expect(line(card, 'cutters').state).toBe('pass');
  });

  it('fails at vendor + 2', () => {
    const card = score(OURS({ cutters: 6 }), VENDOR({ cutters: 4 }));
    expect(line(card, 'cutters').state).toBe('fail');
  });

  it('fails a bench card using a cutter the location does not own, whatever the count', () => {
    const card = score(OURS({ cutters: 1, cuttersOwned: false }), VENDOR({ cutters: 4 }));
    expect(line(card, 'cutters').state).toBe('fail');
    expect(line(card, 'cutters').note).toContain('location owns');
  });

  it('does not judge ownership for a demo card (null)', () => {
    const card = score(OURS({ cuttersOwned: null }));
    expect(line(card, 'cutters').state).toBe('pass');
  });
});

describe('#964 line 7 — posts as filed', () => {
  it('passes when the record states it posted at the card’s holding and pitch', () => {
    expect(line(score(), 'postsAsFiled').state).toBe('pass');
  });

  it('prints BOTH holdings on every card — ours and the vendor’s stated one (#943)', () => {
    const card = score();
    expect(card.holding.ours).toBe('vise');
    expect(card.holding.vendor).toBe("Makera's own: bare bed, tape-down");
    // An unreferenced card still prints its own holding; the vendor side is literally absent.
    const alone = score(OURS(), null);
    expect(alone.holding.ours).toBe('vise');
    expect(alone.holding.vendor).toBeNull();
  });

  it('never lets a TAPE card claim “as filed” — the line passes only in the vise (#943)', () => {
    const card = score(
      OURS({
        postsAsFiled: {
          ok: false,
          holding: 'tape',
          pitchMm: 0.1,
          note: "'posts as filed' means the vise with jaw clearance (#943); this card is a tape-down plan",
        },
      }),
    );
    expect(line(card, 'postsAsFiled').state).toBe('fail');
    expect(line(card, 'postsAsFiled').ours).toContain('no — tape');
    expect(line(card, 'postsAsFiled').ours).not.toMatch(/^yes —/);
    expect(line(card, 'postsAsFiled').rule).toContain('vise with jaw clearance');
  });

  it('fails when the run refused or changed the pitch', () => {
    const card = score(
      OURS({ postsAsFiled: { ok: false, holding: 'vise', pitchMm: 0.2, note: 'goal-program-too-big' } }),
    );
    expect(line(card, 'postsAsFiled').state).toBe('fail');
    expect(line(card, 'postsAsFiled').ours).toContain('goal-program-too-big');
  });

  it('STATES the line when the card carries no posting record', () => {
    const card = score(OURS({ postsAsFiled: null }));
    expect(line(card, 'postsAsFiled').state).toBe('stated');
    expect(card.pass).toBe(false);
  });
});

describe('#964 — unreferenced cards', () => {
  it('never passes without a vendor program, and says so', () => {
    const card = score(OURS(), null);
    expect(card.referenced).toBe(false);
    expect(card.pass).toBe(false);
    expect(card.sentence).toContain('Unreferenced');
    // The lines that compare against the vendor are stated; the two that judge OUR program on
    // its own (cut-into, posts as filed) are still judged, and the card still cannot pass.
    for (const key of ['coverage', 'cycle', 'air', 'rapids', 'cutters']) {
      expect(line(card, key).state).toBe('stated');
    }
    expect(line(card, 'cutInto').state).toBe('pass');
    expect(line(card, 'postsAsFiled').state).toBe('pass');
  });

  it('keeps the vendor-dependent keys in the failing list', () => {
    const card = score(OURS(), null);
    expect(card.failing).toContain('coverage');
    expect(card.failing).toContain('cycle');
    expect(card.failing).not.toContain('postsAsFiled');
  });
});

describe('#964 — a failing card names its lines in words', () => {
  it('lists every non-passing line in the sentence', () => {
    const card = score(
      OURS({
        coverage: 0.8,
        cycleSeconds: 10 * 3600,
        airFraction: 0.6,
        rapidsPer1000FeedLines: 400,
        cutters: 9,
      }),
    );
    expect(card.pass).toBe(false);
    expect(card.failing).toEqual(['coverage', 'cycle', 'air', 'rapids', 'cutters']);
    expect(card.sentence).toContain('Deviates');
    expect(card.sentence).toContain('cycle time');
  });
});
