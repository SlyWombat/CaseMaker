/**
 * #1170 — THE END OF THE JOB, UNDER STEP 3. The mockup is canvas artboard 8 ("the end of the job").
 *
 * The three steps stay above it (#1123 item 39): this card never replaces them. It adds the job's
 * own accounting and the two last questions:
 *
 *   - THREE TILES: the measured cutting time with its estimate under it, the operator's own wall
 *     time with the bit changes and flips that made it, and the stops with the program they hit.
 *   - BEFORE YOU TAKE IT OUT: whether the part is free of its tabs (and the one-program replay that
 *     frees them), and whether the offcut goes on the shelf — described by its size, thickness and
 *     what was cut out of it, with the shelf action that already exists.
 *   - THE NEXT MOVE: save the run record, cut another of the same job, or start a new one.
 *
 * THE REPLAY IS THE TAB RELEASE ONLY. The generated result names the program that leaves the tabs
 * (`EngraveProgram.tabRelease`); the card finds that program's hash in the package and asks the
 * release store to play that one file again. `RunContext.rerun` makes the end record nothing — the
 * blank was already consumed and the part already finished.
 */
import { useState } from 'react';
import type { JSX } from 'react';

import { formatDuration } from '@/engine/cnc/plan/format';
import { buildRunRecord, runRecordFileName, runSeconds, serializeRunRecord, type RunRecord } from '@/engine/cnc/engrave/runRecord';
import { ensureLabelFontsLoaded } from '@/engine/fonts/registry';
import { saveText } from '@/engine/exportTrigger';
import { machineKey, useMachineRunStore, type RunEntry, type RunEnd } from '@/store/machineRunStore';
import { useEngraveReleaseStore } from '@/store/engraveReleaseStore';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { useCncModeStore } from '@/store/cncModeStore';
import { useMachineStore } from '@/store/machineStore';
import { useStripAccessoryStore } from '@/store/stripAccessoryStore';
import type { EngraveGenerated } from '@/workers/sim/engraveGenerate';
import type { EngraveJob, FrozenPackage } from '@/types/engraveJob';
import { cutMachineLine } from './cutMachineStatus';

const BOX = { padding: 12, border: '1px solid #2a3542', borderRadius: 10, background: '#161d27' } as const;
const MUTED = { color: '#9aa4b0' } as const;
const OK = '#5fc27f';

export interface CutEndModel {
  cuttingSeconds: number | null;
  estimateSeconds: number | null;
  yourSeconds: number | null;
  bitChanges: number;
  flips: number;
  stops: { count: number; lines: string[] };
  /** The offcut as the run offered it, with the part's own names appended. */
  offcut: RunEnd['offcut'];
  offcutText: string | null;
  /** The 1-based (cut-order) program that leaves the tabs, or null when the job has none. */
  releaseIndex: number | null;
}

/** The named parts the document cuts: the "what is cut out of it" half of the offcut sentence. */
function partNames(job: EngraveJob): string[] {
  const items = [
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
  ] as { name?: string; text?: string }[];
  return items
    .map((item) => item.name ?? item.text ?? null)
    .filter((name): name is string => name !== null && name.length > 0);
}

/**
 * WHAT THE END CARD SAYS, from what the run recorded. Pure: the component only draws it.
 *
 * The clocks are the imported timed record's (`actualSeconds`, `estimatedSeconds`, the operator's
 * `minutes`); a job with no record says "—" rather than inventing a clock. The changes and flips
 * are the PACKAGE's own cut order; the stops are the document's run log, which is the durable
 * record of a program that did not finish.
 */
export function cutEndModel(input: {
  job: EngraveJob;
  pkg: FrozenPackage;
  generated: EngraveGenerated | null;
  run: RunEntry | null;
  lastMeasuredRun: RunRecord | null;
}): CutEndModel {
  const { job, pkg } = input;
  let bitChanges = 0;
  const setups = new Set<number>();
  pkg.programs.forEach((program, i) => {
    if (i > 0 && pkg.programs[i - 1]!.toolKey !== program.toolKey) bitChanges += 1;
    setups.add(program.setupIndex);
  });
  const flips = Math.max(0, setups.size - 1);
  const indexByHash = new Map(pkg.programs.map((program, i) => [program.hash, i + 1]));
  const stopEntries = (job.runLog ?? []).filter((entry) => entry.outcome !== 'finished');
  const stops = {
    count: stopEntries.length,
    lines: stopEntries.map((entry) => {
      const at = indexByHash.get(entry.programHash);
      return `${at === undefined ? 'a program' : `program ${at}`} · by ${entry.outcome === 'failed' ? 'the machine' : 'you'}`;
    }),
  };
  const cuttingSeconds = input.lastMeasuredRun === null ? null : runSeconds(input.lastMeasuredRun);
  const actual = input.lastMeasuredRun?.actualSeconds ?? null;
  const minutes = input.lastMeasuredRun?.minutes ?? null;
  const yourSeconds = actual === null || minutes === null ? null : Math.max(0, Math.round(minutes * 60 - actual));
  const releaseHash = input.generated?.programs.find((program) => program.tabRelease != null)?.programHash ?? null;
  const releaseIndex = releaseHash === null ? null : (indexByHash.get(releaseHash) ?? null);
  const offcut = input.run?.end?.offcut ?? null;
  const parts = partNames(job);
  const cutWhat = parts.length > 0 ? parts.join(', ') : job.name;
  const offcutText = offcut === null ? null : `${offcut.text} The part cut from it: ${cutWhat}.`;
  return {
    cuttingSeconds,
    estimateSeconds: input.lastMeasuredRun?.estimatedSeconds ?? null,
    yourSeconds,
    bitChanges,
    flips,
    stops,
    offcut,
    offcutText,
    releaseIndex,
  };
}

export interface CutEndCardProps {
  job: EngraveJob;
  pkg: FrozenPackage;
  generated: EngraveGenerated | null;
  run: RunEntry | null;
  lastMeasuredRun: RunRecord | null;
  /** #927 — the last measured run's clock against its recorded estimate, in the surface's words. */
  measuredSentence: string;
  target: { host: string; port: number };
}

export function CutEndCard({
  job,
  pkg,
  generated,
  run,
  lastMeasuredRun,
  measuredSentence,
  target,
}: CutEndCardProps): JSX.Element | null {
  const machine = useMachineStore((s) => s.machine);
  const heartbeat = useMachineStore((s) => s.heartbeat);
  const release = useEngraveReleaseStore((s) => s.records[machineKey(target)]);
  const light = useStripAccessoryStore((s) => s.modes[machineKey(target)]?.light ?? null);
  const [out, setOut] = useState(false);
  if (run === null) return null;
  const model = cutEndModel({ job, pkg, generated, run, lastMeasuredRun });
  const machineWords = cutMachineLine({
    machine,
    heartbeat,
    light,
    vacuum: release?.vacuum ?? null,
  });

  const saveRecord = async (): Promise<void> => {
    if (generated === null) return;
    await ensureLabelFontsLoaded(job.labels, job.customFonts ?? []);
    await saveText(serializeRunRecord(buildRunRecord(job, generated)), runRecordFileName(job.name), 'application/json');
  };

  return (
    <section data-testid="engrave-cut-end-card" style={{ ...BOX, marginTop: 8 }}>
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, borderBottom: '1px solid #222c38', paddingBottom: 8 }}
      >
        <span
          style={{
            width: 22,
            height: 22,
            borderRadius: '50%',
            background: '#173224',
            color: OK,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 13,
            fontWeight: 700,
          }}
        >
          ✓
        </span>
        <span style={{ flex: '1 1 auto' }}>
          <b style={{ fontWeight: 600 }}>3 · Cut</b>{' '}
          <span style={MUTED}>
            · {pkg.programs.length} of {pkg.programs.length} done
          </span>
        </span>
        {machineWords.length > 0 && <span style={{ fontSize: 12, color: '#9aa8b8' }}>{machineWords}</span>}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10, marginTop: 10 }}>
        <div data-testid="engrave-cut-end-cutting" style={{ padding: '10px 12px', borderRadius: 8, background: '#1b2531' }}>
          <div style={{ fontSize: 12, ...MUTED }}>Cutting time</div>
          <div style={{ fontSize: 20, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
            {model.cuttingSeconds === null ? '—' : formatDuration(model.cuttingSeconds)}
          </div>
          <div style={{ fontSize: 12, ...MUTED }}>
            {model.estimateSeconds === null ? 'no estimate recorded' : `estimate ${formatDuration(model.estimateSeconds)}`}
          </div>
        </div>
        <div data-testid="engrave-cut-end-your" style={{ padding: '10px 12px', borderRadius: 8, background: '#1b2531' }}>
          <div style={{ fontSize: 12, ...MUTED }}>Your time</div>
          <div style={{ fontSize: 20, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
            {model.yourSeconds === null ? '—' : formatDuration(model.yourSeconds)}
          </div>
          <div style={{ fontSize: 12, ...MUTED }}>
            {model.bitChanges} bit change{model.bitChanges === 1 ? '' : 's'}, {model.flips} flip{model.flips === 1 ? '' : 's'}
          </div>
        </div>
        <div data-testid="engrave-cut-end-stops" style={{ padding: '10px 12px', borderRadius: 8, background: '#1b2531' }}>
          <div style={{ fontSize: 12, ...MUTED }}>Stops</div>
          <div style={{ fontSize: 20, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{model.stops.count}</div>
          <div style={{ fontSize: 12, ...MUTED }}>
            {model.stops.lines.length === 0 ? 'none' : model.stops.lines.join(' · ')}
          </div>
        </div>
      </div>

      {/* #927 — THE MEASURED RUN AGAINST ITS OWN RECORD'S ESTIMATE, dated. It moved here with the
          screen: the end card is where the job's clock now lives. */}
      <p style={{ margin: '8px 0 0', fontSize: 12, ...MUTED }} data-testid="engrave-cut-actual-time">
        {measuredSentence}
      </p>

      <div style={{ marginTop: 12, display: 'grid', gap: 8, fontSize: 14 }}>
        <span style={{ fontSize: 12, letterSpacing: '0.08em', textTransform: 'uppercase', ...MUTED, fontWeight: 600 }}>
          Before you take it out
        </span>
        {!out && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '10px 12px', borderRadius: 8, background: '#1b2531' }}>
            <span>Is the part free of its tabs?</span>
            <span style={{ display: 'flex', gap: 6 }}>
              <button type="button" data-testid="engrave-cut-end-out" onClick={() => setOut(true)}>
                Yes, out
              </button>
              <button
                type="button"
                data-testid="engrave-cut-end-tabs"
                disabled={model.releaseIndex === null}
                title={model.releaseIndex === null ? 'this job has no tab-release program' : undefined}
                onClick={() => {
                  if (model.releaseIndex === null) return;
                  void useEngraveReleaseStore.getState().rerunProgram(target, model.releaseIndex);
                }}
              >
                Cut the tabs again
              </button>
            </span>
          </div>
        )}
        {out && (
          <p style={{ ...MUTED, margin: 0 }} data-testid="engrave-cut-end-out-note">
            The part is out. The run record and the shelf question are below.
          </p>
        )}
        <div
          data-testid="engrave-cut-end-offcut-question"
          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '10px 12px', borderRadius: 8, background: '#1b2531' }}
        >
          <span>
            {model.offcutText === null ? 'No offcut was offered from this blank.' : `Keep the offcut on the shelf? ${model.offcutText}`}
          </span>
          <span style={{ display: 'flex', gap: 6 }}>
            {model.offcut?.state === 'asked' ? (
              <>
                <button type="button" data-testid="engrave-cut-end-keep" onClick={() => void useMachineRunStore.getState().keepOffcut(machineKey(target))}>
                  Keep
                </button>
                <button type="button" data-testid="engrave-cut-end-scrap" onClick={() => useMachineRunStore.getState().skipOffcut(machineKey(target))}>
                  Scrap
                </button>
              </>
            ) : (
              <span data-testid="engrave-cut-end-offcut-state" style={MUTED}>
                {model.offcut?.state === 'kept' ? 'kept on the shelf' : model.offcut?.state === 'skipped' ? 'scrapped' : 'nothing to keep'}
              </span>
            )}
          </span>
        </div>
      </div>

      <div style={{ marginTop: 12, display: 'grid', gap: 8 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            data-testid="engrave-cut-end-save"
            disabled={generated === null}
            style={{ flex: '1 1 auto', padding: 11, borderRadius: 8, border: 0, background: '#4f8ef7', color: '#0b1220', font: 'inherit', fontWeight: 600 }}
            onClick={() => void saveRecord()}
          >
            Save the run record
          </button>
          <button
            type="button"
            data-testid="engrave-cut-end-another"
            style={{ flex: '1 1 auto', padding: 11, borderRadius: 8, border: '1px solid #3a4a5e', background: '#1b2531', font: 'inherit', fontWeight: 600, color: '#e6ebf1' }}
            onClick={() => {
              useEngraveReleaseStore.getState().reset(target);
              useCncModeStore.getState().show('design');
            }}
          >
            Cut another of these
          </button>
          <button
            type="button"
            data-testid="engrave-cut-end-new"
            style={{ flex: '1 1 auto', padding: 11, borderRadius: 8, border: '1px solid #3a4a5e', background: '#1b2531', font: 'inherit', fontWeight: 600, color: '#e6ebf1' }}
            onClick={() => {
              useEngraveJobStore.getState().reset();
              useCncModeStore.getState().show('design');
            }}
          >
            New job
          </button>
        </div>
        <span style={{ fontSize: 12, ...MUTED }} data-testid="engrave-cut-end-steps-note">
          The three steps stay above this card. Nothing on this screen replaces them, however many programs the job had.
        </span>
      </div>
    </section>
  );
}
