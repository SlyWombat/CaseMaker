/**
 * #423 — run the uploaded program from the app: play, watch, finish (§5.10). The engine is
 * `platform/machineRun.ts`; the run itself, and everything this panel draws, is the machine's entry in
 * `store/machineRunStore.ts` — the single source of truth.
 *
 * DRAWN FROM THE STORE, BY MACHINE. An upload that went through prepares the entry (the file, the
 * program's hash); this panel shows whatever that entry holds. Closing the engrave panel leaves the
 * run watching; reopening it finds the run, its progress and its Stop exactly where they were.
 *
 * "I AM AT THE MACHINE", ONCE PER PROGRAM (Q17) — keyed on the machine and the uploaded program's
 * hash, so a re-generated program asks again. It covers the machine moving, nothing done by hand.
 *
 * STOP IS ALWAYS THERE WHILE IT RUNS, and says what it is. Home is offered only after a stop the
 * machine CONFIRMED (Idle, vacuum off).
 */

import { useState, type CSSProperties, type JSX } from 'react';
import { attachConsole } from '@/platform/machineConsole';
import { describeRun, runSettings } from '@/platform/machineRun';
import { machineKey, useMachineRunStore } from '@/store/machineRunStore';
import { runKey, useRunConfirmStore } from '@/store/runConfirmStore';
import { useShopDefaultsStore } from '@/store/shopDefaultsStore';

const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '4px 0' };
const LOG: CSSProperties = { fontSize: 10, fontFamily: 'monospace', maxHeight: 120, overflow: 'auto', margin: '4px 0', color: '#c8d3de' };

export interface EngraveMachineRunProps {
  target: { host: string; port: number };
}

/** The run panel for a machine, or nothing when no program has been prepared for it. */
export function EngraveMachineRun({ target }: EngraveMachineRunProps): JSX.Element | null {
  const machine = machineKey(target);
  const entry = useMachineRunStore((s) => s.runs[machine]);
  const key = runKey(target, entry?.programHash ?? '');
  const confirmed = useRunConfirmStore((s) => s.confirmed.has(key));
  const confirm = useRunConfirmStore((s) => s.confirm);
  const defaults = useShopDefaultsStore((s) => s.defaults);
  const start = useMachineRunStore((s) => s.start);
  const requestStop = useMachineRunStore((s) => s.requestStop);
  const [atMachine, setAtMachine] = useState(false);
  const [homeNote, setHomeNote] = useState<string | null>(null);
  if (!entry) return null;
  const running = entry.running;

  const run = () => {
    if (!confirmed) confirm(key);
    setHomeNote(null);
    start(target, runSettings(defaults));
  };

  const home = async () => {
    const session = attachConsole(target);
    try {
      const r = await session.send('$H');
      setHomeNote(r.kind === 'sent' ? 'Homing.' : `Home was not sent: ${r.detail}`);
    } finally {
      await session.close();
    }
  };

  const outcome = entry.outcome;
  const canRun = !running && (confirmed || atMachine);
  return (
    <div data-testid="engrave-run" data-file={entry.filename}>
      {!confirmed && !running && (
        <label style={MUTED}>
          <input
            type="checkbox"
            checked={atMachine}
            data-testid="engrave-run-at-machine"
            onChange={(e) => setAtMachine(e.target.checked)}
          />{' '}
          I am at the machine, with the head clear and the stock clamped — asked once for this program.
        </label>
      )}
      <button
        type="button"
        data-testid="engrave-run-start"
        disabled={!canRun}
        style={{ width: '100%', padding: 7, marginTop: 6 }}
        title={
          running ? 'A program is running on this machine' : canRun ? `Play ${entry.filename} on the machine` : 'Confirm you are at the machine first'
        }
        onClick={run}
      >
        {running ? 'Running…' : `Run ${entry.filename}`}
      </button>
      <p style={MUTED}>Vacuum on before it plays, off after; the machine homes when it finishes.</p>

      {running && (
        <button
          type="button"
          data-testid="engrave-run-stop"
          disabled={entry.stopAsked}
          style={{ width: '100%', padding: 7, marginTop: 6 }}
          onClick={() => requestStop(machine)}
        >
          {entry.stopAsked ? 'Stopping…' : 'Stop program — the machine’s red button is the emergency stop'}
        </button>
      )}

      {entry.progress && (
        <p style={MUTED} data-testid="engrave-run-progress">
          {entry.progress.state ?? '—'} · {entry.progress.percent === null ? '—' : `${entry.progress.percent} %`} · line{' '}
          {entry.progress.line ?? '—'} · {entry.progress.elapsedS === null ? '—' : `${entry.progress.elapsedS} s`}
        </p>
      )}
      {entry.lines.length > 0 && (
        <pre style={LOG} data-testid="engrave-run-lines">
          {entry.lines.join('\n')}
        </pre>
      )}
      {outcome !== null && !running && (
        <p style={MUTED} data-testid="engrave-run-outcome" data-state={outcome.kind}>
          {describeRun(outcome)}
        </p>
      )}
      {!running && outcome?.kind === 'aborted' && outcome.stop.kind === 'stopped' && (
        <button type="button" data-testid="engrave-run-home" onClick={() => void home()}>
          Home ($H)
        </button>
      )}
      {homeNote !== null && <p style={MUTED}>{homeNote}</p>}
    </div>
  );
}
