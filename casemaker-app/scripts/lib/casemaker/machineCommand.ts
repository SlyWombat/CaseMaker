/**
 * `casemaker machine …` (#477) — the commands that speak to the controller.
 *
 * THE LINE (#479's decision, with the maintainer's amendment). Power is OUTSIDE Case Maker: the
 * smart plug is this bench's fixture, not a product assumption, and `tools/z1/power.sh` stays a
 * bench script. Nothing in this module reads or switches it.
 *
 *   Read, unattended:      status · version · hashes · finished
 *   Physical, confirmed:   upload · play            (behind `--confirm <program hash>`)
 *                          home · probe            (behind the literal word: `--confirm home|probe`)
 *   Never here:            a generate chained into a play; any MCP tool (#481's server has none)
 *
 * The two reads that touch the LAN are the same protocol calls the app's bridge uses — `runStatus`,
 * `readConfigKey`, `runMd5Sum` — over the same `MachineTransport` seam (`tools/z1/transport.node.mjs`
 * in Node, the Tauri transport in the app). There is no second reader of the wire here.
 *
 * WHY `finished` IS NOT A MACHINE READ. The hashes a machine has finished cleanly live in its own
 * record, written by the app's append endpoint (`finishedProgramsClient.ts`), not on the controller.
 * The command reads the resolved location document and prints that list; nothing is sent.
 *
 * THE OUTPUT IS A RECEIPT. Every result line comes from `renderReceipt` (#478), so `--json` and the
 * terminal carry the same facts. A usage error is printed before a receipt exists and exits 2; a
 * command that opened a socket and was refused emits an `ok: false` receipt and exits 1.
 *
 * SAFETY OF THE PATH ARGUMENTS. `hashes` and `play` take absolute card paths only, and the protocol
 * itself builds the `md5sum`/`cat`/`play` line from a pattern-checked path — this module never sends
 * free text. `play` never uploads, never homes, and never touches the vacuum.
 */
import {
  COMMAND_TCP_PORT,
  GCODE_DIR,
  MIN_STATUS_POLL_MS,
  alarmLine,
  openConsole,
  playProgramLine,
  readConfigKey,
  readJobProgress,
  runMd5Sum,
  runReadFile,
  runStatus,
  uploadPath,
  type MachineTransport,
} from '../../../src/platform/desktop/protocol.ts';
import { asVerifiedProgram, uploadVerifiedProgram } from '../../../src/platform/desktop/machineBridge';
import { verifyCheck } from '../../../src/engine/cnc/uploadGate';
import {
  setMachineUploadLoader,
  uploadProgram,
  type MachineUploadClient,
  type MachineUploadResult,
} from '../../../src/platform/machineUpload';
import { programHash } from '../../../src/engine/cnc/programHash';
import { lastPrb } from '../../../src/engine/cnc/registration/readings';
import { CONSOLE_TIMING } from '../../../src/platform/machineConsole';
import type { VerifyReport } from '../../../src/engine/cnc/verify';
import { createNodeTransport } from '../../../tools/z1/transport.node.mjs';
import { loadLocation, LocationDocumentError, type LoadedLocation } from '../../../src/platform/headless/bootstrap';
import {
  diagnostic,
  RECEIPT_VERSION,
  type MachineDetails,
  type MachineStatusRead,
  type Receipt,
  type ReceiptDiagnostic,
  type ReceiptFile,
  type ReceiptRefusal,
} from '../../../src/platform/headless/receipt';
import type { MachineRecord } from '../../../src/platform/locationClient';
import { CliExit, isCliExit } from './exit';
import { commandOutput, HUMAN, type CommandOptions } from './output';
import { fileReceipt } from './receiptFiles';
import {
  prepareVerifiedProgram,
  type PreparedProgram,
  type PrepareOptions,
  type PrepareResult,
} from './verifiedProgram';

const SECTIONS = ['status', 'version', 'hashes', 'finished', 'upload', 'play', 'home', 'probe'] as const;
type Section = (typeof SECTIONS)[number];

const USAGE =
  'usage: casemaker machine status  [--host <ip>] [--port <n>] [--location <file>]\n' +
  '       casemaker machine version [--host <ip>] [--port <n>] [--location <file>]\n' +
  '       casemaker machine hashes  <card-path> [<card-path> ...] [--host <ip>] [--port <n>]\n' +
  '       casemaker machine finished [--machine <id>] [--location <file>]\n' +
  '       casemaker machine upload  <job.json> --dry | --confirm <program hash>\n' +
  '              [--my-machine <file>] [--calibration <file>] [--acknowledge=<codes>]\n' +
  '              [--dir <card dir>] [--host <ip>] [--port <n>]\n' +
  '       casemaker machine play    <card-path> --confirm <program hash> [--timeout <seconds>]\n' +
  '              [--poll <ms, >= 2000>] [--host <ip>] [--port <n>]\n' +
  '       casemaker machine home    --confirm home [--timeout <seconds>] [--poll <ms, >= 2000>]\n' +
  '       casemaker machine probe   --confirm probe [--timeout <seconds>] [--poll <ms, >= 2000>]\n' +
  '\n' +
  'Reads, unattended: status polls `?`, version reads the `version` key from /sd/config.txt,\n' +
  'hashes asks the controller for its own MD5 of files it holds, and finished reads the machine\n' +
  'record’s finished-program list.\n' +
  '\n' +
  'PHYSICAL, and only with the token that names what will move: upload sends the program a job\n' +
  'generates, but only when --confirm names its FNV hash (--dry prints the hash and sends nothing);\n' +
  'play runs a file the CARD ALREADY HOLDS, but only when --confirm names the hash of the bytes the\n' +
  'card returns; home sends `$H`, and probe sends `M491` (the tool-length probe — fit the wired\n' +
  'probe first; it does NOT home, run `machine home` for that). Those two have no program to hash,\n' +
  'so their token is the literal word: `--confirm home` and `--confirm probe`, and nothing else.\n' +
  'The bench rule is `$H` before every bit change, so the operator\'s order is home → fit the\n' +
  'probe → probe, each as its own command.\n' +
  'Nothing here switches power (#479: the plug is outside Case Maker), and nothing generates and\n' +
  'plays in one step.';

/** The connect window: the app's own 3 s connect timeout. */
const CONNECT_TIMEOUT_MS = 3000;

interface Args {
  section?: Section;
  host?: string;
  port: number;
  location?: string;
  machine?: string;
  paths: string[];
  confirm?: string;
  dry: boolean;
  dir?: string;
  myMachine?: string;
  calibration?: string;
  acknowledge: string[] | null;
  timeoutS?: number;
  pollMs: number;
}

/** `--acknowledge=a,b` and a bare `--acknowledge` (an empty list) both parse, as the bench does. */
function acknowledgeValue(arg: string): string[] {
  const raw = arg.slice('--acknowledge'.length).replace(/^=/, '');
  return raw
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

function parseArgs(argv: string[]): Args {
  const args: Args = { port: COMMAND_TCP_PORT, paths: [], dry: false, acknowledge: null, pollMs: MIN_STATUS_POLL_MS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--host') {
      const v = argv[++i];
      if (v === undefined) throw new Error('--host needs an address');
      args.host = v;
    } else if (a === '--port') {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v < 1 || v > 65535) throw new Error('--port must be a TCP port number');
      args.port = v;
    } else if (a === '--location') {
      const v = argv[++i];
      if (v === undefined) throw new Error('--location needs a file');
      args.location = v;
    } else if (a === '--machine') {
      const v = argv[++i];
      if (v === undefined) throw new Error('--machine needs a machine record id');
      args.machine = v;
    } else if (a === '--confirm') {
      const v = argv[++i];
      if (v === undefined) throw new Error('--confirm needs the program hash (or the word "probe"/"home")');
      args.confirm = v;
    } else if (a === '--dry') {
      args.dry = true;
    } else if (a === '--dir') {
      const v = argv[++i];
      if (v === undefined) throw new Error('--dir needs the card directory the program lands in');
      args.dir = v;
    } else if (a === '--my-machine') {
      const v = argv[++i];
      if (v === undefined) throw new Error('--my-machine needs the app’s exported machine record');
      args.myMachine = v;
    } else if (a === '--calibration') {
      const v = argv[++i];
      if (v === undefined) throw new Error('--calibration needs a saved calibration record');
      args.calibration = v;
    } else if (a !== undefined && (a === '--acknowledge' || a.startsWith('--acknowledge='))) {
      args.acknowledge = acknowledgeValue(a);
    } else if (a === '--timeout') {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v <= 0) throw new Error('--timeout must be a whole number of seconds');
      args.timeoutS = v;
    } else if (a === '--poll') {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v < MIN_STATUS_POLL_MS) {
        throw new Error(`--poll must be at least ${MIN_STATUS_POLL_MS} ms — a faster poll faulted the controller on 2026-10-12`);
      }
      args.pollMs = v;
    } else if (a !== undefined && a.startsWith('--')) throw new Error(`unknown flag "${a}"`);
    else if (args.section === undefined) {
      if (!(SECTIONS as readonly string[]).includes(a ?? '')) {
        throw new Error(`"${a}" is not a machine command — one of ${SECTIONS.join(', ')}`);
      }
      args.section = a as Section;
    } else args.paths.push(a as string);
  }
  if (args.section === undefined) throw new Error(`no machine command given\n\n${USAGE}`);
  return args;
}

/**
 * Flags each command accepts, refused by name rather than ignored. A `--confirm` on `status` is a
 * caller who thinks they are running something else; a silent no-op would let that stand.
 */
function validateArgs(args: Args): void {
  const section = args.section as Section;
  const hasFlags = (): string[] => {
    const used: string[] = [];
    if (args.confirm !== undefined) used.push('--confirm');
    if (args.dry) used.push('--dry');
    if (args.dir !== undefined) used.push('--dir');
    if (args.myMachine !== undefined) used.push('--my-machine');
    if (args.calibration !== undefined) used.push('--calibration');
    if (args.acknowledge !== null) used.push('--acknowledge');
    if (args.timeoutS !== undefined) used.push('--timeout');
    if (args.pollMs !== MIN_STATUS_POLL_MS) used.push('--poll');
    return used;
  };

  if (section === 'upload') {
    if (args.paths.length !== 1) fail('upload needs exactly one job document');
    if (args.dry === (args.confirm !== undefined)) {
      fail('upload needs exactly one of --confirm <program hash> or --dry');
    }
    if (args.timeoutS !== undefined || args.pollMs !== MIN_STATUS_POLL_MS) {
      fail('upload takes no --timeout or --poll — it does not follow a job');
    }
    return;
  }
  if (section === 'play') {
    if (args.paths.length !== 1) fail('play needs exactly one card path (e.g. /sd/gcodes/badge.nc)');
    if (args.confirm === undefined) {
      fail('play needs --confirm <program hash> — the hash of the bytes the CARD holds (see `machine hashes`)');
    }
    if (args.dry) fail('play takes no --dry — the card read and its hash are what --confirm is checked against');
    if (args.dir !== undefined) fail('play takes no --dir: the path you named is the file it runs');
    if (args.myMachine !== undefined || args.calibration !== undefined || args.acknowledge !== null) {
      fail('play takes no --my-machine, --calibration or --acknowledge — nothing is generated');
    }
    return;
  }
  if (section === 'home' || section === 'probe') {
    if (args.paths.length > 0) fail(`${section} takes no arguments, not "${args.paths[0]}"`);
    // No program is generated, so there is no hash to name. The token is the word itself (#479's
    // amendment): it says which physical act the caller means, and it cannot be obtained by accident.
    if (args.confirm !== section) {
      fail(`${section} has no program to hash — its confirmation token is the literal word: --confirm ${section}`);
    }
    if (args.dry) fail(`${section} takes no --dry — the word IS the confirmation; without it nothing is sent`);
    const refused: string[] = [];
    if (args.dir !== undefined) refused.push('--dir');
    if (args.myMachine !== undefined) refused.push('--my-machine');
    if (args.calibration !== undefined) refused.push('--calibration');
    if (args.acknowledge !== null) refused.push('--acknowledge');
    if (refused.length > 0) fail(`${section} takes none of ${refused.join(', ')} — nothing is generated or cleared here`);
    return;
  }
  const used = hasFlags();
  if (used.length > 0) fail(`${section} is a read and takes none of ${used.join(', ')}`);
}

function fail(message: string, code = 2): never {
  console.error(`casemaker machine: ${message}`);
  throw new CliExit(code);
}

/** The document, or a refusal that says which file could not be read. */
function documentOf(args: Args, locate: (path?: string) => LoadedLocation | null): LoadedLocation | null {
  try {
    return locate(args.location);
  } catch (e) {
    if (e instanceof LocationDocumentError) fail(e.message);
    throw e;
  }
}

/**
 * Where to reach the machine. `--host` wins; otherwise the resolved document must name exactly one
 * machine with an address. Nothing is discovered on the network by default: a broadcast is a read
 * this command has no need to send, and "which machine" is a question the document already answers.
 */
function targetOf(args: Args, locate: (path?: string) => LoadedLocation | null): { host: string; port: number } {
  if (args.host !== undefined) return { host: args.host, port: args.port };
  const loaded = documentOf(args, locate);
  if (loaded === null) {
    fail('no machine address — pass --host <ip> (there is no location.json or house.json here)');
  }
  const addressed = loaded.machines.filter((m) => m.address !== null);
  if (addressed.length === 0) {
    fail(`no machine in ${loaded.path} has an address — pass --host <ip>`);
  }
  if (addressed.length > 1) {
    const names = addressed
      .map((m) => (m.address === null ? m.id : `${m.id} @${m.address.host}:${m.address.port}`))
      .join(', ');
    fail(`${loaded.path} names ${addressed.length} machines (${names}) — pass --host <ip>`);
  }
  const only = addressed[0] as MachineRecord;
  const address = only.address;
  if (address === null) fail(`machine ${only.id} has no address — pass --host <ip>`);
  return { host: address.host, port: address.port };
}

/** The machine record `finished` reports on: the named one, or the document's only one. */
function recordOf(args: Args, locate: (path?: string) => LoadedLocation | null): MachineRecord {
  const loaded = documentOf(args, locate);
  if (loaded === null) {
    fail('no machine record — pass --location <file> (there is no location.json or house.json here)');
  }
  if (loaded.machines.length === 0) fail(`${loaded.path} has no machine records`);
  if (args.machine !== undefined) {
    const found = loaded.machines.find((m) => m.id === args.machine);
    if (found === undefined) {
      fail(`${loaded.path} has no machine "${args.machine}" — it names ${loaded.machines.map((m) => m.id).join(', ')}`);
    }
    return found;
  }
  if (loaded.machines.length > 1) {
    fail(`${loaded.path} names ${loaded.machines.length} machines — pass --machine <id>`);
  }
  return loaded.machines[0] as MachineRecord;
}

/**
 * The controller's own alarm line, if it said one.
 *
 * `alarmLine` returns the FIRST line carrying the dialect's alarm words, and the status line
 * `<Alarm|…>` is one of them — so a reply that also carried a real `ALARM: Probe fail` would have
 * the state word quoted instead of the sentence. This reads the alarm lines that are NOT the status
 * line first, then the diagnostics frames, and falls back to the state word only when that is all
 * the controller said. The words themselves are still `alarmLine`'s; this only picks which line.
 */
function alarmOf(text: string | null, diagnostics: string[]): string | null {
  if (text !== null) {
    for (const line of text.split(/\r?\n/)) {
      if (line.trim().startsWith('<')) continue;
      const found = alarmLine(line);
      if (found !== null) return found;
    }
  }
  const fromDiagnostics = alarmLine(diagnostics.join('\n'));
  if (fromDiagnostics !== null) return fromDiagnostics;
  if (text === null) return null;
  const first = text.split(/\r?\n/)[0];
  return first === undefined ? null : alarmLine(first);
}

/** The receipt envelope for a machine run; the details differ per section. */
function machineReceipt(
  details: MachineDetails,
  ok: boolean,
  refusals: ReceiptRefusal[],
  extra: { inputs?: ReceiptFile[]; diagnostics?: ReceiptDiagnostic[] } = {},
): Extract<Receipt, { command: 'machine' }> {
  return {
    version: RECEIPT_VERSION,
    command: 'machine',
    ok,
    stage: details.section,
    gate: null,
    inputs: extra.inputs ?? [],
    outputs: [],
    diagnostics: extra.diagnostics ?? [],
    provenance: [],
    refusals,
    details,
  };
}

/** Every code the preparer's run raised, in the receipt's own vocabulary. */
function prepareDiagnostics(program: PreparedProgram): ReceiptDiagnostic[] {
  const out: ReceiptDiagnostic[] = [];
  for (const f of program.findings) {
    out.push(diagnostic(f.code, f.severity, f.message, 'findings', program.jobName));
  }
  for (const f of program.verify.findings) {
    out.push(diagnostic(f.code, f.severity, f.message, 'verify', program.jobName));
  }
  for (const d of program.sim.diagnostics) {
    out.push(diagnostic(d.code, d.severity, d.message, 'simulation', program.jobName));
  }
  return out;
}

/** A status line read the way `machine status` reads one. */
function statusRead(text: string | null, diagnostics: string[] = []): MachineStatusRead {
  const progress = text === null ? null : readJobProgress(text);
  return {
    line: text,
    state: progress?.state ?? null,
    progressLine: progress?.line ?? null,
    percent: progress?.percent ?? null,
    elapsedS: progress?.elapsedS ?? null,
    alarm: alarmOf(text, diagnostics),
    finished: progress?.state === 'Idle' && progress?.percent === 100,
  };
}

function emptyDetails(section: Section, host: string | null, port: number): MachineDetails {
  return {
    section,
    host,
    port,
    status: null,
    version: null,
    hashes: [],
    finished: null,
    action: null,
    probe: null,
  };
}

/** What the dependency seam is: the socket layer, and the document reader a spec replaces. */
export interface MachineDeps {
  /** The five-call transport. Production: the Node sockets; specs: a fake. */
  transport: MachineTransport;
  /** The document reader. Production: `loadLocation`; specs pass a fixture without touching disk. */
  locate?: (path?: string) => LoadedLocation | null;
  /**
   * `upload`'s job → verified-program pipeline. Production: `prepareVerifiedProgram`; a spec
   * replaces it so the upload paths are driven without running the wasm generator.
   */
  prepare?: (jobPath: string, opts: PrepareOptions) => Promise<PrepareResult>;
  /** `upload`'s gate and transfer. Production: the app's `uploadProgram`; a spec fakes it. */
  upload?: (
    target: { host: string; port: number },
    program: { filename: string; nc: string; verify: VerifyReport },
    transport: MachineTransport,
  ) => Promise<MachineUploadResult>;
  /** `play`'s wait between polls, so a spec never sleeps for a real interval. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The app's own upload path, reached through its test seam. `machineUpload.ts` loads the Tauri
 * bridge by default; under Node there is no such bridge, so the loader is pointed at the same
 * functions over the injected transport — the identical gate and idle check, with only the socket
 * underneath switched, exactly as `scripts/machine-upload-check.ts` does.
 */
async function uploadThroughApp(
  target: { host: string; port: number },
  program: { filename: string; nc: string; verify: VerifyReport },
  transport: MachineTransport,
): Promise<MachineUploadResult> {
  const client: MachineUploadClient = {
    status: async (t) => {
      const conn = await transport.tcpConnect(t.host, t.port, CONNECT_TIMEOUT_MS);
      try {
        const read = await runStatus(transport, conn);
        return { ok: read.ok, text: read.text };
      } finally {
        await transport.tcpClose(conn);
      }
    },
    upload: async (t, p) => {
      const verified = asVerifiedProgram(p.filename, p.content, p.check);
      if (verified === null) {
        return { ok: false, reason: 'error', detail: 'the program has not passed the verifier' };
      }
      return uploadVerifiedProgram(t, verified, { transport, connectTimeoutMs: CONNECT_TIMEOUT_MS });
    },
  };
  setMachineUploadLoader(async () => client);
  try {
    // #535 — the upload seam speaks one check type; the CLI's programs carry the verifier's report.
    return await uploadProgram(target, { filename: program.filename, nc: program.nc, check: verifyCheck(program.verify) });
  } finally {
    setMachineUploadLoader(null);
  }
}

/**
 * The production seam. Built lazily so importing this module for its types (or a spec's fake
 * transport) never opens the Node socket layer.
 */
function defaultDeps(): MachineDeps {
  return {
    transport: createNodeTransport(),
    locate: (path) => loadLocation(path),
    prepare: prepareVerifiedProgram,
    upload: uploadThroughApp,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/** The handler `handlers.ts` binds; `machineMain` is the dispatcher-facing wrapper. */
export async function machineMain(
  argv: string[],
  options: CommandOptions = HUMAN,
  deps?: MachineDeps,
): Promise<number> {
  try {
    return await machineBody(argv, options, deps ?? defaultDeps());
  } catch (e) {
    if (isCliExit(e)) return e.code;
    if (e instanceof Error) {
      console.error(`casemaker machine: ${e.message}`);
      return 2;
    }
    throw e;
  }
}

async function machineBody(argv: string[], options: CommandOptions, deps: MachineDeps): Promise<number> {
  const args = parseArgs(argv);
  validateArgs(args);
  const section = args.section as Section;
  const locate = deps.locate ?? ((path?: string) => loadLocation(path));
  const out = commandOutput(options);

  if (section === 'upload') return uploadBody(args, options, deps, locate);
  if (section === 'play') return playBody(args, options, deps, locate);
  if (section === 'home' || section === 'probe') return physicalBody(args, options, deps, locate);

  if (section === 'finished') {
    const record = recordOf(args, locate);
    const receipt = machineReceipt(
      {
        ...emptyDetails('finished', null, args.port),
        finished: { machine: record.id, hashes: [...record.finishedPrograms] },
      },
      true,
      [],
    );
    out.emitReceipt(receipt);
    return 0;
  }

  if (section === 'hashes' && args.paths.length === 0) {
    fail('hashes needs at least one absolute path on the card, e.g. /sd/gcodes/badge.nc');
  }
  if (section !== 'hashes' && args.paths.length > 0) {
    fail(`${section} takes no arguments, not "${args.paths[0]}"`);
  }

  const target = targetOf(args, locate);
  const details = emptyDetails(section, target.host, target.port);
  const refusals: ReceiptRefusal[] = [];
  let ok = true;

  let conn: number;
  try {
    conn = await deps.transport.tcpConnect(target.host, target.port, CONNECT_TIMEOUT_MS);
  } catch (e) {
    out.progress(`could not reach ${target.host}:${target.port} — nothing was sent`);
    refusals.push({
      code: 'machine-unreachable',
      reason: `could not connect to ${target.host}:${target.port}: ${e instanceof Error ? e.message : String(e)}`,
    });
    out.emitReceipt(machineReceipt(details, false, refusals));
    return 1;
  }

  try {
    if (section === 'status') {
      const read = await runStatus(deps.transport, conn);
      const text = read.text;
      const progress = text === null ? null : readJobProgress(text);
      const alarm = alarmOf(text, read.diagnostics);
      const status: MachineStatusRead = {
        line: text,
        state: progress?.state ?? null,
        progressLine: progress?.line ?? null,
        percent: progress?.percent ?? null,
        elapsedS: progress?.elapsedS ?? null,
        alarm,
        finished: progress?.state === 'Idle' && progress?.percent === 100,
      };
      details.status = status;
      if (!read.ok) {
        ok = false;
        refusals.push({
          code: 'status-no-reply',
          reason: 'the machine did not answer a status poll — the read returned nothing',
        });
      }
    } else if (section === 'version') {
      const read = await readConfigKey(deps.transport, conn, 'version', { source: 'sd' });
      if (read.ok) details.version = read.value;
      else {
        ok = false;
        refusals.push({
          code: 'version-unread',
          reason: `the controller’s version could not be read: ${read.detail}`,
        });
      }
    } else {
      for (const path of args.paths) {
        const read = await runMd5Sum(deps.transport, conn, path);
        details.hashes.push({
          path,
          md5: read.ok ? read.md5 : null,
          detail: read.ok ? null : read.detail,
        });
        if (!read.ok) ok = false;
      }
      if (!ok) {
        refusals.push({
          code: 'hash-unread',
          reason: 'the controller did not return a digest for every file asked about',
        });
      }
    }
  } finally {
    await deps.transport.tcpClose(conn);
  }

  out.emitReceipt(machineReceipt(details, ok, refusals));
  return ok ? 0 : 1;
}

/** A failed upload's own receipt refusal — the app's six outcomes, each named for what happened. */
function uploadRefusal(outcome: Exclude<MachineUploadResult, { kind: 'uploaded' }>): ReceiptRefusal {
  switch (outcome.kind) {
    case 'busy':
      return { code: 'machine-busy', reason: outcome.detail };
    case 'refused':
      return { code: 'upload-refused', reason: `the machine declined the transfer: ${outcome.detail}` };
    case 'timeout':
      return { code: 'upload-timeout', reason: outcome.detail };
    case 'error':
      return { code: 'upload-error', reason: outcome.detail };
    case 'unavailable':
      return { code: 'machine-unavailable', reason: outcome.reason };
  }
}

/**
 * Why the machine may not be started now, or null. The app's own rule (`machineUpload.ts`): an
 * alarm outranks the state word, only `Idle` passes, and `Idle` with a `P:` below 100 is still a
 * running program (#390's spin-down window).
 */
function playProblem(status: MachineStatusRead): ReceiptRefusal | null {
  if (status.alarm !== null) {
    return {
      code: 'machine-alarm',
      reason: `the controller is in an alarm (\`${status.alarm}\`) — clear it at the machine first; nothing was sent`,
    };
  }
  if (status.state === null) {
    return {
      code: 'machine-unreadable',
      reason: `the status line was not readable (${status.line ?? 'no reply'}) — nothing was sent`,
    };
  }
  if (status.state.toLowerCase() !== 'idle') {
    return { code: 'machine-busy', reason: `it reports ${status.state} rather than Idle — nothing was sent` };
  }
  if (status.percent !== null && status.percent < 100) {
    return {
      code: 'machine-busy',
      reason: `it reports Idle, but its status line says a program is ${status.percent}% through — nothing was sent`,
    };
  }
  return null;
}

/**
 * `machine upload` — a job document through the app's own generate → verify → upload gate, and to
 * the card only when `--confirm` names the program's hash.
 *
 * The order is the point. `--dry` stops after generation and prints the hash, so the token comes
 * from the command that consumes it. A token that does not match is refused with both hashes and
 * no connection. The send itself is `machineUpload.uploadProgram`: the app's verified-only gate,
 * its idle check, and its transfer — not a second implementation.
 */
async function uploadBody(
  args: Args,
  options: CommandOptions,
  deps: MachineDeps,
  locate: (path?: string) => LoadedLocation | null,
): Promise<number> {
  const out = commandOutput(options);
  const jobPath = args.paths[0] as string;

  let input: ReceiptFile;
  try {
    input = fileReceipt(jobPath);
  } catch (e) {
    fail(`cannot read ${jobPath}: ${e instanceof Error ? e.message : String(e)}`);
  }

  const prepare = deps.prepare ?? prepareVerifiedProgram;
  let result: PrepareResult;
  try {
    result = await prepare(jobPath, {
      myMachine: args.myMachine,
      calibration: args.calibration,
      acknowledged: args.acknowledge,
    });
  } catch (e) {
    // An unreadable --my-machine or --calibration record is a usage error, not a refusal.
    if (e instanceof Error) fail(e.message);
    throw e;
  }

  const details = emptyDetails('upload', null, args.port);
  if (!result.ok) {
    const receipt = machineReceipt(
      details,
      false,
      [{ code: 'program-refused', reason: result.reason }],
      { inputs: [input] },
    );
    out.emitReceipt(receipt);
    return 1;
  }

  const program = result.program;
  const diagnostics = prepareDiagnostics(program);
  details.action = {
    confirm: args.confirm ?? null,
    programHash: program.hash,
    path: null,
    sent: null,
    dryRun: args.dry,
    ackCodes: args.acknowledge ?? [],
    alreadyPresent: false,
  };

  // A --acknowledge list that is not exactly what this run asks for is a usage error, and the
  // bench script's rule: the tick is per-program, so a blanket one waves through what it was not
  // meant to.
  if (program.ackError !== null) fail(program.ackError);

  if (program.blocker !== null) {
    const hint =
      program.requiredAcks.length > 0
        ? ` Once they are made at the machine, pass --acknowledge=${program.requiredAcks.join(',')}.`
        : '';
    const receipt = machineReceipt(
      details,
      false,
      [{ code: 'upload-blocked', reason: `${program.blocker}.${hint}` }],
      { inputs: [input], diagnostics },
    );
    out.emitReceipt(receipt);
    return 1;
  }

  const destination = uploadPath(args.dir ?? GCODE_DIR, program.filename);
  details.action.path = destination;

  if (args.dry) {
    out.emitReceipt(machineReceipt(details, true, [], { inputs: [input], diagnostics }));
    return 0;
  }

  if (args.confirm !== program.hash) {
    const receipt = machineReceipt(
      details,
      false,
      [
        {
          code: 'confirm-mismatch',
          reason:
            `--confirm ${args.confirm ?? '(none)'} does not name this job's program: ` +
            `${jobPath} generates ${program.hash}. Nothing was sent.`,
        },
      ],
      { inputs: [input], diagnostics },
    );
    out.emitReceipt(receipt);
    return 1;
  }

  const target = targetOf(args, locate);
  details.host = target.host;
  details.port = target.port;

  const upload = deps.upload ?? uploadThroughApp;
  const canWriteNote =
    `${program.filename} (${program.nc.length} bytes) — ${program.machineId}, ` +
    `margins ${program.margins.boundaryMargin} mm / ±${program.margins.zTolerance} (${program.marginsFrom})` +
    (program.calibrationNote === null ? ', shipped profile' : `, ${program.calibrationNote}`);
  out.progress(`uploading ${canWriteNote}`);

  let outcome: MachineUploadResult;
  try {
    outcome = await upload(
      target,
      { filename: program.filename, nc: program.nc, verify: program.verify },
      deps.transport,
    );
  } catch (e) {
    const receipt = machineReceipt(
      details,
      false,
      [{ code: 'upload-error', reason: `the upload failed: ${e instanceof Error ? e.message : String(e)}` }],
      { inputs: [input], diagnostics },
    );
    out.emitReceipt(receipt);
    return 1;
  }

  if (outcome.kind === 'uploaded') {
    details.action.sent = `upload ${destination}`;
    details.action.alreadyPresent = outcome.alreadyPresent;
    details.status = statusRead(outcome.status);
    out.emitReceipt(machineReceipt(details, true, [], { inputs: [input], diagnostics }));
    return 0;
  }

  if (outcome.kind === 'busy') details.status = statusRead(outcome.status);
  const receipt = machineReceipt(details, false, [uploadRefusal(outcome)], {
    inputs: [input],
    diagnostics,
  });
  out.emitReceipt(receipt);
  return 1;
}

/**
 * `machine play` — run a file the card ALREADY HOLDS, only when `--confirm` names the hash of the
 * bytes the card returns.
 *
 * The hash is computed from `runReadFile`'s text, not from a local file, so the token names what
 * the machine will actually run. The pre-play read is the app's own idle rule; the follow-up is
 * `?` at `--poll` (never under 2000 ms, the interval whose faster cousin faulted the controller on
 * 2026-10-12). Ctrl-C sends `abort` at the next poll boundary and says so; this command sends no
 * `M331`/`M332`, no `$H`, and never uploads.
 */
async function playBody(
  args: Args,
  options: CommandOptions,
  deps: MachineDeps,
  locate: (path?: string) => LoadedLocation | null,
): Promise<number> {
  const out = commandOutput(options);
  const path = args.paths[0] as string;
  const line = playProgramLine(path);
  if (line === null) {
    fail(`"${path}" is not a playable card path — absolute, and only A-Z a-z 0-9 . _ - /`);
  }
  const confirm = args.confirm as string;

  const target = targetOf(args, locate);
  const details = emptyDetails('play', target.host, target.port);
  const refusals: ReceiptRefusal[] = [];

  let conn: number;
  try {
    conn = await deps.transport.tcpConnect(target.host, target.port, CONNECT_TIMEOUT_MS);
  } catch (e) {
    refusals.push({
      code: 'machine-unreachable',
      reason: `could not connect to ${target.host}:${target.port}: ${e instanceof Error ? e.message : String(e)}`,
    });
    out.emitReceipt(machineReceipt(details, false, refusals));
    return 1;
  }

  let aborted = false;
  const onSignal = (): void => {
    aborted = true;
  };
  process.on('SIGINT', onSignal);

  try {
    // The token names the CARD's bytes, so the card is asked first. A local hash would name what
    // this run believes is there, which is the assumption --confirm exists to remove.
    const read = await runReadFile(deps.transport, conn, path);
    if (!read.ok) {
      refusals.push({
        code: 'card-unreadable',
        reason: `the card did not return ${path}: ${read.detail}`,
      });
      out.emitReceipt(machineReceipt(details, false, refusals));
      return 1;
    }
    const hash = programHash(read.text);
    details.action = {
      confirm,
      programHash: hash,
      path,
      sent: null,
      dryRun: false,
      ackCodes: [],
      alreadyPresent: false,
    };
    if (hash !== confirm) {
      refusals.push({
        code: 'confirm-mismatch',
        reason:
          `--confirm ${confirm} does not name the bytes the card holds: ${path} hashes ${hash}. ` +
          `Nothing was sent.`,
      });
      out.emitReceipt(machineReceipt(details, false, refusals));
      return 1;
    }

    const before = await runStatus(deps.transport, conn);
    details.status = statusRead(before.text, before.diagnostics);
    const problem = playProblem(details.status);
    if (problem !== null) {
      refusals.push(problem);
      out.emitReceipt(machineReceipt(details, false, refusals));
      return 1;
    }

    const session = openConsole(deps.transport, conn);
    const played = await session.send(line);
    if (!played.ok) {
      refusals.push({
        code: 'play-refused',
        reason: `the controller refused \`${line}\`: ${played.detail}`,
      });
      out.emitReceipt(machineReceipt(details, false, refusals));
      return 1;
    }
    details.action.sent = line;

    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const deadline = args.timeoutS === undefined ? null : Date.now() + args.timeoutS * 1000;
    out.progress(`playing ${path} — polling \`?\` every ${args.pollMs} ms (Ctrl-C aborts)`);

    for (;;) {
      if (aborted) {
        // The bench's stop: `abort` stops the spindle at once; the controller then drains the moves
        // it had already buffered. 60 s is the seeded `stop.abortReplyMs` (`z1.mjs run`).
        const stopped = await session.send('abort', { firstReplyMs: 60_000, maxMs: 60_000 });
        refusals.push({
          code: 'aborted',
          reason: stopped.ok
            ? 'Ctrl-C — `abort` was sent; the controller is draining its queue. The vacuum state is whatever the program left it in.'
            : `Ctrl-C — \`abort\` was NOT answered (${stopped.detail}). Check the machine.`,
        });
        out.emitReceipt(machineReceipt(details, false, refusals));
        return 130;
      }

      const readStatus = await runStatus(deps.transport, conn);
      details.status = statusRead(readStatus.text, readStatus.diagnostics);
      if (details.status.finished) {
        out.emitReceipt(machineReceipt(details, true, refusals));
        return 0;
      }
      if (details.status.alarm !== null) {
        refusals.push({
          code: 'machine-alarm',
          reason: `the controller raised \`${details.status.alarm}\` while the program ran — check the machine`,
        });
        out.emitReceipt(machineReceipt(details, false, refusals));
        return 1;
      }
      if (deadline !== null && Date.now() > deadline) {
        refusals.push({
          code: 'play-timeout',
          reason: `--timeout ${args.timeoutS} s passed before the program reported finished`,
        });
        out.emitReceipt(machineReceipt(details, false, refusals));
        return 1;
      }
      await sleep(args.pollMs);
    }
  } finally {
    process.off('SIGINT', onSignal);
    await deps.transport.tcpClose(conn);
  }
}

/** The line each no-program action sends. The section itself is the token (#479's amendment). */
const PHYSICAL_LINES = { home: '$H', probe: 'M491' } as const;

/**
 * `machine home` and `machine probe` — the two physical acts with no program to hash.
 *
 * Their token is the literal word, and nothing else. `home` sends `$H`; `probe` sends `M491`, the
 * firmware's tool-length probe (the wired probe must be fitted first — `runRegistration`'s own
 * operator step), and does NOT home first: a caller who wants both runs both commands, in that
 * order. The bench rule is `$H` before every bit change, so the operator's order is home → fit the
 * probe → probe. Neither line is built from an argument, so there is no path or text to guard.
 *
 * Both require the same pre-flight `play` does — an alarm, a non-Idle state or a `P:` below 100
 * refuses before anything is sent — and both follow the line with `?` at `--poll` until the machine
 * reports Idle. `$H` and `M491` are macros measured in tens of seconds at the bench (27.5 s and
 * 31.4 s, 2026-10-15), which is why the send uses the app's typed-line window rather than the
 * status poll's.
 */
async function physicalBody(
  args: Args,
  options: CommandOptions,
  deps: MachineDeps,
  locate: (path?: string) => LoadedLocation | null,
): Promise<number> {
  const out = commandOutput(options);
  const section = args.section as 'home' | 'probe';
  const line = PHYSICAL_LINES[section];

  const target = targetOf(args, locate);
  const details = emptyDetails(section, target.host, target.port);
  const refusals: ReceiptRefusal[] = [];

  let conn: number;
  try {
    conn = await deps.transport.tcpConnect(target.host, target.port, CONNECT_TIMEOUT_MS);
  } catch (e) {
    refusals.push({
      code: 'machine-unreachable',
      reason: `could not connect to ${target.host}:${target.port}: ${e instanceof Error ? e.message : String(e)}`,
    });
    out.emitReceipt(machineReceipt(details, false, refusals));
    return 1;
  }

  let aborted = false;
  const onSignal = (): void => {
    aborted = true;
  };
  process.on('SIGINT', onSignal);

  try {
    const before = await runStatus(deps.transport, conn);
    details.status = statusRead(before.text, before.diagnostics);
    const problem = playProblem(details.status);
    if (problem !== null) {
      refusals.push(problem);
      out.emitReceipt(machineReceipt(details, false, refusals));
      return 1;
    }

    const session = openConsole(deps.transport, conn);
    const sent = await session.send(line, CONSOLE_TIMING);
    if (!sent.ok) {
      refusals.push({
        code: `${section}-refused`,
        reason:
          `the controller did not answer \`${line}\` within its window` +
          (sent.detail === '' ? '' : `: ${sent.detail}`),
      });
      out.emitReceipt(machineReceipt(details, false, refusals));
      return 1;
    }
    details.action = {
      confirm: section,
      programHash: null,
      path: null,
      sent: line,
      dryRun: false,
      ackCodes: [],
      alreadyPresent: false,
    };
    if (section === 'probe') details.probe = { line, prb: lastPrb(sent.text), text: sent.text };

    out.progress(`${line} sent — polling \`?\` every ${args.pollMs} ms until the machine is Idle (Ctrl-C aborts)`);

    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const deadline = args.timeoutS === undefined ? null : Date.now() + args.timeoutS * 1000;
    for (;;) {
      if (aborted) {
        // The bench's stop: `abort` stops the machine at once. 60 s is the seeded `stop.abortReplyMs`
        // (`z1.mjs run`).
        const stopped = await session.send('abort', { firstReplyMs: 60_000, maxMs: 60_000 });
        refusals.push({
          code: 'aborted',
          reason: stopped.ok
            ? 'Ctrl-C — `abort` was sent; the controller is stopping.'
            : `Ctrl-C — \`abort\` was NOT answered (${stopped.detail}). Check the machine.`,
        });
        out.emitReceipt(machineReceipt(details, false, refusals));
        return 130;
      }

      const readStatus = await runStatus(deps.transport, conn);
      details.status = statusRead(readStatus.text, readStatus.diagnostics);
      if (details.status.alarm !== null) {
        refusals.push({
          code: 'machine-alarm',
          reason: `the controller raised \`${details.status.alarm}\` — check the machine`,
        });
        out.emitReceipt(machineReceipt(details, false, refusals));
        return 1;
      }
      if (details.status.state !== null && details.status.state.toLowerCase() === 'idle') break;
      if (deadline !== null && Date.now() > deadline) {
        // #543 — the --timeout deadline aborts like Ctrl-C, not just an exit: a stalled `$H`/`M491`
        // must not be left mid-move. Same reply window as the SIGINT path above.
        const stopped = await session.send('abort', { firstReplyMs: 60_000, maxMs: 60_000 });
        refusals.push({
          code: `${section}-timeout`,
          reason: stopped.ok
            ? `--timeout ${args.timeoutS} s passed — \`abort\` was sent; the controller is stopping.`
            : `--timeout ${args.timeoutS} s passed, and \`abort\` was NOT answered (${stopped.detail}). Check the machine.`,
        });
        out.emitReceipt(machineReceipt(details, false, refusals));
        return 1;
      }
      await sleep(args.pollMs);
    }

    // The reading is judged only once the machine has settled: a miss usually raises the alarm the
    // status read above reports first, and this branch catches the case where it did not.
    if (section === 'probe' && details.probe !== null) {
      const prb = details.probe.prb;
      if (prb === null) {
        refusals.push({
          code: 'probe-no-reading',
          reason: `${line} answered no [PRB:…] reading: ${details.probe.text.trim() || '(the reply was empty)'}`,
        });
        out.emitReceipt(machineReceipt(details, false, refusals));
        return 1;
      }
      if (!prb.touched) {
        refusals.push({
          code: 'probe-missed',
          reason:
            `the probe travelled its whole distance and touched nothing (it stopped at x ${prb.x}, y ${prb.y}, z ${prb.z})` +
            ' — check the probe and the surface before trusting any Z0 from it',
        });
        out.emitReceipt(machineReceipt(details, false, refusals));
        return 1;
      }
    }

    out.emitReceipt(machineReceipt(details, true, refusals));
    return 0;
  } finally {
    process.off('SIGINT', onSignal);
    await deps.transport.tcpClose(conn);
  }
}

export { USAGE as MACHINE_USAGE };
