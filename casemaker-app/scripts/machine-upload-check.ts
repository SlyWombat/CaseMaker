// One-off live check: hand a VERIFIED program to the Z1 through the app's own bridge (#255).
//
//   npx tsx --tsconfig tsconfig.scripts.json scripts/machine-upload-check.ts <job.json> <host>
//
// Flags: --dry (generate and print, send nothing), --verbose (every byte, both directions),
//        --name <file.nc> (a bare filename; default the run sheet's own name),
//        --dir <path> (the card directory; default GCODE_DIR = /sd/gcodes),
//        --calibration <file.json> (the app's saved machine calibration, #279/#395; without it the
//                                   shipped profile is used, which is what the app runs before
//                                   any probe — a real upload says so out loud rather than
//                                   requiring one the app would not require either),
//        --my-machine <file.json> (the app's exported "my machine" record, #247 — the program is
//                                  generated with ITS #345 depth margins, which is what the app
//                                  would use. REQUIRED for a real upload: without it the shipped
//                                  defaults are used, which is a program the button might not
//                                  send. --dry may go without, and says so),
//        --acknowledge=<codes> (the panel's clearance tick, said out loud. A run that asks for an
//                       acknowledgement — an unmeasured vise — is refused without it, exactly as
//                       the app refuses to Save or Upload one. The codes are the ones the refusal
//                       names, comma-separated: the tick is per-program, and a flag that waved
//                       through whatever this run happened to raise would not be one).
//
// Why this exists rather than "just drive the desktop app": the GUI needs a Rust build and a person
// clicking, and the thing that is actually unproven is the PROTOCOL, not the button (the button has
// its own spec). This drives `machineBridge.ts` itself — the same `asVerifiedProgram` gate and the
// same `runUpload` — over `tools/z1/transport.node.mjs`, which implements the identical five-call
// `MachineTransport` seam the Tauri transport does. The upload code under test is the app's; only
// the socket underneath it differs. The Rust socket layer is NOT covered by this — that needs the
// desktop build, and is a separate half of the live run.
//
// SAFETY. Uploading writes a file to the controller's card; it does NOT run it. On the Z1 a file on
// the card is inert until Studio's five-step Machining Wizard is driven by hand at the machine
// (recorded 2026-10-07, docs/bench/2026-10-bench-day-1.md D0). This script sends a file and reports
// what the controller said. It has no motion path and cannot start a job.
//
// THE GATE IS THE APP'S OWN (#395). This script does not decide for itself whether a program is fit
// to send: it builds the end state of the app's run and asks `uploadBlocker` — the function that
// disables the Upload button — so anything the button refuses is refused here too, and the two
// cannot drift apart. `src/store/engraveRunGate.ts` exists for that: the run store itself cannot be
// imported outside a browser.

import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

import ManifoldModule from 'manifold-3d';

import { asVerifiedProgram, uploadVerifiedProgram } from '../src/platform/desktop/machineBridge.ts';
import { GCODE_DIR, md5Hex } from '../src/platform/desktop/protocol.ts';
import { createNodeTransport } from '../tools/z1/transport.node.mjs';
import { engraveGenerate } from '../src/workers/sim/engraveGenerate';
import { createSimSession } from '../src/workers/sim/session';
import type { SimDiagnostic } from '../src/workers/sim/session';
import { simErrors } from '../src/engine/cnc/simGate';
import { runSheetFileName } from '../src/engine/cnc/engrave/runSheet';
import { jobTool, toSetup } from '../src/engine/cnc/engrave/jobSetup';
import { jobMachine, parseMachineCalibration, type MachineCalibration } from '../src/engine/cnc/calibration';
import { effectiveMargins, MARGIN_DEFAULTS, type MarginSettings } from '../src/engine/cnc/engrave/depthBounds';
import type { OracleReport } from '../src/engine/cnc/engrave/oracle';
import { parseEngraveJob } from '../src/store/engraveJobSchema';
import { parseMyMachineFile } from '../src/store/myMachineFile';
import { requiredAckCodes, uploadBlocker, type EngraveRunView } from '../src/store/engraveRunGate';
import type { SimStatus } from '../src/store/simStore';
import { BUNDLED_FONT_KEYS, registerBundledFontBytes } from '../src/engine/fonts/registry';

const [jobPath, host] = process.argv.slice(2);
if (!jobPath || !host) {
  console.error('usage: machine-upload-check.ts <job.json> <host>');
  process.exit(2);
}

const require = createRequire(import.meta.url);
const tl = await ManifoldModule({ locateFile: () => require.resolve('manifold-3d/manifold.wasm') });
tl.setup();

// Text labels need parsed fonts, and the app loads them by `fetch`ing a static asset, which node's
// fetch cannot do for a `file:` URL. Same seeding `scripts/engrave-job.ts` and `tests/setup/fonts.ts`
// use, so a job with text engraves here too.
for (const key of BUNDLED_FONT_KEYS) {
  const bytes = readFileSync(new URL(`../src/engine/fonts/files/${key}.ttf`, import.meta.url));
  registerBundledFontBytes(key, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

const parsed = parseEngraveJob(JSON.parse(readFileSync(jobPath, 'utf8')));
if (!parsed.ok) {
  console.error(`${jobPath} is not a valid job document:`);
  for (const e of parsed.errors) console.error(`   ${e}`);
  process.exit(2);
}
const job = parsed.job;

/**
 * The app's saved machine calibration, if the caller passed one (#279). Read from a FILE because
 * this script runs in node: the app keeps it in `localStorage`, which a headless run has none of,
 * so the record has to be handed over rather than fetched.
 */
function savedCalibration(): MachineCalibration | null {
  const flag = process.argv.indexOf('--calibration');
  if (flag === -1) return null;
  const path = process.argv[flag + 1];
  if (path === undefined) {
    console.error('--calibration needs the path of a saved calibration record');
    process.exit(2);
  }
  const parsedCal = parseMachineCalibration(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsedCal.ok) {
    console.error(`${path} is not a calibration record: ${parsedCal.reason}`);
    process.exit(2);
  }
  return parsedCal.calibration;
}

/**
 * The house depth margins the app would generate this job with (#345), read from the app's own
 * "my machine" export (#247) — or the shipped defaults when no file is given.
 *
 * WHY A FILE, AND WHY HERE. The app resolves them from `useSettingsStore`, which a headless run has
 * no localStorage for; the export carries them. This script used to call `engraveGenerate` with no
 * margins at all, which silently took the worker's own fallback — the shipped defaults — so a job
 * generated here could differ from the same job generated in the app, on the one number that gates
 * where a cut is allowed to reach (#395).
 */
/** Whether this run sends anything. `--dry` generates and prints, and stops before the socket. */
const dryRun = process.argv.includes('--dry');

/**
 * The clearance codes the caller says they have made at the machine, or null when they said nothing.
 *
 * `[]` means the flag was passed with no codes: a bare `--acknowledge`, which is the blanket tick
 * this replaces (#395 follow-up 6). It is not an error on its own — the exactness check below says
 * what it is missing, which is more useful than "bad flag", and it keeps `--acknowledge` from being
 * silently ignored by a typo.
 */
function acknowledgedCodes(): string[] | null {
  const arg = process.argv.find((a) => a === '--acknowledge' || a.startsWith('--acknowledge='));
  if (arg === undefined) return null;
  return arg
    .slice('--acknowledge='.length)
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

function houseMargins(): { margins: MarginSettings; from: string } {
  const flag = process.argv.indexOf('--my-machine');
  if (flag === -1) return { margins: MARGIN_DEFAULTS, from: 'the shipped defaults (no --my-machine)' };
  const path = process.argv[flag + 1];
  if (path === undefined) {
    console.error('--my-machine needs the path of a saved "my machine" record');
    process.exit(2);
  }
  const record = parseMyMachineFile(readFileSync(path, 'utf8'));
  if (!record.ok) {
    console.error(`${path} is not a machine record: ${record.reason}`);
    process.exit(2);
  }
  if (record.margins === null) {
    console.error(`${path} carries no margins (it was exported before #345) — pass a current one, or leave the flag off for the shipped defaults`);
    process.exit(2);
  }
  return { margins: record.margins, from: path };
}

// No Makera feed rows in a headless run (#324): the catalogue tier needs a house service.
const tool = jobTool(job);
// The machine the file is posted AND swept against, resolved ONCE (#395). `engraveGenerate`
// resolves the same profile internally and feeds the post, the setup and its own verifier from
// it; this script used to hand the sweep a bare `Z1`, which is the shipped profile with none of
// the calibration applied. Same reader, same arguments, so the two cannot judge different
// machines — and `session.load` resolves the id it is given the same way.
const calibration = savedCalibration();
const mill = jobMachine(job, calibration);
// The depth margins the APP would gate this job's cuts against (#345), for the same reason as the
// calibration above: a job carrying its own record keeps them, and one that does not runs on the
// house setting — not on whatever the worker falls back to when it is handed nothing (#395).
const house = houseMargins();

// LOOSER THAN THE BUTTON WITHOUT ITS FILES (#395 follow-up 5). The app generates this job with the
// house depth margins from `useSettingsStore`; headless, the only copy of them is the "my machine"
// export, and without it `engraveGenerate` falls back to the SHIPPED defaults (#345's out-of-the-box
// settings). That is a program that can differ from the one the Upload button would send, on the one
// number that decides where a cut is allowed to reach — so a dry run may say so and send nothing,
// and a real upload may not proceed. This is the same reason `houseMargins` exists at all (#395).
if (!dryRun && process.argv.indexOf('--my-machine') === -1) {
  console.error(
    'a real upload needs --my-machine: without it this job is generated with the SHIPPED depth margins, not the house ones the app would use, so the program may not be the one the Upload button sends. Pass the app\'s exported "my machine" record, or run with --dry.',
  );
  process.exit(2);
}
// A calibration is not required for the same reason it is not required by the app: before a probe
// there is none, `jobMachine` returns the shipped profile, and that is what the button would have
// used too. It is said out loud instead, because a run against the shipped profile looks exactly
// like a run against the machine in every other line of the receipt.
if (!dryRun && calibration === null) {
  console.error('note: no --calibration, so everything below is checked against the SHIPPED profile — the same profile the app uses before its first probe (#279).');
}

const margins = effectiveMargins(job, house.margins);
const generated = engraveGenerate(tl, job, tool, [], calibration, margins);

console.log(`job      : ${job.name}`);
console.log(
  `margins  : boundary ${margins.boundaryMargin} mm, z ±${margins.zTolerance}   (${job.margins ? "this job's own record" : house.from})`,
);
console.log(
  `machine  : ${mill.id}   ${calibration === null ? 'shipped profile (no calibration passed)' : `calibrated ${calibration.measuredAt} — ${calibration.source}`}`,
);
console.log(`stage    : ${generated.stage}   ok: ${generated.ok}`);
console.log(`verify   : ok=${generated.verify?.ok}   findings=${generated.verify?.findings.length ?? 0}`);
for (const f of generated.verify?.findings ?? []) {
  console.log(`   ${f.severity.padEnd(7)} ${f.code}: ${f.message}`);
}
for (const e of generated.errors) console.log(`   ${e.stage.padEnd(7)} ${e.message}`);

// The app's run stops here when the job has no cutter at all (`run()` sets a blocked phase with
// "the job has no usable cutter" and never sweeps). Said plainly rather than inferred from whatever
// the shared gate answers about a run that never happened.
if (tool === null) {
  console.error('\nthe job has no usable cutter — nothing is swept, prepared or sent.');
  process.exit(1);
}

// #395. THE APP'S OWN GATE, not a second list of conditions. The app runs
// generate → simulate → oracle and then asks ONE question of the end state — `uploadBlocker`, which
// is never weaker than Save's. This script is that pipeline by hand, so it builds the same end state
// and asks the same function.
//
// What it used to do instead was re-list the conditions for itself, and the list came out weaker
// than the app's in the two places that matter — a program whose sweep does not match the
// prediction (`oracle.ok`), and an unticked clearance acknowledgement (`requiredAckCodes`) — so a
// program the Upload button refuses could be carried to the card by the one tool in this repo that
// hands a file to the real machine. The sweep's own refusal WAS stated here, and correctly;
// stating a safety rule correctly in two places is what a rule does before the two drift.
//
// WHERE the app's run stops is part of the gate, not a detail: `run()` never sweeps a program
// `engraveGenerate` refused (`!ok || nc === null` returns first). Copied exactly, or this script
// would judge a program the app never judged — and the frame-file failure (#244) is exactly that
// case: `ok: false` with a PASSING `verify` and CLEAN findings, because the program is fine and the
// file beside it was refused. Sweeping it here would have turned a refusal into a pass.
const run = {
  simStatus: 'idle' as SimStatus,
  simDiagnostics: [] as SimDiagnostic[],
  oracle: null as OracleReport | null,
};
const programNc = generated.ok ? generated.nc : null;
if (programNc !== null) {
  const session = createSimSession(tl);
  const sim = session.load(programNc, toSetup(job, mill), tool, mill.id, { calibration });
  run.simStatus = sim.ok ? 'ready' : 'refused';
  run.simDiagnostics = sim.diagnostics;
  // The oracle the app's own run performs, against the same prediction and on the same session, so
  // it is the prediction this program was CAM'd from and not a second one.
  if (sim.ok) run.oracle = session.oracle(generated.predicted);
  session.dispose();
}
console.log(`sim      : ${run.simStatus}   errors=${simErrors(run.simDiagnostics).length}`);
// Named, not counted: a `ready` load can still carry an error diagnostic — a sweep that drove the
// cutter into the fixed jaw comes back `ok: true` (#393) — and the gate below refuses on it.
for (const d of simErrors(run.simDiagnostics)) console.error(`   ERROR ${d.code}: ${d.message}`);
if (run.oracle !== null) {
  console.log(`oracle   : ok=${run.oracle.ok}   band=${run.oracle.band}   worst under/over ${run.oracle.worst.underCut}/${run.oracle.worst.overCut}`);
}

// THE TICK IS PER-PROGRAM, AND SO IS THIS FLAG (#395 follow-up 6). It used to be a bare
// `--acknowledge`, which is a blanket: a habitual one waves through whatever codes this run happens
// to raise, and nothing anywhere records which were waved. The flag now NAMES them, and they have to
// be exactly the codes the run asks for — the same list `uploadBlocker` reads, so a code this run
// does not raise cannot be pre-ticked and one it does raise cannot be skipped.
const ackCodes = acknowledgedCodes();
const acknowledged = ackCodes !== null;
const view: EngraveRunView = {
  generated,
  oracle: run.oracle,
  simDiagnostics: run.simDiagnostics,
  simStatus: run.simStatus,
  // As the store leaves it: `ready` only once the oracle has passed, `blocked` otherwise. The gate
  // reads the three in-flight phases, not these, but a view that is not the app's is a view that
  // can disagree with it.
  phase: run.oracle?.ok ? 'ready' : 'blocked',
  acknowledged,
  staleSince: null,
  error: null,
};
// The run's own list, asked for once and used by both the exactness check and the refusal below.
// `requiredAckCodes` reads the job's findings, the verifier's report and the sweep — never
// `acknowledged` — so asking it here and again inside `uploadBlocker` is one question, not two.
const required = requiredAckCodes(view);
if (ackCodes !== null) {
  const missing = required.filter((c) => !ackCodes.includes(c));
  const extra = ackCodes.filter((c) => !required.includes(c));
  if (missing.length > 0 || extra.length > 0) {
    console.error('\n--acknowledge must name exactly the codes this run asks for:');
    console.error(
      `  this run asks for: ${required.length > 0 ? required.join(', ') : '(none)'}`,
    );
    console.error(
      `  --acknowledge said: ${ackCodes.length > 0 ? ackCodes.join(', ') : '(no codes — a bare --acknowledge is the blanket tick this replaces)'}`,
    );
    if (missing.length > 0) console.error(`  not named, and asked for: ${missing.join(', ')}`);
    if (extra.length > 0) console.error(`  named, and not asked for: ${extra.join(', ')}`);
    console.error('');
    process.exit(2);
  }
}

const blocker = uploadBlocker(view);
if (blocker !== null) {
  // The tick is the one the script cannot press, so it names what a person has to look at first.
  if (required.length > 0 && !acknowledged) {
    console.error(`\nthis job's run flags a clearance check for a person to make at the machine: ${required.join(', ')}.`);
    console.error(`Once they have made it, pass --acknowledge=${required.join(',')} and run again.`);
  }
  // The app's own sentence, quoted: it is what the Upload button would show, and re-wording it here
  // would be the second statement of a reason this whole change is about not having.
  console.error(`\nthe app's own upload gate refuses this program: "${blocker}" — nothing is prepared or sent.`);
  process.exit(1);
}

// What the tick waved through, in the receipt rather than only in the operator's memory (#395
// follow-up 6). The app records a tick as a boolean; this run has to say which codes it covered,
// because the log is the only record of what a person said they had checked.
if (ackCodes !== null && ackCodes.length > 0) {
  console.log(`ack      : ${ackCodes.join(', ')} — made at the machine, and said out loud here`);
}

// The gate above has already proved both of these exist — it refuses a run with no program, and one
// whose verifier report is missing — so this is the same fact, narrowed, rather than a second gate.
// It is here because a crash is not a refusal: if the gate ever stopped proving it, the honest
// answer to "may this go to the machine?" is still no.
if (generated.nc === null || generated.verify === null) {
  console.error('\nno program, or no verifier report — nothing is prepared or sent.');
  process.exit(1);
}

// The app's own name for this job, and the DIRECTORY are separate here on purpose. The first live
// run (2026-10-07) sent a bare name and the machine resolved it against the card root, answering
// `Error: failed to open file [/165-depth-ladder.nc]!` — so the name is really a path, and the
// BRIDGE is what builds it (`uploadVerifiedProgram`'s `directory`, defaulting to `GCODE_DIR`).
// Passing the two halves separately is what exercises that join; `--name` is a bare filename.
const nameFlag = process.argv.indexOf('--name');
const filename = nameFlag === -1 ? runSheetFileName(job.name) : process.argv[nameFlag + 1]!;
const dirFlag = process.argv.indexOf('--dir');
const directory = dirFlag === -1 ? undefined : process.argv[dirFlag + 1]!;
const program = asVerifiedProgram(filename, new TextEncoder().encode(generated.nc), generated.verify);
if (program === null) {
  console.error('\nthe gate refused this program — nothing is sent.');
  process.exit(1);
}

// The MD5 the machine will compare against its own copy, and the bytes themselves on disk so the
// card can be checked independently of anything this script claims (`tools/z1/z1.mjs md5 <path>`).
// The copy goes to the system temp dir, not the repo: it exists to be hashed, not to be kept, and
// a byte-identical duplicate of a committed program is not something to leave lying in the tree.
const md5 = md5Hex(program.content);
const localPath = join(tmpdir(), filename.split('/').pop() ?? 'program.nc');
writeFileSync(localPath, program.content);
console.log(`local    : ${localPath}`);
console.log(`md5      : ${md5}`);

if (dryRun) {
  console.log('\n--dry: nothing sent.');
  process.exit(0);
}

// --verbose wraps the socket and prints every byte in both directions. The frame type the machine
// cancels with, and any text it attaches, is the whole question — a cancel is documented as meaning
// BOTH "already present" and "refused", so the payload is the only thing that could tell them apart.
const verbose = process.argv.includes('--verbose');
const base = createNodeTransport();
const hex = (b: Uint8Array) =>
  Array.from(b)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join(' ');
const printable = (b: Uint8Array) =>
  Array.from(b)
    .map((x) => (x >= 0x20 && x < 0x7f ? String.fromCharCode(x) : '.'))
    .join('');
const transport = verbose
  ? {
      ...base,
      async tcpWrite(conn: number, data: Uint8Array) {
        console.log(`  -> ${data.length}B  ${hex(data)}`);
        console.log(`     "${printable(data)}"`);
        return base.tcpWrite(conn, data);
      },
      async tcpRead(conn: number, max: number, timeoutMs: number) {
        const data = await base.tcpRead(conn, max, timeoutMs);
        console.log(`  <- ${data.length}B  ${hex(data)}`);
        console.log(`     "${printable(data)}"`);
        return data;
      },
    }
  : base;

const destination = `${(directory ?? GCODE_DIR).replace(/\/+$/, '')}/${filename}`;
console.log(`\nuploading ${destination}  (${program.content.length} bytes)  ->  ${host}:2222`);
const outcome = await uploadVerifiedProgram({ host }, program, { transport, directory });
console.log('outcome  :', JSON.stringify(outcome));
process.exit(outcome.ok ? 0 : 1);
