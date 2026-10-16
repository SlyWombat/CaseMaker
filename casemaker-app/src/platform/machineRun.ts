/**
 * Running a verified program from the app (#423, §5.10) — the harness's `z1.mjs run`, ported to the
 * app's console seam. Upload is `machineUpload.ts`'s; this is what comes after it.
 *
 * NEVER STREAMED (#386). The program is already on the machine's card; it starts with ONE line,
 * `play /sd/gcodes/<file>`, and the controller runs it. Feeding a program line by line through the
 * console faulted the controller on 2026-10-12 with the spindle still turning.
 *
 * THE SEQUENCE.
 *   1. `?` — and nothing but `Idle` with no alarm (in the reply OR between lines) may start a program.
 *      An unanswered poll is refused too: "probably idle" is not a state to start a program on.
 *   2. `M331` — the vacuum, on for every cut (the maintainer's default).
 *   3. `play <path>` — a reply with an error refuses the run (and the vacuum goes off again). An
 *      UNANSWERED play is not a refusal: the controller may still be opening the file, so the watch
 *      starts anyway, as the harness's does.
 *   4. `?` every `pollMs` (never under 2000 ms — the floor is #386's), measured from the previous
 *      send, the first from `play`. The job ends:
 *        - finished — `P` 100 % AND `Idle` in one reply (`Idle` alone is 3–4 s of the job at `M05`), or
 *          `P` seen and then gone with `Idle` (the field leaves the status once the job is over);
 *        - alarm — an alarm anywhere: nothing further is sent;
 *        - unreachable — `missLimit` polls in a row unanswered: NOT stopped from here, and `M332` is
 *          never sent blind;
 *        - never-started — no `P` field within `noProgressMs`: nothing here is watching a job (the
 *          machine answers, nothing runs, so the vacuum this run switched on goes off again).
 *   5. On a finish: `M332`, then `$H` — home after every activity (the bench rule).
 *   6. STOP, asked at any time, goes out at the next poll boundary on the SAME session, through
 *      `machineStop.ts`'s `stopOnSession` (`?`, `abort`, Idle polls, `M332` only once Idle). Home is
 *      then OFFERED, not sent: what the head does after an abort is the person's to see first.
 *
 * Every line sent and every poll read goes to `onEvent`, so a panel can show the run live and a
 * viewport can follow the controller's line number.
 */

import { STOP_FALLBACK, stopOnSession, stopSettings, type StopOutcome, type StopSettings } from './machineStop';
import { alarmLine } from './machineUpload';
import {
  STATUS_POLL_TIMING,
  statusPollTimingFrom,
  type ConsoleHandle,
  type ConsoleSendResult,
  type ConsoleTiming,
} from './machineConsole';
import { VACUUM_OFF, VACUUM_ON } from './machineVacuum';
import { readDefault, type ShopDefaults } from './defaultsClient';

/** The status poll's floor, ms (#386: 0.6 s faulted the controller). The shop default may only raise it. */
export const RUN_POLL_FLOOR_MS = 2000;
/** The machine's job directory — `protocol.ts`'s `GCODE_DIR`, where an upload writes. */
export const RUN_DIR = '/sd/gcodes';

export interface RunSettings {
  pollMs: number;
  noProgressMs: number;
  missLimit: number;
  /** #449 — the status poll's reply window (`run.statusReplyMs`); `STATUS_POLL_TIMING` when absent. */
  statusTiming?: ConsoleTiming;
  /** #449 — what a Stop pressed during the run polls with (`stop.*`); `STOP_FALLBACK` when absent. */
  stop?: StopSettings;
}

/** A status line read for the job's progress — `protocol.ts`'s `readJobProgress`, restated web-safe. */
export interface Progress {
  state: string | null;
  line: number | null;
  percent: number | null;
  elapsedS: number | null;
}

export function readProgress(text: string): Progress {
  const state = /^<([A-Za-z]+)/.exec(text.trim());
  const p = /(?:^|\|)P:([^|>]*)/.exec(text);
  const fields = p === null ? [] : (p[1] as string).split(',');
  const num = (i: number): number | null => {
    const raw = fields[i]?.trim();
    if (raw === undefined || raw === '') return null;
    const v = Number(raw);
    return Number.isFinite(v) ? v : null;
  };
  return { state: state === null ? null : state[1]!, line: num(0), percent: num(1), elapsedS: num(2) };
}

/** The one line that starts a program — `protocol.ts`'s `playProgramLine` rule. */
export function playLine(filename: string): string | null {
  const path = `${RUN_DIR}/${filename}`;
  return /^\/[A-Za-z0-9._/-]+$/.test(path) && !filename.includes('/') ? `play ${path}` : null;
}

export type RunEvent =
  | { kind: 'sent'; line: string; reply: string }
  | { kind: 'poll'; progress: Progress }
  | { kind: 'missed'; misses: number; detail: string };

export type RunOutcome =
  | { kind: 'refused'; reason: string }
  | { kind: 'finished'; last: Progress; homed: boolean; vacuumOff: boolean }
  | { kind: 'aborted'; stop: StopOutcome; last: Progress }
  | { kind: 'alarm'; alarm: string; last: Progress }
  | { kind: 'unreachable'; last: Progress; misses: number }
  | { kind: 'never-started'; last: Progress; vacuumOff: boolean }
  /**
   * Stop was pressed before the machine ever reported progress, and it reads Idle: nothing here can
   * tell whether the program ran, so nothing further is sent — no `M332`, no home (#423 re-review).
   */
  | { kind: 'stopped-unconfirmed'; status: string };

export interface RunDeps {
  session: Pick<ConsoleHandle, 'send'>;
  settings: RunSettings;
  /** True once the person pressed Stop; read at every poll boundary. */
  stopRequested: () => boolean;
  onEvent?: (e: RunEvent) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function said(r: ConsoleSendResult): string {
  return r.kind === 'sent' || r.kind === 'timeout' ? r.text : r.detail;
}

function anyAlarm(r: ConsoleSendResult): string | null {
  if (r.kind !== 'sent' && r.kind !== 'timeout') return null;
  return alarmLine(r.text) ?? alarmLine(r.carried?.text ?? null);
}

export async function runProgram(filename: string, deps: RunDeps): Promise<RunOutcome> {
  const sleep = deps.sleep ?? realSleep;
  const now = deps.now ?? (() => Date.now());
  const pollMs = Math.max(RUN_POLL_FLOOR_MS, deps.settings.pollMs);
  /** Every line goes through here, Stop's included, so the panel sees all of them. */
  const send = async (line: string, timing?: Partial<ConsoleTiming>): Promise<ConsoleSendResult> => {
    const r = await deps.session.send(line, timing);
    deps.onEvent?.({ kind: 'sent', line, reply: said(r) });
    return r;
  };
  const statusTiming = deps.settings.statusTiming ?? STATUS_POLL_TIMING;
  const poll = () => send('?', statusTiming);

  const play = playLine(filename);
  if (play === null) return { kind: 'refused', reason: `${filename} is not a file name the machine can play` };

  // 1 — Idle with no alarm and no program in progress, or nothing.
  const before = await poll();
  const alarmBefore = anyAlarm(before);
  if (alarmBefore !== null) return { kind: 'refused', reason: `the controller is in an alarm (\`${alarmBefore}\`); nothing was played — clear it at the machine` };
  if (before.kind !== 'sent') return { kind: 'refused', reason: 'the machine did not answer a status poll, so whether it is idle is unknown; nothing was played' };
  const pre = readProgress(before.text);
  if (pre.state !== 'Idle') return { kind: 'refused', reason: `the controller reports ${pre.state ?? 'no state'}, not Idle; nothing was played` };
  // Idle with P below 100 is a program paused mid-job (the 3–4 s `Idle` at `M05`), not a free machine.
  if (pre.percent !== null && pre.percent < 100) {
    return { kind: 'refused', reason: `the controller reads Idle with a program at ${pre.percent} % — one is still in progress; nothing was played` };
  }
  if (deps.stopRequested()) return { kind: 'refused', reason: 'Stop was pressed before the program started; nothing was played' };

  // 2 — the vacuum.
  const vac = await send(VACUUM_ON);
  if (vac.kind !== 'sent' || anyAlarm(vac) !== null) {
    return { kind: 'refused', reason: `the vacuum did not switch on (${said(vac).trim() || vac.kind}); nothing was played` };
  }

  // 3 — play. Only a reply that SAYS no, or a line that was never sent, means it did not start.
  const playSentAt = now();
  const played = await send(play);
  if (played.kind === 'sent' && /\berror\b|not found|no such file|unknown/i.test(played.text)) {
    await send(VACUUM_OFF);
    return { kind: 'refused', reason: `the controller did not accept the program: ${played.text.trim()}` };
  }
  if (played.kind === 'refused' || played.kind === 'unavailable') {
    await send(VACUUM_OFF);
    return { kind: 'refused', reason: `${play} could not be sent: ${said(played)}` };
  }
  // A timeout or a socket error AFTER the line went out is not a job that failed to start: the
  // controller may be running it. The watch starts anyway (the harness's rule); the next poll opens a
  // fresh connection if the old one died.

  // 4 — watch.
  let last: Progress = { state: null, line: null, percent: null, elapsedS: null };
  let seenProgress = false;
  let misses = 0;
  let lastSendAt = playSentAt;
  for (;;) {
    const wait = pollMs - (now() - lastSendAt);
    if (wait > 0) await sleep(wait);

    if (deps.stopRequested()) {
      const stop = await stopOnSession({ send }, sleep, deps.settings.stop ?? STOP_FALLBACK);
      // `not-running` is Idle with no program in progress. After progress was seen, that is the job
      // ending just as Stop was pressed — a finish. Before any, it proves nothing: say so, send nothing.
      if (stop.kind === 'not-running') {
        return seenProgress ? finish(readProgress(stop.status)) : { kind: 'stopped-unconfirmed', status: stop.status };
      }
      return { kind: 'aborted', stop, last };
    }

    lastSendAt = now();
    const r = await poll();
    const alarm = anyAlarm(r);
    if (alarm !== null) return { kind: 'alarm', alarm, last };
    if (r.kind !== 'sent') {
      misses += 1;
      deps.onEvent?.({ kind: 'missed', misses, detail: said(r) });
      // A pressed Stop is always sent (#423 re-review): it goes out at the next boundary, even when
      // this miss would otherwise have been the one that gave up.
      if (misses >= deps.settings.missLimit && !deps.stopRequested()) return { kind: 'unreachable', last, misses };
      continue;
    }
    misses = 0;
    const p = readProgress(r.text);
    last = p;
    deps.onEvent?.({ kind: 'poll', progress: p });
    if (p.percent !== null) seenProgress = true;
    if (p.percent === 100 && p.state === 'Idle') return finish(p);
    if (seenProgress && p.percent === null && p.state === 'Idle') return finish(p);
    if (!seenProgress && now() - playSentAt >= deps.settings.noProgressMs) {
      // Nothing ran. The vacuum this run switched on goes off again — but only on a machine that
      // reads Idle: anything else is a machine doing something this watch cannot see.
      const vacuumOff = p.state === 'Idle' ? (await send(VACUUM_OFF)).kind === 'sent' : false;
      return { kind: 'never-started', last, vacuumOff };
    }
  }

  async function finish(at: Progress): Promise<RunOutcome> {
    const off = await send(VACUUM_OFF);
    const home = await send('$H');
    return {
      kind: 'finished',
      last: at,
      vacuumOff: off.kind === 'sent' && anyAlarm(off) === null,
      homed: home.kind === 'sent' && anyAlarm(home) === null,
    };
  }
}

/** The outcome in a sentence, for the panel. */
export function describeRun(o: RunOutcome): string {
  switch (o.kind) {
    case 'refused':
      return `Not started: ${o.reason}.`;
    case 'finished':
      return `Finished${o.last.elapsedS !== null ? ` in ${Math.round(o.last.elapsedS)} s` : ''}. ${o.vacuumOff ? 'Vacuum off' : 'The vacuum-off (M332) was not confirmed — check it'}; ${o.homed ? 'homed' : 'the home ($H) was not confirmed — home it'}.`;
    case 'aborted':
      return o.stop.kind === 'stopped'
        ? `Stopped at line ${o.last.line ?? '?'}${o.stop.vacuumOff ? ', vacuum off' : ' — the vacuum-off was not confirmed'}. Home the machine when the head is clear.`
        : `Stop was sent, but: ${'detail' in o.stop ? o.stop.detail : o.stop.kind}. The machine's red button is the emergency stop.`;
    case 'alarm':
      return `The controller said \`${o.alarm}\` — an alarm. Nothing further was sent; the physical stop is the stop.`;
    case 'unreachable':
      return `Silence is not stopped: ${o.misses} status polls in a row went unanswered. The job was NOT stopped from here and the vacuum was not switched off — the physical stop (the machine's button, the plug) is the stop.`;
    case 'never-started':
      return `No job progress ever appeared — nothing here was watching a job.${o.vacuumOff ? ' The vacuum was switched off again.' : ' The machine did not read Idle, so the vacuum was left as it is — check the machine.'}`;
    case 'stopped-unconfirmed':
      return 'Stop was pressed before the machine reported any progress, and it reads Idle — nothing shows whether the program ran, so nothing further was sent (no M332: the vacuum is still on; no home). Check the machine.';
  }
}

/** The run tunables from the shop's defaults (`run.*`) — the labelled fallbacks only with no service. */
export function runSettings(defaults: ShopDefaults | null): RunSettings {
  return {
    pollMs: Math.max(RUN_POLL_FLOOR_MS, readDefault(defaults, 'run.pollMs').value),
    noProgressMs: readDefault(defaults, 'run.noProgressMs').value,
    missLimit: readDefault(defaults, 'run.missLimit').value,
    statusTiming: statusPollTimingFrom(defaults),
    stop: stopSettings(defaults),
  };
}

/** A short, stable hash of a program's text (FNV-1a, 32-bit) — the run confirmation's key (#423, Q17). */
export function programHash(nc: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < nc.length; i++) {
    h ^= nc.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
