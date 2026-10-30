/**
 * #787 — the crash-recovery store: what the flight recorder found on this load, and the report the
 * operator can save.
 *
 * The recorder (`platform/flightRecorder.ts`) does the recording; this store is the surface's half:
 * it starts the recorder once at app load, holds the previous (uncleanly-ended) session it found,
 * and builds the report on the user's press. NOTHING IS SENT OR WRITTEN WITHOUT A PRESS — the
 * booking line is the banner's buttons, and this module has no other caller.
 *
 * The report's job facts come from the crumbs (the `work` crumb carries the job's numbers with its
 * mesh BYTES removed), and the mesh bytes are added only when the operator ticks the box: the
 * meshes are the biggest thing a report can carry, and they can be a private design.
 */

import { create } from 'zustand';
import {
  buildCrashReport,
  crashMoment,
  crashReportFileName,
  lastWorkFacts,
  startFlightRecorder,
  type CrashMoment,
  type CrashReport,
  type PreviousSession,
} from '@/platform/flightRecorder';
import { BUILD_TARGET } from '@/platform/capabilities';
import { probeHouse } from '@/platform/houseClient';
import { getMeshBlob } from '@/platform/meshBlobs';
import { saveText } from '@/engine/exportTrigger';

/** Where a crash report is written. Injectable so a spec does not touch the file picker. */
export interface CrashSaveIO {
  save: (text: string, filename: string) => Promise<void>;
}
const FILE_SAVE: CrashSaveIO = {
  save: (text, filename) => saveText(text, filename, 'application/json'),
};
let saveIO: CrashSaveIO = FILE_SAVE;
/** Spec seam: replace the file save (the app never calls this). `null` restores the real one. */
export function setCrashSaveIO(io: CrashSaveIO | null): void {
  saveIO = io ?? FILE_SAVE;
}

/** The house probe, injectable so a spec does not make a network request. */
type ProbeIO = () => Promise<{ kind: string }>;
const REAL_PROBE: ProbeIO = () => probeHouse();
let probeIO: ProbeIO = REAL_PROBE;
/** Spec seam: replace the house probe. `null` restores the real one. */
export function setCrashProbeIO(fn: ProbeIO | null): void {
  probeIO = fn ?? REAL_PROBE;
}

export interface FlightRecorderStoreState {
  /** The previous session, when it did not end cleanly; null on a normal start. */
  previous: PreviousSession | null;
  /** Its last moments in words, for the banner. */
  moment: CrashMoment | null;
  /** True when a house service answered — the "send" half exists only where something can receive. */
  houseOk: boolean;
  /** The banner was dismissed for this load. */
  dismissed: boolean;
  /** The recorder has been started (init is once per load). */
  started: boolean;
  /** The file the last Save wrote, or null. */
  saved: string | null;
  saving: boolean;
  error: string | null;
  init: () => Promise<void>;
  dismiss: () => void;
  /** Build and save the report. `includeMeshes` adds the job's mesh bytes (the operator's choice). */
  saveReport: (includeMeshes: boolean) => Promise<void>;
}

/** The report for the previous session, with the meshes only when asked. */
export async function crashReportFor(
  previous: PreviousSession,
  includeMeshes: boolean,
): Promise<CrashReport> {
  const facts = lastWorkFacts(previous);
  let meshes: { name: string; sha256: string; format: string; data: string }[] | undefined;
  if (includeMeshes && facts?.meshes !== undefined) {
    const loaded = await Promise.all(
      facts.meshes.map(async (m) => {
        const data = await getMeshBlob(m.sha256).catch(() => null);
        return data === null ? null : { name: m.name, sha256: m.sha256, format: m.format, data };
      }),
    );
    meshes = loaded.filter((m): m is { name: string; sha256: string; format: string; data: string } => m !== null);
  }
  return buildCrashReport(previous, {
    appVersion: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'unknown',
    commit: typeof __BUILD_COMMIT__ === 'string' ? __BUILD_COMMIT__ : null,
    desktop: BUILD_TARGET === 'desktop',
    includeJob: facts,
    ...(meshes === undefined ? {} : { meshes }),
  });
}

export const useFlightRecorderStore = create<FlightRecorderStoreState>()((set, get) => ({
  previous: null,
  moment: null,
  houseOk: false,
  dismissed: false,
  started: false,
  saved: null,
  saving: false,
  error: null,

  init: async () => {
    if (get().started) return;
    set({ started: true });
    try {
      const previous = await startFlightRecorder({
        appVersion: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'unknown',
        commit: typeof __BUILD_COMMIT__ === 'string' ? __BUILD_COMMIT__ : null,
      });
      if (previous !== null) {
        set({ previous, moment: crashMoment(previous) });
        // The send half is offered only where a house service answered — and only when there is a
        // report to send. A web build with no service simply never shows the button.
        const probe = await probeIO();
        if (probe.kind === 'present') set({ houseOk: true });
      }
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  dismiss: () => set({ dismissed: true }),

  saveReport: async (includeMeshes) => {
    const previous = get().previous;
    if (previous === null || get().saving) return;
    set({ saving: true, error: null });
    try {
      const report = await crashReportFor(previous, includeMeshes);
      const filename = crashReportFileName(crashMoment(previous).stoppedAt);
      await saveIO.save(JSON.stringify(report, null, 2), filename);
      set({ saving: false, saved: filename });
    } catch (e) {
      set({ saving: false, error: e instanceof Error ? e.message : String(e) });
    }
  },
}));

/** Forget the store between specs (the recorder's own state has its own reset). */
export function __resetFlightRecorderStoreForTests(): void {
  saveIO = FILE_SAVE;
  useFlightRecorderStore.setState({
    previous: null,
    moment: null,
    houseOk: false,
    dismissed: false,
    started: false,
    saved: null,
    saving: false,
    error: null,
  });
}
