/**
 * The live machine heartbeat (#555) — an active, low-rate reachability check for the remembered
 * machine, driving the always-visible indicator and the online↔offline transition notice.
 *
 * The pieces it replaces were all passive: `MachineStatusStrip` (#526) re-reads only when something
 * polls, and the Manage list's dot reflects the last check, not a live heartbeat. A machine that
 * dropped off the LAN (#304) therefore looked alive until the next command timed out. This module
 * closes that gap: once a machine is remembered, a timer asks it `?` every {@link HEARTBEAT_POLL_MS}
 * (never faster), records reachable/unreachable/last-seen into `machineStore`, and posts a notice
 * on the store when the answer flips.
 *
 * THE WEB-SAFE BOUNDARY, same shape as `machineProbe` / `machineUpload`: the real client is the
 * bridge reached through `loadMachineBridge()` behind the `canDriveMachine` guard — never a
 * top-level import of `platform/desktop/`, or the bridge leaks into the web bundle and
 * `npm run check:platform-gate` fails. The poll floor is restated here rather than imported from
 * `protocol.ts` for the same reason; `machineHeartbeat.spec.ts` asserts the two numbers are equal.
 *
 * ONE heartbeat at a time. `startHeartbeat` stops any running one first, and `stopHeartbeat` is the
 * component cleanup. Reachability is re-established on every start, so the first tick never posts a
 * spurious transition (a fresh mount is not a drop), and each tick schedules the next only after it
 * has answered — a dead machine costs a connect timeout, never an overlapping poll.
 */

import { loadMachineBridge } from './capabilities';
import { liveShopDefaults, machineTiming } from './defaultsClient';
import { useMachineStore } from '@/store/machineStore';
import { useMachineNoticeStore } from '@/store/machineNoticeStore';

/**
 * How often the heartbeat asks `?`, ms — `protocol.ts`'s `MIN_STATUS_POLL_MS` (#386), restated
 * web-safe for the reason {@link machineProbe}'s `DEFAULT_COMMAND_PORT` restates the command port.
 * The floor exists because a poll every ~0.6 s faulted the controller (2026-10-12); 2 s is the
 * bench's clean interval, and a background heartbeat must respect it exactly as a run's loop does.
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

/** The socket-facing half: one status read, the same shape `MachineProbeClient.status` has. */
export interface MachineHeartbeatClient {
  status(target: HeartbeatTarget): Promise<HeartbeatStatus>;
}

/** The real client: the bridge, reached only through the capability guard. */
async function loadRealClient(): Promise<MachineHeartbeatClient> {
  const bridge = await loadMachineBridge();
  return {
    status: async (target) => {
      const reading = await bridge.status(target, {
        connectTimeoutMs: machineTiming(liveShopDefaults()).connectTimeoutMs,
      });
      return { ok: reading.ok, text: reading.text };
    },
  };
}

let clientFactory: () => Promise<MachineHeartbeatClient> = loadRealClient;

/** Swap the client. Vitest uses this; the app never calls it. `null` restores the real bridge. */
export function setMachineHeartbeatLoader(fn: (() => Promise<MachineHeartbeatClient>) | null): void {
  clientFactory = fn ?? loadRealClient;
}

let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let lastReachable: boolean | null = null;

/**
 * Start the heartbeat for `target`, replacing any running one. The first check runs immediately so
 * the indicator is live rather than waiting out a full interval; each following tick is scheduled
 * after the previous one answered, at {@link HEARTBEAT_POLL_MS} or slower.
 */
export function startHeartbeat(target: HeartbeatTarget): void {
  stopHeartbeat();
  running = true;
  // Re-established on start: the first tick records the current answer without a transition, so a
  // mount (StrictMode, a re-check, a mode change) is never reported as the machine dropping.
  lastReachable = null;

  const pollMs = HEARTBEAT_POLL_MS;

  const tick = async (): Promise<void> => {
    if (!running) return;

    let client: MachineHeartbeatClient;
    try {
      client = await clientFactory();
    } catch {
      // The web build's answer, and the reason is the guard's own sentence. With no socket there is
      // nothing to poll — but there is also no remembered machine there, so this is unreachable in
      // practice; treat it as unreachable rather than crash a timer.
      if (running) note(false);
      schedule();
      return;
    }

    let reachable = false;
    let line: string | null = null;
    try {
      const reading = await client.status(target);
      reachable = reading.ok;
      // #527 — the same answer is the viewport's live position: keep the raw line, not just a bit.
      // Only the ANSWER is kept, so a failed poll leaves the last reading in place and the
      // heartbeat's `reachable` is what stops a stale line being drawn as live.
      line = reading.ok ? reading.text : null;
    } catch {
      // `tcpConnect`/`tcpRead` reject when the peer is gone — exactly the drop this heartbeat exists
      // to notice, so it is a result (unreachable) rather than a fault to propagate.
    }

    if (!running) return;
    if (line !== null) useMachineStore.getState().noteLiveStatusLine(line);
    note(reachable);
    schedule();
  };

  const note = (reachable: boolean): void => {
    useMachineStore.getState().noteHeartbeat(reachable);
    if (lastReachable !== null && reachable !== lastReachable) {
      useMachineNoticeStore.getState().post({
        kind: reachable ? 'online' : 'offline',
        at: new Date().toISOString(),
      });
    }
    lastReachable = reachable;
  };

  const schedule = (): void => {
    if (!running) return;
    timer = setTimeout(() => void tick(), pollMs);
  };

  void tick();
}

/** Stop the heartbeat and clear its timer. Idempotent; safe to call when nothing is running. */
export function stopHeartbeat(): void {
  running = false;
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}
