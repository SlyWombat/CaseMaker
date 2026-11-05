/**
 * #961 — THE OPERATOR'S PLAN CHOICE ON THE JOB (#961's card slice, step 3).
 *
 * The card's tradeoff control writes `planChoice`; `planChoiceOf` reads it with the OWNED plan as
 * the default. `'owned'` is stored as ABSENCE — a job with no choice keeps following the default
 * the rule states — and `'ideal'` is recorded on the document, round-tripping through Zod.
 */

import { describe, expect, it } from 'vitest';

import { useEngraveJobStore } from '@/store/engraveJobStore';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { engraveJobDocumentSchema } from '@/store/engraveJobSchema';
import { planChoiceOf } from '@/types/engraveJob';

describe('#961 the operator’s plan choice', () => {
  it('records the ideal choice and writes the owned default as absence', () => {
    useEngraveJobStore.getState().replace(defaultEngraveJob());
    expect(planChoiceOf(useEngraveJobStore.getState().job)).toBe('owned');

    useEngraveJobStore.getState().setPlanChoice('ideal');
    expect(useEngraveJobStore.getState().job.planChoice).toBe('ideal');
    expect(planChoiceOf(useEngraveJobStore.getState().job)).toBe('ideal');

    useEngraveJobStore.getState().setPlanChoice('owned');
    expect(useEngraveJobStore.getState().job.planChoice).toBeUndefined();
    expect(planChoiceOf(useEngraveJobStore.getState().job)).toBe('owned');
  });

  it('round-trips the chosen plan through the document schema', () => {
    useEngraveJobStore.getState().replace(defaultEngraveJob());
    useEngraveJobStore.getState().setPlanChoice('ideal');
    const parsed = engraveJobDocumentSchema.parse(JSON.parse(JSON.stringify(useEngraveJobStore.getState().job))) as {
      planChoice?: string;
    };
    expect(parsed.planChoice).toBe('ideal');
  });
});
