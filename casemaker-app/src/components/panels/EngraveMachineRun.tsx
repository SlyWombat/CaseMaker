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

import { useEffect, useRef, useState, type CSSProperties, type JSX } from 'react';
import { attachConsole } from '@/platform/machineConsole';
import { describeRun, programOwnsVacuum, runSettings } from '@/platform/machineRun';
import { machineKey, useMachineRunStore } from '@/store/machineRunStore';
import { runKey, useRunConfirmStore } from '@/store/runConfirmStore';
import { useShopDefaultsStore } from '@/store/shopDefaultsStore';
import { useMachineTranscriptStore } from '@/store/machineTranscriptStore';

const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '4px 0' };

export interface EngraveMachineRunProps {
  target: { host: string; port: number };
  /**
   * The source line the machine last reported (`progress.line`), or null when it reports none
   * (#442's #423 item: "the viewport follows `P`"). Called only when the line CHANGES, so a panel
   * can move a follower without re-seeking the simulation on every render.
   */
  onProgramLine?: (line: number | null) => void;
  /**
   * #469 — drawn BESIDE the release step's own controls rather than owning the run. The release step
   * prepares each program and starts it, so this panel must not offer a second Start, Stop or
   * at-machine tick; it still shows the live progress, the log, the outcome, the end-of-run lines
   * and the offcut/stock questions, which are the machine store's answers and belong to the run
   * whichever component started it.
   */
  controlled?: boolean;
}

/** The run panel for a machine, or nothing when no program has been prepared for it. */
export function EngraveMachineRun({ target, onProgramLine, controlled = false }: EngraveMachineRunProps): JSX.Element | null {
  const machine = machineKey(target);
  const entry = useMachineRunStore((s) => s.runs[machine]);
  const key = runKey(target, entry?.programHash ?? '');
  const confirmed = useRunConfirmStore((s) => s.confirmed.has(key));
  const confirm = useRunConfirmStore((s) => s.confirm);
  const defaults = useShopDefaultsStore((s) => s.defaults);
  const start = useMachineRunStore((s) => s.start);
  const requestStop = useMachineRunStore((s) => s.requestStop);
  const requestPause = useMachineRunStore((s) => s.requestPause);
  const requestResume = useMachineRunStore((s) => s.requestResume);
  const keepOffcut = useMachineRunStore((s) => s.keepOffcut);
  const skipOffcut = useMachineRunStore((s) => s.skipOffcut);
  const answerStockUsed = useMachineRunStore((s) => s.answerStockUsed);
  const [atMachine, setAtMachine] = useState(false);
  const [homeNote, setHomeNote] = useState<string | null>(null);
  // #442's #423 item — the panel follows the line the machine reports. The callback is kept in a
  // ref so a parent that passes a fresh closure on each render does not fire it again for a line
  // that has not changed; the effect below is the only caller.
  const lineCallback = useRef(onProgramLine);
  const line = entry?.progress?.line ?? null;
  useEffect(() => {
    lineCallback.current = onProgramLine;
  });
  useEffect(() => {
    lineCallback.current?.(line);
  }, [line]);
  // #528 — the run log no longer renders in the rail; the dock's Transcript tab reads the store.
  // The text is the same join the old rail `<pre>` rendered, so the content is unchanged.
  const setRunTranscript = useMachineTranscriptStore((s) => s.setRunLines);
  useEffect(() => {
    const lines = entry?.lines ?? [];
    setRunTranscript(lines.length > 0 ? lines.join('\n') : null);
  }, [entry?.lines, setRunTranscript]);
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
  // #470 (review R7) — the vacuum sentence says what THIS prepared file will do, not what the runner
  // used to do for every file. An app upload owns the vacuum (#469), so the file's own words decide:
  // one that carries `M331` switches it itself, and an `air: false` job carries no words at all and
  // runs with the vacuum left off. "Vacuum on before it plays" described a run that does not happen
  // in either case. Only an entry prepared some other way is bracketed by the runner.
  const ownsVacuum = entry.context?.vacuumOwned === true || programOwnsVacuum(entry.context?.nc);
  const span = entry.context?.vacuumSpan;
  const vacuumLine =
    span === 'first'
      ? 'This program switches the vacuum on, and the job leaves it on for the next program.'
      : span === 'middle'
        ? 'The vacuum stays on across this program: the job’s first file switched it on, and its last turns it off.'
        : span === 'last'
          ? 'The vacuum is on from the job’s earlier file; this program switches it off at its end. The machine homes when it finishes.'
          : span === 'whole'
            ? 'The program switches the vacuum on and off itself; the machine homes when it finishes.'
            : span === 'none'
              ? 'This job runs without the vacuum; the machine homes when it finishes.'
              : !ownsVacuum
                ? 'Vacuum on before it plays, off after; the machine homes when it finishes.'
                : programOwnsVacuum(entry.context?.nc)
                  ? 'The program switches the vacuum on and off itself; the machine homes when it finishes.'
                  : 'This program runs without the vacuum; the machine homes when it finishes.';
  return (
    <div data-testid="engrave-run" data-file={entry.filename}>
      {!controlled && !confirmed && !running && (
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
      {!controlled && (
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
      )}
      {!controlled && (
        <p style={MUTED} data-testid="engrave-run-vacuum">
          {vacuumLine}
        </p>
      )}

      {!controlled && running && (
        <>
          {/* #618 — Pause beside Stop: the suspend goes out at the run's next poll boundary, and the
              same button resumes a suspended job. Stop stays the one that ends the job. */}
          <button
            type="button"
            data-testid="engrave-run-pause"
            disabled={entry.stopAsked}
            style={{ width: '100%', padding: 7, marginTop: 6 }}
            onClick={() => (entry.paused ? requestResume(machine) : requestPause(machine))}
          >
            {entry.paused ? 'Resume program' : 'Pause program — suspend goes out at the next status poll'}
          </button>
          <button
            type="button"
            data-testid="engrave-run-stop"
            disabled={entry.stopAsked}
            style={{ width: '100%', padding: 7, marginTop: 6 }}
            onClick={() => requestStop(machine)}
          >
            {entry.stopAsked ? 'Stopping…' : 'Stop program — the machine’s red button is the emergency stop'}
          </button>
        </>
      )}

      {entry.progress && (
        <p style={MUTED} data-testid="engrave-run-progress">
          {entry.progress.state ?? '—'} · {entry.progress.percent === null ? '—' : `${entry.progress.percent} %`} · line{' '}
          {entry.progress.line ?? '—'} · {entry.progress.elapsedS === null ? '—' : `${entry.progress.elapsedS} s`}
        </p>
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

      {!running && entry.pendingStock !== null && (
        <div data-testid="engrave-run-stock-question">
          <p style={MUTED}>
            The run was stopped. Was the stock ({entry.pendingStock.entryId}) used? Yes takes it off the shelf; no keeps it reserved for
            {' '}{entry.pendingStock.jobId}.
          </p>
          <button type="button" data-testid="engrave-run-stock-used" onClick={() => void answerStockUsed(machine, true)}>
            Yes, it was used
          </button>{' '}
          <button type="button" data-testid="engrave-run-stock-unused" onClick={() => void answerStockUsed(machine, false)}>
            No, keep it
          </button>
        </div>
      )}
      {/* #414 — the end of the run, worked out once in the store: what it did, and at most one question. */}
      {!running && entry.end !== null && (
        <div data-testid="engrave-run-end" data-kind={entry.end.kind}>
          {entry.end.lines.map((l, i) => (
            <p key={i} style={MUTED}>
              {l}
            </p>
          ))}
          {entry.end.offcut?.state === 'asked' && (
            <div data-testid="engrave-run-offcut">
              <p style={MUTED}>{entry.end.offcut.text}</p>
              <button type="button" data-testid="engrave-run-offcut-keep" onClick={() => void keepOffcut(machine)}>
                Keep it on the shelf
              </button>{' '}
              <button type="button" data-testid="engrave-run-offcut-skip" onClick={() => skipOffcut(machine)}>
                Ignore scrap
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
