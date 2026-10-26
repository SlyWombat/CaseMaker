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
//
// #502 — THE PIPELINE IS THE LIBRARY'S. generate → sweep → oracle → `uploadBlocker` live in
// `scripts/lib/casemaker/verifiedProgram.ts` (`prepareVerifiedProgram`), the same function
// `casemaker machine upload` calls, so the two tools cannot drift apart on the one safety rule they
// share. This script keeps its own argument handling, its own receipt lines and its own `--verbose`
// byte trace; only the pipeline it calls changed.

import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { asVerifiedProgram, uploadVerifiedProgram } from '../src/platform/desktop/machineBridge.ts';
import { verifyCheck } from '../src/engine/cnc/uploadGate.ts';
import { GCODE_DIR, md5Hex, type MachineTransport } from '../src/platform/desktop/protocol.ts';
import { createNodeTransport } from '../tools/z1/transport.node.mjs';
import {
  prepareVerifiedProgram,
  simulationErrors,
  type PrepareOptions,
  type PrepareResult,
  type PreparedProgram,
} from './lib/casemaker/verifiedProgram';

/** The dependency seam: the socket layer, and the prepare pipeline a spec replaces. */
export interface UploadCheckDeps {
  /** The five-call transport. Production: the Node sockets; specs: a fake. */
  transport: MachineTransport;
  /** The job → verified-program pipeline. Production: `prepareVerifiedProgram`. */
  prepare?: (jobPath: string, opts: PrepareOptions) => Promise<PrepareResult>;
}

/** The clearance codes `--acknowledge` named, or null when the caller said nothing (#395 f6). */
function acknowledgedCodes(argv: string[]): string[] | null {
  const arg = argv.find((a) => a === '--acknowledge' || a.startsWith('--acknowledge='));
  if (arg === undefined) return null;
  return arg
    .slice('--acknowledge='.length)
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

/** The value of `--flag`, or null when absent. A flag present with no value is a usage error. */
function flagValue(argv: string[], flag: string, what: string): { path: string | null; error: string | null } {
  const i = argv.indexOf(flag);
  if (i === -1) return { path: null, error: null };
  const v = argv[i + 1];
  if (v === undefined) return { path: null, error: `${flag} needs the path of a saved ${what} record` };
  return { path: v, error: null };
}

/** The report the script prints for a generated run, from the library's prepared program. */
function printReport(program: PreparedProgram): void {
  console.log(`job      : ${program.jobName}`);
  console.log(
    `margins  : boundary ${program.margins.boundaryMargin} mm, z ±${program.margins.zTolerance}   (${program.marginsFrom})`,
  );
  console.log(
    `machine  : ${program.machineId}   ${program.calibrationNote === null ? 'shipped profile (no calibration passed)' : program.calibrationNote}`,
  );
  console.log(`stage    : ${program.stage}   ok: ${program.ok}`);
  console.log(`verify   : ok=${program.verify.ok}   findings=${program.verify.findings.length}`);
  for (const f of program.verify.findings) {
    console.log(`   ${f.severity.padEnd(7)} ${f.code}: ${f.message}`);
  }
  for (const e of program.errors) console.log(`   ${e.stage.padEnd(7)} ${e.message}`);
  const simErrors = simulationErrors(program);
  console.log(`sim      : ${program.sim.status}   errors=${simErrors.length}`);
  for (const d of simErrors) console.error(`   ERROR ${d.code}: ${d.message}`);
  if (program.sim.oracle !== null) {
    console.log(`oracle   : ok=${program.sim.oracle.ok}   band=${program.sim.oracle.band}   worst under/over ${program.sim.oracle.worst.underCut}/${program.sim.oracle.worst.overCut}`);
  }
}

export async function machineUploadCheck(argv: string[], deps?: UploadCheckDeps): Promise<number> {
  const [jobPath, host] = argv;
  if (!jobPath || !host) {
    console.error('usage: machine-upload-check.ts <job.json> <host>');
    return 2;
  }

  const dryRun = argv.includes('--dry');
  const ackCodes = acknowledgedCodes(argv);

  const calibrationFlag = flagValue(argv, '--calibration', 'calibration');
  if (calibrationFlag.error !== null) {
    console.error(calibrationFlag.error);
    return 2;
  }
  const machineFlag = flagValue(argv, '--my-machine', '"my machine"');
  if (machineFlag.error !== null) {
    console.error(machineFlag.error);
    return 2;
  }

  // LOOSER THAN THE BUTTON WITHOUT ITS FILES (#395 follow-up 5). A real upload must be generated
  // with the house depth margins the app would use, which only the "my machine" export carries
  // headless. A dry run may say so and send nothing; a real upload may not proceed.
  if (!dryRun && machineFlag.path === null) {
    console.error(
      'a real upload needs --my-machine: without it this job is generated with the SHIPPED depth margins, not the house ones the app would use, so the program may not be the one the Upload button sends. Pass the app\'s exported "my machine" record, or run with --dry.',
    );
    return 2;
  }
  // A calibration is not required for the same reason it is not required by the app: before a probe
  // there is none, `jobMachine` returns the shipped profile, and that is what the button would have
  // used too. It is said out loud instead, because a run against the shipped profile looks exactly
  // like a run against the machine in every other line of the receipt.
  if (!dryRun && calibrationFlag.path === null) {
    console.error('note: no --calibration, so everything below is checked against the SHIPPED profile — the same profile the app uses before its first probe (#279).');
  }

  const prepare = deps?.prepare ?? prepareVerifiedProgram;
  let result: PrepareResult;
  try {
    result = await prepare(jobPath, {
      myMachine: machineFlag.path ?? undefined,
      calibration: calibrationFlag.path ?? undefined,
      acknowledged: ackCodes,
    });
  } catch (e) {
    // An unreadable --my-machine or --calibration record is a usage error, not a refusal.
    if (e instanceof Error) {
      console.error(e.message);
      return 2;
    }
    throw e;
  }

  if (!result.ok) {
    if (result.stage === 'job') {
      console.error(result.reason);
      return 2;
    }
    // The report the generate produced (there is none yet when the job did not parse), then the
    // script's own stop — the same lines it printed before it delegated the pipeline.
    if (result.stage === 'findings') {
      console.error('\nthe job has no usable cutter — nothing is swept, prepared or sent.');
    } else {
      console.error('\nno program, or no verifier report — nothing is prepared or sent.');
    }
    return 1;
  }

  const program = result.program;
  printReport(program);

  // The ack exactness the library already judged. The tick is per-program, and a blanket one waves
  // through whatever this run raises — the flag must name exactly what the run asks for.
  if (program.ackError !== null) {
    console.error(`\n${program.ackError}`);
    return 2;
  }

  if (program.blocker !== null) {
    if (program.requiredAcks.length > 0) {
      console.error(`\nthis job's run flags a clearance check for a person to make at the machine: ${program.requiredAcks.join(', ')}.`);
      console.error(`Once they have made it, pass --acknowledge=${program.requiredAcks.join(',')} and run again.`);
    }
    // The app's own sentence, quoted: it is what the Upload button would show, and re-wording it
    // here would be the second statement of a reason this whole change is about not having.
    console.error(`\nthe app's own upload gate refuses this program: "${program.blocker}" — nothing is prepared or sent.`);
    return 1;
  }

  // What the tick waved through, in the receipt rather than only in the operator's memory (#395 f6).
  if (ackCodes !== null && ackCodes.length > 0) {
    console.log(`ack      : ${ackCodes.join(', ')} — made at the machine, and said out loud here`);
  }

  // The app's own name for this job, and the DIRECTORY are separate here on purpose. The first live
  // run (2026-10-07) sent a bare name and the machine resolved it against the card root, answering
  // `Error: failed to open file [/165-depth-ladder.nc]!` — so the name is really a path, and the
  // BRIDGE is what builds it (`uploadVerifiedProgram`'s `directory`, defaulting to `GCODE_DIR`).
  // Passing the two halves separately is what exercises that join; `--name` is a bare filename.
  const nameFlag = argv.indexOf('--name');
  const filename = nameFlag === -1 ? program.filename : argv[nameFlag + 1]!;
  const dirFlag = argv.indexOf('--dir');
  const directory = dirFlag === -1 ? undefined : argv[dirFlag + 1]!;
  const programBytes = new TextEncoder().encode(program.nc);
  // #535 — the seam takes one check type; this script's program carries the verifier's report.
  const verified = asVerifiedProgram(filename, programBytes, verifyCheck(program.verify));
  if (verified === null) {
    console.error('\nthe gate refused this program — nothing is sent.');
    return 1;
  }

  // The MD5 the machine will compare against its own copy, and the bytes themselves on disk so the
  // card can be checked independently of anything this script claims (`tools/z1/z1.mjs md5 <path>`).
  const md5 = md5Hex(verified.content);
  const localPath = join(tmpdir(), filename.split('/').pop() ?? 'program.nc');
  writeFileSync(localPath, verified.content);
  console.log(`local    : ${localPath}`);
  console.log(`md5      : ${md5}`);

  if (dryRun) {
    console.log('\n--dry: nothing sent.');
    return 0;
  }

  // --verbose wraps the socket and prints every byte in both directions.
  const verbose = argv.includes('--verbose');
  const base = deps?.transport ?? createNodeTransport();
  const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join(' ');
  const printable = (b: Uint8Array) =>
    Array.from(b).map((x) => (x >= 0x20 && x < 0x7f ? String.fromCharCode(x) : '.')).join('');
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
  console.log(`\nuploading ${destination}  (${verified.content.length} bytes)  ->  ${host}:2222`);
  const outcome = await uploadVerifiedProgram({ host }, verified, { transport, directory });
  console.log('outcome  :', JSON.stringify(outcome));
  return outcome.ok ? 0 : 1;
}

// Run only when executed directly — a spec imports `machineUploadCheck` and drives it with fakes,
// so the top-level `process.exit` must not fire on import.
const isDirect = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirect) {
  const exit = await machineUploadCheck(process.argv.slice(2));
  process.exit(exit);
}
