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
import { fileURLToPath } from 'node:url';
import { createNodeTransport } from './transport.node.mjs';
import * as P from '../../src/platform/desktop/protocol.ts';
import { CAMERA_PORT, captureFrames, saveFrame } from './camera.mjs';

/** Flags that never take a value. Without this, `--effective <key>` swallows the key as its value. */
const BOOLEAN_FLAGS = new Set(['json', 'help', 'effective', 'i-am-at-the-machine']);

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

  node tools/z1/z1.mjs discover [--window <ms>] [--json]
  node tools/z1/z1.mjs identify <host> [--port <n>] [--json]
  node tools/z1/z1.mjs status   <host> [--port <n>] [--json]
  node tools/z1/z1.mjs read     <host> <path> [--limit <lines>] [--window <ms>] [--out <file>]
  node tools/z1/z1.mjs md5      <host> <path> [<path> ...] [--window <ms>] [--json]
  node tools/z1/z1.mjs config   <host> <key> [<key> ...] [--source <name>] [--effective] [--json]
  node tools/z1/z1.mjs camera   <host> [--out <file-or-dir>] [--count <n>] [--every <ms>] [--port <n>]

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

MOTION AND THE CONSOLE (#302). Two commands send a line you typed, which can move the machine:

  node tools/z1/z1.mjs send    <host> "<line>" --i-am-at-the-machine [--trace <file>]
  node tools/z1/z1.mjs console <host> [--i-am-at-the-machine] [--trace <file>]

\`send\` refuses to run without --i-am-at-the-machine (/Fabrication.md §8: motion needs a person at
the machine). \`console\` asks for it once, in words, before the first line. Both go through the
bridge's guards (protocol.ts \`consoleProblem\`): one printable line; no config-set, no card writes,
no reset or flashing; the realtime bytes are not wired — the physical stop is the stop. Every line
sent and every reply is appended to a trace file (default docs/bench/traces/<date>-console.log), so a
session is a recorded trace. Nothing polls, repeats or queues.`);
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
async function sendTraced(session, file, line, flags) {
  const at = new Date().toISOString();
  const out = await session.send(line, {
    firstReplyMs: num(flags['first-reply'], 3000),
    quietMs: num(flags.quiet, 800),
    maxMs: num(flags.max, 15000),
  });
  const body = out.ok ? out.text.replace(/\r/g, '').trimEnd() : `[${out.reason}] ${out.detail}`;
  trace(file, `${at}  > ${line}\n${body.split('\n').map((l) => `    ${l}`).join('\n')}\n${out.ok ? `    (${out.frames} frame(s), ${out.elapsedMs} ms)\n` : ''}`);
  console.log(body.length > 0 ? body : '(no reply text)');
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
  if (cmd !== 'identify' && cmd !== 'status' && cmd !== 'read' && cmd !== 'config' && cmd !== 'md5' && cmd !== 'send' && cmd !== 'console') {
    console.error(`unknown command: ${cmd}`);
    usage();
    process.exit(2);
  }

  // The console commands are checked BEFORE a socket is opened: refusing costs no connection.
  if (cmd === 'send' && flags['i-am-at-the-machine'] !== true) {
    console.error('send moves hardware. Re-run with --i-am-at-the-machine once you are at the machine with your hand near the stop (/Fabrication.md §8).');
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
        process.stderr.write(`connected to ${host}:${port}. One line per Enter; "exit" or Ctrl-D to leave. The physical stop is the stop.\ntrace: ${file}\n`);
        const session = P.openConsole(transport, conn);
        for (;;) {
          const raw = await ask('z1> ');
          if (raw === null) break;
          const line = raw.trim();
          if (line === '') continue;
          if (line === 'exit' || line === 'quit') break;
          await sendTraced(session, file, line, flags);
        }
      } finally {
        rl.close();
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
