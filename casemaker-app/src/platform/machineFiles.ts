/**
 * The machine's SD card, UI side (#772) — what is on it, and deleting a file this app put there.
 *
 * `machineConsole.ts` is this module's sibling and its shape is copied on purpose: the bridge is
 * desktop-only and reaches a raw socket, and a panel has to be able to list a card and render an
 * honest answer in either build. So: a swappable client for tests, the real one behind
 * `loadMachineBridge()`, and outcomes instead of thrown exceptions.
 *
 * THE WORDS ARE MAKERA'S, NOT OURS. The commands are the Carvera Controller's own — `ls -e -s
 * <dir>` and `rm <file> -e` — and their reply types, escaping and listing format are recorded in
 * `platform/desktop/protocol.ts` beside the code that sends them.
 *
 * THE DELETE RULE HAS TWO CLAUSES, and both live here rather than only in the panel, because a
 * second caller must not be able to skip them:
 *
 *   1. **Only a file this app uploaded.** There is no marker on the card: a `.nc`'s name is the
 *      job's own. So the app keeps a per-machine ledger of what it has uploaded (see
 *      {@link recordUploadedFile}) and refuses to delete anything else, naming the machine-side
 *      alternative. A ledger entry that is wrong can only ever refuse a delete; it can never
 *      delete a file the person did not upload here.
 *   2. **Never while a job runs.** The caller passes the machine's busy fact; a file the running
 *      program is about to play is not something to remove underneath it.
 *
 * The ledger is per-browser (localStorage): it is a convenience that survives a reload, never a
 * claim the app depends on — with no storage the panel simply offers fewer deletes.
 */

import { loadMachineBridge } from './capabilities';
import { liveShopDefaults, machineTiming } from './defaultsClient';

/** Where to reach the machine. Always both: an observation carries the port it was reached on. */
export interface MachineFilesTarget {
  host: string;
  port: number;
}

/** One entry of the card's listing, restated from `protocol.ts`'s `SdEntry`. */
export interface SdFileEntry {
  name: string;
  size: number;
  modified: string | null;
  directory: boolean;
}

/** What asking for the listing did. */
export type ListFilesResult =
  | { kind: 'listed'; entries: SdFileEntry[] }
  | { kind: 'refused'; detail: string }
  | { kind: 'timeout'; detail: string }
  | { kind: 'error'; detail: string }
  | { kind: 'unavailable'; detail: string };

/** What deleting one file did. */
export type DeleteFileResult =
  | { kind: 'deleted'; name: string; detail: string }
  | { kind: 'refused'; detail: string }
  | { kind: 'timeout'; detail: string }
  | { kind: 'error'; detail: string }
  | { kind: 'unavailable'; detail: string };

/** The socket-facing half, for the fake a test installs. */
export interface MachineFilesClient {
  list(target: MachineFilesTarget): Promise<ListFilesResult>;
  remove(target: MachineFilesTarget, name: string): Promise<DeleteFileResult>;
}

/** The machine's job directory — the same one uploads land in. */
export const SD_FILES_DIR = '/sd/gcodes';

/** Why the machine cannot be asked for its files at all, or null. */
export function filesProblem(target: MachineFilesTarget): string | null {
  return target.host.trim().length === 0 ? 'this machine has no address, so its card cannot be read' : null;
}

/** The real client: the bridge, reached only through the capability guard. */
async function loadRealClient(): Promise<MachineFilesClient> {
  const bridge = await loadMachineBridge();
  const timing = () => machineTiming(liveShopDefaults());
  return {
    async list(target) {
      const r = await bridge.listSdFiles(target, {
        directory: SD_FILES_DIR,
        connectTimeoutMs: timing().connectTimeoutMs,
      });
      if (r.ok) return { kind: 'listed', entries: r.entries.map((e) => ({ ...e })) };
      if (r.reason === 'bad-path') return { kind: 'error', detail: r.detail };
      return { kind: r.reason, detail: r.detail };
    },
    async remove(target, name) {
      const r = await bridge.deleteSdFile(target, `${SD_FILES_DIR}/${name}`, {
        connectTimeoutMs: timing().connectTimeoutMs,
      });
      if (r.ok) return { kind: 'deleted', name, detail: `"${name}" was deleted from the machine's card.` };
      if (r.reason === 'bad-path') return { kind: 'error', detail: r.detail };
      return { kind: r.reason, detail: r.detail };
    },
  };
}

let clientFactory: () => Promise<MachineFilesClient> = loadRealClient;

/** Swap the client. Vitest uses this; the app never calls it. `null` restores the real bridge. */
export function setMachineFilesLoader(fn: (() => Promise<MachineFilesClient>) | null): void {
  clientFactory = fn ?? loadRealClient;
}

function reasonOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Ask the machine what is on its card. Never throws; every failure is an outcome. */
export async function listMachineFiles(target: MachineFilesTarget): Promise<ListFilesResult> {
  const problem = filesProblem(target);
  if (problem !== null) return { kind: 'refused', detail: problem };
  let client: MachineFilesClient;
  try {
    client = await clientFactory();
  } catch (e) {
    return { kind: 'unavailable', detail: reasonOf(e) };
  }
  try {
    return await client.list(target);
  } catch (e) {
    return { kind: 'error', detail: reasonOf(e) };
  }
}

// ---------------------------------------------------------------------------
// The upload ledger — what this app put on that machine's card
// ---------------------------------------------------------------------------

const LEDGER_PREFIX = 'casemaker.uploads.';
/** A ledger is a convenience: kept short, newest last. */
const LEDGER_MAX = 200;

function ledgerKey(host: string): string {
  return `${LEDGER_PREFIX}${host}`;
}

function readLedger(host: string): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(ledgerKey(host));
    if (raw === null || raw === undefined) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    // No storage, a blocked accessor or a corrupt value: no ledger, fewer deletes. Never a throw.
    return [];
  }
}

/**
 * Record that this app uploaded `name` to `host`. Called from the upload paths after the machine
 * accepted the file; a failure to write the ledger is swallowed — the file is on the card either
 * way, and the cost is that this browser will not offer to delete it.
 */
export function recordUploadedFile(host: string, name: string): void {
  try {
    const ledger = readLedger(host).filter((n) => n !== name);
    ledger.push(name);
    globalThis.localStorage?.setItem(ledgerKey(host), JSON.stringify(ledger.slice(-LEDGER_MAX)));
  } catch {
    // See above: a convenience that could not be kept.
  }
}

/** The names this browser recorded uploading to `host`. */
export function uploadedFileNames(host: string): string[] {
  return readLedger(host);
}

/** True when this browser recorded uploading `name` to `host` — the delete rule's first clause. */
export function isUploadedFile(host: string, name: string): boolean {
  return readLedger(host).includes(name);
}

/** Forget one name (after a delete), or all of them (a card wiped elsewhere). */
export function forgetUploadedFile(host: string, name: string | null = null): void {
  try {
    const ledger = readLedger(host).filter((n) => n !== name);
    globalThis.localStorage?.setItem(ledgerKey(host), JSON.stringify(ledger));
  } catch {
    // Nothing to do: a stale entry can only refuse a future delete of the same name.
  }
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export interface DeleteFileOptions {
  /** The machine's own busy fact. A delete while a program runs is refused by name. */
  busy?: boolean;
}

/**
 * Delete one file from the machine's card. Never throws. The two safety clauses are checked HERE
 * and not only in the panel: `opts.busy === true` refuses, and so does a file this browser did not
 * record uploading.
 */
export async function deleteMachineFile(
  target: MachineFilesTarget,
  name: string,
  opts: DeleteFileOptions = {},
): Promise<DeleteFileResult> {
  const problem = filesProblem(target);
  if (problem !== null) return { kind: 'refused', detail: problem };
  if (opts.busy === true) {
    return { kind: 'refused', detail: 'The machine is running a job; a file cannot be deleted while it runs.' };
  }
  if (name.length === 0 || name.includes('/')) {
    return { kind: 'refused', detail: `refusing to delete ${JSON.stringify(name)}: one file's name, without a path` };
  }
  if (!isUploadedFile(target.host, name)) {
    return {
      kind: 'refused',
      detail: `"${name}" was not uploaded by Case Maker, so this view will not delete it — delete it at the machine or in Makera Studio.`,
    };
  }
  let client: MachineFilesClient;
  try {
    client = await clientFactory();
  } catch (e) {
    return { kind: 'unavailable', detail: reasonOf(e) };
  }
  try {
    const result = await client.remove(target, name);
    if (result.kind === 'deleted') forgetUploadedFile(target.host, name);
    return result;
  } catch (e) {
    return { kind: 'error', detail: reasonOf(e) };
  }
}
