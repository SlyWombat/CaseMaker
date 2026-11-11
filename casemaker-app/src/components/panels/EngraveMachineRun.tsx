/**
 * #423 — run the uploaded program from the app: play, watch, finish (§5.10). The engine is
 * `platform/machineRun.ts`; the run itself, and everything this panel draws, is the machine's entry in
 * `store/machineRunStore.ts` — the single source of truth.
 *
 * DRAWN FROM THE STORE, BY MACHINE. An upload that went through prepares the entry (the file, the
 * program's hash); this panel shows whatever that entry holds. Closing the engrave panel leaves the
 * run watching; reopening it finds the run, its progress and its Stop exactly where they were.
 *
 * THE STATEMENT IS CUT STEP 1'S (#797): the at-machine ask, the probe-fitted ask and the clearance
 * tick are one statement there, recorded once per program. This panel asks nothing of its own; it
 * reads the run store's flag.
 *
 * THE CONTROLS ARE VERBS (#801): Pause / Resume and Stop, with the how in ONE caption under them.
 * The progress itself lives on the status strip — the one home for it — not in this panel.
 *
 * STOP IS ALWAYS THERE WHILE IT RUNS, and says what it is. Home is offered only after a stop the
 * machine CONFIRMED (Idle, vacuum off).
 */

import { useEffect, useRef, useState, type CSSProperties, type JSX } from 'react';
import { attachConsole } from '@/platform/machineConsole';
import { describeEndLine, programOwnsVacuum, runSettings } from '@/platform/machineRun';
import { machineKey, runTranscriptFor, useMachineRunStore } from '@/store/machineRunStore';
import { runKey, useRunConfirmStore } from '@/store/runConfirmStore';
import { useShopDefaultsStore } from '@/store/shopDefaultsStore';
import { useMachineTranscriptStore } from '@/store/machineTranscriptStore';
import { useEngraveRunStore } from '@/store/engraveRunStore';
import { resolveTool } from '@/engine/cnc/toolRegistry';
import { toolDisplayName } from '@/engine/cnc/toolDisplay';
import { formatDuration } from '@/engine/cnc/plan';
import { useCncModeStore } from '@/store/cncModeStore';
import { useEngraveReleaseStore } from '@/store/engraveReleaseStore';
import { stoppedPhase, useCutRescueStore, waitingCardUp } from './cutRescue';
import { StopReportAction } from '@/components/panels/StopReportAction';
import { stopIsReportable } from '@/platform/machineStopReport';
import { TOOL_CHANGE_NOTE } from '@/platform/toolChangeDry';
import { RoutineDryPreview } from './RoutineDryPreview';
import { TOOL_CHANGE_STATEMENT, toolContinueHeld, useToolChangePreview } from './toolChangePreview';

const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '4px 0' };
/** #655 — the waiting prompt's box: the same frame the panel's other notices use. */
const BOX: CSSProperties = { marginTop: 6, padding: 8, border: '1px solid #3a4552', borderRadius: 4, background: '#1b2027' };

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
  /**
   * #1123 item 8 — THE RUN CARD CARRIES THE STEP'S ONE START. `startless` draws the live run, the
   * log, the end lines and the recoveries, but never a start of its own (nor the vacuum sentence
   * that belongs to it). The operator's start is the run card above.
   */
  startless?: boolean;
}

/** The run panel for a machine, or nothing when no program has been prepared for it. */
export function EngraveMachineRun({
  target,
  onProgramLine,
  controlled = false,
  startless = false,
}: EngraveMachineRunProps): JSX.Element | null {
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
  const requestToolContinue = useMachineRunStore((s) => s.requestToolContinue);
  const keepOffcut = useMachineRunStore((s) => s.keepOffcut);
  const skipOffcut = useMachineRunStore((s) => s.skipOffcut);
  const answerStockUsed = useMachineRunStore((s) => s.answerStockUsed);
  // #797 — the ONE statement at Cut step 1 replaced this run's own at-machine tick.
  const acknowledged = useEngraveRunStore((s) => s.acknowledged);
  const [homeNote, setHomeNote] = useState<string | null>(null);
  /**
   * #1197 — the Home press's OWN failure sentence, kept apart from the note: the note is the
   * panel's words ("Home was not sent: …"), the report carries what the console answered.
   */
  const [homeFailure, setHomeFailure] = useState<string | null>(null);
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
  // #1202 — THE TOOL CHANGE'S OWN PREVIEW. The firmware's `Tool` stop is a motion routine of its
  // own: the surface shows the exact line the Continue sends, marks a shape this machine has never
  // completed, and holds the press for the operator's own statement. The derivation is shared with
  // the Cut step's waiting card (#1123 item 9), which carries the same preview when this panel's
  // prompt folds away there — see `toolChangePreview.ts`.
  const toolPreview = useToolChangePreview(target, entry?.toolWaiting != null);
  const { dry: toolDry, firstRun: toolFirstRun, ticked: toolTicked, setTicked: setToolTicked, headless: toolHeadless } = toolPreview;
  // #1123 item 9 — EXACTLY ONE CONTINUE AND ONE STOP. On the CUT STEP (the `startless` instance —
  // the only screen that renders the rescue cards) the panel's own prompt and Pause/Stop fold away
  // while a card is up; the card carries them, #1202's tool-change preview included. Elsewhere (the
  // upload screen) no card exists, so the prompt stays: a safety preview never disappears because
  // controls moved.
  const cutRelease = useEngraveReleaseStore((s) => s.records[machine]);
  const dismissedStopped = useCutRescueStore((s) => s.dismissedStopped[machine] === true);
  const cutRescueUp = startless && (waitingCardUp(entry) || (stoppedPhase(cutRelease) && !dismissedStopped));
  if (!entry) return null;
  // #655 — the firmware's `Tool` stop, in our words: the tool it waits for, named by the run's own
  // cutter (its context key) so the operator reads the same name the strip and the sheet use.
  const awaited = entry.toolWaiting?.awaited ?? null;
  const contextTool = entry.context?.toolKey === undefined ? null : resolveTool(entry.context.toolKey);
  const cutterName =
    contextTool !== null && (awaited === null || contextTool.number === null || contextTool.number === awaited)
      ? toolDisplayName(contextTool)
      : null;
  const toolWords = awaited === null ? (contextTool?.number === null || contextTool === null ? 'the cutter' : `tool ${contextTool.number}`) : `tool ${awaited}`;
  const running = entry.running;

  const run = () => {
    if (!confirmed) confirm(key);
    setHomeNote(null);
    setHomeFailure(null);
    start(target, runSettings(defaults));
  };

  const home = async () => {
    const session = attachConsole(target);
    try {
      const r = await session.send('$H');
      setHomeNote(r.kind === 'sent' ? 'Homing.' : `Home was not sent: ${r.detail}`);
      // #1197 — a home that was not sent is a stop of its own, and the console's detail is what
      // the report carries (#1187 rule 3 gates the action; the note above stays as it was).
      setHomeFailure(r.kind === 'sent' ? null : r.detail);
    } finally {
      await session.close();
    }
  };

  const outcome = entry.outcome;
  // #1197 — THE REPORT'S JOB FACTS come from the entry's own context; a run prepared without one
  // names the file it played and claims no package it does not know.
  const reportJob =
    entry.context === null
      ? null
      : {
          id: entry.context.jobId ?? entry.filename,
          name: entry.context.jobName ?? entry.filename,
          packageHash: entry.context.packageKey ?? null,
        };
  // #1197 — THE RUN'S OWN REPORTABLE FAILURE, in the machine's words: a stop that failed on the
  // transport, or a start the controller refused. A stop the machine CONFIRMED (`stopped`) is not
  // one, and #1187 rule 3 gates the rest: a refusal of the app's own never earns the action.
  const runFailure =
    outcome === null
      ? null
      : outcome.kind === 'aborted' && outcome.stop.kind !== 'stopped'
        ? 'detail' in outcome.stop
          ? outcome.stop.detail
          : outcome.stop.kind
        : outcome.kind === 'refused'
          ? outcome.reason
          : null;
  const runReportError = runFailure !== null && stopIsReportable(runFailure) ? runFailure : null;
  /**
   * #1197/#1208 — THE REPORT CARRIES THE RUN'S CONVERSATION, not the dock's display strings: the
   * store keeps every command and the reply it got, and the last N status exchanges in a fixed
   * ring. The display lines flatten a reply among the app's own notes, so mapping them made every
   * run line read as a machine reply with an empty line. `droppedPolls` says how much of the
   * status tail is no longer in the report; an empty transcript is honest, an invented one is not.
   */
  const talk = runTranscriptFor(machine);
  const runTranscript = talk.entries;
  const canRun = !running && (confirmed || acknowledged);
  // #470 (review R7) — the vacuum sentence says what THIS prepared file will do, not what the runner
  // used to do for every file. An app upload owns the vacuum (#469), so the file's own words decide:
  // one that carries `M331` switches it itself, and an `air: false` job carries no words at all and
  // runs with the vacuum left off. "Vacuum on before it plays" described a run that does not happen
  // in either case. Only an entry prepared some other way is bracketed by the runner.
  const ownsVacuum = entry.context?.vacuumOwned === true || programOwnsVacuum(entry.context?.nc);
  /** #806 — the run's own clock, as the machine last reported it (a refused outcome has none). */
  const elapsedS = entry.outcome !== null && 'last' in entry.outcome ? entry.outcome.last.elapsedS : null;
  const span = entry.context?.vacuumSpan;
  // #1123 item 41 — the words follow the run's one decision: every start of a job-span program
  // STATES the vacuum's DIRECT OUTPUTS (M851 vacuum, M811 air — 0f's nozzle test, 2026-11-09;
  // the M331 family follows the spindle and did nothing), and only the span's end switches off.
  const vacuumLine =
    span === 'first'
      ? 'The job holds the vacuum on: this run states M851 (vacuum) and M811 (air) before every program, and only the job’s last program switches them off.'
      : span === 'middle'
        ? 'The vacuum stays on across this program: this run states M851 and M811 again before it plays, and the job’s last program turns them off.'
        : span === 'last'
          ? 'The vacuum is on from the job’s earlier files; this run states M851 and M811 again, and switches them off (M852, M812) at this program’s end. The machine homes when it finishes.'
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
      {/* #819 — once a run has ENDED there is nothing left to start from here: the card's action is
          the next step, and a second Start beside it would be a second primary. A fresh upload
          resets the entry (end null), so the button returns for the next program. */}
      {!controlled && !startless && entry.end === null && (
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
      {!controlled && !startless && entry.end === null && (
        <p style={MUTED} data-testid="engrave-run-vacuum">
          {vacuumLine}
        </p>
      )}

      {!controlled && running && !cutRescueUp && (
        <>
          {entry.toolWaiting != null && (
            <div data-testid="engrave-run-tool-prompt" style={{ ...BOX, borderColor: '#5a6b7f' }}>
              <p style={MUTED} data-testid="engrave-run-tool-words">
                The machine is waiting for {toolWords}
                {cutterName === null ? '' : ` — the ${cutterName} —`} to be in the spindle.
              </p>
              <RoutineDryPreview
                preview={toolDry}
                firstRun={toolFirstRun}
                ticked={toolTicked}
                onTick={setToolTicked}
                headless={toolHeadless}
                note={TOOL_CHANGE_NOTE}
                statement={TOOL_CHANGE_STATEMENT}
              />
              <button
                type="button"
                data-testid="engrave-run-tool-continue"
                disabled={toolContinueHeld({
                  stopAsked: entry.stopAsked,
                  firstRun: toolFirstRun,
                  refused: toolDry.refused,
                  ticked: toolTicked,
                  headless: toolHeadless,
                })}
                style={{ width: '100%', padding: 7, marginTop: 4 }}
                onClick={() => requestToolContinue(machine)}
              >
                It is in — Continue
              </button>
            </div>
          )}
          {/* #801 — THE CONTROLS ARE VERBS. Pause beside Stop: the suspend goes out at the run's
              next poll boundary, and the same button resumes a suspended job. Stop stays the one
              that ends the job. #655 — a machine waiting for a tool has nothing to suspend; Pause
              is not offered until it moves. The how is ONE caption under them, not a sentence per
              button; the progress itself lives on the status strip, the one home for it. */}
          {entry.toolWaiting == null && (
            <button
              type="button"
              data-testid="engrave-run-pause"
              disabled={entry.stopAsked}
              title={entry.stopAsked ? 'the program is stopping' : undefined}
              style={{ width: '100%', padding: 7, marginTop: 6 }}
              onClick={() => (entry.paused ? requestResume(machine) : requestPause(machine))}
            >
              {entry.paused ? 'Resume' : 'Pause'}
            </button>
          )}
          <button
            type="button"
            data-testid="engrave-run-stop"
            disabled={entry.stopAsked}
            style={{ width: '100%', padding: 7, marginTop: 6 }}
            onClick={() => requestStop(machine)}
          >
            {entry.stopAsked ? 'Stopping…' : 'Stop'}
          </button>
          <p style={MUTED} data-testid="engrave-run-controls-caption">
            Pause takes effect at the next status read. The machine’s red button is the emergency stop.
          </p>
        </>
      )}

      {!running && outcome?.kind === 'aborted' && outcome.stop.kind === 'stopped' && (
        <button type="button" data-testid="engrave-run-home" onClick={() => void home()}>
          Home ($H)
        </button>
      )}
      {homeNote !== null && (
        <p style={MUTED} data-testid="engrave-run-home-note">
          {homeNote}
        </p>
      )}
      {/* #1197 — the Home press's own report: the console's failure sentence, this run's transcript
          and the entry's job facts. A successful "Homing." has nothing to report. */}
      {homeFailure !== null && stopIsReportable(homeFailure) && (
        <StopReportAction
          action="home"
          target={target}
          error={homeFailure}
          transcript={runTranscript}
          droppedStatusPolls={talk.droppedPolls}
          job={reportJob}
        />
      )}

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
      {/* #414 / #806 / #819 — THE DONE CARD. One card when the run ends: what happened and how
          long ("Finished · 2 min 14 s"), ONE line for the machine's end state, the offcut
          question only when there is one, and the ONE primary action. The run end's bookkeeping
          (the finished-program record, the shelf, the cutter runtime) stays in the records, not
          in this card. */}
      {!running && entry.end !== null && (
        <div data-testid="engrave-run-end" data-kind={entry.end.kind} style={BOX}>
          <p
            data-testid="engrave-run-done-title"
            style={{ fontSize: 12, fontWeight: 600, color: '#e6edf5', margin: '0 0 4px' }}
          >
            {entry.end.kind === 'finished' ? 'Finished' : entry.end.kind === 'stopped' ? 'Stopped' : 'Nothing was cut'}
            {entry.end.kind === 'finished' && elapsedS !== null ? ` · ${formatDuration(elapsedS)}` : ''}
          </p>
          {/* #819 — ONE LINE: the machine's end state, never the run end's bookkeeping. */}
          {outcome !== null && (
            <p style={MUTED} data-testid="engrave-run-outcome" data-state={outcome.kind}>
              {describeEndLine(outcome)}
            </p>
          )}
          {/* #1197 — THE START/STOP'S OWN REPORT: a Stop that failed on the transport, or a start the
              controller refused, carries the machine's sentence, this run's transcript and the
              entry's job facts. The panel's sentence above stays the operator's (#1187 rule 3). */}
          {runReportError !== null && (
            <StopReportAction
              action="run"
              target={target}
              error={runReportError}
              transcript={runTranscript}
              droppedStatusPolls={talk.droppedPolls}
              job={reportJob}
            />
          )}
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
          {/* #806 — THE NEXT PART, in one verb. The design's rule is that the card holds the next
              step's only primary action: after a finished part that step is another design. */}
          <button
            type="button"
            data-testid="engrave-run-another"
            style={{ width: '100%', padding: 7, marginTop: 6, fontWeight: 600 }}
            onClick={() => useCncModeStore.getState().show('design')}
          >
            Cut another
          </button>
        </div>
      )}
    </div>
  );
}
