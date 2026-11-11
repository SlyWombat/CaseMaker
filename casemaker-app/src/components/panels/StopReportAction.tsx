/**
 * #1187 — "SEND A REPORT OF THIS STOP": the secondary action a STOPPED machine action carries.
 *
 * It appears only on a stop the app read as a transport or controller error (`stopIsReportable`),
 * never on a refusal of its own. The press builds the report from THIS action's facts — the session's
 * transcript, the error, the machine's last status line, the build and the job/package — and sends
 * it to the house. Nothing is sent without the press, and the card says where it went.
 */

import type { CSSProperties, JSX } from 'react';
import { useMachineStopReportStore } from '@/store/machineStopReportStore';
import type { StopActionKind, StopTranscriptEntry } from '@/platform/machineStopReport';
const LINK: CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  font: 'inherit',
  fontSize: 12,
  color: '#8ab4f8',
  textDecoration: 'underline',
  cursor: 'pointer',
};

export interface StopReportActionProps {
  action: StopActionKind;
  target: { host: string; port: number };
  /** The stopped action's own failure sentence. */
  error: string;
  transcript: readonly StopTranscriptEntry[];
  /**
   * #1208 — status exchanges a run's ring dropped before its transcript's first entry, so the
   * report never presents a tail as the whole conversation. Absent (or 0) when it has them all.
   */
  droppedStatusPolls?: number;
  job: { id: string; name: string; packageHash: string | null } | null;
}

export function StopReportAction({
  action,
  target,
  error,
  transcript,
  droppedStatusPolls,
  job,
}: StopReportActionProps): JSX.Element {
  const sending = useMachineStopReportStore((s) => s.sending);
  const sent = useMachineStopReportStore((s) => s.sent);
  const sendError = useMachineStopReportStore((s) => s.error);
  const send = useMachineStopReportStore((s) => s.send);
  return (
    <div data-testid="stop-report-action" data-action={action} style={{ marginTop: 6 }}>
      {sent === null && (
        <button
          type="button"
          data-testid="stop-report-send"
          style={LINK}
          disabled={sending}
          onClick={() => void send({ action, target, error, transcript, droppedStatusPolls, job })}
        >
          {sending ? 'Sending…' : 'Send a report of this stop'}
        </button>
      )}
      {sent !== null && (
        <p style={{ fontSize: 11, color: '#b8d8a8', margin: 0 }} data-testid="stop-report-sent">
          Sent the report of this stop to the house: {sent}
        </p>
      )}
      {sendError !== null && (
        <p style={{ fontSize: 11, color: '#f0b4ad', margin: 0 }} data-testid="stop-report-error">
          The report was not sent — {sendError}
        </p>
      )}
    </div>
  );
}
