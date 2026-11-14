// #386 review — the shared harness for `z1.mjs run`'s poll-loop specs (z1RunLoop*.spec.ts).
// Moved here verbatim from z1RunLoop.spec.ts when that file was split for parallel running:
// the fake controller, the subprocess driver and the status-line constants. No test logic.
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
// Ctrl-C: on Windows `child.kill('SIGINT')` terminates the process outright instead of delivering the
// signal (Node maps it to `TerminateProcess`), so the abort path cannot be driven there; on Linux and
// macOS it is (`z1RunLoopAbort.spec.ts`, which names its own Windows skip). At the bench it is a real
// keypress and a real trace line.
//
// The rest of that review IS exercised: the pre-play `Idle` gate, a `play` the controller never
// answers, a `play` it answers with an error, and the bound on a job that reports no `P` at all.

import { spawn, type ChildProcess } from 'node:child_process';
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

// One level deeper than the spec it came from (tests/unit/helpers -> casemaker-app).
const APP = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const Z1 = join(APP, 'tools', 'z1', 'z1.mjs');

/** A reply frame as the controller sends one. */
const reply = (text: string): Uint8Array => encodeFrame(0x81, utf8(text));

export const RUNNING = '<Run|MPos:-11.6000,-14.6000,-3.0000,0.0000,0.0000|F:0.0,500.0,100.0|L:0, 0, 0, 0.0,100.0|P:0,56,4|C:3,1,0,1|OTA:0,0>';
/** The air file's own `Idle`, 3-4 s into the job at `M05` — NOT the end. */
export const MID_JOB_IDLE = '<Idle|MPos:-98.4000,-102.8000,-9.6109|L:0, 0, 0, 0.0,100.0|P:29,74,42|C:3,1,0,1|OTA:0,0>';
export const END = '<Idle|MPos:-11.6000,-14.6000,-3.0000|L:0, 0, 0, 0.0,100.0|P:34,100,51|C:3,1,0,1|OTA:0,0>';
/** Every reply after the end: the `P:` field is gone. */
export const AFTER = '<Idle|MPos:-11.6000,-14.6000,-3.0000|L:0, 0, 0, 0.0,100.0|C:3,1,0,1|OTA:0,0>';
/** The state word the machine reports when it wants a person: `run` must not play into it. */
export const ALARMED = '<Alarm|MPos:-11.6000,-14.6000,-3.0000|L:0, 0, 0, 0.0,100.0|C:3,1,0,1|OTA:0,0>';

/**
 * A fake controller. Each `?` takes the next status line (silence past the end of the list), and a
 * command line (`play …`) is answered with the file size.
 *
 * `before` is the queue for the PRE-PLAY status poll — the one sent before `play` — and it defaults to
 * the idle-no-`P` line the machine reports when nothing has run, because `run` refuses to play
 * anything whose status does not read `Idle`. The two queues are separate on purpose: `before: []`
 * means "the pre-play poll went unanswered", not "the job's first status reply is missing".
 *
 * `unsolicited` sends a frame that answers NOTHING, `delayMs` after the reply to the Nth job poll
 * (`afterPoll`, 0-based) — the controller still talking when no line is in flight, which is what
 * #386 item 3 is about. The delay has to clear the poll's own quiet window (`--quiet`, 150 ms here)
 * and land well before the next poll (one `--interval`, 2000 ms by default) so the frame is provably
 * waiting on the socket when the next line goes out.
 */
export async function fakeController(
  status: string[],
  opts: { before?: string[]; playReply?: string | null; unsolicited?: { afterPoll: number; text: string; delayMs?: number } } = {},
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
          const u = opts.unsolicited;
          if (played && u !== undefined && polls - 1 === u.afterPoll) {
            const timer = setTimeout(() => {
              if (!socket.destroyed) socket.write(Buffer.from(reply(u.text)));
            }, u.delayMs ?? 500);
            timer.unref();
          }
        } else if (frame.type === PTYPE_CTRL_MULTI) {
          const line = decodeText(frame.data).trim();
          seen.push(line);
          played = true;
          // An `abort` line is answered the way the controller does (2026-10-12: it says "aborted playing").
          const said = line === 'abort' ? 'ok\r\naborted playing\r\n' : opts.playReply === undefined ? 'File size 791\r\n' : opts.playReply;
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
export async function runHarness(
  port: number,
  extra: string[],
  /** Hands the spawned child to the caller (a spec that must signal it, e.g. SIGINT for the abort path). */
  onChild?: (child: ChildProcess) => void,
): Promise<{ code: number | null; stdout: string; stderr: string; trace: string }> {
  const trace = join(mkdtempSync(join(tmpdir(), 'casemaker-386-run-')), 'trace.log');
  const child = spawn(
    process.execPath,
    [
      Z1,
      'run',
      '127.0.0.1',
      '/sd/gcodes/fake.nc',
      '--i-am-at-the-machine',
      '--port',
      String(port),
      '--trace',
      trace,
      // #449 — `run` reads the shop's defaults from the app's own location.json; `none` keeps a run on
      // the maintainer's machine from being steered by the maintainer's own file. Every value is then
      // its fallback, which is what these expectations were written against.
      '--location',
      'none',
      '--quiet',
      '150',
      // The CONNECT window, not a rule under test: on a loaded machine the child's own start plus the
      // connect can outlast the 3 s default, and then the run never reaches its first poll. The gate
      // saw exactly that on 2026-10-13 — the full parallel run failed "gives up, non-zero…" with
      // `expected [] to equal Array(5)`. That EMPTY `seen` is the evidence: a lost REPLY window would
      // have left the pre-play `?` in it (`[ '?' ]`, what the test would then print), because the
      // frame is written before any window is waited on. Empty means the run never wrote a frame at
      // all. `tcpConnect` sits outside the run's `try` (`z1.mjs:359`), so it throws, node exits 1, and
      // the `code` assertion above the failing one passes — which is the signature that was reported.
      // `--timeout` reaches only `tcpConnect`, so no test's subject moves.
      '--timeout',
      '20000',
      ...extra,
    ],
    { cwd: APP },
  );
  onChild?.(child);
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
