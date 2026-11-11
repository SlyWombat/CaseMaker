/**
 * #1169 — THE MACHINE IS WAITING FOR YOU. Mockup 7 (`Cut-BitChange.dc.html`, right column top).
 *
 * The firmware's `Tool` state is the program stopped at its tool change, waiting for `M490.2`:
 * the bench met it with no Continue on the screen the operator was looking at (#1123 item 32).
 * This card is that prompt where the operator is — step 3 and, because a run can leave the tab
 * showing any step, ABOVE the steps — with the machine's own words, the bit to fit, and the two
 * actions: Continue (the run's `M490.2` path, or a direct send when no run of ours owns the
 * machine) and Stop.
 *
 * #1123 item 9 + manager ruling (2026-11-11): the card OWNS the recovery, so A's #1202 preview
 * lives HERE when the panel's prompt folds away on the Cut step — the same dry line, first-run
 * mark, statement, headless refusal, hold rule and sender (`requestToolContinue`). A safety
 * preview may not disappear because the controls moved.
 *
 * Display + the EXISTING run actions: `toolContinuePlan` is the strip's own decision, and Stop is
 * `useEngraveReleaseStore.stop` — the same handlers the strip and the release step call.
 */
import type { JSX } from 'react';

import { attachConsole } from '@/platform/machineConsole';
import type { MachineObservation } from '@/platform/machineProbe';
import { useEngraveReleaseStore } from '@/store/engraveReleaseStore';
import { machineKey, useMachineRunStore } from '@/store/machineRunStore';
import { getTools } from '@/engine/cnc/toolRegistry';
import { toolDisplayName } from '@/engine/cnc/toolDisplay';
import { toolContinuePlan } from '@/components/viewport/machineStripActions';
import { TOOL_CHANGE_NOTE } from '@/platform/toolChangeDry';
import { RoutineDryPreview } from './RoutineDryPreview';
import { TOOL_CHANGE_STATEMENT, toolContinueHeld, useToolChangePreview } from './toolChangePreview';

const MUTED = { color: '#9aa4b0' } as const;

export function CutRecoveryCard({
  machine,
  target,
}: {
  machine: MachineObservation | null;
  target: { host: string; port: number } | null;
}): JSX.Element | null {
  const entry = useMachineRunStore((s) => (target === null ? undefined : s.runs[machineKey(target)]));
  const release = useEngraveReleaseStore((s) => (target === null ? undefined : s.records[machineKey(target)]));
  const waiting = entry?.running === true && entry.toolWaiting != null;
  // #1202 — the preview is derived on every render (hooks before the early return); it only
  // matters while the wait is up, which is exactly when the card draws.
  const preview = useToolChangePreview(target, waiting);
  if (machine === null || target === null || !waiting) return null;
  const awaited = entry.toolWaiting?.awaited ?? null;
  const cutter = awaited === null ? null : (getTools().find((e) => e.tool.number === awaited) ?? null);
  const cutterName = cutter === null ? null : toolDisplayName(cutter.tool).split(' · ')[0]!;
  const program = release?.active ?? null;
  const continuePress = async (): Promise<void> => {
    const plan = toolContinuePlan(entry);
    if (plan === 'request') {
      useMachineRunStore.getState().requestToolContinue(machineKey(target));
      return;
    }
    if (plan === 'none') return;
    // No run of ours owns the machine (started by hand): the line goes out now, as the strip does.
    const session = attachConsole({ host: target.host, port: target.port });
    try {
      await session.send('M490.2');
    } finally {
      await session.close();
    }
  };
  return (
    <section
      data-testid="engrave-cut-recovery-waiting"
      data-state="waiting"
      style={{ marginTop: 6, padding: 14, border: '1px solid #e0a84a', borderRadius: 12, background: '#161d27' }}
    >
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 14 }}>
        <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: '50%', background: '#4f8ef7', boxShadow: '0 0 0 4px #152238' }} />
        <span style={{ flex: '1 1 auto' }}>
          <b style={{ fontWeight: 600 }}>The machine is waiting for you</b> <span style={MUTED}>· its light blinks blue</span>
        </span>
      </div>
      <p style={{ margin: '10px 0 0', fontSize: 14 }}>
        {program === null ? 'A program' : `Program ${program}`} asked for tool {awaited ?? 'n'}
        {cutterName === null ? '' : ` (${cutterName})`} and the machine does not have it recorded. It has parked the head at its change position and
        is waiting for a tool change to be confirmed.
      </p>
      <p style={{ margin: '6px 0 0', fontSize: 13, ...MUTED }}>
        If the {cutterName ?? 'cutter'} is already in, just continue: the machine will measure it and carry on. Otherwise fit it first.
      </p>
      {/* #1202 carried onto the card (#1123 item 9): the exact line the Continue sends, this
          machine's record of the shape, the guard's refusal and the operator's statement. */}
      <RoutineDryPreview
        preview={preview.dry}
        firstRun={preview.firstRun}
        ticked={preview.ticked}
        onTick={preview.setTicked}
        headless={preview.headless}
        note={TOOL_CHANGE_NOTE}
        statement={TOOL_CHANGE_STATEMENT}
      />
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button
          type="button"
          data-testid="engrave-cut-recovery-continue"
          disabled={toolContinueHeld({
            stopAsked: entry.stopAsked === true,
            firstRun: preview.firstRun,
            refused: preview.dry.refused,
            ticked: preview.ticked,
            headless: preview.headless,
          })}
          style={{ flex: '1 1 auto', padding: 11, borderRadius: 8, border: 0, background: '#4f8ef7', color: '#0b1220', font: 'inherit', fontWeight: 600 }}
          onClick={() => void continuePress()}
        >
          Continue — the bit is in
        </button>
        <button
          type="button"
          data-testid="engrave-cut-recovery-stop"
          disabled={release === undefined || entry.stopAsked === true}
          style={{ width: 110, padding: 11, borderRadius: 8, border: '1px solid #b3261e', background: '#2a1715', color: '#f08a83', font: 'inherit', fontWeight: 600 }}
          onClick={() => {
            if (release !== undefined) useEngraveReleaseStore.getState().stop(target);
          }}
        >
          ■ Stop
        </button>
      </div>
    </section>
  );
}
