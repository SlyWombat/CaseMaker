// #423 — the run engine (`platform/machineRun.ts`): the harness's `z1.mjs run`, ported, against a FAKE
// controller and a fake clock. Nothing here reaches a machine.

import { describe, expect, it } from 'vitest';
import { STATUS_POLL_TIMING, type ConsoleSendResult, type ConsoleTiming } from '@/platform/machineConsole';
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
    expect(f.lines()).toEqual(['?', 'M851', 'play /sd/gcodes/job.nc', '?', '?', '?', '?', 'M852', '$H']);
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
    expect(f.lines().at(-1)).toBe('M852');
    expect(f.lines()).not.toContain('$H');
  });

  it('three unanswered polls: unreachable — and M852 is never sent blind', async () => {
    const f = fake(['<Run|P:10,10,5>', null, null, null]);
    const o = await runProgram('job.nc', deps(f));
    expect(o.kind).toBe('unreachable');
    expect(f.lines().filter((l) => l === 'M852')).toEqual([]);
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
    expect(f.lines()).toEqual(['?', 'M851', 'play /sd/gcodes/job.nc', 'M852']);
  });
});

describe('#423 Stop', () => {
  it('goes out at the next poll boundary on the same session: ?, abort, Idle, M852 — and offers home, not sends it', async () => {
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
    expect(tail).toEqual(['?', 'abort', '?', 'M852']);
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
      expect(f.lines().slice(0, 4)).toEqual(['?', 'M851', 'play /sd/gcodes/job.nc', '?']);
    }
  });

  it('never started on a machine that is not Idle: the vacuum is left alone', async () => {
    const f = fake(['<Run|MPos:0,0,0>']);
    const o = await runProgram('job.nc', deps(f));
    expect(o).toMatchObject({ kind: 'never-started', vacuumOff: false });
    expect(f.lines().filter((l) => l === 'M852')).toEqual([]);
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

  it('a stop that is still draining sends no M852 and does not count as stopped', async () => {
    let pressed = false;
    const f = fake(['<Run|P:10,10,5>'], { drainPolls: 10 });
    const o = await runProgram('job.nc', {
      ...deps(f, () => pressed),
      onEvent: (e) => {
        if (e.kind === 'poll') pressed = true;
      },
    });
    expect(o).toMatchObject({ kind: 'aborted', stop: { kind: 'draining' } });
    expect(f.lines().filter((l) => l === 'M852')).toEqual([]);
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
    expect(reported.slice(-4)).toEqual(['?', 'abort', '?', 'M852']);
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
    expect(f.lines().filter((l) => l === 'M852' || l === '$H' || l === 'abort')).toEqual([]);
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
    expect(f.lines().filter((l) => l === 'M851' || l === 'M852')).toEqual([]);
    // …but the file is still played and the machine is still homed.
    expect(f.lines()).toContain('play /sd/gcodes/job.nc');
    expect(f.lines().at(-1)).toBe('$H');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('carries its own M331/M332');
    expect(describeRun(o)).toContain('The program owns the vacuum words');
  });

  it('a refused play leaves nothing to switch off either', async () => {
    const f = fake([], { play: 'Error: file not found' });
    const o = await runProgram('job.nc', { ...deps(f), programOwnsVacuum: true });
    expect(o.kind).toBe('refused');
    expect(f.lines().filter((l) => l === 'M851' || l === 'M852')).toEqual([]);
  });

  it('a program that never started switches nothing either way, and says so', async () => {
    const f = fake(['<Idle|MPos:0,0,0>']);
    const o = await runProgram('job.nc', { ...deps(f), programOwnsVacuum: true });
    expect(o.kind).toBe('never-started');
    expect(f.lines().filter((l) => l === 'M851' || l === 'M852')).toEqual([]);
    expect(describeRun(o)).toContain('nothing was switched either way');
  });

  it('without the flag — any file that does not carry the words — the runner still brackets it', async () => {
    const f = fake(['<Run|P:10,20,5>', '<Idle|P:9,100,4>']);
    const o = await runProgram('job.nc', deps(f));
    expect(o.kind).toBe('finished');
    if (o.kind !== 'finished') return;
    expect(o.vacuumOwner).toBe('runner');
    expect(f.lines().slice(0, 3)).toEqual(['?', 'M851', 'play /sd/gcodes/job.nc']);
    expect(f.lines().at(-2)).toBe('M852');
  });
});

// #1060 — the spindle blower (Makera's Auto Blow, M811/M812) follows the vacuum: on when the
// run switches the vacuum on, off BEFORE the vacuum's own off, at the finish and at an abort. The
// program never carries the sub-codes, so this run is the only thing that switches it.
describe('#1060 — the spindle blower follows the vacuum', () => {
  it('on with the vacuum at the start, off before it at the finish', async () => {
    const f = fake(['<Run|P:10,10,5>', '<Idle|P:51,100,41>']);
    const o = await runProgram('job.nc', { ...deps(f), blow: true });
    expect(o).toMatchObject({ kind: 'finished', vacuumOff: true, blowOff: true });
    expect(f.lines()).toEqual(['?', 'M851', 'M811', 'play /sd/gcodes/job.nc', '?', '?', 'M812', 'M852', '$H']);
  });

  it('the option off sends neither word; an air:false job (span none) neither', async () => {
    const off = fake(['<Run|P:10,10,5>', '<Idle|P:51,100,41>']);
    await runProgram('job.nc', deps(off));
    expect(off.lines().filter((l) => l === 'M811' || l === 'M812')).toEqual([]);
    const airless = fake(['<Run|P:10,10,5>', '<Idle|P:51,100,41>']);
    await runProgram('job.nc', { ...deps(airless), blow: true, vacuumSpan: 'none' });
    expect(airless.lines().filter((l) => l === 'M811' || l === 'M812' || l === 'M851' || l === 'M852')).toEqual([]);
  });

  it('a program-owned vacuum still gets the run’s blower bracket, and the blow goes off before its own M852 is never sent', async () => {
    const f = fake(['<Run|P:10,20,5>', '<Idle|P:9,100,4>']);
    const o = await runProgram('job.nc', { ...deps(f), programOwnsVacuum: true, blow: true });
    expect(o).toMatchObject({ kind: 'finished', blowOff: true });
    // The program owns M851/M852; the blower is the run's, bracketing it.
    expect(f.lines().filter((l) => l === 'M851' || l === 'M852')).toEqual([]);
    expect(f.lines()).toEqual(['?', 'M811', 'play /sd/gcodes/job.nc', '?', '?', 'M812', '$H']);
  });

  // #1123 item 41 — THE SPAN IS RE-ASSERTED ON EVERY (RE)START. A job-owned span's middle file
  // carries no word at all, and a retry after an alarm starts a controller whose outputs are off
  // (finding 38: the first attempt's M851 died with the alarm, and the retry ran dry). So the run
  // states M851 (and the blower) before EVERY program of a span that wants the vacuum on —
  // idempotent when it is already on — and leaves the switch-off to the span's end.
  it('a three-file job-owned span re-states the vacuum and blower on every program, and switches off only at the end', async () => {
    // File 1 (span 'first'): the vacuum goes on and STAYS on across the bit change — the blower
    // stays on with it, so this file's finish must not send M812.
    const first = fake(['<Run|P:10,10,5>', '<Idle|P:51,100,41>']);
    const f1 = await runProgram('job.nc', { ...deps(first), blow: true, vacuumSpan: 'first', programOwnsVacuum: true });
    expect(f1.kind).toBe('finished');
    expect(first.lines().filter((l) => l === 'M851')).toHaveLength(1);
    expect(first.lines()).toContain('M811');
    expect(first.lines()).not.toContain('M812');
    expect(first.lines()).not.toContain('M852');
    // File 2 (span 'middle'): the vacuum is already on, and the run RE-STATES it anyway — the same
    // words the maintainer sent by hand before every program at the bench.
    const middle = fake(['<Run|P:10,10,5>', '<Idle|P:51,100,41>']);
    const f2 = await runProgram('job.nc', { ...deps(middle), blow: true, vacuumSpan: 'middle', programOwnsVacuum: true });
    expect(f2.kind).toBe('finished');
    expect(middle.lines().filter((l) => l === 'M851')).toHaveLength(1);
    expect(middle.lines().filter((l) => l === 'M811')).toHaveLength(1);
    expect(middle.lines()).not.toContain('M812');
    expect(middle.lines()).not.toContain('M852');
    // File 3 (span 'last'): re-stated at the start; the vacuum's own M852 is in the file, so the
    // blower goes off after it, in the finish — the run never sends its own M852.
    const last = fake(['<Run|P:10,10,5>', '<Idle|P:51,100,41>']);
    const f3 = await runProgram('job.nc', { ...deps(last), blow: true, vacuumSpan: 'last', programOwnsVacuum: true });
    expect(f3.kind).toBe('finished');
    expect(last.lines().filter((l) => l === 'M851')).toHaveLength(1);
    expect(last.lines().filter((l) => l === 'M811')).toHaveLength(1);
    // #1123 item 41 — THE SPAN'S END SWITCHES OFF HERE: the file's own M332 is an auto mode the
    // controller ignores, so the run's M812/M852 are the span's last words.
    expect(last.lines()).toContain('M812');
    expect(last.lines()).toContain('M852');
  });

  it('#1123 item 41 — a play refused after a job-span file re-stated its M851 switches it off again', async () => {
    const f = fake([], { play: 'error: file not found' });
    const o = await runProgram('job.nc', { ...deps(f), vacuumSpan: 'first', programOwnsVacuum: true });
    expect(o.kind).toBe('refused');
    const lines = f.lines();
    // The run stated the vacuum on (the span's re-assert) and the file never played: the run
    // undoes its own word rather than leaving the vacuum on with nothing cutting.
    expect(lines).toContain('M851');
    expect(lines).toContain('M852');
    expect(lines.indexOf('M851')).toBeLessThan(lines.indexOf('M852'));
  });

  it('a Stop during a middle file turns the blower off before the vacuum, though this file sent neither', async () => {
    let pressed = false;
    const f = fake(['<Run|P:10,10,5>', '<Run|P:12,20,7>']);
    // The program's own per-line progress; press Stop after the first poll boundary.
    const sleep = async (): Promise<void> => {
      pressed = true;
    };
    const o = await runProgram('job.nc', {
      ...deps(f),
      blow: true,
      vacuumSpan: 'middle',
      programOwnsVacuum: true,
      stopRequested: () => pressed,
      sleep,
    });
    expect(o.kind).toBe('aborted');
    const lines = f.lines();
    expect(lines).toContain('M812');
    expect(lines.indexOf('M812')).toBeLessThan(lines.indexOf('M852'));
  });

  it('a refused play turns the blower off before the vacuum it switched on', async () => {
    const f = fake([], { play: 'error: file not found' });
    const o = await runProgram('job.nc', { ...deps(f), blow: true });
    expect(o.kind).toBe('refused');
    const lines = f.lines();
    expect(lines).toContain('M812');
    expect(lines.indexOf('M812')).toBeLessThan(lines.indexOf('M852'));
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
    expect(f.lines()).toEqual(['?', 'M851', 'M331.4', 'play /sd/gcodes/job.nc', '?', '?', 'M852', 'M332.4', '$H']);
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
    expect(f.lines().filter((l) => l === 'M851' || l === 'M852')).toEqual([]);
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
    expect(tail).toEqual(['?', 'abort', '?', 'M852', 'M332.4']);
    expect(describeRun(o)).toContain('antistatic off');
  });

  it('a play the controller refuses switches the antistatic back off too', async () => {
    const f = fake([], { play: 'error: file not found' });
    const o = await runProgram('job.nc', { ...deps(f), antistatic: true });
    expect(o.kind).toBe('refused');
    expect(f.lines()).toEqual(['?', 'M851', 'M331.4', 'play /sd/gcodes/job.nc', 'M852', 'M332.4']);
  });

  it('never started on an Idle machine: the antistatic this run switched on goes off again', async () => {
    const f = fake(['<Idle|MPos:0,0,0>']);
    const o = await runProgram('job.nc', { ...deps(f), antistatic: true });
    expect(o).toMatchObject({ kind: 'never-started', vacuumOff: true, antistaticOff: true });
    expect(f.lines().at(-2)).toBe('M852');
    expect(f.lines().at(-1)).toBe('M332.4');
    expect(f.lines()).not.toContain('$H');
  });
});

describe('#618 pause / resume', () => {
  /**
   * A watch that suspends after the first progress poll and resumes when the suspend lands. The
   * script is the bench's open question made explicit: after the suspend the controller reports
   * `Idle` with NO `P:` — which is the finish rule — so a paused run that reads it as finished has
   * failed this test.
   */
  it('suspends at a boundary, does not read the suspended Idle as a finish, resumes, and finishes', async () => {
    const f = fake(['<Run|P:40,40,10>', '<Idle|MPos:0,0,0>', '<Idle|MPos:0,0,0>', '<Run|P:60,60,20>', '<Idle|P:60,100,30>']);
    let ask: 'suspend' | 'resume' | null = null;
    const events: string[] = [];
    const o = await runProgram('job.nc', {
      ...deps(f),
      takePauseRequest: () => {
        const a = ask;
        ask = null;
        return a;
      },
      onEvent: (e) => {
        events.push(e.kind);
        if (e.kind === 'poll' && e.progress.percent === 40) ask = 'suspend';
        if (e.kind === 'paused') ask = 'resume';
      },
    });

    expect(o).toMatchObject({ kind: 'finished', homed: true });
    const lines = f.lines();
    expect(lines).toContain('suspend');
    expect(lines).toContain('resume');
    expect(lines.indexOf('suspend')).toBeLessThan(lines.indexOf('resume'));
    // The suspended Idle did NOT end the run: all five scripted polls were taken before the finish.
    expect(lines.filter((l) => l === '?')).toHaveLength(6); // the gate poll + five watches
    expect(events).toContain('paused');
    expect(events).toContain('resumed');
    // The suspend's reply is waited for with the abort's generous window, not a status poll's.
    expect(f.timings.find((t) => t.line === 'suspend')?.firstReplyMs).toBe(60_000);
  });

  it('a Stop while paused ends the job without recording a finish', async () => {
    const f = fake(['<Run|P:40,40,10>', '<Idle|MPos:0,0,0>', '<Idle|MPos:0,0,0>']);
    let ask: 'suspend' | 'resume' | null = null;
    let pressed = false;
    const o = await runProgram('job.nc', {
      ...deps(f, () => pressed),
      takePauseRequest: () => {
        const a = ask;
        ask = null;
        return a;
      },
      onEvent: (e) => {
        if (e.kind === 'poll' && e.progress.percent === 40) ask = 'suspend';
        // The operator presses Stop while suspended: the machine reads Idle with no P, which must
        // NOT be read as the job having finished (#618's pause guard).
        if (e.kind === 'paused') pressed = true;
      },
    });

    expect(o.kind).toBe('stopped-unconfirmed');
    expect(f.lines()).toContain('suspend');
    expect(f.lines()).not.toContain('M852'); // the stop found nothing running to switch off
    expect(f.lines()).not.toContain('$H');
  });

  it('a job that finishes at the same boundary takes no suspend', async () => {
    const f = fake(['<Idle|P:60,100,30>']);
    let ask: 'suspend' | null = 'suspend';
    const o = await runProgram('job.nc', {
      ...deps(f),
      takePauseRequest: () => {
        const a = ask;
        ask = null;
        return a;
      },
    });
    expect(o.kind).toBe('finished');
    expect(f.lines()).not.toContain('suspend');
  });

  it('a suspend that could not be sent leaves the job running and says so', async () => {
    const f = fake(['<Run|P:40,40,10>', '<Run|P:50,60,20>', '<Idle|P:60,100,30>']);
    let ask: 'suspend' | 'resume' | null = 'suspend';
    const notes: string[] = [];
    const session = {
      send: (line: string, timing?: Partial<ConsoleTiming>) =>
        line === 'suspend'
          ? Promise.resolve({ kind: 'error' as const, line, detail: 'socket closed' })
          : f.session.send(line, timing),
    };
    const o = await runProgram('job.nc', {
      ...deps(f),
      session,
      takePauseRequest: () => {
        const a = ask;
        ask = null;
        return a;
      },
      onEvent: (e) => {
        if (e.kind === 'note') notes.push(e.text);
      },
    });
    expect(o.kind).toBe('finished');
    expect(notes.some((n) => n.includes('suspend was not sent'))).toBe(true);
  });
});

describe('#655 the firmware’s Tool state after T1 M6', () => {
  const TOOL = '<Tool|MPos:-10.090,-12.830,-3.000|WPos:0,0,0|T:0,-9.757,1>';

  it('waits at Tool without failing, and M490.2 carries the program on', async () => {
    const events: string[] = [];
    let ask: 'continue-tool' | null = null;
    const f = fake([TOOL, TOOL, '<Run|MPos:0,0,0|P:5,10,2>', '<Idle|MPos:0,0,0|P:5,100,9>']);
    const o = await runProgram('job.nc', {
      ...deps(f),
      takePauseRequest: () => {
        const a = ask;
        ask = null;
        return a;
      },
      onEvent: (e) => {
        if (e.kind === 'tool-waiting') {
          events.push(`waiting:${e.awaited}`);
          ask = 'continue-tool';
        }
        if (e.kind === 'tool-continued') events.push('continued');
        // #1202 — the tool change is DONE once the controller leaves `Tool`; only OUR line makes
        // that a completion this app records (`byApp`).
        if (e.kind === 'tool-done') events.push(`done:${e.byApp}`);
      },
    });
    expect(events).toEqual(['waiting:1', 'continued', 'done:true']);
    expect(f.lines()).toContain('M490.2');
    expect(o.kind).toBe('finished');
  });

  it('does not call a machine standing at the tool change “never started”', async () => {
    // The no-progress window is 4 s here, and the machine waits 6 s at `Tool`: the clock is paused
    // while it waits, so the run must reach the program, not give up on it.
    const f = fake([TOOL, TOOL, TOOL, '<Run|MPos:0,0,0|P:5,10,2>', '<Idle|P:5,100,9>']);
    const o = await runProgram('job.nc', { ...deps(f), settings: { ...SETTINGS, noProgressMs: 4000 } });
    expect(o.kind).toBe('finished');
    expect(f.lines()).not.toContain('M490.2');
  });

  it('says so when the machine is carried on by hand', async () => {
    // #1202 — the run reports the tool change as done either way; `byApp: false` says a hand at
    // the console carried it on, so this app must NOT record the completion as its own routine.
    const done: boolean[] = [];
    const f = fake([TOOL, TOOL, '<Run|MPos:0,0,0|P:5,10,2>', '<Idle|P:5,100,9>']);
    const o = await runProgram('job.nc', {
      ...deps(f),
      onEvent: (e) => {
        if (e.kind === 'tool-done') done.push(e.byApp);
      },
    });
    expect(o.kind).toBe('finished');
    expect(done).toEqual([false]);
    expect(f.lines()).not.toContain('M490.2');
  });
});
