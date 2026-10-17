// The jaw check before the text faces are parsed (#488 review).
//
// `validateJob` is called from the Engrave panel's RENDER, and that render can beat the effect
// that fetches the project's faces (#180) — it did, on the wizard's own path, where the setup
// flow takes over the moment the project is made. A `resolveFont` throw there unmounted the panel
// and took 14 Playwright specs with it. The rule the module now keeps: the COMPILE path still
// throws on an unparsed face (a program is never cut from an estimate), while the collision check
// reads `inkBoxOf`'s documented upper-bound box, so it errs strict instead of skipping or crashing.
//
// Vitest has every bundled face parsed (`tests/setup/fonts.ts`), so the cold cache is made here by
// stubbing the registry's `resolveFont` alone. That is the one seam both paths go through, which is
// what makes this evidence about the shipped behaviour rather than about a fixture.

import { describe, it, expect, vi } from 'vitest';

vi.mock('@/engine/fonts/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/engine/fonts/registry')>();
  return {
    ...actual,
    resolveFont: () => {
      throw new Error(
        'bundled font "Barlow-Bold" is not loaded — call ensureFontsLoaded() with the project\'s font keys before resolving it (issue #180)',
      );
    },
  };
});

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { toPartPlan, sweptCuts } from '@/engine/cnc/engrave/partPlan';
import { validateJob } from '@/engine/cnc/engrave/jobSetup';

/** The demo job, with its one line moved near the fixed jaw — #488's own near-jaw position. */
function nearJaw() {
  const job = defaultEngraveJob();
  job.workholding.vise.stockProud = 2.5;
  job.workholding.vise.source = 'saved';
  job.labels = [{ ...job.labels[0]!, position: { x: 24, y: 43 } }];
  return job;
}

describe('a label whose face is not parsed yet (#488 review)', () => {
  it('still throws on the COMPILE path, because a program is never cut from an estimate', () => {
    expect(() => toPartPlan(nearJaw())).toThrow(/is not loaded/);
  });

  it('answers the jaw check with the estimated box, so the panel renders and the check still runs', () => {
    const job = nearJaw();
    // The sweep reads the estimate rather than throwing…
    const cuts = sweptCuts(job);
    expect(cuts).toHaveLength(1);
    expect(cuts[0]!.box.minX).toBeLessThan(job.labels[0]!.position.x);
    // …and the refusal is still raised, naming the line: an estimate that can only over-state the
    // extent errs strict, which is the safe direction for a collision check.
    const collision = validateJob(job).find((f) => f.code === 'vise-jaw-collision');
    expect(collision?.severity).toBe('error');
    expect(collision?.labelId).toBe(job.labels[0]!.id);
  });
});
