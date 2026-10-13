#!/usr/bin/env node
// Talk to the Z1 at the bench, without building the desktop app.
//
// This is a *harness*, not a second implementation. It imports the real
// `src/platform/desktop/protocol.ts` — Node 24 strips the types natively, so there is no build step
// and no copy to drift — and drives it over `transport.node.mjs`, the same five-call seam the Tauri
// transport implements. If a fact about the protocol is wrong, it is wrong in one place, and this
// tool inherits the fix.
//
// Run it from Windows (see transport.node.mjs for why):
//
//   node tools/z1/z1.mjs discover
//   node tools/z1/z1.mjs identify 192.168.10.43
//   node tools/z1/z1.mjs status   192.168.10.43
//   node tools/z1/z1.mjs read     192.168.10.43 /sd/config.txt
//   node tools/z1/z1.mjs config   192.168.10.43 coordinate.anchor1_x soft_endstop.x_min
//
// SAFETY (Z1-Bridge-Protocol.md §8, /Fabrication.md §8). Everything here is read-only EXCEPT `send` and
// `console` (#302, added 2026-10-08 when R10 was reopened), which send a line the person at the machine
// typed, through the bridge's guards, and record it (the guards: protocol.ts `consoleProblem`). The
// read-only commands: listen for the machine's broadcast, ask it who it is, ask for its status, read a
// file off its card and ask what its own configuration keys are set to. There is still no upload path
// here — a program reaches the card through the app's verified-upload gate (#174/#206), not a script.
//
// The two commands added on 2026-10-06 were `read` and `config`, and both went in through
// `protocol.ts` as *parameters* rather than as a console-command box: the bridge builds the single
// `cat` or `config-get` line itself and refuses anything that is not a plain path or a plain key, so
// this script still cannot be talked into sending a second command. That distinction — one narrow,
// checked parameter instead of a free-text box — is the whole reason they could be added at the bench.
// `config` only ever *reads*: `config-get`, never `config-set`. Nothing in this repo may change a
// value on the machine, and this script has no path that would.

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createNodeTransport } from './transport.node.mjs';
import * as P from '../../src/platform/desktop/protocol.ts';
import { CAMERA_PORT, captureFrames, saveFrame } from './camera.mjs';

/** Flags that never take a value. Without this, `--effective <key>` swallows the key as its value. */
const BOOLEAN_FLAGS = new Set(['json', 'help', 'effective', 'i-am-at-the-machine', 'all']);

/**
 * `run`'s own reply windows (#386 review), which are not a console line's.
 *
 * `abort` is the reason they exist: the controller stops the spindle at once but answers only after it
 * has finished the moves it had already queued — ~18 s in the 2026-10-12 observation (#303) — so the
 * reply that says the queue is drained gets 30 s rather than the 3 s a console line is given.
 */
const ABORT_REPLY_MS = 30000;
/** After an abort that never answered: how many polls may still find `Idle`, and each one's window. */
const ABORT_IDLE_POLLS = 3;
const ABORT_IDLE_POLL_MS = 5000;
/** How long a played job may report no `P` progress field before `run` stops polling (`--no-progress`). */
const NO_PROGRESS_MS = 30000;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!BOOLEAN_FLAGS.has(key) && next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

const num = (v, fallback) => (v === undefined ? fallback : Number(v));

function usage() {
  console.log(`z1 — bench harness for the Makera Z1 (reads, the camera, plus a guarded console — see the end)

  node tools/z1/z1.mjs discover [--window <ms>] [--json] [--all]
  node tools/z1/z1.mjs identify <host> [--port <n>] [--json]
  node tools/z1/z1.mjs status   <host> [--port <n>] [--json]
  node tools/z1/z1.mjs read     <host> <path> [--limit <lines>] [--window <ms>] [--out <file>]
  node tools/z1/z1.mjs md5      <host> <path> [<path> ...] [--window <ms>] [--json]
  node tools/z1/z1.mjs config   <host> <key> [<key> ...] [--source <name>] [--effective] [--json]
  node tools/z1/z1.mjs camera   <host> [--out <file-or-dir>] [--count <n>] [--every <ms>] [--skip <n>] [--port <n>]

\`config\` reads from source \`sd\` by default, one \`config-get sd <key>\` per key. \`--effective\` asks for
the merged cache instead (one \`config-get <key>\`) — but on this machine that cache answers
"not in config" for keys \`sd\` reads correctly, so \`sd\` is the default.
Silence to a \`config-get\` means the source is not one the controller carries, not that it is busy:
the firmware's source loop has no else branch, so an unknown source prints nothing at all.

\`md5\` asks the controller to hash a file it holds — one short line back, no file contents transferred —
and is the independent half of an upload check: the bridge verifies a \`.nc\` with its own handshake, and
this is what the controller says it ended up with.

Sends nothing to the machine except the two identify queries, the status poll, the one \`cat\` line a
read needs, one \`config-get\` line per key asked for and one \`md5sum\` line per path asked about.
\`read\` and \`md5\` take an absolute path on the controller's card and nothing else; \`config\` takes
configuration keys and nothing else.

\`camera\` saves JPEG frames from the machine's camera (its own ESP32 module, ws://<host>:82/ws_video —
see camera.mjs). One frame to --out (default docs/bench/img/camera-<timestamp>.jpg); with --count N
the frames go into --out as a directory, --every <ms> apart. It moves nothing and writes nothing on
the machine. A frame before and after a move is the cheapest answer to A6 (head- or frame-mounted).

\`discover --all\` prints **every** datagram received in the window, un-de-duplicated and with nothing
dropped, each line led by the time it ARRIVED at this listener (ISO, UTC — receipt, never the
controller's clock) and followed by the raw datagram, then field 4 — the undocumented textual state —
beside the \`busy\` flag (#275; only \`Idle\` has ever been seen). The times are what date a state
change: the raw lines alone say which state came first, not when. Plain \`discover\` still returns one
line per distinct machine. Nothing is decided from field 4: it is an observation, not an input.

MOTION AND THE CONSOLE (#302). Two commands send a line you typed, which can move the machine:

  node tools/z1/z1.mjs send    <host> "<line>" --i-am-at-the-machine [--trace <file>]
  node tools/z1/z1.mjs console <host> [--i-am-at-the-machine] [--interval <ms>] [--trace <file>]
  node tools/z1/z1.mjs run     <host> <path> --i-am-at-the-machine [--interval <ms>] [--no-progress <ms>] [--trace <file>] [--json]

\`send\` refuses to run without --i-am-at-the-machine (/Fabrication.md §8: motion needs a person at
the machine), and \`run\` asks for the same flag for the same reason. \`console\` asks for it once, in
words, before the first line. Both go through the
bridge's guards (protocol.ts \`consoleProblem\`): one printable line; no config-set, no card writes,
no reset or flashing; the realtime bytes are not wired — the physical stop is the stop. Every line
sent and every reply is appended to a trace file (default docs/bench/traces/<date>-console.log), so a
session is a recorded trace. A typed line is never repeated, queued or retried: \`run\` is the one
command that sends anything on its own, and only because it was asked to watch the job it started.

ONE LINE IS ONE COMMAND, and a PIPED console is the status poll alone (#386). Feeding a program
through the console line by line faulted the controller on 2026-10-12 (\`ALARM: Mainboard did not
receive a status response from the CTRL\`) and left the spindle turning with the plug as the only
stop, so \`consoleProblem\` refuses a line the dispatcher would run as more than one command, and
when stdin is not a keyboard — \`console < program.nc\`, or any script — only \`?\` is sent
(\`consolePipedProblem\`), paced at one poll per ${P.MIN_STATUS_POLL_MS} ms.

TO RUN A PROGRAM, use \`run\`: it uploads nothing and decides nothing. It first polls the status ONCE
and plays only on a reply that reads \`Idle\` with no alarm — a \`play\` on a machine already running, or
in an alarm, is the one way this command could turn a person's intent into something else. Then it
sends \`play <path>\` and the status poll \`?\` every \`--interval\` ms (default
${P.MIN_STATUS_POLL_MS}, the rate the bench uses; a faster one is refused — 0.6 s faulted the
controller on 2026-10-12) on the SAME connection, until one reply says the job is finished. The
interval is measured from one send to the next, and the first \`?\` is one interval after \`play\`: the
controller is at its busiest just after starting a file, which is exactly where the 2026-10-12 fault
was. What finishing takes is worth knowing: the air file of 2026-10-12 reported \`Idle\` for 3–4 s in the
middle of itself (at \`M05\`), so job end is \`P\` percent 100 together with \`Idle\`, never \`Idle\`
alone — and the \`P\` field disappears from the status once the job is over, so a run that misses the
100 % reply ends on the poll after it. A \`play\` the controller does not answer is NOT a job that
failed: the status poll starts anyway, and only a reply containing \`Error\` stops the run. A job that
reports no \`P\` field for \`--no-progress\` ms (default ${NO_PROGRESS_MS}) ends it too, non-zero:
nothing this tool can see is running. One line is printed per poll (to stderr; stdout stays clean for
\`--json\`), and Ctrl-C sends \`abort\` — the very word Studio's own grey Stop sends, observed at the
bench on 2026-10-12 (#303) — so the machine is not left cutting unwatched, and exits 130; a second
Ctrl-C leaves at once. \`abort\` stops the SPINDLE at once, but the controller finishes the moves it had
already queued before it answers (~18 s in that observation), and that reply is what \`run\` waits for
before it sends \`M332\` — the one line it sends that the program did not ask for — because an aborted
program never ran its own vacuum-off; if the abort goes unanswered, \`M332\` waits for a status poll to
read \`Idle\` instead, and is NOT sent if none does. Three polls in a row with no reply at all end it
too, non-zero: the socket is gone, and this tool cannot claim it stopped anything. The physical stop
is still the stop.`);
}

/** The trace file for a session: one dated file per day unless --trace says otherwise. */
function tracePath(flags) {
  if (typeof flags.trace === 'string') return resolve(flags.trace);
  const day = new Date().toISOString().slice(0, 10);
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'bench', 'traces', `${day}-console.log`);
}

function trace(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, text);
}

/** Send one line through an open console session, echo and record both sides. */
async function sendTraced(session, file, line, flags, opts = {}) {
  const at = new Date().toISOString();
  let out;
  try {
    out = await session.send(line, {
      firstReplyMs: num(flags['first-reply'], 3000),
      quietMs: num(flags.quiet, 800),
      maxMs: num(flags.max, 15000),
      ...(opts.window ?? {}),
    });
  } catch (error) {
    // A dropped socket THROWS out of the transport instead of answering (#386 review). Turned into the
    // miss shape every caller already handles: a `run` then ends with its summary and "the physical
    // stop is the stop" rather than a stack trace, and the line is traced like any other attempt.
    out = { ok: false, reason: 'failed', detail: `the socket failed: ${error instanceof Error ? error.message : String(error)}`, text: '' };
  }
  const body = out.ok ? out.text.replace(/\r/g, '').trimEnd() : `[${out.reason}] ${out.detail}`;
  trace(file, `${at}  > ${line}\n${body.split('\n').map((l) => `    ${l}`).join('\n')}\n${out.ok ? `    (${out.frames} frame(s), ${out.elapsedMs} ms)\n` : ''}`);
  // A polling loop echoes nothing: its own progress line is the display, the trace file is the record
  // of every reply, and stdout stays clean for `--json`.
  if (opts.echo !== false) console.log(body.length > 0 ? body : '(no reply text)');
  return out;
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];
  if (cmd === undefined || flags.help) {
    usage();
    process.exit(cmd === undefined ? 2 : 0);
  }

  const transport = createNodeTransport();
  const asJson = flags.json === true;

  if (cmd === 'discover') {
    const windowMs = num(flags.window, 5000);
    process.stderr.write(`listening on UDP ${P.DISCOVERY_UDP_PORT} for ${windowMs} ms (sends nothing)...\n`);
    // --all (#275): every datagram, un-de-duplicated and nothing discarded, so field 4 (the textual
    // state — `Idle`, and whatever else it says when the machine is not idle) can be watched against
    // field 3 (`busy`) as the machine changes. Nothing here is decided from field 4: it stays an
    // observation, because whether the two can disagree, and which is authoritative, is unknown.
    if (flags.all === true) {
      const datagrams = await P.discoveryDatagrams(transport, { windowMs });
      if (asJson) {
        console.log(
          JSON.stringify(
            datagrams.map((d) => ({
              at: new Date(d.at).toISOString(),
              raw: d.text,
              parsed: P.parseDiscoveryDatagram(d.text),
            })),
            null,
            2,
          ),
        );
        return;
      }
      if (datagrams.length === 0) {
        console.log('no datagrams received.');
        return;
      }
      // The time leads and the raw datagram follows it: the time is what dates a state change, and
      // the raw text is the evidence — the parsed reading is an aside on the same line, for field 4
      // beside field 3, and nothing is decided from it (#275).
      for (const d of datagrams) {
        const at = new Date(d.at).toISOString();
        const m = P.parseDiscoveryDatagram(d.text);
        console.log(
          m === null
            ? `${at}  ${d.text}   [not a machine datagram]`
            : `${at}  ${d.text}   [${m.busy ? 'BUSY' : 'not busy'}, state=${m.state ?? '(none)'}]`,
        );
      }
      return;
    }
    const machines = await P.runDiscovery(transport, { windowMs });
    if (asJson) {
      console.log(JSON.stringify(machines, null, 2));
      return;
    }
    if (machines.length === 0) {
      console.log('no machines found.');
      return;
    }
    for (const m of machines) {
      console.log(`${m.name}  ${m.host}:${m.port}  ${m.busy ? 'BUSY' : 'not busy'}`);
    }
    return;
  }

  const host = positional[1];
  if (host === undefined) {
    usage();
    process.exit(2);
  }

  // The camera is not on the command channel: its own server, its own port, no transport seam.
  if (cmd === 'camera') {
    const count = num(flags.count, 1);
    const everyMs = num(flags.every, 0);
    // The module replays its LAST frame to a new client first (camera.mjs); skip it by default.
    const skip = num(flags.skip, 3);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const here = dirname(fileURLToPath(import.meta.url));
    const defaultOut = resolve(here, '..', '..', '..', 'docs', 'bench', 'img', count === 1 ? `camera-${stamp}.jpg` : `camera-${stamp}`);
    const out = typeof flags.out === 'string' ? resolve(flags.out) : defaultOut;
    process.stderr.write(`camera: ${count} frame(s) from ws://${host}:${num(flags.port, CAMERA_PORT)}/ws_video — no motion, no write on the machine...\n`);
    const result = await captureFrames({
      host,
      port: num(flags.port, CAMERA_PORT),
      count,
      everyMs,
      skip,
      onFrame: (jpeg, n) => {
        const path = count === 1 ? out : resolve(out, `frame-${String(n).padStart(4, '0')}.jpg`);
        saveFrame(path, jpeg);
        console.log(`${path}  ${jpeg.length} bytes`);
      },
    });
    process.stderr.write(`${result.frames} frame(s) saved.\n`);
    return;
  }

  const port = num(flags.port, P.COMMAND_TCP_PORT);
  if (cmd !== 'identify' && cmd !== 'status' && cmd !== 'read' && cmd !== 'config' && cmd !== 'md5' && cmd !== 'send' && cmd !== 'console' && cmd !== 'run') {
    console.error(`unknown command: ${cmd}`);
    usage();
    process.exit(2);
  }

  // The console commands are checked BEFORE a socket is opened: refusing costs no connection.
  if (cmd === 'send' && flags['i-am-at-the-machine'] !== true) {
    console.error('send moves hardware. Re-run with --i-am-at-the-machine once you are at the machine with your hand near the stop (/Fabrication.md §8).');
    process.exit(2);
  }
  if (cmd === 'run' && flags['i-am-at-the-machine'] !== true) {
    console.error('run starts a program on the machine. Re-run with --i-am-at-the-machine once you are at the machine with your hand near the stop (/Fabrication.md §8).');
    process.exit(2);
  }
  // The poll interval is a floor, not a preference (#386): `?` every 0.6 s is what faulted the
  // controller on 2026-10-12, and the bench's rate, 2 s, is the slowest-tested one that never did.
  const intervalMs = num(flags.interval, P.MIN_STATUS_POLL_MS);
  if (!(intervalMs >= P.MIN_STATUS_POLL_MS)) {
    console.error(
      `--interval must be milliseconds and at least ${P.MIN_STATUS_POLL_MS}: the status poll is what the controller ` +
        'answers in 0.6–0.7 s, and asking faster than that faulted it on 2026-10-12 (#386).',
    );
    process.exit(2);
  }
  // The bound on "the controller is answering, but reports no job" (#386 review): the status poll
  // cannot tell this tool that a `play` did nothing, so `run` stops asking. It is a flag so the bound
  // itself is testable without a 30-second wait.
  const noProgressMs = num(flags['no-progress'], NO_PROGRESS_MS);
  if (cmd === 'run' && !(noProgressMs > 0)) {
    console.error('--no-progress must be positive milliseconds: it is how long `run` keeps polling a job that reports no progress.');
    process.exit(2);
  }
  if (cmd === 'send') {
    const line = positional[2];
    const problem = line === undefined ? 'send needs a line, e.g. send 192.168.10.43 "G28" --i-am-at-the-machine' : P.consoleProblem(line);
    if (problem !== null) {
      console.error(problem);
      process.exit(2);
    }
  }
  // The `play` line is BUILT here from a checked path, the way `read` and `config` build theirs: the
  // caller passes a path on the card, never a line, so a path can never smuggle a second command.
  const playLine = cmd === 'run' && positional[2] !== undefined ? P.playProgramLine(positional[2]) : null;
  if (cmd === 'run' && playLine === null) {
    console.error(
      positional[2] === undefined
        ? `run needs the card path of a program, e.g. run ${host} /sd/gcodes/<file>.nc --i-am-at-the-machine`
        : `run takes an absolute path on the card, plain characters only — not ${JSON.stringify(positional[2])}`,
    );
    process.exit(2);
  }

  const conn = await transport.tcpConnect(host, port, num(flags.timeout, 3000));
  try {
    if (cmd === 'send') {
      const file = tracePath(flags);
      const out = await sendTraced(P.openConsole(transport, conn), file, positional[2], flags);
      process.stderr.write(`trace: ${file}\n`);
      if (!out.ok) process.exitCode = 1;
    } else if (cmd === 'console') {
      const file = tracePath(flags);
      // A line iterator rather than `rl.question`: it ends cleanly when stdin does (a piped script, or
      // Ctrl-D), where `question` would wait forever.
      const rl = createInterface({ input: process.stdin });
      const lines = rl[Symbol.asyncIterator]();
      const ask = async (prompt) => {
        process.stderr.write(prompt);
        const next = await lines.next();
        return next.done ? null : next.value;
      };
      try {
        if (flags['i-am-at-the-machine'] !== true) {
          const answer = await ask('Lines you type here can MOVE the machine. Type "I am at the machine" to continue: ');
          if (answer === null || answer.trim().toLowerCase() !== 'i am at the machine') {
            console.error('\nnot confirmed; nothing was sent.');
            process.exit(2);
          }
        }
        trace(file, `\n=== console session ${new Date().toISOString()} ${host}:${port} ===\n`);
        // A PIPED session is the status poll and nothing else (#386): `console < program.nc` streams a
        // program one line at a time, and that is what faulted the controller. `isTTY` is the test for
        // "a person is typing", so it is the test for "a line may move the machine".
        const typed = process.stdin.isTTY === true;
        if (!typed) {
          process.stderr.write(
            'stdin is not a keyboard: this session sends the status poll (?) and refuses everything else (#386).\n',
          );
        }
        process.stderr.write(
          typed
            ? `connected to ${host}:${port}. One line per Enter; "exit" or Ctrl-D to leave. The physical stop is the stop.\ntrace: ${file}\n`
            : `connected to ${host}:${port}. Poll only. The physical stop is the stop.\ntrace: ${file}\n`,
        );
        const session = P.openConsole(transport, conn);
        let refusedLine = false;
        let lastPipedPollAt = null;
        for (;;) {
          const raw = await ask(typed ? 'z1> ' : '');
          if (raw === null) break;
          const line = raw.trim();
          if (line === '') continue;
          if (line === 'exit' || line === 'quit') break;
          if (!typed) {
            const problem = P.consolePipedProblem(line);
            if (problem !== null) {
              // Loud, and the exit code says so: a script must not read a refusal as a run.
              console.error(problem);
              refusedLine = true;
              continue;
            }
            // A piped poll has a FLOOR (#386): `?` in a tight loop is the shape that faulted the
            // controller on 2026-10-12, so a script's polls are paced at --interval (default
            // MIN_STATUS_POLL_MS). A TYPED line is never delayed — at the keyboard the person at the
            // machine sets the pace, which is the whole reason the console is allowed at all.
            if (lastPipedPollAt !== null) {
              const wait = intervalMs - (Date.now() - lastPipedPollAt);
              if (wait > 0) {
                process.stderr.write(`  (paced: waiting ${wait} ms — the poll is at most one per ${intervalMs} ms)\n`);
                await sleep(wait);
              }
            }
            lastPipedPollAt = Date.now();
          }
          await sendTraced(session, file, line, flags);
        }
        if (refusedLine) process.exitCode = 1;
      } finally {
        rl.close();
      }
    } else if (cmd === 'run') {
      const file = tracePath(flags);
      trace(file, `\n=== run session ${new Date().toISOString()} ${host}:${port} ===\n`);
      const session = P.openConsole(transport, conn);
      let stopAsked = 0;
      // Set the moment `abort` has gone out, so a SECOND Ctrl-C can say what is true at that moment
      // rather than the reassuring thing: the spindle is stopping, and `M332` — the vacuum-off the
      // aborted program never ran — has NOT been sent yet, so the vacuum is still on (#386 review).
      let abortSent = false;
      // Ctrl-C does not kill the process: it asks for the play to be aborted, which is a single line
      // this session is allowed to send because a person pressed the key. The send happens at the next
      // poll boundary, never during one: a reply belongs to one open request (protocol.ts's channel),
      // and two lines in flight would attach the next reply to the wrong one.
      const onSigint = () => {
        if (stopAsked === 1) {
          console.error(
            abortSent
              ? '\nleaving now. `abort` was already sent and the controller is draining its queue, but `M332` has NOT been sent — the vacuum is still on. Turn it off at the machine.'
              : '\nleaving now. The machine was NOT stopped — the physical stop is the stop.',
          );
          process.exit(130);
        }
        stopAsked = 1;
        process.stderr.write('\nCtrl-C — `abort` goes out at the next poll boundary. The physical stop is the stop.\n');
      };
      process.on('SIGINT', onSigint);
      try {
        // Everything this command prints on the way goes to stderr; stdout carries the one summary
        // line (or the JSON), so a script can read it and a person can watch the rest.
        //
        // BEFORE the program, one status poll, and it has to read `Idle` with no alarm (#386 review).
        // `play` on a machine that is already running, or in an alarm, is the one way this command could
        // turn a person's intent into something else — and a status reply is the only evidence this tool
        // has of what the machine is doing. A poll that goes UNANSWERED is not that evidence: it is
        // refused too, because "probably idle" is not a state this tool may start a program on.
        const before = await sendTraced(session, file, '?', flags, { echo: false });
        const beforeState = before.ok ? P.readJobProgress(before.text).state : null;
        if (stopAsked === 1) {
          // Ctrl-C while the pre-play poll was in flight (#386 review): the program was never sent, so
          // there is nothing to abort and nothing is left running. Same exit code a Ctrl-C gives.
          console.error('Ctrl-C before the program started. Nothing was played.');
          process.exitCode = 130;
        } else if (!before.ok) {
          console.error(`the machine did not answer a status poll (${before.detail}), so whether it is idle is unknown. Nothing was played.`);
          process.exitCode = 1;
        } else if (/ALARM/i.test(before.text) || beforeState === 'Alarm') {
          console.error('the controller is in an ALARM (see the trace above). Nothing was played: clear it at the machine first.');
          process.exitCode = 1;
        } else if (beforeState !== 'Idle') {
          console.error(
            `the controller reports ${beforeState === null ? 'no state this tool reads' : `\`${beforeState}\``}, not \`Idle\`. ` +
              'Nothing was played — the physical stop is the stop.',
          );
          process.exitCode = 1;
        } else {
          process.stderr.write(`idle — playing ${playLine}\n`);
          const playSentAt = Date.now();
          const played = await sendTraced(session, file, playLine, flags, { echo: false });
          if (played.ok) {
            const said = played.text.replace(/\r/g, '').trim();
            if (said.length > 0) process.stderr.write(`  ${said.split('\n').join('\n  ')}\n`);
          }
          if (played.ok && /\berror\b|not found|no such file|unknown/i.test(played.text)) {
            console.error('the controller did not accept that program (see its reply above). Nothing is being polled.');
            process.exitCode = 1;
          } else {
            if (!played.ok) {
              // A `play` that was not answered is NOT a job that failed to start (#386 review). The
              // controller may still be opening the file, and its reply can come later than a console
              // line's window — so the watching does not depend on it. Only an ERROR reply stops the run,
              // because that one is the controller saying it did not start the program.
              process.stderr.write(
                `\`${playLine}\` was not answered (${played.detail}). That is not a refusal, so the status poll is started anyway.\n`,
              );
            }
            process.stderr.write(
              `polling \`?\` every ${intervalMs} ms until the job finishes (Ctrl-C aborts; a second one leaves). The physical stop is the stop.\n`,
            );
            let polls = 0;
            let seenProgress = false;
            let misses = 0;
            let outcome = 'left';
            let last = { state: null, line: null, percent: null, elapsedS: null };
            // The status poll's floor is measured from the PREVIOUS send, and the first one from `play`:
            // a `?` a second after starting a file is exactly the rate that faulted the controller on
            // 2026-10-12, and the controller is at its busiest just then (#386 review).
            let lastPollAt = playSentAt;
            const pollOnce = async (reply) => {
              const wait = intervalMs - (Date.now() - lastPollAt);
              if (wait > 0) await sleep(wait);
              lastPollAt = Date.now();
              return sendTraced(session, file, '?', flags, { echo: false, window: reply });
            };
            for (;;) {
              const out = await pollOnce();
              polls++;
              if (!out.ok) {
                // A missed poll is not a failed job, so it is retried — but three in a row means the
                // socket is gone (#386: the controller does drop it), and polling a dead socket forever
                // would report nothing while the spindle is still turning.
                misses++;
                process.stderr.write(`  ${String(polls).padStart(3)}  (no status reply: ${out.detail})\n`);
                if (misses >= 3) {
                  outcome = 'unreachable';
                  process.exitCode = 1;
                  break;
                }
              } else {
                misses = 0;
                if (/ALARM/i.test(out.text) || P.readJobProgress(out.text).state === 'Alarm') {
                  outcome = 'alarm';
                  process.exitCode = 1;
                  break;
                }
                const p = P.readJobProgress(out.text);
                last = p;
                if (p.percent !== null) seenProgress = true;
                process.stderr.write(
                  `  ${String(polls).padStart(3)}  ${p.state ?? '?'}  ${(p.percent === null ? '   ' : `${p.percent}`).padStart(3)}%` +
                    `  line ${p.line ?? '–'}  ${p.elapsedS ?? '–'} s\n`,
                );
                // Job end is percent 100 AND `Idle` in one reply — `Idle` alone is 3–4 s of the job at
                // `M05`. The `P` field then leaves the status entirely, so a run that missed the 100 %
                // reply ends here instead of polling forever (both halves are in the 2026-10-12 trace).
                if (p.percent === 100 && p.state === 'Idle') {
                  outcome = 'finished';
                  break;
                }
                if (seenProgress && p.percent === null && p.state === 'Idle') {
                  outcome = 'finished';
                  break;
                }
                if (!seenProgress && polls === 5 && p.state === 'Idle') {
                  process.stderr.write('  (no progress field in five polls — the job may not have started)\n');
                }
                // A `P` field that never appears means this tool is watching NOTHING (#386 review): the
                // controller is answering, and nothing it reports is a running job. The old loop polled
                // for it forever. Bounded and non-zero — "stopped watching" is not "finished".
                if (!seenProgress && Date.now() - playSentAt >= noProgressMs) {
                  outcome = 'never-started';
                  process.exitCode = 1;
                  break;
                }
              }
              if (stopAsked === 1) {
                // #303, bench 2026-10-12: this is the word Studio's own grey Stop sends. The spindle
                // stops at once, but the controller first drains the queue it already had and answers
                // `Aborted playing or paused file` when it is done — ~18 s in that observation, so this
                // one send gets ABORT_REPLY_MS rather than a console line's 3 s (#386 review).
                const aborted = await sendTraced(session, file, 'abort', flags, {
                  echo: false,
                  window: { firstReplyMs: ABORT_REPLY_MS, maxMs: ABORT_REPLY_MS },
                });
                abortSent = true;
                if (aborted.ok) {
                  const said = aborted.text.replace(/\r/g, '').trim();
                  process.stderr.write(`  ${said.length > 0 ? said.split('\n').join('\n  ') : '(the abort was answered with no text)'}\n`);
                } else {
                  process.stderr.write(`  \`abort\` was not answered (${aborted.detail}).\n`);
                }
                // Then the vacuum, because the program's own tail — its `M332` (§11.10) — never ran. This
                // is the one line `run` sends that the program did not ask for, and it goes out only once
                // something says the controller has finished draining: the abort's own reply, or a status
                // poll that reads `Idle`. A vacuum line into a controller that is still moving is one more
                // line to answer at the worst possible moment (#386 review).
                //
                // And only the reply that SAYS SO counts (#386 review): the controller sends unsolicited
                // lines mid-job — `G28 means goto clearance position on CARVERA` arrived inside a `?`
                // reply in the 2026-10-12 log — so any text at all is not the abort's answer. Without the
                // word, the Idle polls below decide, which is the same rule one step later.
                let drained = aborted.ok && /aborted playing/i.test(aborted.text);
                for (let i = 0; !drained && i < ABORT_IDLE_POLLS; i++) {
                  const q = await pollOnce({ firstReplyMs: ABORT_IDLE_POLL_MS, maxMs: ABORT_IDLE_POLL_MS });
                  if (q.ok && P.readJobProgress(q.text).state === 'Idle') drained = true;
                }
                if (drained) {
                  const vacuumOff = await sendTraced(session, file, 'M332', flags, { echo: false });
                  if (!vacuumOff.ok) console.error(`the vacuum: \`M332\` went unanswered (${vacuumOff.detail}) — check the machine.`);
                } else {
                  console.error(
                    `the vacuum: \`M332\` was NOT sent — nothing confirmed the controller had finished draining (${ABORT_IDLE_POLLS} polls ` +
                      'after the abort did not read `Idle`). Check the machine and the vacuum.',
                  );
                }
                outcome = 'aborted';
                process.exitCode = 130;
                break;
              }
            }
            const why =
              outcome === 'finished'
                ? 'the job is finished'
                : outcome === 'aborted'
                  ? 'aborted'
                  : outcome === 'unreachable'
                    ? 'the status stopped answering — NOT stopped from here'
                    : outcome === 'never-started'
                      ? 'no job progress ever appeared — nothing here was watching a job'
                      : 'stopped at an alarm';
            if (asJson) {
              console.log(JSON.stringify({ path: positional[2], outcome, polls, ...last }, null, 2));
            } else {
              console.log(
                `${playLine} — ${why}: ${last.percent ?? '–'}%, line ${last.line ?? '–'}, ` +
                  `${last.elapsedS ?? '–'} s on the controller's clock, ${polls} poll(s).`,
              );
            }
            if (outcome === 'aborted') {
              console.error(
                '`abort` was sent: the spindle stops at once, but the controller finishes the moves it had already queued ' +
                  '(~18 s on 2026-10-12) before it answers. `M332` follows once that answer — or a status poll — says it has ' +
                  'drained, because an aborted program never ran its own vacuum-off.',
              );
            }
            if (outcome === 'unreachable') {
              console.error('three polls in a row went unanswered — the socket or the controller is gone. The job may still be running: the physical stop is the stop.');
            }
            if (outcome === 'never-started') {
              console.error(
                `no \`P\` progress field in ${Math.round(noProgressMs / 1000)} s of status polls — the controller answers ` +
                  `\`${last.state ?? 'no state this tool reads'}\` and no reply carried a progress line, so nothing here was a job this tool could watch. ` +
                  'Polling stopped; nothing was stopped from here, and the machine is not idle because this tool says so.',
              );
            }
          }
        }
      } finally {
        process.off('SIGINT', onSigint);
      }
    } else if (cmd === 'identify') {
      const id = await P.runIdentify(transport, conn, host, { windowMs: num(flags.window, 1500) });
      if (asJson) {
        console.log(JSON.stringify(id, null, 2));
        return;
      }
      console.log(`host (as connected): ${id.host}`);
      console.log(`reported IP        : ${id.ip ?? 'NOT FOUND in reply'}`);
      console.log(`reported MAC       : ${id.mac ?? 'NOT FOUND in reply'}`);
      console.log('raw replies:');
      if (id.replies.length === 0) console.log('  (none)');
      for (const r of id.replies) console.log(`  ${JSON.stringify(r)}`);
    } else if (cmd === 'md5') {
      const paths = positional.slice(2);
      if (paths.length === 0) {
        console.error('md5 needs at least one path, e.g. md5 192.168.10.43 /sd/config.txt');
        process.exit(2);
      }
      process.stderr.write(
        `asking the controller to hash ${paths.length} file(s) — no motion, no write, no contents...\n`,
      );
      const digests = [];
      let failed = false;
      for (const path of paths) {
        const res = await P.runMd5Sum(transport, conn, path, { windowMs: num(flags.window, 2000) });
        digests.push({ path, ...res });
        if (!res.ok) failed = true;
        if (!asJson) {
          if (res.ok) console.log(`${res.md5}  ${path}`);
          else console.error(`${path}: ${res.reason} — ${res.detail}`);
        }
      }
      if (asJson) console.log(JSON.stringify(digests, null, 2));
      if (failed) process.exitCode = 1;
    } else if (cmd === 'config') {
      const keys = positional.slice(2);
      if (keys.length === 0) {
        console.error('config needs at least one key, e.g. config 192.168.10.43 coordinate.anchor1_x');
        process.exit(2);
      }
      // `sd` by default, not the one-argument effective-value form: on this machine the merged cache
      // is empty for the shell, so the effective form answers "not in config" for keys `sd` reads
      // correctly (measured 2026-10-06). `--effective` asks for it anyway — as its own flag rather
      // than an empty `--source`, which PowerShell silently swallows.
      const source = flags.effective === true ? undefined : String(flags.source ?? 'sd');
      process.stderr.write(
        `asking the controller ${keys.length} \`config-get ${source === undefined ? '' : `${source} `}<key>\` question(s)` +
          `${source === undefined ? ' for effective values' : ` from source ${source}`} — no motion, no write...\n`,
      );
      // One key per frame, one connection, in order. `readConfigKey` refuses anything that is not a
      // plain key, so a key arriving from a shell can never become a second command.
      const answers = [];
      let failed = false;
      for (const key of keys) {
        const res = await P.readConfigKey(transport, conn, key, {
          source,
          windowMs: num(flags.window, 2000),
        });
        answers.push({ key, ...res });
        if (!res.ok) failed = true;
        if (!asJson) {
          if (res.ok) console.log(`${key} = ${res.value}`);
          else if (res.reason === 'not-in-config') console.log(`${key}: not in config`);
          else console.error(`${key}: ${res.reason} — ${res.detail}`);
        }
      }
      if (asJson) console.log(JSON.stringify(answers, null, 2));
      if (failed) process.exitCode = 1;
    } else if (cmd === 'read') {
      const path = positional[2];
      if (path === undefined) {
        console.error('read needs a path, e.g. /sd/config.txt');
        process.exit(2);
      }
      const limit = num(flags.limit, undefined);
      process.stderr.write(
        `reading ${path}${limit === undefined ? '' : ` (first ${limit} lines)`} with one console \`cat\` — no motion, no write...\n`,
      );
      const res = await P.runReadFile(transport, conn, path, { limit, windowMs: num(flags.window, 8000) });
      if (asJson) console.log(JSON.stringify(res, null, 2));
      else if (res.ok) console.log(`read ok: ${res.text.length} chars in ${res.frames} frame(s)`);
      else console.error(`read failed (${res.reason}): ${res.detail}`);
      if (res.text.length > 0) process.stdout.write(res.text.endsWith('\n') ? res.text : `${res.text}\n`);

      // Only a complete read is written to disk. A partial one would look exactly like a whole file
      // the next time someone opened it, and the config this is for is read by eye.
      if (flags.out !== undefined) {
        if (!res.ok) console.error(`not writing ${flags.out}: the read did not complete`);
        else {
          writeFileSync(String(flags.out), res.text);
          console.error(`wrote ${res.text.length} chars to ${flags.out}`);
        }
      }
      if (!res.ok) process.exitCode = 1;
    } else {
      const st = await P.runStatus(transport, conn, { windowMs: num(flags.window, 1500) });
      if (asJson) {
        console.log(JSON.stringify(st, null, 2));
        return;
      }
      console.log(`status ok: ${st.ok}`);
      console.log(`text     : ${st.text === null ? '(no reply)' : JSON.stringify(st.text)}`);
      if (st.diagnostics.length > 0) {
        console.log('diagnostics:');
        for (const d of st.diagnostics) console.log(`  ${JSON.stringify(d)}`);
      }
    }
  } finally {
    await transport.tcpClose(conn);
  }
}

await main();
