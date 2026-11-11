// #1102 item 8 — the run sheet states a taped blank that is pushed into the bracket's corner, with
// the anchor the bracket is on and the tape numbers from the job and the shop's registry.

import { describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { defaultTapeHold } from '@/engine/cnc/engrave/jobSetup';
import { buildRunSheet } from '@/engine/cnc/engrave/runSheet';
import type { BedFence, EngraveJob } from '@/types/engraveJob';

const GENERATED = { findings: [], feeds: null, cam: null, nc: '', verify: null, frameNc: null } as const;

function fenced(anchor: 1 | 2): EngraveJob {
  const fence: BedFence = { kind: 'bracket', anchor, variant: 'thin', edges: 'corner' };
  return { ...defaultEngraveJob(), workholding: { kind: 'tape', tape: { ...defaultTapeHold(), where: null, squareTo: 'fence', fence } } };
}
const stepsOf = (job: EngraveJob, options = {}): string =>
  buildRunSheet(job, GENERATED, null, new Date(), undefined, options)
    .sections.flatMap((s) => s.steps.map((step) => step.text))
    .join('\n');

describe('#1102 the run sheet of a taped blank located against the bracket', () => {
  it('says taped to the bed and pushed into the bracket corner at anchor 1, with the shop’s strip count', () => {
    expect(stepsOf(fenced(1), { tapeStripCount: 5 })).toContain(
      'Taped to the bed — 5 strips of the 20 mm tape, 2 mm in from every edge; pushed into the bracket’s corner at anchor 1.',
    );
  });

  it('names the anchor the bracket is on (2), in the pin step and the corner step too', () => {
    const text = stepsOf(fenced(2), { tapeStripCount: 5 });
    expect(text).toContain('pushed into the bracket’s corner at anchor 2.');
    expect(text).toContain('at anchor 2');
    expect(text).not.toContain('at anchor 1');
  });

  it('without a strip count in hand the sentence leaves the count out rather than inventing one', () => {
    expect(stepsOf(fenced(1))).toContain(
      'Taped to the bed — the 20 mm tape, 2 mm in from every edge; pushed into the bracket’s corner at anchor 1.',
    );
  });

  it('an unfenced taped job keeps its own steps', () => {
    const job = { ...defaultEngraveJob(), workholding: { kind: 'tape' as const, tape: defaultTapeHold() } };
    const text = stepsOf(job, { tapeStripCount: 5 });
    expect(text).not.toContain('Taped to the bed —');
    expect(text).toContain('Lay strips of 20 mm double-sided tape across the bed');
  });
});
