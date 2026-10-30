/**
 * The USB serial check (#775), UI side — the desktop-only counterpart of `machineProbe.ts`.
 *
 * WHY A SECOND SEAM. `machineProbe` answers "is there a machine on the network?": it discovers,
 * identifies and reads a KNOWN machine's coordinate frame. A serial reach has no discovery and no
 * announced name, so the model is not established even when the controller answers — the frame is
 * deliberately not read (it belongs to a profile that this link cannot prove). Treating it as the
 * remembered network machine would put an unidentified controller where every panel reads a Z1's
 * envelope, which is the exact guess `profileForDiscoveredName` refuses. So the result stays here,
 * for the Manage pane to show, and does not enter `machineStore`.
 *
 * THE DESKTOP-ONLY BOUNDARY is the same as the probe's: the real client reaches the bridge through
 * `loadMachineBridge()`, never a top-level import, or the desktop module graph leaks into the web
 * bundle and `npm run check:platform-gate` fails. In a browser the loader throws and the answer is
 * `unavailable` with the guard's own sentence.
 *
 * THE TEST SEAM. `setMachineSerialLoader` swaps the client, matching `setMachineProbeLoader` and
 * `setMachineConsoleLoader`. The orchestration and the result shape below are the real code in
 * every test; only the port is faked, because a COM port is the one thing a unit test cannot have.
 */

import { loadMachineBridge } from './capabilities';
import { readStatusLine, type MachineStatusLine } from './desktop/protocol';

/** The baud used when no caller names one. Restated from the bridge (which is desktop-only);
 *  `machineSerial.spec.ts` asserts the two numbers are equal, so they cannot drift silently. */
export const DEFAULT_SERIAL_BAUD = 115_200;

/** One port the desktop shell offers (#775). */
export interface SerialPortChoice {
  portName: string;
  label: string;
  usb: boolean;
}

/** What one serial reach established. */
export interface SerialReach {
  portName: string;
  baud: number;
  /** The IPv4 the controller reported for itself, or null when it reported none. */
  ip: string | null;
  /** The MAC, lowercase colon form, or null. */
  mac: string | null;
  /** The controller's status line (`?`), verbatim, or null when it did not answer. */
  status: string | null;
  /** The parsed status line, from the same reader every other screen uses. */
  statusLine: MachineStatusLine | null;
  /** One sentence per thing this link could NOT establish. */
  notes: string[];
  /** ISO timestamp of the check. This is a record of a moment, like the network probe's. */
  observedAt: string;
}

/** The three honest answers. `not-found` has no meaning here: a port either answers or it does not. */
export type SerialCheckResult =
  | { kind: 'found'; reach: SerialReach }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'error'; detail: string };

/**
 * The port-facing half of the bridge. Every method restates the bridge's signature, so the real
 * client is a pass-through and the fake in a test is three functions.
 */
export interface MachineSerialClient {
  /** Whether THIS page can list and open serial ports — false in a LAN browser. */
  available(): Promise<boolean>;
  ports(): Promise<SerialPortChoice[]>;
  /** Identify + status on ONE connection. */
  check(target: { serialPort: string; baud?: number }): Promise<{
    identity: { ip: string | null; mac: string | null };
    status: { ok: boolean; text: string | null } | null;
  }>;
}

/** The real client: the bridge, reached only through the capability guard. */
async function loadRealClient(): Promise<MachineSerialClient> {
  const bridge = await loadMachineBridge();
  return {
    available: async () => bridge.serialTransportAvailable(),
    ports: () => bridge.listSerialPorts(),
    check: (target) => bridge.checkSerial(target),
  };
}

let clientFactory: () => Promise<MachineSerialClient> = loadRealClient;

/** Swap the client. Vitest uses this; the app never calls it. `null` restores the real bridge. */
export function setMachineSerialLoader(fn: (() => Promise<MachineSerialClient>) | null): void {
  clientFactory = fn ?? loadRealClient;
}

function reasonOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Whether this page offers USB serial at all (#775). False for the web build, false in a LAN
 * browser served by the desktop app, true in the Tauri webview on Windows. A failure to even load
 * the bridge is that same answer, not an error: a browser has no ports to show.
 */
export async function serialAvailable(): Promise<boolean> {
  try {
    return await (await clientFactory()).available();
  } catch {
    return false;
  }
}

/** The serial ports this machine offers. Empty when this page has no serial link, or none exist. */
export async function listSerialPorts(): Promise<SerialPortChoice[]> {
  try {
    return await (await clientFactory()).ports();
  } catch {
    return [];
  }
}

/**
 * Connect to a serial port, ask it to identify itself and for its status, and report what answered.
 * Never throws: every failure is one of the three outcomes, because the pane renders a failure as
 * readily as a success.
 *
 * The model is NOT established: nothing on this link announces the machine's name, so the note
 * says its envelope and limits are unknown. That is the same honest answer a typed IP gets.
 */
export async function checkSerialPort(
  portName: string,
  baud: number = DEFAULT_SERIAL_BAUD,
): Promise<SerialCheckResult> {
  const port = portName.trim();
  if (port.length === 0) return { kind: 'error', detail: 'no serial port was chosen' };

  let client: MachineSerialClient;
  try {
    client = await clientFactory();
  } catch (e) {
    return { kind: 'unavailable', reason: reasonOf(e) };
  }

  const notes: string[] = [];
  let reach: Awaited<ReturnType<MachineSerialClient['check']>>;
  try {
    reach = await client.check({ serialPort: port, baud });
  } catch (e) {
    return { kind: 'error', detail: reasonOf(e) };
  }

  // The identify exchange completing is itself an answer: a null IP/MAC is what the controller
  // said, not a silence. If the port did not open at all, `check` rejected above.
  const ip = reach.identity.ip;
  const mac = reach.identity.mac;
  let status: string | null = null;
  if (ip === null) notes.push('The controller did not report an IP address of its own.');
  if (mac === null) notes.push('The controller did not report a MAC address.');

  if (reach.status === null) {
    notes.push('The controller did not answer a status request.');
  } else if (reach.status.ok) {
    status = reach.status.text;
  } else {
    notes.push('The controller did not answer a status request.');
  }

  notes.push(
    'This machine answered over USB serial. Nothing on this link announces its model, so its work ' +
      'envelope and limits are unknown — it is not recorded as the network machine.',
  );

  return {
    kind: 'found',
    reach: {
      portName: port,
      baud,
      ip,
      mac,
      status,
      statusLine: status === null ? null : readStatusLine(status),
      notes,
      observedAt: new Date().toISOString(),
    },
  };
}
