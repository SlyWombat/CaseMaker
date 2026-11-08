/**
 * #1076 — THE GENERATOR WATCHDOG'S SENTENCE, as the app actually knows things. A sweep that goes
 * quiet is inside one synchronous geometry call: name the checkpoint the stream was in (when it
 * has one) and say the worker is alive — silence alone cannot prove a fault, and a genuinely dead
 * worker rejects its pending call by name instead.
 */

import { describe, expect, it } from 'vitest';

import { generatorStallSentence } from '@/store/engraveRunStore';

describe('#1076 the generator watchdog sentence', () => {
  it('names the checkpoint in flight when the sim stream has one, and says the worker is alive', () => {
    expect(generatorStallSentence(180_000, 'simulating', { phase: 'sweep', progress: { done: 6, total: 20 } })).toBe(
      'no checkpoint completed in 180 s — checkpoint 7 of 20 is inside one geometry call; the worker is alive',
    );
  });

  it('names no checkpoint when the stream has none, or its ticks are the rapid-move check', () => {
    expect(generatorStallSentence(180_000, 'simulating', { phase: 'sweep', progress: null })).toBe(
      'no checkpoint completed in 180 s; the worker is alive',
    );
    // The air phase's ticks are moves, not checkpoints — never read as one.
    expect(generatorStallSentence(180_000, 'simulating', { phase: 'air', progress: { done: 12, total: 35 } })).toBe(
      'no checkpoint completed in 180 s; the worker is alive',
    );
    // Every checkpoint completed: no "next" one to name.
    expect(generatorStallSentence(180_000, 'simulating', { phase: 'sweep', progress: { done: 20, total: 20 } })).toBe(
      'no checkpoint completed in 180 s; the worker is alive',
    );
  });

  it('the generate and goal-check phases keep their own words', () => {
    expect(generatorStallSentence(180_000, 'generating', { phase: null, progress: null })).toBe(
      'The generator stopped reporting for 180 s. Its worker may have stopped.',
    );
    expect(generatorStallSentence(180_000, 'checking', { phase: 'playback', progress: null })).toBe(
      'the goal check has reported nothing for 180 s; the worker is alive',
    );
  });
});
