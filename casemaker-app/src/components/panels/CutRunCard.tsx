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
import type { JSX } from 'react';

import { useEngraveReleaseStore } from '@/store/engraveReleaseStore';
import { machineKey, useMachineRunStore } from '@/store/machineRunStore';
import { useToolRegistryStore } from '@/store/toolRegistryStore';
import { jobSetups } from '@/engine/cnc/engrave/jobSetup';
import { cutterIdentity } from '@/engine/cnc/engrave/cutterCaseLine';
import { nextBitChange, remainingSeconds, runClockSeconds } from '@/engine/cnc/engrave/runProgress';
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
}

export function CutRunCard({ job, pkg, plan, finishedHashes, target }: CutRunCardProps): JSX.Element {
  const release = useEngraveReleaseStore((s) => (target === null ? undefined : s.records[machineKey(target)]));
  const runEntry = useMachineRunStore((s) => (target === null ? undefined : s.runs[machineKey(target)]));
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
  const left = remainingSeconds(progress?.percent ?? null, runClockSeconds(runEntry ?? null, Date.now()));
  const canControl = dockKey !== null && runningIndex !== null;
  // #1180/A's acceptance rule — A DISABLED CONTROL SAYS WHY. The fixed row is on the card in every
  // state, so with no live run both buttons are disabled and each carries the same plain reason a
  // person needs; Stop adds the machine, which it cannot act on without one.
  const pauseReason = canControl ? null : 'Nothing is running yet';
  const stopReason = target === null ? 'Choose the machine first' : canControl ? null : 'Nothing is running yet';
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

      {/* THE RUNNING ROW — in a FIXED-HEIGHT slot, empty when nothing runs, so the fixed control
          row below does not move between idle, running, paused and bit-change states. */}
      <div data-testid="engrave-cut-card-running-slot" style={{ height: 150, marginTop: 8 }}>
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
              {left === null ? '' : ` · ${formatDuration(left)} left`}
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
      </div>

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

      {/* FIXED CONTROL ROW */}
      <div
        data-testid="engrave-cut-card-controls"
        style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid #222c38', display: 'flex', gap: 8, alignItems: 'center' }}
      >
        <button
          type="button"
          data-testid="engrave-cut-card-pause"
          disabled={!canControl}
          {...(pauseReason === null ? {} : { title: pauseReason, 'aria-description': pauseReason })}
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
          disabled={!canControl || target === null}
          {...(stopReason === null ? {} : { title: stopReason, 'aria-description': stopReason })}
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
    </section>
  );
}
