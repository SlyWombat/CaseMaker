/**
 * The run on each machine (#423) — the SINGLE SOURCE OF TRUTH for it. The run is owned here, not by
 * any panel:
 *
 *   - an upload that went through PREPARES the machine's entry (the file and its program hash);
 *     the run panel is drawn from that entry, keyed by machine, so closing and reopening the engrave
 *     panel finds the run — and its Stop — exactly where it was;
 *   - ONE RUN PER MACHINE: `start` refuses while one is running there, and the upload panel locks
 *     Upload on the same flag;
 *   - the watch keeps going with no panel attached (#423 re-review: a run nobody can see must still
 *     finish, or still be stoppable, the way it would with the panel open);
 *   - STOP is a flag the watch reads at its next poll boundary, and a pressed Stop is always sent.
 */

import { create } from 'zustand';
import { attachConsole } from '@/platform/machineConsole';
import { runProgram, type Progress, type RunOutcome, type RunSettings } from '@/platform/machineRun';

export interface RunEntry {
  running: boolean;
  filename: string;
  /** The hash of the program that was uploaded — the once-per-program confirmation's key (Q17). */
  programHash: string;
  progress: Progress | null;
  lines: string[];
  outcome: RunOutcome | null;
  stopAsked: boolean;
}

export interface MachineRunState {
  runs: Record<string, RunEntry>;
  /** An upload went through: this file is what "Run it" will play. Refused while a run is going. */
  prepare: (target: { host: string; port: number }, filename: string, programHash: string) => boolean;
  /** Start the prepared program; false when one is already running there, or nothing is prepared. */
  start: (target: { host: string; port: number }, settings: RunSettings) => boolean;
  requestStop: (machine: string) => void;
}

export function machineKey(target: { host: string; port: number }): string {
  return `${target.host}:${target.port}`;
}

/** The Stop flag a watch reads at its boundaries — outside zustand, so reading it never re-renders. */
const flags = new Map<string, { stop: boolean }>();

export const useMachineRunStore = create<MachineRunState>((set, get) => {
  const patch = (machine: string, p: Partial<RunEntry>) =>
    set((s) => ({ runs: { ...s.runs, [machine]: { ...(s.runs[machine] as RunEntry), ...p } } }));

  return {
    runs: {},
    prepare: (target, filename, programHash) => {
      const machine = machineKey(target);
      if (get().runs[machine]?.running) return false;
      set((s) => ({
        runs: {
          ...s.runs,
          [machine]: { running: false, filename, programHash, progress: null, lines: [], outcome: null, stopAsked: false },
        },
      }));
      return true;
    },
    start: (target, settings) => {
      const machine = machineKey(target);
      const prepared = get().runs[machine];
      if (!prepared || prepared.running) return false;
      const f = { stop: false };
      flags.set(machine, f);
      patch(machine, { running: true, progress: null, lines: [], outcome: null, stopAsked: false });
      const session = attachConsole(target);
      void (async () => {
        try {
          const outcome = await runProgram(prepared.filename, {
            session,
            settings,
            stopRequested: () => f.stop,
            onEvent: (e) => {
              const entry = get().runs[machine];
              if (!entry) return;
              if (e.kind === 'poll') patch(machine, { progress: e.progress });
              else if (e.kind === 'sent' && e.line !== '?') {
                patch(machine, { lines: [...entry.lines, `> ${e.line}  ${e.reply.trim().split('\n')[0] ?? ''}`] });
              } else if (e.kind === 'missed') patch(machine, { lines: [...entry.lines, `(no status reply ${e.misses})`] });
            },
          });
          patch(machine, { outcome });
        } catch (e) {
          patch(machine, { outcome: { kind: 'refused', reason: e instanceof Error ? e.message : String(e) } });
        } finally {
          await session.close();
          patch(machine, { running: false });
        }
      })();
      return true;
    },
    requestStop: (machine) => {
      const f = flags.get(machine);
      const entry = get().runs[machine];
      if (!f || !entry?.running) return;
      f.stop = true;
      patch(machine, { stopAsked: true, lines: [...entry.lines, '(Stop pressed — abort goes out at the next poll)'] });
    },
  };
});

/** Test seam. */
export function resetMachineRunStore(): void {
  flags.clear();
  useMachineRunStore.setState({ runs: {} });
}
