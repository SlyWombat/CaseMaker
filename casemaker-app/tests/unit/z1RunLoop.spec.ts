// #386 review — `z1.mjs run`, driven against a controller that answers the wire (#386).
//
// The rules `run` obeys are unit-tested in `platformMachineProtocol.spec.ts`; what is NOT is the loop
// that uses them: play once, poll `?` on that ONE connection, and decide when the job ended. That
// loop is the one tomorrow's bench routine runs, and getting it wrong is expensive in both directions
// — stop at the mid-job `Idle` and the rest of the file never runs; never stop and the operator
// watches a poll that has nothing left to say.
//
// So this drives the REAL harness (a subprocess, `process.execPath` + the script) against a fake
// controller on 127.0.0.1 that speaks the bridge's framing. The status lines are the 2026-10-12
// trace's own replies, in order. Nothing here touches a machine: the address is a loopback socket the
// test opened, and the trace file is written to a temp directory rather than the repo's traces.
//
// Not covered here: Ctrl-C. On Windows `child.kill('SIGINT')` terminates the process outright instead
// of delivering the signal (Node maps it to `TerminateProcess`), so the abort path cannot be driven
// from a test — at the bench it is a real keypress and a real trace line, and the two things the
// #386 review changed there (a 30 s reply window, and `M332` only after the queue is drained) are
// reasoned from the 2026-10-12 observation rather than exercised here.
//
// The rest of that review IS exercised: the pre-play `Idle` gate, a `play` the controller never
// answers, a `play` it answers with an error, and the bound on a job that reports no `P` at all.

import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decodeText,
  encodeFrame,
  FrameDecoder,
  PTYPE_CTRL_MULTI,
  PTYPE_CTRL_SINGLE,
  utf8,
} from '@/platform/desktop/protocol';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const Z1 = join(APP, 'tools', 'z1', 'z1.mjs');

/** A reply frame as the controller sends one. */
const reply = (text: string): Uint8Array => encodeFrame(0x81, utf8(text));

const RUNNING = '<Run|MPos:-11.6000,-14.6000,-3.0000,0.0000,0.0000|F:0.0,500.0,100.0|L:0, 0, 0, 0.0,100.0|P:0,56,4|C:3,1,0,1|OTA:0,0>';
/** The air file's own `Idle`, 3-4 s into the job at `M05` — NOT the end. */
const MID_JOB_IDLE = '<Idle|MPos:-98.4000,-102.8000,-9.6109|L:0, 0, 0, 0.0,100.0|P:29,74,42|C:3,1,0,1|OTA:0,0>';
const END = '<Idle|MPos:-11.6000,-14.6000,-3.0000|L:0, 0, 0, 0.0,100.0|P:34,100,51|C:3,1,0,1|OTA:0,0>';
/** Every reply after the end: the `P:` field is gone. */
const AFTER = '<Idle|MPos:-11.6000,-14.6000,-3.0000|L:0, 0, 0, 0.0,100.0|C:3,1,0,1|OTA:0,0>';
/** The state word the machine reports when it wants a person: `run` must not play into it. */
const ALARMED = '<Alarm|MPos:-11.6000,-14.6000,-3.0000|L:0, 0, 0, 0.0,100.0|C:3,1,0,1|OTA:0,0>';

/**
 * A fake controller. Each `?` takes the next status line (silence past the end of the list), and a
 * command line (`play …`) is answered with the file size.
 *
 * `before` is the queue for the PRE-PLAY status poll — the one sent before `play` — and it defaults to
 * the idle-no-`P` line the machine reports when nothing has run, because `run` refuses to play
 * anything whose status does not read `Idle`. The two queues are separate on purpose: `before: []`
 * means "the pre-play poll went unanswered", not "the job's first status reply is missing".
 */
async function fakeController(
  status: string[],
  opts: { before?: string[]; playReply?: string | null } = {},
) {
  const seen: string[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const decoder = new FrameDecoder();
    let before = 0;
    let polls = 0;
    let played = false;
    socket.on('data', (chunk) => {
      for (const frame of decoder.push(new Uint8Array(chunk))) {
        if (frame.type === PTYPE_CTRL_SINGLE) {
          seen.push('?');
          const queue = played ? status : (opts.before ?? [AFTER]);
          const next = queue[played ? polls++ : before++];
          if (next !== undefined) socket.write(Buffer.from(reply(next)));
        } else if (frame.type === PTYPE_CTRL_MULTI) {
          const line = decodeText(frame.data).trim();
          seen.push(line);
          played = true;
          const said = opts.playReply === undefined ? 'File size 791\r\n' : opts.playReply;
          if (said !== null) socket.write(Buffer.from(reply(said)));
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    seen,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Run the harness against `port` and return its exit code, both streams, and the trace it wrote. */
async function runHarness(
  port: number,
  extra: string[],
): Promise<{ code: number | null; stdout: string; stderr: string; trace: string }> {
  const trace = join(mkdtempSync(join(tmpdir(), 'casemaker-386-run-')), 'trace.log');
  const child = spawn(
    process.execPath,
    [Z1, 'run', '127.0.0.1', '/sd/gcodes/fake.nc', '--i-am-at-the-machine', '--port', String(port), '--trace', trace, '--quiet', '150', ...extra],
    { cwd: APP },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d: string) => (stdout += d));
  child.stderr.on('data', (d: string) => (stderr += d));
  const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
  // No initial value: both arms assign, and a `= ''` here is dead — the catch already covers the
  // file the run never wrote.
  let written: string;
  try {
    written = readFileSync(trace, 'utf8');
  } catch {
    written = '';
  }
  return { code, stdout, stderr, trace: written };
}

describe('#386 run — the harness poll loop (against a fake controller)', () => {
  it(
    'plays the path once, polls on that one connection, and stops when percent 100 meets Idle',
    async () => {
      const controller = await fakeController([RUNNING, END]);
      try {
        const { code, stdout, stderr } = await runHarness(controller.port, ['--json']);
        expect(code).toBe(0);
        // The pre-play status poll comes FIRST, then the program line, and the program line is BUILT
        // from the path rather than passed through.
        expect(controller.seen[0]).toBe('?');
        expect(controller.seen[1]).toBe('play /sd/gcodes/fake.nc');
        expect(controller.seen).toEqual(['?', 'play /sd/gcodes/fake.nc', '?', '?']);
        expect(JSON.parse(stdout)).toMatchObject({
          path: '/sd/gcodes/fake.nc',
          outcome: 'finished',
          polls: 2,
          state: 'Idle',
          percent: 100,
          line: 34,
        });
        // stdout is the JSON ALONE — the whole of it parses above — and the human-readable half is on
        // stderr: the machine's reply to `play`, then one line per poll.
        expect(stderr).toContain('File size 791');
        expect(stderr).toContain('Run');
        expect(stderr).toContain('100%');
      } finally {
        await controller.close();
      }
    },
    30_000,
  );

  it(
    'does not stop at the mid-job Idle, and ends on the poll after the P field disappears',
    async () => {
      // The 100 % reply is never seen (the fake goes straight past it), so the run has to end the
      // other honest way: a `P` was seen, and now it is gone.
      const controller = await fakeController([RUNNING, MID_JOB_IDLE, AFTER, AFTER]);
      try {
        const { code, stdout, stderr } = await runHarness(controller.port, ['--json']);
        expect(code).toBe(0);
        expect(controller.seen).toEqual(['?', 'play /sd/gcodes/fake.nc', '?', '?', '?']);
        const out = JSON.parse(stdout) as { outcome: string; polls: number; percent: number | null };
        expect(out).toMatchObject({ outcome: 'finished', polls: 3, percent: null });
        // The mid-job Idle was displayed, not acted on: ONE more poll came after it (the review
        // corrected this comment's earlier "three"), and that poll ended the run because the `P` field
        // was gone — which is the only way this run can end when it misses the 100 % reply.
        expect(stderr).toContain('74%');
        expect(stderr).not.toContain('100%');
      } finally {
        await controller.close();
      }
    },
    45_000,
  );

  it(
    'rides out a mid-job Idle at a partial percent and keeps watching when Run comes back',
    async () => {
      // The mid-job `Idle` is not always bare: at `M05` the controller reports it with the job's own
      // `P` field still in place — `P:29,74` is line 29, percent 74, so it is emphatically not the end
      // (`END` is percent 100). The loop must carry on through it and end when the trip home finishes
      // (#386 review: the code handles this, nothing pinned it).
      const controller = await fakeController([RUNNING, MID_JOB_IDLE, RUNNING, END]);
      try {
        const { code, stdout, stderr } = await runHarness(controller.port, ['--json']);
        expect(code).toBe(0);
        expect(controller.seen).toEqual(['?', 'play /sd/gcodes/fake.nc', '?', '?', '?', '?']);
        expect(JSON.parse(stdout)).toMatchObject({
          outcome: 'finished',
          polls: 4,
          state: 'Idle',
          percent: 100,
          line: 34,
        });
        // The pause was displayed as what it was, and the run went on from it.
        expect(stderr).toContain('74%');
        expect(stderr).toContain('100%');
      } finally {
        await controller.close();
      }
    },
    45_000,
  );

  it(
    'gives up, non-zero, when the controller stops answering — it does not poll a dead socket forever',
    async () => {
      const controller = await fakeController([]);
      try {
        const { code, stderr, trace } = await runHarness(controller.port, ['--first-reply', '200']);
        expect(code).toBe(1);
        // The pre-play poll is answered (the default idle line), so the run starts; every poll AFTER
        // `play` goes unanswered.
        expect(controller.seen).toEqual(['?', 'play /sd/gcodes/fake.nc', '?', '?', '?']);
        expect(stderr).toContain('no status reply');
        expect(stderr).toContain('the physical stop is the stop');
        // The trace records both sides even when the machine says nothing back.
        expect(trace).toContain('> play /sd/gcodes/fake.nc');
        expect(trace).toContain('File size 791');
      } finally {
        await controller.close();
      }
    },
    45_000,
  );

  it(
    'refuses to play unless the status reads Idle: a running job, an alarm, or a poll nobody answered',
    async () => {
      // `play` on a machine that is already running — or in an alarm — is the one way this command
      // could turn a person's intent into something else, and the status poll is the only evidence
      // this tool has. An unanswered poll is not evidence (#386 review).
      const cases = [
        { why: 'a job is already running', before: [RUNNING], said: 'not `Idle`' },
        { why: 'the controller is alarming', before: [ALARMED], said: 'ALARM' },
        { why: 'the poll went unanswered', before: [], said: 'did not answer a status poll' },
      ];
      for (const { why, before, said } of cases) {
        const controller = await fakeController([RUNNING, END], { before });
        try {
          const { code, stdout, stderr } = await runHarness(controller.port, ['--json', '--first-reply', '250']);
          expect(stderr, why).toContain(said);
          expect(stderr, why).toContain('Nothing was played');
          expect(controller.seen, why).toEqual(['?']);
          // No summary at all: there is no job to summarize.
          expect(stdout, why).toBe('');
          expect(code, why).toBe(1);
        } finally {
          await controller.close();
        }
      }
    },
    30_000,
  );

  it(
    'stops without polling when the controller answers `play` with an error',
    async () => {
      const controller = await fakeController([RUNNING, END], { playReply: 'Error: no such file\r\n' });
      try {
        const { code, stderr } = await runHarness(controller.port, ['--json']);
        expect(code).toBe(1);
        expect(controller.seen).toEqual(['?', 'play /sd/gcodes/fake.nc']);
        expect(stderr).toContain('did not accept that program');
      } finally {
        await controller.close();
      }
    },
    30_000,
  );

  it(
    'watches anyway when `play` is not answered — only an error reply stops the run',
    async () => {
      // The controller may still be opening the file, and its reply can arrive later than a console
      // line's window. A silent `play` is not a refused one (#386 review), so the poll starts and the
      // job is watched to its end.
      const controller = await fakeController([RUNNING, END], { playReply: null });
      try {
        const { code, stdout, stderr } = await runHarness(controller.port, ['--json', '--first-reply', '250']);
        expect(code).toBe(0);
        expect(controller.seen).toEqual(['?', 'play /sd/gcodes/fake.nc', '?', '?']);
        expect(stderr).toContain('was not answered');
        expect(stderr).toContain('started anyway');
        expect(JSON.parse(stdout)).toMatchObject({ outcome: 'finished', percent: 100 });
      } finally {
        await controller.close();
      }
    },
    30_000,
  );

  it(
    'stops polling, non-zero, when a job never reports a P field',
    async () => {
      // A `?` that keeps answering with no `P` is a controller that is up and a job this tool cannot
      // see either way. The old loop polled it forever (#386 review); the bound is `--no-progress`.
      const controller = await fakeController([AFTER, AFTER, AFTER, AFTER]);
      try {
        const { code, stdout, stderr } = await runHarness(controller.port, ['--json', '--no-progress', '400']);
        expect(code).toBe(1);
        expect(JSON.parse(stdout)).toMatchObject({ outcome: 'never-started' });
        expect(stderr).toContain('no `P` progress field');
        expect(stderr).toContain('nothing was stopped from here');
        // It did not keep polling: the pre-play poll, `play`, and one poll that found nothing.
        expect(controller.seen).toEqual(['?', 'play /sd/gcodes/fake.nc', '?']);
      } finally {
        await controller.close();
      }
    },
    30_000,
  );
});
