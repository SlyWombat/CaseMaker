/**
 * #786 slice 4c-2 — AN UNPROVEN PLUNGE IS A QUESTION, AND THE HOLE IS NOT CUT UNTIL IT IS ANSWERED.
 *
 * A plunge needs a centre-cutting cutter. Nothing in the `.nc` header says so, and a generic tool
 * records `null` — unknown. The old behaviour cut the plunge anyway with a warning; now the hole is
 * LEFT OUT of the programs (everything else still posts) and the finding asks the one question:
 * "Is the ⌀3.175 mm flat end centre-cutting?" The answer is written to the cutter's own record, so
 * the question is asked once per cutter, ever. A drill bit is centre-cutting by its point and a
 * bore is helixed, so neither is asked.
 */
import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { generate } from './helpers/engravePipeline';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { validateJob } from '@/engine/cnc/engrave/jobSetup';
import type { EngraveJob } from '@/types/engraveJob';

const FLAT_KEY = 'inv:flat-3';
const FLAT: Tool = flatEndMill(3.175, { name: '3.175 mm flat end', fluteLength: 20, centreCutting: null });
const PROVEN: Tool = { ...FLAT, centreCutting: true };

const POCKET = {
  kind: 'circle' as const,
  id: 'pocket',
  name: 'pocket',
  position: { x: 40, y: 25 },
  rotation: 0,
  depth: 2,
  enabled: true,
  diameter: 10,
};
const HOLE = {
  kind: 'drill' as const,
  id: 'hole',
  position: { x: 20, y: 20 },
  rotation: 0,
  depth: 2,
  enabled: true,
  through: false,
};

function job(tool: Tool, over: Partial<EngraveJob> = {}): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    labels: [],
    shapes: [POCKET],
    drills: [HOLE],
    toolKey: FLAT_KEY,
    tool,
    ...over,
  };
}

const plungeWord = (j: EngraveJob) => validateJob(j).find((f) => f.code === 'plunge-unproven');

describe('#786 4c-2 the plunge question', () => {
  it('asks the question with the cutter’s display name, and names the withheld hole', () => {
    const finding = plungeWord(job(FLAT));
    expect(finding?.severity).toBe('warning');
    expect(finding?.message).toContain('Is the ⌀ 3.175 mm flat end centre-cutting?');
    expect(finding?.message).toContain('left out of the programs');
    expect(finding?.message).toContain('every other cut still posts');
    // Answered on the record: the question is gone.
    expect(plungeWord(job(PROVEN))).toBeUndefined();
  });

  it('does not ask about a BORE — it helixes, it does not plunge', () => {
    const bore: EngraveJob = {
      ...job(FLAT),
      drills: [{ ...HOLE, mode: 'bore', diameter: 4 }],
    };
    expect(plungeWord(bore)).toBeUndefined();
  });

  it('the pocket posts and the hole does not, until the record says centre-cutting', () => {
    // UNKNOWN: the program posts (ok) with the pocket only — the hole's disc is nowhere in the
    // prediction, because the plan withheld it before the CAM.
    const unknown = generate(tl, job(FLAT));
    expect(unknown.errors).toEqual([]);
    expect(unknown.ok, JSON.stringify(unknown.findings.map((f) => `${f.severity}:${f.code}`))).toBe(true);
    expect(unknown.programs).toHaveLength(1);
    expect(unknown.predicted.some((p) => p.itemId === HOLE.id)).toBe(false);
    expect(unknown.predicted.some((p) => p.itemId === POCKET.id)).toBe(true);

    // ANSWERED YES: the same job cuts the hole as well.
    const proven = generate(tl, job(PROVEN));
    expect(proven.ok).toBe(true);
    expect(proven.predicted.some((p) => p.itemId === HOLE.id)).toBe(true);
    expect(proven.predicted.some((p) => p.itemId === POCKET.id)).toBe(true);
  }, 60_000);
});
