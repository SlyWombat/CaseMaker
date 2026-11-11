/**
 * #1169 (part B) — THE MACHINE STOPPED. Mockup 7 (`Cut-BitChange.dc.html`, right column bottom).
 *
 * One red card, shown at whichever step the stop happened (it is rendered above the Cut steps),
 * naming the step and position, quoting the machine's own words, stating what is still good — and
 * giving the recovery in the bench's order: `1 · Unlock and home`, then `2 · choose what happened`.
 *
 * DISPLAY + THE EXISTING RUN ACTIONS. Unlock is `unlockMachine` (`$X`, offered only against Alarm),
 * home is the strip's own `$H` console send, Clean now is `useEngraveReleaseStore.cleanNow`, and
 * "run again" is `startRelease` (which prepares a FRESH run id through #1153 — nothing here patches
 * the stopped run). "The bit broke or slipped" is disabled with "after #1168" until that card
 * exists. "End the job here" was approved 2026-11-10 as: dismiss the card only, leave the run
 * record/finishedPrograms untouched, no new store field.
 */
import { useEffect, useState, type JSX } from 'react';

import { attachConsole } from '@/platform/machineConsole';
import type { MachineObservation } from '@/platform/machineProbe';
import { unlockMachine } from '@/platform/machineUnlock';
import { useEngraveReleaseStore } from '@/store/engraveReleaseStore';
import { machineKey, useMachineRunStore } from '@/store/machineRunStore';
import { stoppedPhase, useCutRescueStore } from './cutRescue';

const MUTED = { color: '#9aa4b0' } as const;
const OK = '#5fc27f';

export interface CutStoppedCardProps {
  machine: MachineObservation | null;
  target: { host: string; port: number } | null;
  /** The job's registration record says the origin was written; null when it cannot be read. */
  originWritten: boolean | null;
  /** Take the operator to step 2's registration (the blank moved). */
  onRegisterAgain: () => void;
}

export function CutStoppedCard({ machine, target, originWritten, onRegisterAgain }: CutStoppedCardProps): JSX.Element | null {
  const release = useEngraveReleaseStore((s) => (target === null ? undefined : s.records[machineKey(target)]));
  const runEntry = useMachineRunStore((s) => (target === null ? undefined : s.runs[machineKey(target)]));
  const [recovered, setRecovered] = useState(false);
  const [busy, setBusy] = useState<'unlock' | null>(null);
  // #1123 items 9/10 — the dismissal is UI state shared with the run card and the status strip
  // (they must know the card is down); the run record itself is untouched, as approved.
  const dismissed = useCutRescueStore((s) => (target === null ? false : s.dismissedStopped[machineKey(target)] === true));
  const stopped = stoppedPhase(release);
  // A NEW stop on a recovered machine is a new card: the old dismissal does not carry over.
  useEffect(() => {
    if (target !== null && !stopped) useCutRescueStore.getState().clearDismissed(machineKey(target));
  }, [target, stopped]);
  if (machine === null || target === null || !stopped || dismissed) return null;
  const rec = release!;
  const active = rec.active;
  const file = active === null ? null : (rec.files.find((f) => f.index === active) ?? null);
  const total = rec.files.length;
  // The step the stop happened at, from the release record's own phase and the file it held.
  const stepWords =
    file !== null
      ? `while cutting program ${file.index} of ${total}`
      : rec.phase === 'failed'
        ? 'while preparing the run'
        : 'between programs';
  const line = runEntry?.progress?.line ?? null;
  const totalLines = file === null ? null : file.nc.split('\n').length;
  const machineWords = (() => {
    const lines = runEntry?.lines ?? [];
    const last = [...lines].reverse().find((l) => !l.startsWith('>') && !l.startsWith('(')) ?? null;
    return last;
  })();
  const programsOnMachine =
    rec.files.length > 0 &&
    rec.files.every((f) => f.done || f.upload === 'uploaded' || f.upload === 'present');
  const vacuumWords = rec.vacuum === 'on' ? 'the vacuum is still on' : rec.vacuum === 'off' ? 'the vacuum is off' : 'the vacuum state is unknown';
  const unlockAndHome = async (): Promise<void> => {
    setBusy('unlock');
    try {
      await unlockMachine({ host: target.host, port: target.port });
      const session = attachConsole({ host: target.host, port: target.port });
      try {
        await session.send('$H');
      } finally {
        await session.close();
      }
      setRecovered(true);
    } finally {
      setBusy(null);
    }
  };
  const runAgain = (): void => {
    // The operator is at the machine, having just recovered it: the release step's own "I am at
    // the machine" tick is what startRelease waits for, so it is set with the choice.
    useEngraveReleaseStore.getState().setAtMachine(target, true);
    useEngraveReleaseStore.getState().startRelease(target);
  };
  const choice = (
    testid: string,
    title: string,
    detail: string,
    onClick: (() => void) | null,
    disabled = false,
  ): JSX.Element => (
    <button
      key={testid}
      type="button"
      data-testid={testid}
      disabled={!recovered || disabled || onClick === null}
      onClick={onClick ?? (() => {})}
      style={{
        textAlign: 'left',
        padding: '8px 12px',
        borderRadius: 8,
        border: '1px solid #2a3542',
        background: recovered && !disabled ? '#121a24' : '#0f141b',
        color: recovered && !disabled ? '#c9d4e2' : '#6f7f92',
        font: 'inherit',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      }}
    >
      <span style={{ fontSize: 14, fontWeight: 600 }}>{title}</span>
      <span style={{ fontSize: 12 }}>{detail}</span>
    </button>
  );
  return (
    <section
      data-testid="engrave-cut-recovery-stopped"
      data-state="stopped"
      style={{ marginTop: 6, padding: 14, border: '1px solid #b3261e', borderRadius: 12, background: '#161d27', display: 'flex', flexDirection: 'column', gap: 10 }}
    >
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 14 }}>
        <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: '50%', background: '#f08a83' }} />
        <span style={{ flex: '1 1 auto' }}>
          <b style={{ fontWeight: 600 }}>The machine stopped</b>{' '}
          <span style={MUTED}>
            · {stepWords}
            {line === null ? '' : ` · line ${line.toLocaleString('en-CA')}${totalLines === null ? '' : ` of ${totalLines.toLocaleString('en-CA')}`}`}
          </span>
        </span>
      </div>
      <p style={{ margin: 0, fontSize: 14 }}>
        You pressed Stop or the red button, or the machine stopped itself.
        {machineWords === null ? '' : ` Its words: “${machineWords}”.`} The spindle is off; {vacuumWords}; the head is where it stopped.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '10px 12px', borderRadius: 8, background: '#173224', color: '#c9f0d4', fontSize: 13 }}>
        {originWritten === true && (
          <span>
            <span style={{ color: OK }}>✓</span> The machine still knows where the blank is. You do not probe again unless the blank moved.
          </span>
        )}
        {programsOnMachine && (
          <span>
            <span style={{ color: OK }}>✓</span> All {total} programs are still on the machine. Nothing is lost by stopping.
          </span>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          data-testid="engrave-cut-recovery-unlock-home"
          disabled={busy !== null || recovered}
          style={{ flex: '1 1 auto', padding: 11, borderRadius: 8, border: 0, background: '#4f8ef7', color: '#0b1220', font: 'inherit', fontWeight: 600 }}
          onClick={() => void unlockAndHome()}
        >
          {recovered ? 'Machine unlocked and homed' : busy === null ? '1 · Unlock and home' : 'Unlocking…'}
        </button>
        <button
          type="button"
          data-testid="engrave-cut-recovery-clean"
          disabled={!recovered || rec.walks.clean === null}
          style={{ width: 150, padding: 11, borderRadius: 8, border: '1px solid #2a3542', background: recovered && rec.walks.clean !== null ? '#1b2531' : '#121a24', color: recovered && rec.walks.clean !== null ? '#e6edf1' : '#6f7f92', font: 'inherit', fontWeight: 600 }}
          onClick={() => useEngraveReleaseStore.getState().cleanNow(target)}
        >
          Clean now
        </button>
      </div>
      <span style={{ fontSize: 12, letterSpacing: '0.08em', textTransform: 'uppercase', ...MUTED, fontWeight: 600 }}>
        2 · Then choose what happened — offered once homed
      </span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {choice(
          'engrave-cut-recovery-run-again',
          `Nothing is wrong — run program ${active ?? 1} again`,
          'From its start. It passes over what is already cut, then carries on.',
          runAgain,
        )}
        {choice(
          'engrave-cut-recovery-bit-broke',
          'The bit broke or slipped — fit a bit, then run again',
          'Shows the bit to fit, measures it, runs the program from its start. (after #1168)',
          null,
          true,
        )}
        {choice(
          'engrave-cut-recovery-register-again',
          'The blank moved — register again, then run again',
          'Probe in, one touch on top. If it moved after side 2 began, the two bores.',
          onRegisterAgain,
        )}
        {choice('engrave-cut-recovery-end', 'End the job here', `Keeps the record: ${rec.files.filter((f) => f.done).length} of ${total} cut. You can open it later and continue.`, () => {
          if (target !== null) useCutRescueStore.getState().dismissStopped(machineKey(target));
        })}
      </div>
      <span style={{ fontSize: 12, ...MUTED }}>
        This card appears wherever the stop happens — registering, measuring a bit, cutting or cleaning — and names that step. Cleaning never starts
        by itself after a stop: hands may be in. No answer from the machine at all? Switch it off and on at its plug, then Unlock and home.
      </span>
    </section>
  );
}
