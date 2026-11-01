/**
 * #786 slice 4c-2 — AN UNPROVEN PLUNGE IS A QUESTION, NOT A REFUSAL.
 *
 * A plunge needs a centre-cutting cutter. Nothing in the `.nc` header says so, and a generic tool
 * records `null` — unknown. An UNRECORDED cutter keeps the cut (#220's own rule: "a warning with
 * the uncertainty named, never a silent plunge") while the finding asks the one question: "Is the
 * ⌀3.175 mm flat end centre-cutting?" The answer is written to the cutter's own record, so the
 * question is asked once per cutter, ever. Only an ANSWERED "no" — a record that states the cutter
 * cannot plunge — leaves the hole out. A drill bit is centre-cutting by its point and a bore is
 * helixed, so neither is asked.
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
  it('asks the question with the cutter’s display name, and does not threaten the cut', () => {
    const finding = plungeWord(job(FLAT));
    expect(finding?.severity).toBe('warning');
    expect(finding?.message).toContain('Is the ⌀ 3.175 mm flat end centre-cutting?');
    expect(finding?.message).toContain('the cut posts');
    // Answered on the record: the question is gone.
    expect(plungeWord(job(PROVEN))).toBeUndefined();
  });

  it('an ANSWERED no is the only claim that leaves the hole out, and says so', () => {
    const finding = plungeWord(job({ ...FLAT, centreCutting: false }));
    expect(finding?.severity).toBe('warning');
    expect(finding?.message).toContain('recorded as NOT centre-cutting');
    expect(finding?.message).toContain('left out of the programs');
    expect(finding?.message).toContain('every other cut still posts');
  });

  it('does not ask about a BORE — it helixes, it does not plunge', () => {
    const bore: EngraveJob = {
      ...job(FLAT),
      drills: [{ ...HOLE, mode: 'bore', diameter: 4 }],
    };
    expect(plungeWord(bore)).toBeUndefined();
  });

  it('an UNKNOWN cutter cuts the plunge hole; only an ANSWERED no withholds it', () => {
    // UNKNOWN: the question is asked AND the hole is cut — the regression this pins. The first
    // version of this slice withheld it, which deleted every drill's own operation from jobs whose
    // cutter had never been asked (the engrave e2e's seven operations became six).
    const unknown = generate(tl, job(FLAT));
    expect(unknown.errors).toEqual([]);
    expect(unknown.ok, JSON.stringify(unknown.findings.map((f) => `${f.severity}:${f.code}`))).toBe(true);
    expect(unknown.findings.some((f) => f.code === 'plunge-unproven')).toBe(true);
    expect(unknown.predicted.some((p) => p.itemId === HOLE.id)).toBe(true);
    expect(unknown.predicted.some((p) => p.itemId === POCKET.id)).toBe(true);

    // ANSWERED YES: no question, the hole still cut.
    const proven = generate(tl, job(PROVEN));
    expect(proven.ok).toBe(true);
    expect(proven.findings.some((f) => f.code === 'plunge-unproven')).toBe(false);
    expect(proven.predicted.some((p) => p.itemId === HOLE.id)).toBe(true);

    // ANSWERED NO: the hole is withheld (everything else posts) and the sentence says so.
    const refused = generate(tl, job({ ...FLAT, centreCutting: false }));
    expect(refused.ok).toBe(true);
    expect(refused.predicted.some((p) => p.itemId === HOLE.id)).toBe(false);
    expect(refused.predicted.some((p) => p.itemId === POCKET.id)).toBe(true);
  }, 60_000);
});
