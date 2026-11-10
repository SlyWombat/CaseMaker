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
import { readDesktopCrashLog } from '@/platform/desktop/crashLog';
import { houseSendCrashReport, houseSendFailureWords, probeHouse, type CrashSend } from '@/platform/houseClient';
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

/** The desktop crash log — injectable so a spec does not reach the Tauri IPC. */
type CrashLogIO = () => Promise<string[]>;
const REAL_LOG: CrashLogIO = () => readDesktopCrashLog();
let logIO: CrashLogIO = REAL_LOG;
/** Spec seam: replace the desktop-log read. `null` restores the real one. */
export function setCrashLogIO(fn: CrashLogIO | null): void {
  logIO = fn ?? REAL_LOG;
}

/** Where a report is sent. Injectable so a spec does not make a network request. */
type CrashSendIO = (report: unknown) => Promise<CrashSend>;
const REAL_SEND: CrashSendIO = (report) => houseSendCrashReport(report);
let sendIO: CrashSendIO = REAL_SEND;
/** Spec seam: replace the house send. `null` restores the real one. */
export function setCrashSendIO(fn: CrashSendIO | null): void {
  sendIO = fn ?? REAL_SEND;
}

/** The house probe, injectable so a spec does not make a network request. */
type ProbeIO = () => Promise<{ kind: string }>;
const REAL_PROBE: ProbeIO = () => probeHouse();
let probeIO: ProbeIO = REAL_PROBE;
/** Spec seam: replace the house probe. `null` restores the real one. */
export function setCrashProbeIO(fn: ProbeIO | null): void {
  probeIO = fn ?? REAL_PROBE;
}

/**
 * #1187 — OFFERED ONCE. A report the operator sent or dismissed is remembered against the SESSION
 * it describes (the marker's id), so the next load does not offer it again: on 2026-11-10 a report
 * of the 11-09 crash was offered after an 11-10 Register stop and sent a second time, because
 * nothing outlived the load that had already dealt with it.
 */
export type ReportLedgerState = 'sent' | 'dismissed';
export interface ReportLedgerEntry {
  state: ReportLedgerState;
  /** When the operator dealt with it, ISO 8601. */
  at: string;
  /** Where it went, when it was sent: the house path the service answered with. */
  where?: string;
}
/** The ledger seam (localStorage by default), injectable so a spec runs without a browser. */
export interface ReportLedgerIO {
  read(): Record<string, ReportLedgerEntry>;
  write(entries: Record<string, ReportLedgerEntry>): void;
}
const LEDGER_KEY = 'casemaker.flight.reports.v1';
const REAL_LEDGER: ReportLedgerIO = {
  read() {
    try {
      if (typeof localStorage === 'undefined') return {};
      const raw = localStorage.getItem(LEDGER_KEY);
      if (raw === null) return {};
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, ReportLedgerEntry>) : {};
    } catch {
      return {};
    }
  },
  write(entries) {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(LEDGER_KEY, JSON.stringify(entries));
    } catch {
      // A recorder that cannot record must not break the app it watches (the recorder's own rule).
    }
  },
};
let ledgerIO: ReportLedgerIO = REAL_LEDGER;
/** Spec seam: replace the ledger store. `null` restores the real one. */
export function setReportLedgerIO(io: ReportLedgerIO | null): void {
  ledgerIO = io ?? REAL_LEDGER;
}

/** Whether this marker's report was already sent or dismissed, and how — null when it was not. */
export function reportAlreadyHandled(markerId: string): ReportLedgerEntry | null {
  return ledgerIO.read()[markerId] ?? null;
}

/** Deal with a marker's report once: remembered, so a later load does not offer it again. */
function markReportHandled(markerId: string, entry: ReportLedgerEntry): void {
  // A sent report stays sent: the banner's own leave-after-confirmation is not a second, weaker act.
  if (entry.state === 'dismissed' && ledgerIO.read()[markerId]?.state === 'sent') return;
  const all = ledgerIO.read();
  ledgerIO.write({ ...all, [markerId]: entry });
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
  /** Where the last Send stored the report on the house, or null. */
  sent: string | null;
  sending: boolean;
  /** Why the last Send failed, in the service's own words where it gave one. */
  sendError: string | null;
  error: string | null;
  init: () => Promise<void>;
  dismiss: () => void;
  /** Build and save the report. `includeMeshes` adds the job's mesh bytes (the operator's choice). */
  saveReport: (includeMeshes: boolean) => Promise<void>;
  /**
   * Build and SEND the report to the house service. Only ever called from the banner's Send, and
   * the button exists only where a house answered — nothing leaves the machine on its own.
   */
  sendReport: (includeMeshes: boolean) => Promise<void>;
}

/**
 * #890 — how long a saved or sent report's confirmation line stays before the banner puts itself
 * away. Long enough to read where the report went, short enough that it is not one more thing to
 * close: the banner has done its job the moment the report is on disk or at the house.
 */
export const CRASH_BANNER_CONFIRM_MS = 4_000;

/** The one pending dismissal (a save and a send cannot both be the last word). */
let dismissTimer: ReturnType<typeof setTimeout> | null = null;

/** #890 — hold the confirmation line for {@link CRASH_BANNER_CONFIRM_MS}, then dismiss. */
function dismissAfterConfirmation(): void {
  if (dismissTimer !== null) clearTimeout(dismissTimer);
  dismissTimer = setTimeout(() => {
    dismissTimer = null;
    // #1187 — the report was dealt with (saved or sent): the banner's own leaving is a dismissal
    // for the once-only ledger, so a later load does not offer the same session's report again.
    const previous = useFlightRecorderStore.getState().previous;
    if (previous !== null) markReportHandled(previous.marker.id, { state: 'dismissed', at: new Date().toISOString() });
    useFlightRecorderStore.setState({ dismissed: true });
  }, CRASH_BANNER_CONFIRM_MS);
}

function cancelPendingDismiss(): void {
  if (dismissTimer !== null) clearTimeout(dismissTimer);
  dismissTimer = null;
}

/** #1187 — the words moved to the house client so a stop report words the same failure the same way. */

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
  // #787 — on the desktop, WebView2's own ProcessFailed records ride along: the page's recorder
  // knows what it was doing, and this says why the renderer died when it did.
  const desktopLog = BUILD_TARGET === 'desktop' ? await logIO() : [];
  return buildCrashReport(previous, {
    appVersion: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'unknown',
    commit: typeof __BUILD_COMMIT__ === 'string' ? __BUILD_COMMIT__ : null,
    desktop: BUILD_TARGET === 'desktop',
    includeJob: facts,
    desktopLog,
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
  sent: null,
  sending: false,
  sendError: null,
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
        // #1187 — a report already sent or dismissed for this session is not offered again.
        if (reportAlreadyHandled(previous.marker.id) !== null) return;
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

  dismiss: () => {
    cancelPendingDismiss();
    // #1187 — dismissed once means dismissed: the next load does not raise the same report again.
    const previous = get().previous;
    if (previous !== null) markReportHandled(previous.marker.id, { state: 'dismissed', at: new Date().toISOString() });
    set({ dismissed: true });
  },

  saveReport: async (includeMeshes) => {
    const previous = get().previous;
    if (previous === null || get().saving) return;
    set({ saving: true, error: null });
    try {
      const report = await crashReportFor(previous, includeMeshes);
      const filename = crashReportFileName(crashMoment(previous).stoppedAt);
      await saveIO.save(JSON.stringify(report, null, 2), filename);
      set({ saving: false, saved: filename });
      // #890 — the report is written: the confirmation line shows, and then the banner leaves.
      dismissAfterConfirmation();
    } catch (e) {
      set({ saving: false, error: e instanceof Error ? e.message : String(e) });
    }
  },

  sendReport: async (includeMeshes) => {
    const previous = get().previous;
    if (previous === null || get().sending) return;
    set({ sending: true, sendError: null });
    try {
      const report = await crashReportFor(previous, includeMeshes);
      const answer = await sendIO(report);
      if (answer.kind === 'ok') {
        // #1187 — SENT IS SENT: remembered against the session it describes, so no later load
        // offers the same report for sending a second time.
        markReportHandled(previous.marker.id, { state: 'sent', at: new Date().toISOString(), where: answer.path });
        set({ sending: false, sent: answer.path });
        // #890 — the house has it: the confirmation line shows, and then the banner leaves.
        dismissAfterConfirmation();
      } else {
        set({ sending: false, sendError: houseSendFailureWords(answer) });
      }
    } catch (e) {
      set({ sending: false, sendError: e instanceof Error ? e.message : String(e) });
    }
  },
}));

/** Forget the store between specs (the recorder's own state has its own reset). */
export function __resetFlightRecorderStoreForTests(): void {
  saveIO = FILE_SAVE;
  ledgerIO = REAL_LEDGER;
  cancelPendingDismiss();
  useFlightRecorderStore.setState({
    previous: null,
    moment: null,
    houseOk: false,
    dismissed: false,
    started: false,
    saved: null,
    saving: false,
    sent: null,
    sending: false,
    sendError: null,
    error: null,
  });
}
