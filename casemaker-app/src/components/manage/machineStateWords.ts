/**
 * What one machine is doing, in the operator's words (#1173A item 1).
 *
 * THE FOUR STATES THE PAGE DRAWS, from two observations that are kept apart on purpose:
 *   - the live status line the heartbeat folds in (`machine.status`), and
 *   - whether the last heartbeat reached the machine at all (`heartbeat.reachable`).
 *
 * A stale status line is not a standing claim. When the heartbeat misses, the machine is SILENT no
 * matter what its last line said — that is why `reachable` is consulted first. Alarm outranks
 * motion (an alarm stops the program), and motion outranks ready.
 *
 * "Homed" is the controller's own answer (`Idle` at its homed rest — see `machineChangeRun.ts`),
 * never a guess: an `Idle` machine away from home is simply ready.
 */

import { readMachineRest } from '@/platform/machineChangeRun';
import { controllerState, jobProgressPercent } from '@/platform/machineUpload';
import { clockWords } from './switchWords';

export type MachineLiveState = 'ready' | 'running' | 'alarm' | 'silent' | 'unknown';

export interface LiveFactsInput {
  /** The name the operator sees (`machineDisplayName` or the controller's own). */
  name: string;
  /** The model row's name, e.g. "Makera Z1". */
  modelName: string;
  host: string;
  /** The last status line the heartbeat folded in, or the check's. */
  status: string | null;
  reachable: boolean | null;
  lastSeenAt: string | null;
  /** The check's own moment, used when no heartbeat has ever answered. */
  checkedAt: string | null;
  /** Injectable for tests; the caller passes `Date.now()`. */
  now: number;
}

export interface LiveFacts {
  state: MachineLiveState;
  /** The state card's one line. */
  headline: string;
  /** Whether a program (or a homing move) owns the machine now. */
  moving: boolean;
  /** Whether the Stop control would send anything at this moment. */
  stopLive: boolean;
  /** The Stop control's label, which says what a press would do now. */
  stopLabel: string;
  /** Whether the controller reports an alarm. */
  alarmed: boolean;
  /** Switches are locked while a program runs and while the machine is not answering. */
  switchesLocked: boolean;
  /** `HH:MM` the machine was last reached, for the silent state (null when never reached). */
  silentSince: string | null;
}

/** `2 s ago` / `1 min ago` — the age of the last heartbeat answer. */
function agoWords(iso: string | null, now: number): string {
  if (iso === null) return 'just now';
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return 'just now';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} min ago`;
}

/**
 * The machine's own alarm words, skipping the status line itself. `alarmLine`'s dialect matches the
 * state word `Alarm` too, so on a `<Alarm|…>` line it would quote the whole line; the operator wants
 * the controller's `ALARM: Probe fail` sentence, which arrives as its own line in the same reply.
 */
function machineAlarmWords(status: string | null): string | null {
  if (status === null) return null;
  for (const line of status.split(/\r?\n/)) {
    const text = line.trim();
    if (text === '' || text.startsWith('<')) continue;
    if (/\bALARM\b|Probe fail|error:/i.test(text)) return text;
  }
  return null;
}

export function liveFacts(input: LiveFactsInput): LiveFacts {
  const stateWord = controllerState(input.status);
  const alarm = machineAlarmWords(input.status);
  const percent = jobProgressPercent(input.status);
  const alarmed = stateWord === 'Alarm' || alarm !== null;
  // `Idle` appears mid-job for the spin-down; a `P:` below 100 is a program still finishing.
  const program =
    stateWord === 'Run' || stateWord === 'Hold' || (percent !== null && percent < 100);
  const homing = stateWord !== null && stateWord !== 'Idle' && !program && !alarmed;
  const moving = !alarmed && (program || homing);
  const stopLive = !alarmed && program;

  const stopLabel = stopLive ? '■ Stop · stops now' : '■ Stop · nothing running';

  if (input.reachable === false) {
    const since = input.lastSeenAt ?? input.checkedAt;
    return {
      state: 'silent',
      headline: since === null ? 'Not answering' : `Not answering since ${clockWords(since)}`,
      moving: false,
      stopLive: false,
      stopLabel,
      // The last line may have been an alarm, but a machine that is not answering cannot be
      // unlocked: no live claim, so the action is off.
      alarmed: false,
      switchesLocked: true,
      silentSince: since === null ? null : clockWords(since),
    };
  }

  if (alarmed) {
    return {
      state: 'alarm',
      headline: `In alarm — “${alarm ?? 'the controller reports Alarm'}”`,
      moving: false,
      stopLive: false,
      stopLabel,
      alarmed: true,
      switchesLocked: true,
      silentSince: null,
    };
  }

  if (moving) {
    const headline = program
      ? percent !== null && percent < 100
        ? `Cutting program — ${percent}% done`
        : 'Cutting program'
      : `${stateWord ?? 'Moving'} — the machine is moving`;
    return {
      state: 'running',
      headline,
      moving: true,
      stopLive,
      stopLabel,
      alarmed: false,
      switchesLocked: true,
      silentSince: null,
    };
  }

  if (input.reachable === true) {
    const homed = readMachineRest(input.status)?.homed === true;
    return {
      state: 'ready',
      headline: `${input.name} is ready — ${stateWord ?? 'Idle'}${homed ? ' · homed' : ''} · answered ${agoWords(input.lastSeenAt, input.now)} · ${input.modelName} at ${input.host}`,
      moving: false,
      stopLive: false,
      stopLabel,
      alarmed: false,
      switchesLocked: false,
      silentSince: null,
    };
  }

  return {
    state: 'unknown',
    headline: `Checking whether ${input.name} is answering…`,
    moving: false,
    stopLive: false,
    stopLabel,
    alarmed: false,
    switchesLocked: false,
    silentSince: null,
  };
}
