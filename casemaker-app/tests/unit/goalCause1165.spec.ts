// #1165 — THE GOAL VERDICT'S CAUSE CLASS (#1157 ruling, comment 6767626064). The verdict stays
// one line against the whole goal; what it gains is WHY it missed, from numbers the plan already
// has:
//   setup-infeasible — the share of the goal this staging can address is itself under the pass line;
//   shop-infeasible  — addressable, but a refused region's floor sits beyond the longest usable
//                      cutter reach the set has;
//   plan-shortfall   — addressable and reachable, and still not cut: the only engine defect.
// The addressable share rides beside it as a DIAGNOSTIC, never judged. A pass, or a check that
// never ran, carries no class (the receipt then has no key — Set B's passing packages stay
// byte-identical).
import { describe, expect, it } from 'vitest';

import type { PlanStatement } from '@/engine/cnc/cam/model/types';
import { goalCauseFacts, goalCauseOf } from '@/engine/cnc/engrave/goalCause';
import type { JobFinding } from '@/engine/cnc/engrave/jobSetup';

const failAt = (leftover: number): { ran: true; leftoverFractions: number[]; passCoverage: number } => ({
  ran: true,
  leftoverFractions: [leftover],
  passCoverage: 0.95,
});

const facts = (over: Partial<ReturnType<typeof goalCauseFacts>> = {}) => ({
  addressableFraction: 0.98 as number | null,
  deepestUnreachableFloorMm: null as number | null,
  longestUsableMm: null as number | null,
  ...over,
});

describe('#1165 — the cause class', () => {
  it('a fail whose own staging cannot address the goal is setup-infeasible', () => {
    // heart-gear-a as a relief: 46 % of the surface faces this setup at most.
    expect(goalCauseOf(failAt(0.1), facts({ addressableFraction: 0.46 }))).toEqual({
      causeClass: 'setup-infeasible',
      addressableFraction: 0.46,
    });
  });

  it('addressable but beyond every cutter’s reach is shop-infeasible', () => {
    const cause = goalCauseOf(failAt(0.1), facts({ deepestUnreachableFloorMm: 34.7, longestUsableMm: 22 }));
    expect(cause).toEqual({ causeClass: 'shop-infeasible', addressableFraction: 0.98 });
  });

  it('a floor within the longest usable reach is NOT shop-infeasible', () => {
    const cause = goalCauseOf(failAt(0.1), facts({ deepestUnreachableFloorMm: 20, longestUsableMm: 22 }));
    expect(cause?.causeClass).toBe('plan-shortfall');
  });

  it('addressable and reachable, and still not cut, is the plan shortfall', () => {
    expect(goalCauseOf(failAt(0.1), facts())?.causeClass).toBe('plan-shortfall');
  });

  it('a pass carries no class, and neither does a check that never ran', () => {
    expect(goalCauseOf(failAt(0.01), facts({ addressableFraction: 0.5 }))).toBeNull();
    expect(goalCauseOf({ ran: false, leftoverFractions: [], passCoverage: 0.95 }, facts())).toBeNull();
  });
});

describe('#1165 — the facts come from what the plan already stated', () => {
  const finding = (over: Partial<JobFinding>): JobFinding => ({
    severity: 'warning',
    code: 'goal-unreached',
    message: 'the top setup reproduces 46 % of the goal’s surface',
    ...over,
  });
  const statement = (over: Partial<PlanStatement>): PlanStatement => ({
    severity: 'warning',
    code: 'goal-finish-unreachable',
    text: 'not finished',
    ...over,
  } as PlanStatement);

  it('reads the top setup’s share and the deepest refused floor', () => {
    const result = goalCauseFacts(
      [finding({ goalTopFraction: 0.46 }), finding({ code: 'goal-cutter-substituted' })],
      [
        statement({ floorMm: 23.9, usableMm: 22 }),
        statement({ floorMm: 34.7, usableMm: 22 }),
        statement({ code: 'goal-rest-uncut', count: 2 }),
      ],
    );
    expect(result).toEqual({ addressableFraction: 0.46, deepestUnreachableFloorMm: 34.7, longestUsableMm: 22 });
  });

  it('states null for a staging fact the plan did not state', () => {
    expect(goalCauseFacts([], [])).toEqual({
      addressableFraction: null,
      deepestUnreachableFloorMm: null,
      longestUsableMm: null,
    });
  });
});
