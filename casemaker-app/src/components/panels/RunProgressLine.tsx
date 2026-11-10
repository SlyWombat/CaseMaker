/**
 * #830 review / #1123-45 — THE RUN'S PROGRESS LINE, its own leaf.
 *
 * Generate's own stages are one half; the SIMULATION is the other, and it used to show a bare
 * "Working…" for a whole multi-program sweep. The sweep's stage names the program and, from the sim
 * store, how many checkpoints are done.
 *
 * #830 — WHY IT IS A SEPARATE COMPONENT. The sweep reports a checkpoint per swept row, and the sim
 * store's `progress` changes on every one. Subscribing a whole panel to it (as #830 first did)
 * re-rendered every group, row and fold once per row: the two-side mouse-shell walk
 * (flipMouldShell) went from 71.7 s to locked past 18 minutes. Only this span reads those fields,
 * so only this span re-renders.
 *
 * #1123-45 — and it is SHARED now: the Design footer and the Cut step both show it, because a
 * Generate pressed from the Cut tab must say what it is doing there too.
 */
import { useEffect, useState, type JSX } from 'react';

import { useSimStore } from '@/store/simStore';
import type { EngraveRunState } from '@/store/engraveRunStore';
import { formatDuration } from '@/engine/cnc/plan/format';

/** A count in the operator's own reading form: `49,915` (#895's example line). */
function grouped(n: number): string {
  return n.toLocaleString('en-CA');
}

/**
 * #895 — WHAT IS LEFT, from the sweep's own rate projection (#871): the projected total less the
 * share already swept. It INFORMS — the sweep runs as long as it keeps advancing, so this can say
 * hours without anything stopping. Null until the projection's first trustworthy sample.
 */
function timeLeftWords(projectionMs: number | null, progress: { done: number; total: number }): string | null {
  if (projectionMs === null || progress.total <= 0) return null;
  const leftMs = Math.max(0, projectionMs * (1 - progress.done / progress.total));
  return `about ${formatDuration(leftMs / 1000)} left`;
}

/** #830 — what the run is doing, for the progress line. */
export function runProgressWords(
  run: Pick<EngraveRunState, 'phase' | 'progress' | 'simProgram'>,
  simStatus: string,
  simPhase: string | null,
  simProgress: { done: number; total: number } | null,
  simProjectionMs: number | null,
): string {
  if (run.phase === 'simulating') {
    const where = run.simProgram === null ? 'simulating' : `simulating program ${run.simProgram.index} of ${run.simProgram.count}`;
    if (simStatus === 'loading' && simPhase === 'playback') return `${where} · preparing playback`;
    // #1048 — the worker is busy with an earlier task (the background ideal): the load is queued,
    // not stalled. Said as waiting, in the one place the operator reads the run's progress.
    if (simStatus === 'loading' && simPhase === 'waiting') return `${where} · waiting for the simulation worker`;
    // #1048 — the rapid-move check is its own phase and reports k of M while it works.
    if (simStatus === 'loading' && simPhase === 'air' && simProgress !== null) {
      return `${where} · checking rapid moves ${grouped(simProgress.done)} of ${grouped(simProgress.total)}`;
    }
    // #1056 — the check is done; the app is finishing the sweep's meshes.
    if (simStatus === 'loading' && simPhase === 'air-done') return `${where} · finishing the sweep`;
    if (simStatus === 'loading' && simProgress !== null) {
      const left = timeLeftWords(simProjectionMs, simProgress);
      return `${where} · swept ${grouped(simProgress.done)} of ${grouped(simProgress.total)}${left === null ? '' : ` · ${left}`}`;
    }
    return where;
  }
  if (run.phase === 'checking') return 'checking the result';
  return run.progress === null ? 'Working…' : `${run.progress.label}…`;
}

export function RunProgressLine({ run }: { run: Pick<EngraveRunState, 'phase' | 'progress' | 'simProgram'> }): JSX.Element {
  const simStatus = useSimStore((s) => s.status);
  const simPhase = useSimStore((s) => s.phase);
  const simProgress = useSimStore((s) => s.progress);
  const simProjectionMs = useSimStore((s) => s.projectionMs);
  const waitingSince = useSimStore((s) => s.waitingSince);
  // #1048 — the wait is counted out loud; Stop stays beside it (the run's own Cancel press).
  const [now, setNow] = useState(() => Date.now());
  const waiting = simStatus === 'loading' && simPhase === 'waiting' && waitingSince !== null;
  useEffect(() => {
    if (!waiting) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [waiting]);
  return (
    <span>
      {runProgressWords(run, simStatus, simPhase, simProgress, simProjectionMs)}
      {waiting ? ` · ${formatDuration((now - waitingSince) / 1000)}` : ''}
    </span>
  );
}
