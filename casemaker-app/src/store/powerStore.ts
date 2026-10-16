/**
 * The power switch's GUARDS and FLOWS (#416, decision Q5): pure rules handed the evidence, plus the
 * on-and-wait and cycle sequences with the switch and the machine check passed in, so every rule is
 * tested against a fake provider and nothing here can reach a real plug on its own.
 *
 * THE RULES, IN ONE PLACE.
 *   - Never off while a job is running — the flow's own knowledge, AND the status line's `P:` progress
 *     (the machine reads `Idle` for ~4 s mid-job at `M05`, so the state word alone cannot say it).
 *   - Off at the END OF A JOB only after a fresh status read showing `Idle` and a home recorded after
 *     the last run. An unreachable machine at job end is not switched off: its state is not known.
 *   - The card's MANUAL Off mirrors `tools/z1/power.sh off`: refused unless the machine reads `Idle`.
 *     A machine that does not answer is NOT switched off on one silent probe — a Wi-Fi blip mid-job
 *     looks exactly like that (#416 review). It is probed several times ({@link probeSettled}); still
 *     silent, Off needs the person to CONFIRM it, and only then goes ahead with a warning.
 *   - A window that cannot read the status at all (the web build) cannot meet either guard, and gets
 *     no Off.
 *   - On waits until the controller answers — port 2222 accepts and `?` returns a status line — for
 *     the shop's `power.onWaitSeconds` (a location default, not a constant here); on a timeout the
 *     plug is LEFT ON, as `power.sh` leaves it.
 *   - A plug that is on with the machine silent is NEVER cycled by On (#416 review). On says so, and
 *     the CYCLE — off, a pause, on — is its own action the person confirms, like `power.sh on
 *     --cycle`; it too probes several times first and refuses a machine that answers.
 *
 * WHO CALLS THESE. The Machines card's On / Off. The job flow (switch on at the start, off after the
 * end) will call {@link powerOnAndWait} and {@link jobEndOffAllowed}; its screens are not this file's,
 * so that wiring is the job flow's (#419).
 */

import { alarmLine, controllerState, jobProgressPercent } from '@/platform/machineUpload';

/** What is known about the machine at the moment of an Off. */
export interface OffEvidence {
  /** Whether this window can read a status line at all (`canDriveMachine`). */
  canReadStatus: boolean;
  /** A status line read JUST NOW, or null when the machine did not answer. */
  status: string | null;
  /** The flow's own knowledge that a program is running (a job in progress). */
  jobRunning: boolean;
  /** Whether a home ($H) was recorded after the last run finished. Only the job-end rule asks. */
  homedAfterLastRun: boolean;
}

export type PowerVerdict = { ok: true; warning?: string } | { ok: false; reason: string };

/** Whether the status line itself says a program is running (`P:` below 100), or the machine alarms. */
function statusSaysBusy(status: string): string | null {
  const alarm = alarmLine(status);
  if (alarm !== null) return `the machine is in alarm (${alarm})`;
  const p = jobProgressPercent(status);
  if (p !== null && p < 100) return `a program is running (${p}%)`;
  return null;
}

/** The END-OF-JOB Off: Idle, nothing running, and homed since the last run. */
export function jobEndOffAllowed(e: OffEvidence): PowerVerdict {
  if (e.jobRunning) return { ok: false, reason: 'a job is running — power is never cut while one runs' };
  if (!e.canReadStatus) return { ok: false, reason: 'this window cannot read the machine’s status, so it cannot switch it off' };
  if (e.status === null) return { ok: false, reason: 'the machine did not answer, so its state is not known — it is left on' };
  const busy = statusSaysBusy(e.status);
  if (busy !== null) return { ok: false, reason: `${busy} — it is left on` };
  const state = controllerState(e.status);
  if (state !== 'Idle') return { ok: false, reason: `the machine reads ${state ?? 'no state'}, not Idle — it is left on` };
  if (!e.homedAfterLastRun) return { ok: false, reason: 'the machine has not homed since the run — home it, then switch off' };
  return { ok: true };
}

/**
 * The card's MANUAL Off, as `power.sh off` judges it. `status` must come from {@link probeSettled}
 * (several probes), never one. A silent machine needs `confirmedSilent` — the person said "switch it
 * off anyway" after being told it did not answer.
 */
export function manualOffAllowed(
  e: Omit<OffEvidence, 'homedAfterLastRun'> & { confirmedSilent?: boolean },
): PowerVerdict | { ok: false; needsConfirm: true; reason: string } {
  if (e.jobRunning) return { ok: false, reason: 'a job is running — power is never cut while one runs' };
  if (!e.canReadStatus) return { ok: false, reason: 'this window cannot read the machine’s status, so it cannot switch it off' };
  if (e.status === null) {
    if (!e.confirmedSilent) {
      return {
        ok: false,
        needsConfirm: true,
        reason: 'the machine did not answer after several tries — it may be mid-job on a dropped network; switch it off anyway?',
      };
    }
    return { ok: true, warning: 'the machine did not answer, so it was switched off without asking it' };
  }
  const busy = statusSaysBusy(e.status);
  if (busy !== null) return { ok: false, reason: busy };
  const state = controllerState(e.status);
  if (state !== 'Idle') return { ok: false, reason: `the machine reads ${state ?? 'no state'}, not Idle` };
  return { ok: true };
}

/** What a flow needs from the outside world — the switch, the machine check, and time. */
export interface PowerDeps {
  /** Switch the plug; the provider's own sentence on failure. */
  switchPlug: (on: boolean) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /** The plug's state now, or null when the provider could not say. */
  plugIsOn: () => Promise<boolean | null>;
  /** One machine check: did port 2222 accept, and what did `?` answer. */
  probe: () => Promise<{ answered: boolean; status: string | null }>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export type PowerOnResult =
  | { ok: true; status: string }
  | { ok: false; reason: string; needsCycle?: true };

/**
 * Ask the machine `tries` times, `gapMs` apart, and return the first status line it answers with —
 * or null only when EVERY try was silent (#416 review: one silent probe is a Wi-Fi blip as often as
 * it is a dead controller, and a decision to cut mains must not rest on one).
 */
export async function probeSettled(
  deps: Pick<PowerDeps, 'probe' | 'sleep'>,
  opts: { tries?: number; gapMs?: number } = {},
): Promise<string | null> {
  const tries = opts.tries ?? 3;
  for (let i = 0; i < tries; i++) {
    const r = await deps.probe();
    if (r.answered && r.status !== null) return r.status;
    if (i < tries - 1) await deps.sleep(opts.gapMs ?? 2000);
  }
  return null;
}

/** Poll until the controller answers with a status line, or `waitSeconds` pass. */
async function waitForAnswer(deps: PowerDeps, waitSeconds: number, pollMs: number): Promise<string | null> {
  const start = deps.now();
  for (;;) {
    const r = await deps.probe();
    if (r.answered && r.status !== null) return r.status;
    if (deps.now() - start >= waitSeconds * 1000) return null;
    await deps.sleep(pollMs);
  }
}

/**
 * Switch on, then wait until the controller answers (port, then `?`). A plug that is ALREADY on is
 * not touched: the machine answering is success, and a silent one is reported with `needsCycle` —
 * the cycle is {@link cycleConfirmed}, an action of its own. On a timeout the plug is left on.
 */
export async function powerOnAndWait(
  deps: PowerDeps,
  opts: { waitSeconds: number; pollMs?: number; probeGapMs?: number },
): Promise<PowerOnResult> {
  const pollMs = opts.pollMs ?? 3000;
  if ((await deps.plugIsOn()) === true) {
    const status = await probeSettled(deps, { gapMs: opts.probeGapMs });
    if (status !== null) return { ok: true, status };
    return {
      ok: false,
      needsCycle: true,
      reason:
        'the plug is already on but the machine does not answer — it sometimes fails to join the network at power-up, and only a plug cycle brings it back. Cycle it only if no job is running.',
    };
  }
  const on = await deps.switchPlug(true);
  if (!on.ok) return { ok: false, reason: on.reason };
  const status = await waitForAnswer(deps, opts.waitSeconds, pollMs);
  if (status === null) {
    return { ok: false, reason: `the plug is on, but the machine did not answer within ${opts.waitSeconds} s — it is left on` };
  }
  return { ok: true, status };
}

/**
 * The CONFIRMED plug cycle (`power.sh on --cycle`, the #304 recovery). Called only after the person
 * confirmed it. Still refuses a machine that answers on any of several probes — a machine that talks
 * is not the case a cycle is for — and a plug that is not on.
 */
export async function cycleConfirmed(
  deps: PowerDeps,
  opts: { waitSeconds: number; pollMs?: number; probeGapMs?: number; pauseMs?: number },
): Promise<PowerOnResult> {
  if ((await deps.plugIsOn()) !== true) return { ok: false, reason: 'the plug is not on — use On instead' };
  const answering = await probeSettled(deps, { gapMs: opts.probeGapMs });
  if (answering !== null) return { ok: false, reason: 'the machine answered, so it is not cycled' };
  const off = await deps.switchPlug(false);
  if (!off.ok) return { ok: false, reason: off.reason };
  await deps.sleep(opts.pauseMs ?? 10_000);
  const on = await deps.switchPlug(true);
  if (!on.ok) return { ok: false, reason: on.reason };
  const status = await waitForAnswer(deps, opts.waitSeconds, opts.pollMs ?? 3000);
  return status === null
    ? { ok: false, reason: `cycled, but the machine did not answer within ${opts.waitSeconds} s — it is left on` }
    : { ok: true, status };
}

/** Off, judged first: the verdict is returned unchanged when it refuses, and nothing is switched. */
export async function powerOffGuarded<V extends PowerVerdict | { ok: false; needsConfirm: true; reason: string }>(
  deps: PowerDeps,
  verdict: V,
): Promise<V | PowerVerdict> {
  if (!verdict.ok) return verdict;
  const off = await deps.switchPlug(false);
  return off.ok ? verdict : { ok: false, reason: off.reason };
}
