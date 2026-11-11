/**
 * #1187 — a stopped machine action's report, and the one press that sends it.
 *
 * The document is built by `platform/machineStopReport.ts` (pure); this store is the surface's half:
 * it holds the press's outcome and does the ONE thing the operator asked for. Nothing is written or
 * sent without the press — no app path calls `send` on its own, and the report leaves for the house
 * service exactly as the crash banner's Send does (the same route, a different `kind`).
 */

import { create } from 'zustand';
import { BUILD_TARGET } from '@/platform/capabilities';
import { houseSendCrashReport, houseSendFailureWords, type CrashSend } from '@/platform/houseClient';
import { buildMachineStopReport, type MachineStopReportInput } from '@/platform/machineStopReport';

/** Where a stop report is sent. Injectable so a spec does not make a network request. */
type StopSendIO = (report: unknown) => Promise<CrashSend>;
const REAL_SEND: StopSendIO = (report) => houseSendCrashReport(report);
let sendIO: StopSendIO = REAL_SEND;
/** Spec seam: replace the house send. `null` restores the real one. */
export function setStopReportSendIO(fn: StopSendIO | null): void {
  sendIO = fn ?? REAL_SEND;
}

export interface MachineStopReportState {
  sending: boolean;
  /** Where the house stored it, or null. */
  sent: string | null;
  /** Why the send failed, in the service's own words where it gave one. */
  error: string | null;
  /** Build the report from THIS action's facts and send it. Only the operator's press calls this. */
  send: (input: MachineStopReportInput) => Promise<void>;
  /** Forget the last press's outcome, so another stop's card starts clean. */
  reset: () => void;
}

export const useMachineStopReportStore = create<MachineStopReportState>()((set, get) => ({
  sending: false,
  sent: null,
  error: null,

  send: async (input) => {
    if (get().sending) return;
    set({ sending: true, error: null, sent: null });
    try {
      const report = buildMachineStopReport(input, {
        version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'unknown',
        commit: typeof __BUILD_COMMIT__ === 'string' ? __BUILD_COMMIT__ : null,
        desktop: BUILD_TARGET === 'desktop',
      });
      const answer = await sendIO(report);
      if (answer.kind === 'ok') set({ sending: false, sent: answer.path });
      else set({ sending: false, error: houseSendFailureWords(answer) });
    } catch (e) {
      set({ sending: false, error: e instanceof Error ? e.message : String(e) });
    }
  },

  reset: () => set({ sending: false, sent: null, error: null }),
}));

/** Forget the store between specs. */
export function __resetMachineStopReportStoreForTests(): void {
  sendIO = REAL_SEND;
  useMachineStopReportStore.setState({ sending: false, sent: null, error: null });
}
