/**
 * #1167 — STEP 3 AS ONE CARD: the whole job, in run order, on display.
 *
 * The bench note: step 3 was a fold, a plan, an upload list and a release walk, and its shape
 * changed as a run moved through them. This card is the mockup-6 layout (canvas "Case Maker CNC
 * Flow Mockups", `project/Cut-Steps.dc.html`): ONE card that lists every program and never changes
 * shape between programs.
 *
 *   - HEADER: `Cut · N programs · d done · r running · about T left`, with the vacuum and air dots
 *     reading the run's own outputs.
 *   - THE RUNNING ROW: program k of N, the bit, the side and what it cuts; a progress bar and the
 *     percent/time left from OUR clock (#1145); the machine's line; and the next thing (an amber
 *     bit change, or the end).
 *   - THE LIST: one row per program — done with its measured time, running, a bit-change mark, or
 *     queued — plus the FLIP row between a two-sided job's sides.
 *   - FOOTNOTE: what a bit change and the cleaning pass/air walk are.
 *   - FIXED CONTROL ROW: Pause after this move and Stop, at the bottom of the card in every state.
 *
 * DISPLAY ONLY (the Manager's scope): it reads the stores and calls the SAME run actions the
 * release step calls; it changes nothing the run sends. The release step below keeps its own
 * controls until #1169 consolidates the run-control path.
 */
import { useEffect, useState, type JSX } from 'react';

import { useEngraveReleaseStore, type ReleaseRecord } from '@/store/engraveReleaseStore';
import type { ReleaseSource } from '@/engine/cnc/engrave/release';
import { machineKey, useMachineRunStore } from '@/store/machineRunStore';
import { useToolRegistryStore } from '@/store/toolRegistryStore';
import { jobSetups } from '@/engine/cnc/engrave/jobSetup';
import { cutterIdentity } from '@/engine/cnc/engrave/cutterCaseLine';
import { stoppedPhase, useCutRescueStore, waitingCardUp } from './cutRescue';
import { nextBitChange, remainingSeconds, runClockSeconds, runRemainingSeconds } from '@/engine/cnc/engrave/runProgress';
import type { RunPlan } from '@/engine/cnc/plan';
import { formatDuration } from '@/engine/cnc/plan/format';
import type { EngraveJob, FrozenPackage } from '@/types/engraveJob';

const BOX = { padding: 10, border: '1px solid #4f8ef7', borderRadius: 10, background: '#161d27' } as const;
const MUTED = { color: '#9aa4b0' } as const;
const AMBER = '#e0a84a';
const OK = '#5fc27f';
const BLUE = '#8ab4f8';

export interface CutCardProgramRow {
  kind: 'program';
  /** 1-based cut order. */
  index: number;
  setupIndex: number;
  toolKey: string;
  /** The bit in the operator's words (the cutter list's own name). */
  bit: string;
  /** What this program cuts, when the document names it; null is honest. */
  purpose: string | null;
  done: boolean;
  running: boolean;
  /** The program before it needs a different cutter, so this one starts at a bit change. */
  needsChange: boolean;
  /** The plan's estimate for this program's cut, seconds; null when the plan has none. */
  estimateSeconds: number | null;
  /** The measured time of a done program, from the plan's last-run clock; null when unknown. */
  measuredSeconds: number | null;
}

/** A two-sided job's flip, between the sides, in run order. */
export interface CutCardFlipRow {
  kind: 'flip';
  /** The setup whose first program follows the flip (1-based). */
  toSetup: number;
}

export type CutCardRow = CutCardProgramRow | CutCardFlipRow;

export interface CutCardModel {
  rows: CutCardRow[];
  total: number;
  done: number;
  running: number | null;
  /** Estimated seconds left over the unfinished programs; null when the plan has no numbers. */
  secondsLeft: number | null;
  /** The setup count: 2 or more means the job turns the stock between its sides. */
  sides: number;
}

/**
 * WHAT THE CARD LISTS, from the plan's own program records and the package's cut order. Pure: the
 * component below only renders it.
 */
export function cutCardModel(input: {
  job: EngraveJob;
  pkg: FrozenPackage;
  plan: RunPlan;
  finishedHashes: readonly string[];
  /** The program the machine is playing (1-based), or null. */
  runningIndex: number | null;
}): CutCardModel {
  const { job, pkg, plan } = input;
  const finished = new Set(input.finishedHashes);
  const setups = jobSetups(job);
  const cutPhase = (programId: string) => plan.phases.find((p) => p.kind === 'cut' && p.programId === programId) ?? null;
  const rows: CutCardRow[] = [];
  let previousTool: string | null = null;
  let previousSetup: number | null = null;
  pkg.programs.forEach((program, i) => {
    const index = i + 1;
    // THE FLIP IS ITS OWN ROW between the sides: the first program of a later setup, when the job
    // has more than one setup (a two-sided job turns the stock into the next corner).
    if (previousSetup !== null && program.setupIndex !== previousSetup) {
      rows.push({ kind: 'flip', toSetup: program.setupIndex });
    }
    const phase = cutPhase(`p${index}`);
    const setup = setups[program.setupIndex - 1] ?? null;
    const ids = setup?.toolItems?.[program.toolKey] ?? setup?.itemIds ?? [];
    const purpose = purposeOf(job, ids);
    const done = finished.has(program.hash);
    rows.push({
      kind: 'program',
      index,
      setupIndex: program.setupIndex,
      toolKey: program.toolKey,
      bit: bitOf(program.toolKey),
      purpose,
      done,
      running: input.runningIndex === index,
      needsChange: previousTool !== null && previousTool !== program.toolKey,
      estimateSeconds: phase?.seconds ?? null,
      measuredSeconds: done ? (phase?.lastRun?.seconds ?? null) : null,
    });
    previousTool = program.toolKey;
    previousSetup = program.setupIndex;
  });
  const programRows = rows.filter((r): r is CutCardProgramRow => r.kind === 'program');
  const seconds = programRows.filter((r) => !r.done).map((r) => r.estimateSeconds);
  return {
    rows,
    total: pkg.programs.length,
    done: programRows.filter((r) => r.done).length,
    running: input.runningIndex,
    secondsLeft: seconds.every((s): s is number => s !== null) ? seconds.reduce((n, s) => n + s, 0) : null,
    sides: new Set(pkg.programs.map((p) => p.setupIndex)).size,
  };
}

/** The cutter in the operator's words; a key no record knows stays the key. */
function bitOf(toolKey: string): string {
  const identity = cutterIdentity(toolKey, useToolRegistryStore.getState().items);
  return identity.name;
}

/** What a program's items are called in the document, joined; null when none are named. */
function purposeOf(job: EngraveJob, itemIds: readonly string[]): string | null {
  const names: string[] = [];
  const all = [
    ...(job.labels ?? []),
    ...(job.shapes ?? []),
    ...(job.combined ?? []),
    ...(job.traces ?? []),
    ...(job.vectors ?? []),
    ...(job.drills ?? []),
    ...(job.threads ?? []),
    ...(job.cutouts ?? []),
    ...(job.primitives ?? []),
    ...(job.chamfers ?? []),
  ] as { id: string; name?: string; text?: string }[];
  for (const item of all) {
    if (!itemIds.includes(item.id)) continue;
    const name = item.name ?? item.text ?? null;
    if (name !== null && name.length > 0) names.push(name);
  }
  return names.length === 0 ? null : names.join(', ');
}

export interface CutRunCardProps {
  job: EngraveJob;
  pkg: FrozenPackage;
  plan: RunPlan;
  finishedHashes: readonly string[];
  target: { host: string; port: number } | null;
  /**
   * #1123 item 8 — the release's frozen sources. The old step-3 block is not rendered while this
   * card is up, so the card plans the release its ONE Start plays. Empty (a display-only caller):
   * the card reads whatever record the release step already planned, and never re-plans it.
   */
  programs?: readonly ReleaseSource[];
  /** The step-3 gate the old block read; the Start states it as its visible reason. */
  blocker?: string | null;
  /** #1286 — a line under Start about the registration that stands (no blank id yet); null otherwise. */
  registrationNote?: string | null;
  /**
   * #819/#1123 item 39 — THIS JOB'S RUN HAS ENDED. On a finished job the press would start the
   * same program again; with programs left the bit-change card owns the next one. Either way this
   * card draws no Start.
   */
  noStart?: boolean;
  /**
   * #1145 × #1123 item 42 — THE RUN'S OWN TOTAL over every program (#1193, the surface's
   * `runCycleSeconds`), seconds. While a multi-program job runs, the time-left line states the
   * WHOLE RUN's remaining from it; absent (a result that states no total), the line falls back to
   * our clock plus the programs not started, and says which figure it is showing.
   */
  runTotalSeconds?: number | null;
}

/** Every program and walk file is on the machine (or already ran). */
function uploadsDone(record: ReleaseRecord): boolean {
  const files = record.files.every((f) => f.done || f.upload === 'uploaded' || f.upload === 'present');
  const walks = [record.walks.airwalk, record.walks.clean]
    .filter((w): w is NonNullable<typeof w> => w !== null)
    .every((w) => w.upload === 'uploaded' || w.upload === 'present');
  return files && walks;
}

export function CutRunCard({
  job,
  pkg,
  plan,
  finishedHashes,
  target,
  programs = [],
  blocker = null,
  registrationNote = null,
  noStart = false,
  runTotalSeconds = null,
}: CutRunCardProps): JSX.Element {
  const releasePlan = useEngraveReleaseStore((s) => s.plan);
  const release = useEngraveReleaseStore((s) => (target === null ? undefined : s.records[machineKey(target)]));
  const dismissedStopped = useCutRescueStore((s) => (target === null ? false : s.dismissedStopped[machineKey(target)] === true));
  const runEntry = useMachineRunStore((s) => (target === null ? undefined : s.runs[machineKey(target)]));
  const [pressing, setPressing] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  // #1123 item 8 — THE CARD PLANS THE RELEASE, as the old block did: while it is up that block is
  // not rendered, and the record is what the ONE Start plays.
  useEffect(() => {
    if (target === null || blocker !== null || programs.length === 0) return;
    releasePlan({ host: target.host, port: target.port }, job, programs);
    // The host and port are the machine's identity; a new object with the same address is no change.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the address pair, not the object
  }, [target?.host, target?.port, job, programs, blocker, releasePlan]);
  const progress = runEntry?.progress ?? null;
  const paused = runEntry?.paused === true;
  const runningIndex = release !== undefined && release.phase === 'running' && release.active !== null ? release.active : null;
  const model = cutCardModel({ job, pkg, plan, finishedHashes, runningIndex });
  const runningRow = model.rows.find((r): r is CutCardProgramRow => r.kind === 'program' && r.running) ?? null;
  const change = release === undefined ? null : nextBitChange(release.files, release.active);
  const nextChange =
    change?.kind === 'change'
      ? cutterIdentity(change.file.toolKey, useToolRegistryStore.getState().items).name
      : runningRow === null
        ? null
        : (model.rows.find(
            (r): r is CutCardProgramRow => r.kind === 'program' && r.index > runningRow.index && r.toolKey !== runningRow.toolKey,
          )?.bit ?? null);
  const dockKey = target === null ? null : machineKey(target);
  const clock = runClockSeconds(runEntry ?? null, Date.now());
  const left = remainingSeconds(progress?.percent ?? null, clock);
  // #1145 × #1123 item 42 — A MULTI-PROGRAM JOB'S LINE STATES THE WHOLE RUN. The operator waits for
  // the job, not the program in hand: the basis is the run's own total (#1193), less the finished
  // programs' own times and OUR clock. No total (or an unmeasured finished program): the honest sum
  // over what is left — this program's remaining plus every program not started. The words say
  // which figure the line shows.
  const doneSeconds = (() => {
    const done = model.rows.filter((r): r is CutCardProgramRow => r.kind === 'program' && r.done);
    return done.every((r) => r.measuredSeconds !== null || r.estimateSeconds !== null)
      ? done.reduce((n, r) => n + (r.measuredSeconds ?? r.estimateSeconds ?? 0), 0)
      : null;
  })();
  const queuedSeconds = (() => {
    const queued = model.rows.filter((r): r is CutCardProgramRow => r.kind === 'program' && !r.done && !r.running);
    return queued.every((r) => r.estimateSeconds !== null)
      ? queued.reduce((n, r) => n + (r.estimateSeconds ?? 0), 0)
      : null;
  })();
  const jobLeft =
    model.total > 1
      ? runRemainingSeconds({
          runTotalS: runTotalSeconds,
          doneS: doneSeconds,
          elapsedS: clock,
          programLeftS: left,
          queuedS: queuedSeconds,
        })
      : left;
  const leftWords =
    model.total > 1
      ? jobLeft !== null
        ? `${formatDuration(jobLeft)} left in the job`
        : left !== null
          ? `${formatDuration(left)} left in this program`
          : null
      : left !== null
        ? `${formatDuration(left)} left`
        : null;
  // #1123 items 9/10 — WHILE A RESCUE CARD IS UP IT OWNS THE CONTROLS. The waiting card carries the
  // one Continue and Stop; the stopped card owns its recovery; this card offers neither a Start nor
  // a Pause/Stop of its own.
  const waiting = waitingCardUp(runEntry);
  const stoppedUp = stoppedPhase(release) && !dismissedStopped;
  const rescueUp = waiting || stoppedUp;
  // READY: no program running, no rescue card up, and the release is not inside a transition.
  const phasesWithoutStart = new Set(['running', 'starting', 'uploading', 'retouch', 'airwalk', 'cleaning', 'closing', 'bit-change']);
  const readyUp = !rescueUp && !noStart && runningIndex === null && (release === undefined || !phasesWithoutStart.has(release.phase));
  const files = release?.files ?? [];
  const total = files.length > 0 ? files.length : model.total;
  const nextIndex = files.length > 0 ? (release?.next ?? files.find((f) => !f.done)?.index ?? null) : 1;
  const nextFile = nextIndex === null ? null : (files.find((f) => f.index === nextIndex) ?? null);
  const nextToolKey = nextFile?.toolKey ?? pkg.programs[(nextIndex ?? 1) - 1]?.toolKey ?? null;
  const nextBit = nextToolKey === null ? null : bitOf(nextToolKey);
  // "the bit in the spindle": the previous program used the same cutter, or the last prepared run
  // did — the operator has no change to make.
  const previousFile = nextIndex === null ? null : [...files].reverse().find((f) => f.index < nextIndex && f.done) ?? null;
  const spindleKey = runEntry?.context?.toolKey ?? previousFile?.toolKey ?? null;
  const inSpindle = nextToolKey !== null && spindleKey === nextToolKey;
  const startReason =
    startError ??
    blocker ??
    (target === null
      ? 'Choose the machine first'
      : release === undefined
        ? 'Planning the release…'
        : release.phase === 'closing'
          ? 'Stopping — the vacuum is switching off before anything starts'
          : null);
  const pressStart = async (): Promise<void> => {
    if (target === null || pressing || startReason !== null) return;
    setPressing(true);
    setStartError(null);
    try {
      // #1123 item 8 — THE ONE START IS THE WHOLE PRESS: it states the operator is at the machine
      // (the tick the old block asked for), uploads whatever is not on the machine, then runs the
      // SAME release action the old block's button ran.
      useEngraveReleaseStore.getState().setAtMachine(target, true);
      const recordNow = (): ReleaseRecord | undefined => useEngraveReleaseStore.getState().records[machineKey(target)];
      const before = recordNow();
      if (before !== undefined && !uploadsDone(before)) await useEngraveReleaseStore.getState().uploadAll(target);
      const after = recordNow();
      const failed = after?.files.find((f) => f.upload === 'failed') ?? null;
      if (failed !== null) {
        setStartError(failed.uploadNote ?? 'the program was not uploaded — check the machine, then start again');
        return;
      }
      if (after !== undefined && !uploadsDone(after)) {
        setStartError('the programs are not on the machine yet — start again once the upload finishes');
        return;
      }
      useEngraveReleaseStore.getState().startRelease(target);
    } finally {
      setPressing(false);
    }
  };
  const vacuum = release?.vacuum ?? 'unknown';
  const airOn = release?.job.blowWithVacuum === true && release?.phase === 'running';

  return (
    <section data-testid="engrave-cut-card" style={BOX}>
      {/* HEADER */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, borderBottom: '1px solid #222c38', paddingBottom: 8 }}>
        <span
          style={{ width: 22, height: 22, borderRadius: '50%', background: '#152238', color: BLUE, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700 }}
        >
          3
        </span>
        <span style={{ flex: '1 1 auto' }}>
          <b style={{ fontWeight: 600 }}>Cut</b>{' '}
          <span style={MUTED}>
            · {model.total} program{model.total === 1 ? '' : 's'}
            {model.done > 0 ? ` · ${model.done} done` : ''}
            {model.running !== null ? ' · 1 running' : ''}
            {model.secondsLeft === null ? '' : ` · about ${formatDuration(model.secondsLeft)} left`}
          </span>
        </span>
        <span data-testid="engrave-cut-card-outputs" style={{ display: 'inline-flex', gap: 10, fontSize: 12, color: '#9aa4b0' }}>
          <span data-state={vacuum === 'on' ? 'on' : vacuum === 'unknown' ? 'unknown' : 'off'}>
            <span style={{ color: vacuum === 'on' ? OK : '#5a6572' }}>●</span> vacuum
          </span>
          <span data-state={airOn ? 'on' : 'off'}>
            <span style={{ color: airOn ? OK : '#5a6572' }}>●</span> air
          </span>
        </span>
      </div>

      {/* #1123 item 10 — NO RESERVED BLOCK. The card's height is its content: the running row is
          here when a program runs and absent when it does not. */}
      {runningRow !== null && (
        <div
          data-testid="engrave-cut-card-running"
          style={{ margin: '8px 0 0', padding: '8px 10px', borderRadius: 8, background: '#152238', border: '1px solid #2f4a7a', display: 'flex', flexDirection: 'column', gap: 6 }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 13, gap: 8 }}>
            <span>
              <b>Program {runningRow.index} of {model.total} · {paused ? 'paused' : 'running'}</b>{' '}
              <span style={MUTED}>
                · {runningRow.bit}
                {model.sides > 1 ? ` · side ${runningRow.setupIndex}` : ''}
                {runningRow.purpose !== null ? ` · ${runningRow.purpose}` : ''}
              </span>
            </span>
            <span style={{ fontVariantNumeric: 'tabular-nums', color: '#c9d4e2', whiteSpace: 'nowrap' }}>
              {progress?.percent === null || progress?.percent === undefined ? '— %' : `${Math.round(progress.percent)} %`}
              {leftWords === null ? '' : ` · ${leftWords}`}
            </span>
          </div>
          <div
            role="progressbar"
            aria-valuenow={progress?.percent ?? 0}
            aria-valuemin={0}
            aria-valuemax={100}
            style={{ height: 8, borderRadius: 4, background: '#1b2531', overflow: 'hidden' }}
          >
            <div style={{ width: `${Math.max(0, Math.min(100, progress?.percent ?? 0))}%`, height: '100%', background: '#4f8ef7' }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12, color: '#9aa4b0' }}>
            <span>
              {progress?.line === null || progress?.line === undefined ? 'line —' : `line ${progress.line.toLocaleString('en-CA')}`}
              {progress?.state === null || progress?.state === undefined ? '' : ` · machine ${progress.state}`}
            </span>
            {nextChange !== null && <span style={{ color: AMBER }}>Next: bit change to {nextChange}, then a cleaning pass</span>}
          </div>
        </div>
      )}

      {/* THE LIST */}
      <div data-testid="engrave-cut-card-list" style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 3, fontSize: 13, maxHeight: 300, overflowY: 'auto' }}>
        {model.rows.map((row) => {
          if (row.kind === 'flip') {
            return (
              <div key={`flip-${row.toSetup}`} data-testid="engrave-cut-card-flip" style={{ display: 'flex', gap: 10, alignItems: 'center', color: AMBER, borderTop: '1px dashed #2a3542', marginTop: 4, paddingTop: 6 }}>
                <span style={{ width: 16, textAlign: 'center' }}>↻</span>
                <span style={{ flex: '1 1 auto' }}>
                  Flip: turn the blank left↔right into the same corner · register side {row.toSetup} on the two bores
                </span>
              </div>
            );
          }
          const glyph = row.done ? '✓' : row.running ? '▶' : row.needsChange ? '⇄' : '·';
          const glyphColor = row.done ? OK : row.running ? BLUE : row.needsChange ? AMBER : '#9aa4b0';
          const time =
            row.done && row.measuredSeconds !== null
              ? formatDuration(row.measuredSeconds)
              : row.estimateSeconds === null
                ? '—'
                : `≈ ${formatDuration(row.estimateSeconds)}`;
          return (
            <div
              key={`program-${row.index}`}
              data-testid={`engrave-cut-card-row-${row.index}`}
              data-state={row.done ? 'done' : row.running ? 'running' : row.needsChange ? 'bit-change' : 'queued'}
              style={{ display: 'flex', gap: 10, alignItems: 'center', color: row.done || row.running ? '#e6edf1' : '#c9d4e2' }}
            >
              <span style={{ width: 16, textAlign: 'center', color: glyphColor }}>{glyph}</span>
              <span style={{ width: 28, textAlign: 'right', fontVariantNumeric: 'tabular-nums', ...MUTED }}>{row.index}</span>
              <span style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {row.bit}
                {model.sides > 1 ? ` · side ${row.setupIndex}` : ''}
                {row.purpose !== null ? ` — ${row.purpose}` : ''}
              </span>
              <span style={{ ...MUTED, whiteSpace: 'nowrap' }}>{time}</span>
            </div>
          );
        })}
      </div>

      {/* FOOTNOTE */}
      <p style={{ ...MUTED, fontSize: 12, margin: '6px 0 0' }} data-testid="engrave-cut-card-footnote">
        ⇄ a bit change, confirmed by you · after every program a cleaning pass · before the first cut an air walk of the outline
      </p>

      {/* #1123 item 8 — READY: the ONE Start, with the line that says which program and bit are
          next. No Pause, no Stop: nothing is running, and the old block's start control is not
          rendered while this card is up. */}
      {readyUp && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid #222c38' }}>
          <p data-testid="engrave-cut-card-ready" style={{ fontSize: 13, color: '#c9d4e2', margin: '0 0 6px' }}>
            <b>Ready</b> · program {nextIndex ?? 1} of {total} · next: {inSpindle ? 'the bit in the spindle' : (nextBit ?? '—')}
          </p>
          <button
            type="button"
            data-testid="engrave-cut-card-start"
            disabled={startReason !== null || pressing}
            style={{
              width: '100%',
              padding: 10,
              borderRadius: 8,
              border: 0,
              background: startReason === null && !pressing ? '#4f8ef7' : '#2a3542',
              color: startReason === null && !pressing ? '#0b1220' : '#9aa4b0',
              font: 'inherit',
              fontWeight: 600,
            }}
            onClick={() => void pressStart()}
          >
            {pressing
              ? 'Starting…'
              : release?.phase === 'stopped'
                ? `Resume — program ${nextIndex ?? 1} of ${total}`
                : release?.phase === 'failed'
                  ? `Try again — program ${nextIndex ?? 1} of ${total}`
                  : `Start program ${nextIndex ?? 1} of ${total}`}
          </button>
          {registrationNote !== null && startReason === null && (
            <p data-testid="engrave-cut-card-registration-note" style={{ ...MUTED, fontSize: 12, margin: '4px 0 0' }}>
              {registrationNote}
            </p>
          )}
          {startReason !== null && (
            <p data-testid="engrave-cut-card-start-reason" style={{ ...MUTED, fontSize: 12, margin: '4px 0 0' }}>
              {startReason}
            </p>
          )}
        </div>
      )}

      {/* #1123 item 8 — PAUSE/STOP APPEAR WHEN A PROGRAM RUNS, and only then. The waiting card owns
          the recovery while the machine is parked. */}
      {runningRow !== null && !waiting && (
        <>
          <div
            data-testid="engrave-cut-card-controls"
            style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid #222c38', display: 'flex', gap: 8, alignItems: 'center' }}
          >
            <button
              type="button"
              data-testid="engrave-cut-card-pause"
              style={{ flex: '1 1 auto', padding: 10, borderRadius: 8, border: '1px solid #3a4a5e', background: '#1b2531', color: '#e6edf1', font: 'inherit', fontWeight: 600 }}
              onClick={() => {
                if (dockKey === null) return;
                if (paused) useMachineRunStore.getState().requestResume(dockKey);
                else useMachineRunStore.getState().requestPause(dockKey);
              }}
            >
              {paused ? 'Resume' : '❚❚ Pause after this move'}
            </button>
            <button
              type="button"
              data-testid="engrave-cut-card-stop"
              disabled={target === null}
              style={{ width: 120, padding: 10, borderRadius: 8, border: '1px solid #b3261e', background: '#2a1715', color: '#f08a83', font: 'inherit', fontWeight: 600 }}
              onClick={() => {
                if (target !== null) useEngraveReleaseStore.getState().stop(target);
              }}
            >
              ■ Stop
            </button>
          </div>
          <p style={{ ...MUTED, fontSize: 11, margin: '6px 0 0' }}>
            The red button on the machine is the emergency stop. Stop here finishes the move, switches the vacuum off and homes.
          </p>
        </>
      )}
    </section>
  );
}
