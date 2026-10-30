/**
 * #787 — the banner a previous, uncleanly-ended session leaves behind.
 *
 * Shown at load only when the flight recorder found its session marker still set: the last load
 * did not exit cleanly (a crash, an OOM kill, a power loss). It says WHEN it stopped, what it was
 * doing and how big the heap was at the end, and offers the one action that matters: save a crash
 * report. Nothing is written or sent until a button is pressed.
 */

import { useState } from 'react';
import { useFlightRecorderStore } from '@/store/flightRecorderStore';
import type { CrashMoment } from '@/platform/flightRecorder';

const WORK_WORDS: Record<string, string> = {
  generate: 'generating',
  simulate: 'simulating',
  'smart-pick': 'measuring cutters',
  preview: 'drawing the preview',
  import: 'importing a model',
};

function clockWords(at: number | null): string | null {
  if (at === null) return null;
  const d = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function heapWords(mb: number | null): string | null {
  if (mb === null) return null;
  return mb >= 1024 ? `heap ${(mb / 1024).toFixed(1)} GB` : `heap ${Math.round(mb)} MB`;
}

/** The banner's sentence, from what the recorder left. Exported so its words are testable. */
export function crashBannerSentence(moment: CrashMoment): string {
  const at = clockWords(moment.stoppedAt);
  const doing = moment.work === null ? null : (WORK_WORDS[moment.work] ?? moment.work);
  const facts = [moment.label, heapWords(moment.heapMb)].filter((w): w is string => w !== null);
  const when = at === null ? 'Case Maker stopped unexpectedly' : `Case Maker stopped unexpectedly at ${at}`;
  const whileDoing = doing === null ? '' : ` while ${doing}`;
  const detail = facts.length === 0 ? '' : ` (${facts.join(', ')})`;
  return `${when}${whileDoing}${detail}. Save a crash report?`;
}

export function CrashRecoveryBanner() {
  const previous = useFlightRecorderStore((s) => s.previous);
  const moment = useFlightRecorderStore((s) => s.moment);
  const dismissed = useFlightRecorderStore((s) => s.dismissed);
  const saving = useFlightRecorderStore((s) => s.saving);
  const saved = useFlightRecorderStore((s) => s.saved);
  const houseOk = useFlightRecorderStore((s) => s.houseOk);
  const sending = useFlightRecorderStore((s) => s.sending);
  const sent = useFlightRecorderStore((s) => s.sent);
  const sendError = useFlightRecorderStore((s) => s.sendError);
  const error = useFlightRecorderStore((s) => s.error);
  const saveReport = useFlightRecorderStore((s) => s.saveReport);
  const sendReport = useFlightRecorderStore((s) => s.sendReport);
  const dismiss = useFlightRecorderStore((s) => s.dismiss);
  const [includeMeshes, setIncludeMeshes] = useState(false);

  if (previous === null || moment === null || dismissed) return null;

  return (
    <div
      data-testid="crash-banner"
      role="alert"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 8,
        margin: '6px 10px',
        padding: '8px 10px',
        border: '1px solid #6b4a33',
        borderRadius: 4,
        background: '#2a2119',
        color: '#e8d9c8',
        fontSize: 12,
        lineHeight: 1.45,
      }}
    >
      <span data-testid="crash-banner-sentence" style={{ flex: '1 1 320px' }}>
        {crashBannerSentence(moment)}
      </span>
      <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <input
          type="checkbox"
          data-testid="crash-include-meshes"
          checked={includeMeshes}
          onChange={(e) => setIncludeMeshes(e.target.checked)}
        />
        include the job’s models
      </label>
      <button type="button" data-testid="crash-save" disabled={saving} onClick={() => void saveReport(includeMeshes)}>
        {saving ? 'Saving…' : 'Save report'}
      </button>
      {/* #787 — the send half exists only where a house service answered. A web build never sees
          this button, and nothing is sent except on the press. */}
      {houseOk && (
        <button type="button" data-testid="crash-send" disabled={sending} onClick={() => void sendReport(includeMeshes)}>
          {sending ? 'Sending…' : 'Send to the house'}
        </button>
      )}
      <button type="button" data-testid="crash-dismiss" onClick={dismiss}>
        Dismiss
      </button>
      {saved !== null && (
        <span data-testid="crash-saved" style={{ color: '#b8d8a8' }}>
          Saved {saved}
        </span>
      )}
      {error !== null && (
        <span data-testid="crash-error" style={{ color: '#f0b4ad' }}>
          The report was not saved: {error}
        </span>
      )}
      {sent !== null && (
        <span data-testid="crash-sent" style={{ color: '#b8d8a8' }}>
          Sent to the house: {sent}
        </span>
      )}
      {sendError !== null && (
        <span data-testid="crash-send-error" style={{ color: '#f0b4ad' }}>
          The report was not sent — {sendError}
        </span>
      )}
    </div>
  );
}
