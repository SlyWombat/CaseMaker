/**
 * #1123 item 4 — THE LOG FOLD beside the progress line.
 *
 * The maintainer's bench note: an 11–12 minute Generate ran behind one changing line and
 * "Working…", with no way to see what it was doing. The run store keeps every stage tick
 * (`runLog.ts`); this fold is the window on it — closed by default so it never crowds the
 * Generate area, open to show clock time, duration and words for every tick, and still there
 * after the run so the operator can read where the time went.
 */
import type { JSX } from 'react';
import { formatRunLogEntry, type RunLogEntry } from '@/engine/cnc/engrave/runLog';

export function RunLogFold({ log }: { log: readonly RunLogEntry[] }): JSX.Element | null {
  if (log.length === 0) return null;
  return (
    <details
      data-testid="engrave-run-log"
      style={{ fontSize: 12, lineHeight: 1.45, color: '#9aa4b0', marginTop: 2 }}
    >
      <summary style={{ cursor: 'pointer' }}>Log ({log.length})</summary>
      <ol
        style={{
          margin: '4px 0 0',
          paddingLeft: 18,
          maxHeight: 180,
          overflowY: 'auto',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: 11,
        }}
      >
        {log.map((entry, i) => (
          <li key={i} data-testid="engrave-run-log-line">
            {formatRunLogEntry(entry)}
          </li>
        ))}
      </ol>
    </details>
  );
}
