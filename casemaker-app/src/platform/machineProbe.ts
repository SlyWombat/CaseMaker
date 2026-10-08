/**
 * The machine check (issue #280) — the one place that turns "is a machine there?" into data.
 *
 * The bridge (#255, `platform/desktop/machineBridge.ts`) can already `discover()`, `identify()`
 * and `status()`, and nothing in the app called it. The startup wizard is the consumer, and this
 * module is the seam between the two: it runs the search, reads back what the machine says about
 * itself, resolves that identity against the profiles we ship, and reports ONE of four honest
 * answers. The wizard renders them and never interprets a socket.
 *
 * THREE RULES, each of them a decision on #280's record:
 *
 *  1. **A check, not a picker.** There is no "which machine do you have?" form. The machine is
 *     asked, and it answers or it does not. That is also what the field does — MillMage's step 1,
 *     Carbide Motion's *Connect to Machine*, gSender's auto-detect on connect (UI-PATTERNS §1).
 *  2. **Never blocks.** `not-found` is a normal outcome, not an error: a job can be authored,
 *     verified and simulated with no machine at all, so the caller keeps going.
 *  3. **An unknown machine is reported as unknown.** {@link profileForDiscoveredName} resolves a
 *     broadcast name to a profile id, and an unrecognised name resolves to `null` — never to the
 *     Z1's numbers. A second vendor's machine discovered tomorrow must produce a truthful answer
 *     rather than a guess (Makera-Parity §13, the multi-vendor lesson in #228).
 *
 * THE FOURTH QUESTION (#279). A machine we KNOW is also asked what its own coordinate frame is set
 * to — `config-get sd <key>`, once per key — because the vendor's `configZ1.default` is a STOCK Z1
 * and a machine on a bench has been trammed since (measured 2026-10-06: `anchor1` is 1.51 mm from
 * the shipped default on X, which moves both the tool-length sensor and the change position). What
 * comes back is a {@link MachineCalibration} with its source and date attached, or a note saying
 * why it could not be read. This module only READS: nothing here writes a setting to a machine.
 *
 * THE DESKTOP-ONLY BOUNDARY. The real client reaches the bridge through `loadMachineBridge()`,
 * whose `await import()` sits behind `canDriveMachine` inside `capabilities.ts` — never a
 * top-level import here, or the bridge leaks into the web bundle and `npm run check:platform-gate`
 * fails. In a browser `loadMachineBridge()` throws, and that becomes `unavailable` WITH the
 * reason, which the wizard shows rather than hiding the step.
 *
 * THE TEST SEAM. `setMachineProbeLoader` swaps the client, matching `setRasterDecodeLoader` and
 * `setEngravePreviewClientLoader`: the orchestration below (search → identify → status → resolve)
 * is the real one in every test, so a test exercises the code the app runs rather than a mock of
 * it. Only the socket is faked, because a socket is the one thing a unit test cannot have.
 */

import { CALIBRATION_KEY_LIST, calibrationFromReplies, type MachineCalibration } from '@/engine/cnc/calibration';
import { loadMachineBridge } from './capabilities';

/**
 * The command port a typed address connects to when none is given: `COMMAND_TCP_PORT`
 * (`platform/desktop/protocol.ts`, Z1-Bridge-Protocol §1).
 *
 * Restated here rather than imported, because `protocol.ts` is a DESKTOP-ONLY module and this one
 * is in the web bundle: a top-level import of it would drag the bridge's module graph in, which is
 * the leak `capabilities.ts` exists to prevent. `machineProbe.spec.ts` asserts the two numbers are
 * equal, so they cannot drift apart silently.
 */
export const DEFAULT_COMMAND_PORT = 2222;

/** What a discovered machine announced. A local copy so this module never imports the bridge. */
export interface DiscoveredMachineSummary {
  /** The broadcast name, e.g. `Makera_Z1_010290`. Also the de-duplication key. */
  name: string;
  host: string;
  port: number;
  busy: boolean;
}

/** What the controller answered when asked to identify itself (#255, `M482.5`/`M482.4`). */
export interface MachineIdentitySummary {
  /** The IPv4 it reported for itself, or null when no plausible address was in the reply. */
  ip: string | null;
  /** The MAC, lowercase colon form, or null. */
  mac: string | null;
}

/** The controller's status line (`?`), or null when it did not answer. */
export interface MachineStatusSummary {
  ok: boolean;
  text: string | null;
}

/**
 * What a configuration read established (#279). `values` holds only the keys the controller
 * answered, verbatim; `failures` names the rest with the controller's own reason, so a read that
 * stopped short can say WHICH key stopped it rather than reporting a count.
 */
export interface ConfigReadSummary {
  values: Map<string, string>;
  failures: Array<{ key: string; reason: string; detail: string }>;
}

/**
 * The socket-facing half of the bridge. Every method is the bridge's own signature restated, so
 * the real client is a pass-through and the fake in a test is four functions.
 */
export interface MachineProbeClient {
  discover(opts: { windowMs?: number }): Promise<DiscoveredMachineSummary[]>;
  identify(target: { host: string; port?: number }): Promise<MachineIdentitySummary>;
  status(target: { host: string; port?: number }): Promise<MachineStatusSummary>;
  /** Read configuration keys from the machine's own config (#279). One connection for the list. */
  readConfig(
    target: { host: string; port?: number },
    keys: readonly string[],
    opts: { source: string },
  ): Promise<ConfigReadSummary>;
}

export interface MachineProbeOptions {
  /** How long to listen for the broadcast. Defaults to the bridge's own (3000 ms). */
  windowMs?: number;
  /**
   * A typed address: skip the search and connect straight here. The manual fallback for a machine
   * on a network that does not deliver its broadcast (a routed subnet, a firewall).
   */
  host?: string;
  /** The command port for a typed address. Defaults to the bridge's own (2222). */
  port?: number;
}

/**
 * A machine we reached, and what it could be told about itself.
 *
 * `name` and `busy` are `null` for a typed address: nobody announced it, and a controller does not
 * volunteer its model over the command socket. That is the honest shape — the alternative is
 * filling in a plausible name, which is how a machine ends up with another machine's limits.
 */
export interface MachineObservation {
  name: string | null;
  host: string;
  port: number;
  busy: boolean | null;
  ip: string | null;
  mac: string | null;
  /** The controller's status line, verbatim, or null when it did not answer. */
  status: string | null;
  /**
   * The `MACHINES` id this identity resolves to, or `null` for a machine we do not know. `null` is
   * a RESULT, not a failure: it says every machine-dependent number for this job is unknown.
   */
  profileId: string | null;
  /** ISO timestamp of the check. What makes this a record of a moment, not a standing claim. */
  observedAt: string;
  /** One sentence per thing the check could NOT establish. Empty when everything answered. */
  notes: string[];
}

/**
 * The configuration source a machine's own frame is read from. `sd` is `/sd/config.txt`, the file a
 * Z1's calibration actually lives in (Z1-Bridge-Protocol §5), and the bench harness's default.
 *
 * Named here rather than left to the bridge's default because this string is what
 * `calibrationFromReplies` writes into the saved record's `source` — a record that said `sd` while
 * reading something else would be a provenance claim that is false.
 */
const FRAME_SOURCE = 'sd';

/** The four answers, and there are deliberately four: see {@link profileForDiscoveredName}'s rule. */
export type MachineProbeResult =
  | {
      kind: 'found';
      observation: MachineObservation;
      /**
       * The machine's own coordinate frame, read during the check (#279, decision 28's measured
       * tier). Null when it could not be read — which is a normal answer, not a failure: the
       * shipped profile's vendor defaults then stay in force and `notes` says why.
       *
       * It is a PEER of `observation` rather than a field on it on purpose. `machineStore`'s rule
       * is that the store holds the connection INSTANCE and not the machine's numbers; the frame's
       * durable home is `settingsStore.machineCalibration`, where its provenance travels with it.
       */
      calibration: MachineCalibration | null;
    }
  /** The search ran and nothing answered. Normal: the wizard carries on. */
  | { kind: 'not-found' }
  /** This build cannot open a raw socket — the web build, or a dev browser. `reason` says so. */
  | { kind: 'unavailable'; reason: string }
  /** The search itself threw: a socket error, a malformed reply, a bridge fault. */
  | { kind: 'error'; detail: string };

/**
 * Broadcast name → profile id. **This table is the adaptability hinge** (#280): every entry is one
 * row, and adding a second vendor is a row plus a profile constant in `machine.ts` — no refactor
 * anywhere else, which is exactly what `Makera-Parity` §13 demands of anything machine-shaped.
 *
 * Matched as a case-insensitive PREFIX against the announced name. The Z1 announces
 * `Makera_Z1_<serial>` (`Z1-Bridge-Protocol.md` §1, observed on hardware as `Makera_Z1_010290`),
 * not the `Makera Z1` of Makera's own `.fcm` template, so a table keyed on the display name would
 * have matched nothing.
 *
 * There is no default and no fallback. A name that matches nothing returns `null`.
 */
const NAME_PREFIXES: ReadonlyArray<{ prefix: string; profileId: string }> = [
  { prefix: 'makera_z1_', profileId: 'Z1' },
];

/**
 * Which profile a broadcast name refers to, or `null` when we do not know this machine.
 *
 * `null` is the whole point. Makera's own Studio assumes a Z1 and has no machine-setup wizard at
 * all (UI-PATTERNS §1); inheriting the Z1's envelope, spindle ceiling and tool-change positions
 * for an unknown machine would be a safety-relevant guess dressed as a default.
 */
export function profileForDiscoveredName(name: string): string | null {
  const needle = name.trim().toLowerCase();
  if (needle.length === 0) return null;
  for (const row of NAME_PREFIXES) {
    if (needle.startsWith(row.prefix)) return row.profileId;
  }
  return null;
}

/** The real client: the bridge, reached only through the capability guard. */
async function loadRealClient(): Promise<MachineProbeClient> {
  const bridge = await loadMachineBridge();
  return {
    discover: (opts) => bridge.discover({ windowMs: opts.windowMs }),
    identify: (target) => bridge.identify(target),
    status: (target) => bridge.status(target),
    readConfig: async (target, keys, opts) => {
      const outcomes = await bridge.readConfigValues(target, keys, { source: opts.source });
      const values = new Map<string, string>();
      const failures: ConfigReadSummary['failures'] = [];
      for (const o of outcomes) {
        if (o.ok && o.value !== null) values.set(o.key, o.value);
        else failures.push({ key: o.key, reason: o.reason, detail: o.detail });
      }
      return { values, failures };
    },
  };
}

let clientFactory: () => Promise<MachineProbeClient> = loadRealClient;

/** Swap the client. Vitest uses this; the app never calls it. `null` restores the real bridge. */
export function setMachineProbeLoader(fn: (() => Promise<MachineProbeClient>) | null): void {
  clientFactory = fn ?? loadRealClient;
}

function reasonOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Look for a machine and report what it says about itself. Never throws: every failure is one of
 * the four outcomes, because the wizard has to render a failure as readily as a success.
 *
 * The order is the protocol's (`Z1-Bridge-Protocol.md` §1): listen for the UDP broadcast, connect
 * to the address it named, ask `M482.5`/`M482.4` for the IP and MAC, then `?` for the status line.
 * A step that fails is recorded as a NOTE and the check keeps going where it can — a machine that
 * answers its broadcast but refuses the command port is still a machine we found, and saying
 * "identity unknown" is a better answer than discarding the discovery.
 *
 * Given `opts.host` the search is skipped and that address is connected to instead: the manual
 * fallback, for a machine whose broadcast never reaches us. It is the same code path from there on,
 * so a typed address gets the same identify, status and resolution — and, having announced no name,
 * the same honest "we do not know what this is" answer.
 */
export async function probeMachine(opts: MachineProbeOptions = {}): Promise<MachineProbeResult> {
  let client: MachineProbeClient;
  try {
    client = await clientFactory();
  } catch (e) {
    // The web build's answer, and the reason is the guard's own sentence rather than a generic one.
    return { kind: 'unavailable', reason: reasonOf(e) };
  }

  if (opts.host !== undefined) {
    const host = opts.host.trim();
    if (host.length === 0) return { kind: 'error', detail: 'no address was given' };
    const { observation, calibration } = await observe(client, {
      name: null,
      host,
      port: opts.port ?? DEFAULT_COMMAND_PORT,
      busy: null,
    });
    return { kind: 'found', observation, calibration };
  }

  let found: DiscoveredMachineSummary[];
  try {
    found = await client.discover({ windowMs: opts.windowMs });
  } catch (e) {
    return { kind: 'error', detail: `the search failed: ${reasonOf(e)}` };
  }

  const first = found[0];
  if (first === undefined) return { kind: 'not-found' };
  const { observation, calibration } = await observe(client, {
    name: first.name,
    host: first.host,
    port: first.port,
    busy: first.busy,
  });
  return { kind: 'found', observation, calibration };
}

/** What the check knows before it connects: everything from the broadcast, or a typed address. */
interface Reached {
  name: string | null;
  host: string;
  port: number;
  busy: boolean | null;
}

/** What one check established about a machine we reached. */
interface Observation {
  observation: MachineObservation;
  calibration: MachineCalibration | null;
}

/**
 * Ask a reached address to identify itself, to say what it is doing, and — for a machine we know —
 * for its own coordinate frame. Every answer is optional and its absence is a note, not a failure:
 * the machine is already found.
 */
async function observe(client: MachineProbeClient, reached: Reached): Promise<Observation> {
  const target = { host: reached.host, port: reached.port };
  const observedAt = new Date().toISOString();
  const notes: string[] = [];

  let ip: string | null = null;
  let mac: string | null = null;
  try {
    const identity = await client.identify(target);
    ip = identity.ip;
    mac = identity.mac;
    if (ip === null) notes.push('The controller did not report an IP address of its own.');
    if (mac === null) notes.push('The controller did not report a MAC address.');
  } catch (e) {
    notes.push(`The controller did not answer the identify request: ${reasonOf(e)}`);
  }

  let status: string | null = null;
  try {
    const s = await client.status(target);
    status = s.ok ? s.text : null;
    if (!s.ok) notes.push('The controller did not answer a status request.');
  } catch (e) {
    notes.push(`The controller did not answer a status request: ${reasonOf(e)}`);
  }

  const profileId = reached.name === null ? null : profileForDiscoveredName(reached.name);
  const calibration = await readFrame(client, target, profileId, observedAt, notes);
  // Notes record what the controller FAILED to tell us — not a restatement of what the panel
  // already says. "Nothing here knows this machine" is a sentence the panel owns and prints for
  // both paths (announced and typed), so it is deliberately not also a note: in the browser that
  // read as the same paragraph twice in two different wordings. A typed address keeps its note,
  // because that is the one thing the panel does not say about it.
  if (reached.name === null) {
    notes.push(
      'This address was typed rather than announced, so the machine has not said what it is: ' +
        'its work envelope and limits are unknown until it does.',
    );
  }

  return {
    observation: {
      name: reached.name,
      host: reached.host,
      port: reached.port,
      busy: reached.busy,
      ip,
      mac,
      status,
      profileId,
      observedAt,
      notes,
    },
    calibration,
  };
}

/**
 * Ask a machine we KNOW for its own coordinate frame (#279), and hand it back as a record — or as
 * a note saying why not.
 *
 * Three refusals, each deliberate:
 *
 *  - **A machine we do not know is not asked.** `profileId === null` means this identity resolves
 *    to no profile of ours, and `coordinate.anchor1_x` is a Z1's key, not a universal one. Sending
 *    it anyway would be the "assume it is a Z1" guess that `profileForDiscoveredName` exists to
 *    refuse, and a second vendor's machine could answer it with something that means something
 *    else entirely.
 *  - **A read that did not complete is not applied.** One key missing or unreadable drops the
 *    WHOLE frame (`calibrationFromReplies`), for the reason a half-read vise is refused: a frame
 *    with one vendor value left in it is a machine of its own, and every position derived from it
 *    would be quietly wrong.
 *  - **A read that failed does not clear a saved one.** A timeout during this check says nothing
 *    about whether the record saved last week is still right, and silently reverting the machine to
 *    the vendor's defaults on a flaky socket would be the worst possible answer. The note says the
 *    read failed; `machineCalibrationNotice` still says which frame is actually in force.
 */
async function readFrame(
  client: MachineProbeClient,
  target: { host: string; port: number },
  profileId: string | null,
  measuredAt: string,
  notes: string[],
): Promise<MachineCalibration | null> {
  if (profileId === null) return null;

  let summary: ConfigReadSummary;
  try {
    summary = await client.readConfig(target, CALIBRATION_KEY_LIST, { source: FRAME_SOURCE });
  } catch (e) {
    notes.push(
      `The machine's own coordinate frame could not be read (${reasonOf(e)}). Positions stay the ` +
        `vendor's defaults (#279).`,
    );
    return null;
  }

  const read = calibrationFromReplies(summary.values, { machineId: profileId, measuredAt, host: target.host });
  if (!read.ok) {
    const parts: string[] = [];
    if (read.missing.length > 0) parts.push(`no answer for ${read.missing.join(', ')}`);
    if (read.malformed.length > 0) parts.push(`unreadable: ${read.malformed.join(', ')}`);
    notes.push(
      `The machine's coordinate frame was not read completely — ${parts.join('; ')}. Nothing was ` +
        `applied: a half-read frame would be a machine of its own, so positions stay the vendor's ` +
        `defaults (#279).`,
    );
    return null;
  }
  return read.calibration;
}
