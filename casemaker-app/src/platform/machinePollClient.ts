/**
 * The socket half of the live status poll (#555, #1173) — one `inspect` per tick: the controller's
 * `?` answer and its diagnostic line, on one connection.
 *
 * THE WEB-SAFE BOUNDARY, same shape as `machineProbe` / `machineUpload`: the real client is the
 * bridge reached through `loadMachineBridge()` behind the `canReachMachine` guard — never a
 * top-level import of `platform/desktop/`, or the bridge leaks into the web bundle and
 * `npm run check:platform-gate` fails. The poll floor is restated here rather than imported from
 * `protocol.ts` for the same reason; `machineStatusPoller.spec.ts` asserts the two numbers are
 * equal.
 *
 * The registry that decides WHEN to call this lives in `machineStatusPoller.ts`; this file only
 * knows how to ask the machine and how a test swaps the answer.
 */

import { loadMachineBridge } from './capabilities';
import { liveShopDefaults, machineTiming } from './defaultsClient';

/**
 * How often the status poll runs, ms — `protocol.ts`'s `MIN_STATUS_POLL_MS` (#386), restated
 * web-safe for the reason {@link machineProbe}'s `DEFAULT_COMMAND_PORT` restates the command port.
 * The floor exists because a poll every ~0.6 s faulted the controller (2026-10-12); 2 s is the
 * bench's clean interval, and every poller — the UI's and a run's — respects it.
 */
export const HEARTBEAT_POLL_MS = 2000;

/** Where to reach the machine. Both, because an observation carries the port it was reached on. */
export interface HeartbeatTarget {
  host: string;
  port: number;
}

/** The controller's answer to `?` — `ok: false` when it sent nothing readable. */
export interface HeartbeatStatus {
  ok: boolean;
  text: string | null;
}

/** #826 — one tick's two reads: the status line, and the diagnostic line when it answered. */
export interface HeartbeatInspection {
  status: HeartbeatStatus;
  diagnose: HeartbeatStatus | null;
}

/** The socket-facing half: one inspection per tick, both reads on one connection. */
export interface MachineHeartbeatClient {
  inspect(target: HeartbeatTarget): Promise<HeartbeatInspection>;
}

/** The real client: the bridge, reached only through the capability guard. */
async function loadRealClient(): Promise<MachineHeartbeatClient> {
  const bridge = await loadMachineBridge();
  return {
    inspect: async (target) => {
      const reading = await bridge.inspect(target, {
        connectTimeoutMs: machineTiming(liveShopDefaults()).connectTimeoutMs,
      });
      return {
        status: { ok: reading.status.ok, text: reading.status.text },
        // A controller that does not answer the word (an older firmware) simply has no reading.
        diagnose: { ok: reading.diagnose.ok, text: reading.diagnose.text },
      };
    },
  };
}

let clientFactory: () => Promise<MachineHeartbeatClient> = loadRealClient;

/** Swap the client. Vitest uses this; the app never calls it. `null` restores the real bridge. */
export function setMachineHeartbeatLoader(fn: (() => Promise<MachineHeartbeatClient>) | null): void {
  clientFactory = fn ?? loadRealClient;
}

/** The one client the poller asks for on each tick (a factory, so a test can answer differently). */
export async function loadMachineHeartbeatClient(): Promise<MachineHeartbeatClient> {
  return clientFactory();
}

/**
 * #1188 — ONE SESSION PER TARGET AT A TIME.
 *
 * The poller's chain schedules its next tick only after the previous inspect resolves, so a single
 * chain never overlaps itself. But a poll IN FLIGHT when a surface re-acquires — the pin unmounts
 * and Manage mounts on a tree change, or the last hold is released and taken again — is still an
 * open socket, and the new chain's first tick would connect beside it. On the real controller the
 * analyst counted two ESTABLISHED sessions in 20–30 % of idle samples that way (2026-11-10
 * evening): 'nothing leaks after an action' is not the same claim as 'at most one at a time'.
 *
 * A second ask for the same target JOINS the inspection already in flight; its caller gets the
 * same answer (at most one read window old), and the machine never sees a second socket. The key
 * normalises the address so a host written two ways cannot split the gate.
 */
const inFlight = new Map<string, Promise<HeartbeatInspection>>();

function keyOf(target: HeartbeatTarget): string {
  return `${target.host.trim().toLowerCase()}:${target.port}`;
}

/** The poller's one read, sharing an inspection already in flight for the same target. */
export async function inspectTarget(target: HeartbeatTarget): Promise<HeartbeatInspection> {
  const key = keyOf(target);
  const existing = inFlight.get(key);
  if (existing !== undefined) return existing;
  const pending = (async () => {
    const client = await loadMachineHeartbeatClient();
    try {
      return await client.inspect(target);
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, pending);
  return pending;
}

/** Test seam: forget inspections in flight (a spec's fake session will not resolve after reset). */
export function clearMachineHeartbeatInFlight(): void {
  inFlight.clear();
}
