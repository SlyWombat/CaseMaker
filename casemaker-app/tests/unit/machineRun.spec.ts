// #423 — the run engine (`platform/machineRun.ts`): the harness's `z1.mjs run`, ported, against a FAKE
// controller and a fake clock. Nothing here reaches a machine.

import { describe, expect, it } from 'vitest';
import { STATUS_POLL_TIMING, type ConsoleSendResult } from '@/platform/machineConsole';
import { STOP_FALLBACK } from '@/platform/machineStop';
import { describeRun, playLine, programHash, programOwnsVacuum, readProgress, runProgram, runSettings, RUN_POLL_FLOOR_MS } from '@/platform/machineRun';
import { readJobProgress } from '@/platform/desktop/protocol';

const SETTINGS = { pollMs: 2000, noProgressMs: 30000, missLimit: 3 };

/**
 * A controller that answers `?` from a script (one status per poll, the last repeating), `abort` with
 * the drain reply, and everything else `ok`. A status of `null` is an unanswered poll.
 */
function fake(
  script: (string | null)[],
  opts: {
    play?: string;
    playKind?: 'timeout' | 'error';
    before?: string;
    carriedBefore?: string;
    /** How many status polls after `abort` still read Run before the queue drains (default 0). */
    drainPolls?: number;
  } = {},
) {
  let t = 0;
  const sent: { line: string; at: number }[] = [];
  let polls = 0;
  let afterPlay = false;
  let aborted = false;
  let drainLeft = 0;
  const timings: { line: string; firstReplyMs: number | undefined }[] = [];
  const ok = (text: string, carried?: string | undefined): ConsoleSendResult => ({
    kind: 'sent',
    line: '',
    text,
    frames: 1,
    elapsedMs: 1,
    ...(carried ? { carried: { text: carried, frames: 1 } } : {}),
  });
  const session = {
    async send(line: string, timing?: { firstReplyMs?: number }): Promise<ConsoleSendResult> {
      sent.push({ line, at: t });
      timings.push({ line, firstReplyMs: timing?.firstReplyMs });
      if (line === '?') {
        if (!afterPlay) return ok(opts.before ?? '<Idle|MPos:0,0,0>', opts.carriedBefore);
        if (aborted) return drainLeft-- > 0 ? ok('<Run|MPos:0,0,0|P:30,40,9>') : ok('<Idle|MPos:0,0,0>');
        const s = script[Math.min(polls++, script.length - 1)];
        return s === null || s === undefined ? { kind: 'timeout', line, detail: 'no answer', text: '' } : ok(s);
      }
      if (line.startsWith('play ')) {
        afterPlay = true;
        if (opts.playKind === 'timeout') return { kind: 'timeout', line, detail: 'no answer', text: '' };
        if (opts.playKind === 'error') return { kind: 'error', line, detail: 'socket closed' };
        return ok(opts.play ?? 'File size 791');
      }
      if (line === 'abort') {
        aborted = true;
        drainLeft = opts.drainPolls ?? 0;
        return ok('ok\nAborted playing or paused file.');
      }
      return ok('ok');
    },
  };
  return {
    session,
    sent,
    lines: () => sent.map((s) => s.line),
    timings,
    sleep: async (ms: number) => {
      t += ms;
    },
    now: () => t,
  };
}

const deps = (f: ReturnType<typeof fake>, stop = () => false) => ({
  session: f.session,
  settings: SETTINGS,
  stopRequested: stop,
  sleep: f.sleep,
  now: f.now,
});

describe('#423 before the program', () => {
  it('plays nothing on a machine that is not Idle, is in an alarm (in the reply or between lines), or does not answer', async () => {
    for (const opts of [
      { before: '<Run|MPos:0,0,0|P:10,5,3>' },
      { before: '<Alarm|MPos:0,0,0>' },
      { carriedBefore: 'ALARM: Hard limit' },
    ]) {
      const f = fake([], opts);
      const o = await runProgram('job.nc', deps(f));
      expect(o.kind).toBe('refused');
      expect(f.lines()).toEqual(['?']);
    }
  });

  it('refuses a file name that is not a playable path', () => {
    expect(playLine('job.nc')).toBe('play /sd/gcodes/job.nc');
    expect(playLine('../x.nc')).toBeNull();
    expect(playLine('a b.nc')).toBeNull();
  });
});

describe('#423 the run', () => {
  it('vacuum on, play, poll at the floor; a mid-job Idle is not the end; P 100 + Idle is; then vacuum off and home', async () => {
    const f = fake(['<Run|P:10,10,5>', '<Idle|P:29,74,20>', '<Run|P:40,90,30>', '<Idle|P:51,100,41>']);
    const polls: number[] = [];
    const o = await runProgram('job.nc', { ...deps(f), onEvent: (e) => e.kind === 'poll' && polls.push(e.progress.percent ?? -1) });
    expect(o).toMatchObject({ kind: 'finished', homed: true, vacuumOff: true });
    expect(polls).toEqual([10, 74, 90, 100]);
    expect(f.lines()).toEqual(['?', 'M331', 'play /sd/gcodes/job.nc', '?', '?', '?', '?', 'M332', '$H']);
    // Every poll at least 2000 ms after the previous send; the first one after play.
    const at = f.sent.filter((s) => s.line === '?').slice(1).map((s) => s.at);
    const playAt = f.sent.find((s) => s.line.startsWith('play'))!.at;
    expect(at[0]! - playAt).toBeGreaterThanOrEqual(RUN_POLL_FLOOR_MS);
    for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(RUN_POLL_FLOOR_MS);
    expect(describeRun(o)).toContain('homed');
  });

  it('a P field that has gone, with Idle, after being seen, is the end too', async () => {
    const f = fake(['<Run|P:10,50,5>', '<Idle|MPos:0,0,0>']);
    expect((await runProgram('job.nc', deps(f))).kind).toBe('finished');
  });

  it('a poll interval below the floor is raised to it', async () => {
    const f = fake(['<Idle|P:1,100,1>']);
    await runProgram('job.nc', { ...deps(f), settings: { ...SETTINGS, pollMs: 500 } });
    const poll = f.sent.filter((s) => s.line === '?')[1]!;
    expect(poll.at).toBeGreaterThanOrEqual(2000);
  });

  it('never started: no P field within the timeout — the vacuum it switched on goes off again', async () => {
    const f = fake(['<Idle|MPos:0,0,0>']);
    const o = await runProgram('job.nc', deps(f));
    expect(o.kind).toBe('never-started');
    expect(f.lines().at(-1)).toBe('M332');
    expect(f.lines()).not.toContain('$H');
  });

  it('three unanswered polls: unreachable — and M332 is never sent blind', async () => {
    const f = fake(['<Run|P:10,10,5>', null, null, null]);
    const o = await runProgram('job.nc', deps(f));
    expect(o.kind).toBe('unreachable');
    expect(f.lines().filter((l) => l === 'M332')).toEqual([]);
    expect(describeRun(o)).toContain('NOT stopped from here');
  });

  it('a missed poll that is followed by an answer is not a failure', async () => {
    const f = fake(['<Run|P:10,10,5>', null, '<Idle|P:20,100,9>']);
    expect((await runProgram('job.nc', deps(f))).kind).toBe('finished');
  });

  it('an alarm mid-run ends it, and nothing further is sent', async () => {
    const f = fake(['<Run|P:10,10,5>', '<Alarm|MPos:0,0,0>']);
    const o = await runProgram('job.nc', deps(f));
    expect(o.kind).toBe('alarm');
    expect(f.lines().at(-1)).toBe('?');
  });

  it('a play the controller refuses turns the vacuum back off and polls nothing', async () => {
    const f = fake([], { play: 'error: file not found' });
    const o = await runProgram('job.nc', deps(f));
    expect(o.kind).toBe('refused');
    expect(f.lines()).toEqual(['?', 'M331', 'play /sd/gcodes/job.nc', 'M332']);
  });
});

describe('#423 Stop', () => {
  it('goes out at the next poll boundary on the same session: ?, abort, Idle, M332 — and offers home, not sends it', async () => {
    let pressed = false;
    const f = fake(['<Run|P:10,10,5>', '<Run|P:12,20,7>']);
    const o = await runProgram('job.nc', {
      ...deps(f, () => pressed),
      onEvent: (e) => {
        if (e.kind === 'poll') pressed = true;
      },
    });
    expect(o.kind).toBe('aborted');
    const tail = f.lines().slice(f.lines().indexOf('abort') - 1);
    expect(tail).toEqual(['?', 'abort', '?', 'M332']);
    expect(f.lines()).not.toContain('$H');
    expect(describeRun(o)).toContain('Home the machine when the head is clear');
  });

  it('Stop before the program started plays nothing', async () => {
    const f = fake([]);
    const o = await runProgram('job.nc', deps(f, () => true));
    expect(o.kind).toBe('refused');
    expect(f.lines()).toEqual(['?']);
  });
});

describe('#423 settings and the status reader', () => {
  it('reads the run.* shop defaults, with the poll floor', () => {
    // #449 — and the status window and the Stop's polls, each its labelled fallback with no location.
    expect(runSettings(null)).toEqual({
      pollMs: 2000,
      noProgressMs: 30000,
      missLimit: 3,
      statusTiming: STATUS_POLL_TIMING,
      stop: STOP_FALLBACK,
    });
  });

  it('reads a status line exactly as protocol.ts does', () => {
    for (const line of ['<Run|MPos:1,2,3|P:120,45,30>', '<Idle|MPos:0,0,0>', '<Idle|MPos:0,0,0|P:51,100,41>', 'garbage']) {
      expect(readProgress(line)).toEqual(readJobProgress(line));
    }
  });
});

describe('#423 review — the fixes', () => {
  it('refuses Idle with a program part-way (P below 100) before play — the mid-job pause at M05', async () => {
    const f = fake([], { before: '<Idle|MPos:0,0,0|P:29,74,20>' });
    expect((await runProgram('job.nc', deps(f))).kind).toBe('refused');
    expect(f.lines()).toEqual(['?']);
  });

  it('a play that timed out or hit a socket error is NOT "not started": the watch goes on', async () => {
    for (const playKind of ['timeout', 'error'] as const) {
      const f = fake(['<Run|P:5,10,2>', '<Idle|P:9,100,5>'], { playKind });
      const o = await runProgram('job.nc', deps(f));
      expect(o.kind, playKind).toBe('finished');
      expect(f.lines().slice(0, 4)).toEqual(['?', 'M331', 'play /sd/gcodes/job.nc', '?']);
    }
  });

  it('never started on a machine that is not Idle: the vacuum is left alone', async () => {
    const f = fake(['<Run|MPos:0,0,0>']);
    const o = await runProgram('job.nc', deps(f));
    expect(o).toMatchObject({ kind: 'never-started', vacuumOff: false });
    expect(f.lines().filter((l) => l === 'M332')).toEqual([]);
  });

  it('Stop on a machine reading Run with no P (or P 100, the trip home) aborts — it never finishes or homes', async () => {
    for (const status of ['<Run|MPos:0,0,0>', '<Run|MPos:0,0,0|P:51,100,40>']) {
      let pressed = false;
      const f = fake(['<Run|P:10,10,5>', status]);
      const o = await runProgram('job.nc', {
        ...deps(f, () => pressed),
        onEvent: (e) => {
          if (e.kind === 'poll' && e.progress.percent === 10) pressed = true;
        },
      });
      expect(o.kind, status).toBe('aborted');
      expect(f.lines()).not.toContain('$H');
      expect(f.lines()).toContain('abort');
    }
  });

  it('a stop that is still draining sends no M332 and does not count as stopped', async () => {
    let pressed = false;
    const f = fake(['<Run|P:10,10,5>'], { drainPolls: 10 });
    const o = await runProgram('job.nc', {
      ...deps(f, () => pressed),
      onEvent: (e) => {
        if (e.kind === 'poll') pressed = true;
      },
    });
    expect(o).toMatchObject({ kind: 'aborted', stop: { kind: 'draining' } });
    expect(f.lines().filter((l) => l === 'M332')).toEqual([]);
    expect(describeRun(o)).toContain('emergency stop');
  });

  it('Stop’s polls keep the 2 s floor after the abort, and every Stop line is reported', async () => {
    let pressed = false;
    const reported: string[] = [];
    const f = fake(['<Run|P:10,10,5>']);
    await runProgram('job.nc', {
      ...deps(f, () => pressed),
      onEvent: (e) => {
        if (e.kind === 'poll') pressed = true;
        if (e.kind === 'sent') reported.push(e.line);
      },
    });
    const abortAt = f.sent.find((x) => x.line === 'abort')!.at;
    const next = f.sent.find((x) => x.line === '?' && x.at > abortAt)!;
    expect(next.at - abortAt).toBeGreaterThanOrEqual(2000);
    expect(reported.slice(-4)).toEqual(['?', 'abort', '?', 'M332']);
  });

  it('every status poll asks for a SHORT reply window, not the console’s 60 s', async () => {
    const f = fake(['<Run|P:10,10,5>', '<Idle|P:20,100,9>']);
    await runProgram('job.nc', deps(f));
    for (const t of f.timings.filter((x) => x.line === '?')) expect(t.firstReplyMs).toBeLessThanOrEqual(3000);
  });

  it('Stop before any progress was seen, on an Idle machine, is NOT a finish: nothing further is sent', async () => {
    const f = fake(['<Idle|MPos:0,0,0>']);
    const o = await runProgram('job.nc', deps(f, () => f.lines().includes('play /sd/gcodes/job.nc')));
    expect(o.kind).toBe('stopped-unconfirmed');
    expect(f.lines().filter((l) => l === 'M332' || l === '$H' || l === 'abort')).toEqual([]);
    expect(describeRun(o)).toContain('the vacuum is still on');
  });

  it('a Stop pressed during the poll that would have given up is still sent', async () => {
    let pressed = false;
    const f = fake(['<Run|P:10,10,5>', null, null, null, '<Run|P:12,20,7>']);
    const o = await runProgram('job.nc', {
      ...deps(f, () => pressed),
      onEvent: (e) => {
        if (e.kind === 'missed' && e.misses === 3) pressed = true;
      },
    });
    expect(f.lines()).toContain('abort');
    expect(o.kind).toBe('aborted');
  });

  it('the unanswered pre-play poll and the program hash', async () => {
    const f = fake([], { before: '<Idle|MPos:0,0,0>' });
    const silent = { ...f.session, send: async () => ({ kind: 'timeout', line: '?', detail: 'x', text: '' }) as ConsoleSendResult };
    expect((await runProgram('job.nc', { ...deps(f), session: silent })).kind).toBe('refused');
    expect(programHash('G0 X1')).toBe(programHash('G0 X1'));
    expect(programHash('G0 X1')).not.toBe(programHash('G0 X2'));
  });
});

// #419 Q-E — the vacuum belongs to the FILE once #419's post puts the words in it: the first file
// turns it on, the last turns it off, and a multi-tool job keeps it running across the bit change
// (the maintainer's 2026-10-16 bench note). The runner's own bracket stays as the fallback for a
// file that carries no words — anything posted before #419, or uploaded from elsewhere.
describe('#419 Q-E — the program owns the vacuum, or the runner brackets it', () => {
  it('reads the words in the program text', () => {
    expect(programOwnsVacuum('G21\nM331\nG0 X0\nM332\nM2\n')).toBe(true);
    expect(programOwnsVacuum('G21\nM332\nM2\n')).toBe(true);
    expect(programOwnsVacuum('M02\n')).toBe(false);
    expect(programOwnsVacuum('; M331 in a comment only\nM02\n')).toBe(false); // never switch the vacuum on a comment
    expect(programOwnsVacuum('  M332\n')).toBe(true);
    expect(programOwnsVacuum(null)).toBe(false);
    expect(programOwnsVacuum(undefined)).toBe(false);
  });

  it('a program that owns the words is not bracketed, and the run log says why', async () => {
    const f = fake(['<Run|P:10,20,5>', '<Idle|P:9,100,4>']);
    const notes: string[] = [];
    const o = await runProgram('job.nc', {
      ...deps(f),
      programOwnsVacuum: true,
      onEvent: (e) => e.kind === 'note' && notes.push(e.text),
    });
    expect(o.kind).toBe('finished');
    if (o.kind !== 'finished') return;
    expect(o.vacuumOwner).toBe('program');
    expect(f.lines().filter((l) => l === 'M331' || l === 'M332')).toEqual([]);
    // …but the file is still played and the machine is still homed.
    expect(f.lines()).toContain('play /sd/gcodes/job.nc');
    expect(f.lines().at(-1)).toBe('$H');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('switches the vacuum itself');
    expect(describeRun(o)).toContain('The program switched the vacuum off itself');
  });

  it('a refused play leaves nothing to switch off either', async () => {
    const f = fake([], { play: 'Error: file not found' });
    const o = await runProgram('job.nc', { ...deps(f), programOwnsVacuum: true });
    expect(o.kind).toBe('refused');
    expect(f.lines().filter((l) => l === 'M331' || l === 'M332')).toEqual([]);
  });

  it('a program that never started switches nothing either way, and says so', async () => {
    const f = fake(['<Idle|MPos:0,0,0>']);
    const o = await runProgram('job.nc', { ...deps(f), programOwnsVacuum: true });
    expect(o.kind).toBe('never-started');
    expect(f.lines().filter((l) => l === 'M331' || l === 'M332')).toEqual([]);
    expect(describeRun(o)).toContain('nothing was switched either way');
  });

  it('without the flag — any file that does not carry the words — the runner still brackets it', async () => {
    const f = fake(['<Run|P:10,20,5>', '<Idle|P:9,100,4>']);
    const o = await runProgram('job.nc', deps(f));
    expect(o.kind).toBe('finished');
    if (o.kind !== 'finished') return;
    expect(o.vacuumOwner).toBe('runner');
    expect(f.lines().slice(0, 3)).toEqual(['?', 'M331', 'play /sd/gcodes/job.nc']);
    expect(f.lines().at(-2)).toBe('M332');
  });
});

// #564 — the antistatic (static-removal) device. The run switches it on for plastic jobs only,
// beside the vacuum, and off at the run's end — the finish AND the abort — exactly once. The
// program never carries `M331.4`/`M332.4`, so this run is the only thing that switches it.
describe('#564 — the antistatic runs for plastic jobs only', () => {
  it('a plastic job switches it on at the start and off at the finish, beside the vacuum', async () => {
    const f = fake(['<Run|P:10,10,5>', '<Idle|P:51,100,41>']);
    const o = await runProgram('job.nc', { ...deps(f), antistatic: true });
    expect(o).toMatchObject({ kind: 'finished', vacuumOff: true, antistaticOff: true });
    expect(f.lines()).toEqual(['?', 'M331', 'M331.4', 'play /sd/gcodes/job.nc', '?', '?', 'M332', 'M332.4', '$H']);
  });

  it('a non-plastic job emits no antistatic words anywhere', async () => {
    const f = fake(['<Run|P:10,10,5>', '<Idle|P:51,100,41>']);
    const o = await runProgram('job.nc', deps(f));
    expect(o.kind).toBe('finished');
    expect(f.lines().filter((l) => l === 'M331.4' || l === 'M332.4')).toEqual([]);
  });

  it('a plastic job whose program owns the vacuum words still brackets the antistatic itself', async () => {
    const f = fake(['<Run|P:10,20,5>', '<Idle|P:9,100,4>']);
    const o = await runProgram('job.nc', { ...deps(f), programOwnsVacuum: true, antistatic: true });
    expect(o).toMatchObject({ kind: 'finished', antistaticOff: true });
    // No vacuum words (the program owns them) — but the antistatic is the run's, on and off.
    expect(f.lines().filter((l) => l === 'M331' || l === 'M332')).toEqual([]);
    expect(f.lines()).toEqual(['?', 'M331.4', 'play /sd/gcodes/job.nc', '?', '?', 'M332.4', '$H']);
  });

  it('an aborted plastic job still switches the antistatic off', async () => {
    let pressed = false;
    const f = fake(['<Run|P:10,10,5>', '<Run|P:12,20,7>']);
    const o = await runProgram('job.nc', {
      ...deps(f, () => pressed),
      antistatic: true,
      onEvent: (e) => {
        if (e.kind === 'poll') pressed = true;
      },
    });
    expect(o.kind).toBe('aborted');
    if (o.kind !== 'aborted') return;
    expect(o.stop.kind).toBe('stopped');
    if (o.stop.kind !== 'stopped') return;
    expect(o.stop.vacuumOff).toBe(true);
    expect(o.stop.antistaticOff).toBe(true);
    const tail = f.lines().slice(f.lines().indexOf('abort') - 1);
    expect(tail).toEqual(['?', 'abort', '?', 'M332', 'M332.4']);
    expect(describeRun(o)).toContain('antistatic off');
  });

  it('a play the controller refuses switches the antistatic back off too', async () => {
    const f = fake([], { play: 'error: file not found' });
    const o = await runProgram('job.nc', { ...deps(f), antistatic: true });
    expect(o.kind).toBe('refused');
    expect(f.lines()).toEqual(['?', 'M331', 'M331.4', 'play /sd/gcodes/job.nc', 'M332', 'M332.4']);
  });

  it('never started on an Idle machine: the antistatic this run switched on goes off again', async () => {
    const f = fake(['<Idle|MPos:0,0,0>']);
    const o = await runProgram('job.nc', { ...deps(f), antistatic: true });
    expect(o).toMatchObject({ kind: 'never-started', vacuumOff: true, antistaticOff: true });
    expect(f.lines().at(-2)).toBe('M332');
    expect(f.lines().at(-1)).toBe('M332.4');
    expect(f.lines()).not.toContain('$H');
  });
});
