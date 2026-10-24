// #618 — the one function the bench corrects: the suspend/resume words and their reply windows.
// Studio sends BARE `suspend` / `resume` on the run's own console (RE 05); what the firmware does
// to the spindle, the vacuum and Z is still the bench's question, so this spec pins only what the
// decompile says and fails loudly if the sequence moves without a deliberate edit here.

import { describe, it, expect } from 'vitest';
import { pauseResumeCommands } from '@/platform/machinePause';

describe('#618 — the suspend/resume sequence, in one place', () => {
  it('suspends and resumes with Studio’s bare words, in the same console as play/abort', () => {
    expect(pauseResumeCommands('suspend').lines).toEqual(['suspend']);
    expect(pauseResumeCommands('resume').lines).toEqual(['resume']);
  });

  it('gives each word the abort’s window: the controller drains its queue before it answers', () => {
    for (const action of ['suspend', 'resume'] as const) {
      const { timing } = pauseResumeCommands(action);
      expect(timing.firstReplyMs).toBe(60_000);
      expect(timing.maxMs).toBe(60_000);
    }
  });
});
