// #1208 (bounded, manager finding) — A RUN'S STOP-REPORT CONVERSATION MUST NOT GROW WITHOUT BOUND.
//
// The first cut appended every sent line, `?` status polls included, by copying the whole array on
// every poll: at the 2 s poll a 3 h run held ~5,400 raw status replies, copied quadratically, and
// shipped all of them in a stop report (#1147's memory-retention class). The rule now: every
// non-poll line is kept whole, and only the last N status exchanges are held, in a fixed ring.
import { describe, expect, it } from 'vitest';

import { RunTranscript } from '@/store/runTranscript';

describe('#1208 the run transcript is bounded', () => {
  it('keeps every command and the last N status exchanges, and reports how many polls it dropped', () => {
    const ring = new RunTranscript(30);
    const commands = [
      { at: 0, line: 'M851', reply: 'ok' },
      { at: 101, line: 'play /sd/gcodes/job.nc', reply: 'File size 10' },
      { at: 2501, line: 'M490.2', reply: 'ok\nDone ATC' },
      { at: 5000, line: 'abort', reply: 'ok\nAborted playing or paused file.' },
      { at: 9999, line: '$H', reply: 'ok' },
    ];
    let next = 0;
    for (let i = 0; i < 10_000; i += 1) {
      while (next < commands.length && commands[next]!.at === i) {
        ring.push(commands[next]!.line, commands[next]!.reply, false);
        next += 1;
      }
      ring.push('?', `<Run|MPos:0,0,0|P:10,${i},5>`, true);
      if (i % 100 === 0) expect(ring.pollsHeld).toBeLessThanOrEqual(ring.keepPolls);
    }

    const view = ring.view();
    // THE DROPPED COUNT IS THE REPORT'S OWN FACT, never a silent truncation.
    expect(view.droppedPolls).toBe(10_000 - 30);
    const polls = view.entries.filter((entry) => entry.line === '?');
    expect(polls).toHaveLength(30);
    expect(polls[0]!.reply).toContain('P:10,9970,5');
    expect(polls.at(-1)!.reply).toContain('P:10,9999,5');
    // COMMANDS ARE WHOLE, in order, and stay in their sent places among the kept polls.
    expect(view.entries.filter((entry) => entry.line !== '?').map((entry) => entry.line)).toEqual(
      commands.map((command) => command.line),
    );
    // THE TRANSCRIPT'S SIZE IS BOUNDED by the ring, not by how long the run went.
    expect(view.entries).toHaveLength(35);
    // `$H` was sent just before the last poll and stays exactly where it was sent.
    expect(view.entries.at(-2)!.line).toBe('$H');
    expect(view.entries.at(-1)!.line).toBe('?');
    expect(ring.pollsHeld).toBe(30);
  });

  it('a command sent after an early poll is kept where it was sent, even when those polls are dropped', () => {
    const ring = new RunTranscript(30);
    ring.push('?', 'p0', true);
    ring.push('M851', 'ok', false);
    for (let i = 1; i < 1_000; i += 1) ring.push('?', `p${i}`, true);
    expect(ring.pollsHeld).toBe(30);
    const view = ring.view();
    expect(view.entries[0]).toEqual({ line: 'M851', reply: 'ok' });
    expect(view.droppedPolls).toBe(1_000 - 30);
  });

  it('keeps every poll when the run polls fewer than N times, and drops nothing', () => {
    const ring = new RunTranscript(30);
    ring.push('play /sd/gcodes/job.nc', 'File size 10', false);
    for (let i = 0; i < 3; i += 1) ring.push('?', `p${i}`, true);
    const view = ring.view();
    expect(view.droppedPolls).toBe(0);
    expect(view.entries.map((entry) => entry.line)).toEqual(['play /sd/gcodes/job.nc', '?', '?', '?']);
  });
});
