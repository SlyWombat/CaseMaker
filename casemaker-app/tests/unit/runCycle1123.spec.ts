/**
 * #1123 item 6 — ONE CYCLE FIGURE, ONE SOURCE.
 *
 * The bench note: the Job panel's Ready card said "about 1 h 22 min" while the Cut step's tradeoff
 * line said "cycle 122.8 → 63.1 min" — one run, two cycle figures on two screens (82 vs 122.8).
 * The Ready card read the FIRST program's `cam.estimatedSeconds`; the tradeoff compares the
 * PLANS' own outcomes (`PlanOutcome.cycleSeconds`, every program plus the plan's tool changes).
 * The fix: the run's cycle is the plan outcome's number wherever the app states it, and the
 * per-program summary is only a fallback for a result that states no outcome.
 */
import { describe, expect, it } from 'vitest';

import { runCycleSeconds } from '@/engine/cnc/engrave/runCycle';

describe('#1123 item 6 — the run’s cycle comes from one place', () => {
  it('prefers the plan outcome — the same number the tradeoff line compares', () => {
    expect(runCycleSeconds({ plan: { outcome: { cycleSeconds: 7_368 } }, cam: { estimatedSeconds: 4_920 } })).toBe(7_368);
  });

  it('falls back to the program summary only when the result states no plan outcome', () => {
    expect(runCycleSeconds({ plan: null, cam: { estimatedSeconds: 86 } })).toBe(86);
    expect(runCycleSeconds({ plan: { outcome: null }, cam: { estimatedSeconds: 86 } })).toBe(86);
  });

  it('states nothing when neither source has a number', () => {
    expect(runCycleSeconds(null)).toBeNull();
    expect(runCycleSeconds({ plan: { outcome: null }, cam: null })).toBeNull();
  });
});
