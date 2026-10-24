import type { JSX } from 'react';
import { useMachineStore } from '@/store/machineStore';
import { useRegistrationTouchesStore } from '@/store/registrationTouchesStore';
import { useEngraveReleaseStore } from '@/store/engraveReleaseStore';
import { machineKey, useMachineRunStore } from '@/store/machineRunStore';
import { readStatusLine, type JobProgress, type StatusRate } from '@/platform/desktop/protocol';

/**
 * #526 — the live machine in one line under the viewport, whenever a machine is remembered.
 *
 * The strip is the single home for machine state (§7): it reads the raw `status` the store keeps
 * and the one parser in `protocol.ts` turns it into the facts it shows. Everything live — the
 * viewport's tool body and the touches — reads the same parsed line, so the strip cannot disagree
 * with them. The rail no longer prints machine state (the Cut surface's `MachineStrip` switches are
 * the operator's DECISIONS, not the machine's report; this is the report).
 */

/** The controller's state word in the operator's words (§5). */
function stateWord(state: string | null): string {
  if (state === null) return 'Not answering';
  switch (state) {
    case 'Idle':
      return 'Idle';
    case 'Home':
      return 'Homing';
    case 'Run':
      return 'Running';
    case 'Alarm':
      return 'Alarm';
    default:
      return state;
  }
}

/** `12.350` → `"12.350"`; null → `"—"`. */
function fmt3(n: number | null): string {
  return n === null ? '—' : n.toFixed(3);
}

/** `75` → `"1:15"`, `12` → `"12 s"` — the job's elapsed time (§5). */
function fmtElapsed(s: number): string {
  if (s < 60) return `${Math.round(s)} s`;
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

/** The `P:` fact in the operator's words, or null when the line carries no program. */
function fmtProgram(p: JobProgress | null | undefined): string | null {
  if (p == null || (p.line === null && p.percent === null)) return null;
  const parts: string[] = [];
  if (p.line !== null) parts.push(`line ${p.line}`);
  if (p.percent !== null) parts.push(`${p.percent} %`);
  if (p.elapsedS !== null) parts.push(fmtElapsed(p.elapsedS));
  return parts.join(' · ');
}

/** The `S:` fact — actual rpm, `off` at zero, the set figure only when actual is missing. */
function fmtSpindle(rate: StatusRate | null | undefined): string | null {
  if (rate == null) return null;
  if (rate.actual !== null) return rate.actual === 0 ? 'spindle off' : `spindle ${rate.actual} rpm`;
  if (rate.set !== null) return `spindle ${rate.set} rpm (set)`;
  return null;
}

export function MachineStatusStrip(): JSX.Element | null {
  const machine = useMachineStore((s) => s.machine);
  // #519 item 3 — a registration owns the machine: the state reads Probing and the strip shows the
  // runner's current step in the program's slot ("what the machine is doing now").
  const registrationActive = useMachineStore((s) => s.registrationActive);
  const registrationStep = useRegistrationTouchesStore((s) => s.step);
  // §5 — the vacuum is what the app last SENT (the controller does not report it), so the reading
  // carries its own qualifier; `unknown` (after an alarm or a drop) is not printed as a state.
  const vacuum = useEngraveReleaseStore((s) =>
    machine === null ? null : s.records[machineKey(machine)]?.vacuum ?? null,
  );
  // #618 — the app knows a job it suspended; the controller may read `Idle` once the queue drains.
  const runPaused = useMachineRunStore((s) => (machine === null ? false : s.runs[machineKey(machine)]?.paused === true));
  const requestStop = useMachineRunStore((s) => s.requestStop);
  if (machine === null) return null;

  // `statusLine` is set by the store and the probe; a test fixture may hand only the raw line.
  const line = machine.statusLine ?? (machine.status === null ? null : readStatusLine(machine.status));
  const state = runPaused
    ? 'Paused'
    : registrationActive && line?.state === 'Run'
      ? 'Probing'
      : stateWord(line?.state ?? null);
  const wpos = line?.wpos ?? null;
  const idle = state === 'Idle' || state === 'Not answering';
  const program = fmtProgram(line?.progress);
  const spindle = fmtSpindle(line?.spindle);
  const tool = line?.tool ?? null;

  return (
    <div
      data-testid="machine-status"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '2px 10px',
        borderTop: '1px solid #2a2f36',
        fontSize: 11,
        color: '#c8d3de',
        minHeight: 22,
      }}
    >
      <span data-testid="machine-status-state">{state}</span>
      {/* #519 item 3 — the registration's current step occupies the program's slot while a
          registration is running; a program's line/percent is the only other thing that slot says. */}
      {registrationActive && registrationStep !== null ? (
        <span data-testid="machine-status-step">{registrationStep}</span>
      ) : (
        program !== null && <span data-testid="machine-status-program">{program}</span>
      )}
      {spindle !== null && <span data-testid="machine-status-spindle">{spindle}</span>}
      {vacuum !== null && vacuum !== 'unknown' && (
        <span data-testid="machine-status-vacuum">vacuum {vacuum} (as sent)</span>
      )}
      {/* While a registration owns the machine the fitted instrument is the probe, not a T number. */}
      {registrationActive ? (
        <span data-testid="machine-status-tool">probe</span>
      ) : (
        tool !== null && <span data-testid="machine-status-tool">T{tool}</span>
      )}
      <span data-testid="machine-status-position">
        X {fmt3(wpos?.x ?? null)} Y {fmt3(wpos?.y ?? null)} Z {fmt3(wpos?.z ?? null)} (work)
      </span>
      {!idle && (
        <button
          type="button"
          data-testid="machine-status-stop"
          style={{ marginLeft: 'auto', padding: '1px 8px' }}
          onClick={() => requestStop(machineKey(machine))}
        >
          Stop
        </button>
      )}
    </div>
  );
}
