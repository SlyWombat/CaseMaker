/**
 * `casemaker machine …` (#477) — the commands that speak to the controller.
 *
 * THE LINE (#479's decision, with the maintainer's amendment). Power is OUTSIDE Case Maker: the
 * smart plug is this bench's fixture, not a product assumption, and `tools/z1/power.sh` stays a
 * bench script. Nothing in this module reads or switches it.
 *
 *   Read, unattended:      status · version · hashes · finished
 *   Physical, confirmed:   upload · play            (behind `--confirm <program hash>`)
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
  alarmLine,
  readConfigKey,
  readJobProgress,
  runMd5Sum,
  runStatus,
  type MachineTransport,
} from '../../../src/platform/desktop/protocol.ts';
import { createNodeTransport } from '../../../tools/z1/transport.node.mjs';
import { loadLocation, LocationDocumentError, type LoadedLocation } from '../../../src/platform/headless/bootstrap';
import {
  RECEIPT_VERSION,
  type MachineDetails,
  type MachineStatusRead,
  type Receipt,
  type ReceiptRefusal,
} from '../../../src/platform/headless/receipt';
import type { MachineRecord } from '../../../src/platform/locationClient';
import { CliExit, isCliExit } from './exit';
import { commandOutput, HUMAN, type CommandOptions } from './output';

const SECTIONS = ['status', 'version', 'hashes', 'finished'] as const;
type Section = (typeof SECTIONS)[number];

const USAGE =
  'usage: casemaker machine status  [--host <ip>] [--port <n>] [--location <file>]\n' +
  '       casemaker machine version [--host <ip>] [--port <n>] [--location <file>]\n' +
  '       casemaker machine hashes  <card-path> [<card-path> ...] [--host <ip>] [--port <n>]\n' +
  '       casemaker machine finished [--machine <id>] [--location <file>]\n' +
  '\n' +
  'Reads only: status polls `?`, version reads the `version` key from /sd/config.txt, hashes asks\n' +
  'the controller for its own MD5 of files it holds, and finished reads the machine record’s\n' +
  'finished-program list. Nothing here uploads, plays, homes or switches power.';

/** The connect window: the app's own 3 s connect timeout. */
const CONNECT_TIMEOUT_MS = 3000;

interface Args {
  section?: Section;
  host?: string;
  port: number;
  location?: string;
  machine?: string;
  paths: string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = { port: COMMAND_TCP_PORT, paths: [] };
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
): Extract<Receipt, { command: 'machine' }> {
  return {
    version: RECEIPT_VERSION,
    command: 'machine',
    ok,
    stage: details.section,
    gate: null,
    inputs: [],
    outputs: [],
    diagnostics: [],
    provenance: [],
    refusals,
    details,
  };
}

function emptyDetails(section: Section, host: string | null, port: number): MachineDetails {
  return { section, host, port, status: null, version: null, hashes: [], finished: null, action: null };
}

/** What the dependency seam is: the socket layer, and the document reader a spec replaces. */
export interface MachineDeps {
  /** The five-call transport. Production: the Node sockets; specs: a fake. */
  transport: MachineTransport;
  /** The document reader. Production: `loadLocation`; specs pass a fixture without touching disk. */
  locate?: (path?: string) => LoadedLocation | null;
}

/**
 * The production seam. Built lazily so importing this module for its types (or a spec's fake
 * transport) never opens the Node socket layer.
 */
function defaultDeps(): MachineDeps {
  return { transport: createNodeTransport(), locate: (path) => loadLocation(path) };
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
  const section = args.section as Section;
  const locate = deps.locate ?? ((path?: string) => loadLocation(path));
  const out = commandOutput(options);

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

export { USAGE as MACHINE_USAGE };
