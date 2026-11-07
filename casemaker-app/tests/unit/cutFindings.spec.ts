// #960 — THE OPERATOR'S WORDS FOR A FINDING. One pure module, so the run sheet, the panel and the
// receipt cannot describe the same uncut feature differently.

import { describe, expect, it } from 'vitest';

import {
  cutFindingSentences,
  unreachableSentence,
  unplannedSentence,
  type UnplannedStepFinding,
} from '@/engine/cnc/engrave/cutFindings';

const step = (over: Partial<UnplannedStepFinding> = {}): UnplannedStepFinding => ({
  kind: 'rest',
  cutterKey: 'flat-3.175',
  regionIds: ['pocket-3', 'pocket-4'],
  reason: 'the rest op planned nothing for its regions',
  ...over,
});

describe('#960 unplanned steps, in the operator’s words', () => {
  it('a failed pocket or rest step names its regions and what was going to happen', () => {
    expect(unplannedSentence(step())).toBe(
      'pocket-3, pocket-4: not cut — the rest op planned nothing for its regions',
    );
  });

  it('a failed freeing contour is "part not freed", not another uncut pocket', () => {
    expect(unplannedSentence(step({ kind: 'contour', regionIds: ['contour'], reason: 'the contour op refused' }))).toBe(
      'part not freed: the contour op refused',
    );
  });

  it('a failed rough/finish/pencil step speaks of finishing; a failed chamfer of the rim', () => {
    expect(unplannedSentence(step({ kind: 'rough', regionIds: ['scoop'], reason: 'rough() refused this curved remainder' }))).toBe(
      'scoop: not finished — rough() refused this curved remainder',
    );
    expect(unplannedSentence(step({ kind: 'finish', regionIds: ['scoop'], reason: 'no scallop fits' }))).toBe(
      'scoop: not finished — no scallop fits',
    );
    expect(unplannedSentence(step({ kind: 'chamfer', regionIds: ['rim'], reason: 'the bit is too wide' }))).toBe(
      'rim: rim not broken — the bit is too wide',
    );
  });

  it('a step with no regions still states its reason, without a dangling colon', () => {
    expect(unplannedSentence(step({ regionIds: [] }))).toBe(
      'not cut: the rest op planned nothing for its regions',
    );
  });
});

describe('#960 unreachable features, in the operator’s words', () => {
  it('names the limiting cutter width and the set the plan priced', () => {
    expect(unreachableSentence('pocket-34', 1.108, '⌀6, ⌀3.175')).toBe(
      'pocket-34: not cut — needs a cutter ≤ 1.11 mm (house offers ⌀6, ⌀3.175)',
    );
  });

  it('a feature with no measured width, or no offered set, states only what it knows', () => {
    expect(unreachableSentence('slot', null, '⌀6')).toBe('slot: not cut');
    expect(unreachableSentence('slot', 2.5)).toBe('slot: not cut — needs a cutter ≤ 2.50 mm');
  });
});

describe('#960 the plan’s whole finding list', () => {
  it('lists the unreachable features first, then one line per failed step, in order', () => {
    expect(
      cutFindingSentences(
        ['pocket-9: not cut — needs a cutter ≤ 0.95 mm', 'contour: not cut'],
        [step(), step({ kind: 'contour', regionIds: ['contour'], reason: 'the contour op refused' })],
      ),
    ).toEqual([
      'pocket-9: not cut — needs a cutter ≤ 0.95 mm',
      'contour: not cut',
      'pocket-3, pocket-4: not cut — the rest op planned nothing for its regions',
      'part not freed: the contour op refused',
    ]);
  });
});
