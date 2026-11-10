// #1186 rule 6 — ONE CUTTER PER SHAPE AND DIAMETER AT THE JOB LEVEL. The maintainer at the bench:
// "a tool change that takes 5 minutes for a tool run that is 40 seconds and can be done with the
// same tool but a longer length is not useful." The tray splits ⌀6 ×15/×25, ⌀1 ×4/×7 and ball
// ×10/×22 ACROSS SETUPS (the per-setup same-diameter pick); the job-level pre-pass keeps one
// cutter per shape+diameter — the longest STATED reach — and keeps a shorter sibling only where
// the data says so: when the longest would run on a borrowed row and the shorter has its own.
import { describe, expect, it } from 'vitest';

import { flatEndMill } from '@/engine/cnc/tool';
import { mergeSiblingCutters } from '@/engine/cnc/cam/model/plan';

const flat = (id: string, diameter: number, fluteLength: number | null) =>
  flatEndMill(diameter, { id, name: `${diameter} flat ${fluteLength}`, number: 1, ...(fluteLength === null ? {} : { fluteLength }) });

describe('#1186 rule 6 — the job-level sibling merge', () => {
  it('keeps one cutter per shape and diameter: the longest stated reach', () => {
    const short = flat('short', 6, 15);
    const long = flat('long', 6, 25);
    expect(mergeSiblingCutters([short, long], () => true)).toEqual([long]);
  });

  it('keeps the shorter only where the data says so: the longest borrows, the shorter has its row', () => {
    const short = flat('short', 6, 15);
    const long = flat('long', 6, 25);
    const merged = mergeSiblingCutters([short, long], (tool) => tool.id === 'short');
    expect(merged).toEqual([long, short]);
  });

  it('leaves different diameters and different shapes untouched', () => {
    const a = flat('a', 6, 25);
    const b = flat('b', 3.175, 20);
    const ball = flatEndMill(6, { id: 'ball', name: '6 ball', number: 2, shape: 'ball', fluteLength: 30 });
    expect(mergeSiblingCutters([a, b, ball], () => true)).toEqual([a, b, ball]);
  });

  it('an unstated flute is never merged away or merged into', () => {
    const unknown = flat('unknown', 6, null);
    const long = flat('long', 6, 25);
    expect(new Set(mergeSiblingCutters([unknown, long], () => true))).toEqual(new Set([unknown, long]));
  });
});
