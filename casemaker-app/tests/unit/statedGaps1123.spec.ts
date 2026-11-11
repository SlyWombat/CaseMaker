// #1123 item 56(b) — THE FIXTURE THE PLAN DOES NOT MODEL, AS SOMETHING TO CHECK.
//
// The Check row read "the bracket fixture envelope is not one of this plan's own region obstacles
// — the posted program is checked against it by the verifier and the sweep": an engine fact that
// does not tell the operator what to do. The sentence now names the fixture and states the check
// and where it happens (the dry run's moves near the arms and clamps).
import { describe, expect, it } from 'vitest';
import { fixtureUnmodelledSentence } from '@/engine/cnc/cam/model/statedGaps';

describe('#1123-56 — the unmodelled fixture says what to check, and where', () => {
  it('a bracket job names the arms and clamps and sends the check to the dry run', () => {
    expect(fixtureUnmodelledSentence('bracket')).toBe(
      "The plan does not model the bracket's arms and clamps: check the program's moves near them in the dry run — the posted program is still swept against them.",
    );
  });

  it('a vise job names the jaws', () => {
    const text = fixtureUnmodelledSentence('vise');
    expect(text).toContain("the vise's jaws");
    expect(text).toContain('in the dry run');
  });

  it('a taped blank names the bed, with the singular pronoun', () => {
    expect(fixtureUnmodelledSentence('tape')).toContain('near it in the dry run');
  });
});
