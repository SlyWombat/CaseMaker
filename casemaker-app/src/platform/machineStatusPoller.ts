/**
 * THE MACHINE STORE'S SINGLE STATUS POLLER (#555, #1173).
 *
 * ONE status poll per machine connection, reference-counted by whoever needs it — the pinned
 * machine in the sidebar, the Manage page, and (by suppression, below) a running program. The
 * analyst's bar of 2026-11-10 is the reason this is a registry rather than a start/stop pair: two
 * surfaces that both want live status must share one timer, and a run's own status loop already IS
 * a poller, so nothing here may add a second stream to the controller while one is going.
 *
 * A BUG THE START/STOP PAIR HAD. `startHeartbeat` stopped any running poller and `stopHeartbeat`
 * stopped whichever was running; with two mounts (the pin and Manage) the second one starting killed
 * the first, and the first one unmounting killed the second. Counting holds makes each surface's
 * unmount release only its own, and the poll stops when the last one lets go.
 *
 * A RUN OWNS THE POLL WHILE IT RUNS. A run takes a hold with `pollsItself`: its loop sends `?` at
 * the poll floor on its own session, so this module starts no timer at all for that connection.
 * `acquireStatusPoll` during a run adds a hold and starts nothing; when the run's hold is released,
 * the timer starts again if anything still holds it. `noteRunStatus` folds the run's own answers
 * into the store, so the Manage page is live during a run without polling the machine itself.
 *
 * THE STORE IS THE ONLY OWNER OF A READING. This module never keeps a status of its own: every
 * answer goes through `machineStore` (`noteLiveStatusLine`, `noteDiagnoseLine`, `noteHeartbeat`),
 * and the transition notice through `machineNoticeStore`. It owns only the timers and the holds.
 */

import {
  HEARTBEAT_POLL_MS,
  loadMachineHeartbeatClient,
  setMachineHeartbeatLoader,
  type HeartbeatTarget,
} from '@/platform/machinePollClient';
import { useMachineNoticeStore } from '@/store/machineNoticeStore';
import { useMachineStore } from '@/store/machineStore';

// The poll's interval and the client type are part of this module's contract for its callers and
// its spec; the socket half itself lives in machinePollClient.ts.
export { HEARTBEAT_POLL_MS, setMachineHeartbeatLoader };
export type { HeartbeatTarget, MachineHeartbeatClient } from '@/platform/machinePollClient';

interface StatusPoller {
  target: HeartbeatTarget;
  /** The surfaces holding this poller; the timer runs while the set is non-empty and none polls itself. */
  holds: Set<string>;
  /** The consumers that send their own `?` (a run); while any is here, no timer of ours runs. */
  selfPolling: Set<string>;
  running: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  /** The previous answer, for a transition notice; null is "no previous answer yet". */
  lastReachable: boolean | null;
}

const pollers = new Map<string, StatusPoller>();

function keyOf(target: HeartbeatTarget): string {
  return `${target.host}:${target.port}`;
}

function stopTimer(entry: StatusPoller): void {
  entry.running = false;
  if (entry.timer !== null) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
}

function startTimer(entry: StatusPoller): void {
  if (entry.running) return;
  entry.running = true;
  // A fresh start re-establishes reachability: the first answer is not a transition (a mount or a
  // run's hand-off is not the machine dropping).
  entry.lastReachable = null;

  const tick = async (): Promise<void> => {
    if (!entry.running) return;

    let reachable = false;
    let line: string | null = null;
    let diagnoseLine: string | null = null;
    try {
      const client = await loadMachineHeartbeatClient();
      const reading = await client.inspect(entry.target);
      reachable = reading.status.ok;
      // #527 — the same answer is the viewport's live position: keep the raw line, not just a bit.
      // Only the ANSWER is kept, so a failed poll leaves the last reading in place and the
      // heartbeat's `reachable` is what stops a stale line being drawn as live.
      line = reading.status.ok ? reading.status.text : null;
      // #826 — the diagnostic line rides the same tick; the store drops an unchanged reading.
      diagnoseLine = reading.diagnose !== null && reading.diagnose.ok ? reading.diagnose.text : null;
    } catch {
      // `tcpConnect`/`tcpRead` reject when the peer is gone — exactly the drop this poller exists
      // to notice, so it is a result (unreachable), not a fault to propagate.
    }

    if (!entry.running) return;
    if (line !== null) useMachineStore.getState().noteLiveStatusLine(line);
    if (diagnoseLine !== null) useMachineStore.getState().noteDiagnoseLine(diagnoseLine);
    noteReachable(entry, reachable);
    entry.timer = setTimeout(() => void tick(), HEARTBEAT_POLL_MS);
  };

  void tick();
}

function noteReachable(entry: StatusPoller, reachable: boolean): void {
  useMachineStore.getState().noteHeartbeat(reachable);
  if (entry.lastReachable !== null && reachable !== entry.lastReachable) {
    useMachineNoticeStore.getState().post({
      kind: reachable ? 'online' : 'offline',
      at: new Date().toISOString(),
    });
  }
  entry.lastReachable = reachable;
}

/**
 * Hold the status poll for one machine. Returns the release; call it on unmount. `consumer` names
 * the surface ('pin', 'manage', 'run'), so one surface's release cannot stop another's poll.
 *
 * `pollsItself` is the run's kind of hold: the run's loop sends `?` on its own session, so while
 * that hold lasts this module starts no timer at all. Each run's answer is folded in by
 * {@link noteRunStatus}.
 */
export function acquireStatusPoll(
  target: HeartbeatTarget,
  consumer: string,
  opts: { pollsItself?: boolean } = {},
): () => void {
  const key = keyOf(target);
  let entry = pollers.get(key);
  if (entry === undefined) {
    entry = {
      target: { ...target },
      holds: new Set(),
      selfPolling: new Set(),
      running: false,
      timer: null,
      lastReachable: null,
    };
    pollers.set(key, entry);
  }
  entry.holds.add(consumer);
  if (opts.pollsItself === true) {
    entry.selfPolling.add(consumer);
    // The run owns the requests from its first one: stop the timer outright, not just a tick.
    stopTimer(entry);
  } else if (entry.selfPolling.size === 0) {
    startTimer(entry);
  }

  return () => {
    const current = pollers.get(key);
    if (current === undefined) return;
    current.holds.delete(consumer);
    current.selfPolling.delete(consumer);
    if (current.holds.size === 0) {
      stopTimer(current);
      pollers.delete(key);
    } else if (current.selfPolling.size === 0 && !current.running) {
      // The run ended while a page still holds the poller: hand the polling back to the timer.
      startTimer(current);
    }
  };
}

/**
 * Fold one of a run's own `?` answers into the store, so the Manage card is live during a run
 * without a second poll. `raw` is null on a missed poll (reachable goes false; the last line stays,
 * exactly as the timer's own failed tick leaves it).
 */
export function noteRunStatus(raw: string | null): void {
  if (raw !== null) useMachineStore.getState().noteLiveStatusLine(raw);
  useMachineStore.getState().noteHeartbeat(raw !== null);
}

/** Test seam: stop every timer and forget every hold. */
export function releaseAllStatusPollers(): void {
  for (const entry of pollers.values()) stopTimer(entry);
  pollers.clear();
}
