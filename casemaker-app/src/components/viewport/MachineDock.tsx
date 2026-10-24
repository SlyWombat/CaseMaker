/**
 * #528 — the dock band under the viewport: what the machine said, in one place, out of the rail.
 *
 * #519 item 1 adds the TOUCHES tab: one row per probe reading as the registration runner lands it
 * (`registrationTouchesStore`, fed by `ExecDeps.onTouch`), then the spread sentence. The rail's
 * `engrave-registration-touches` block (surface line and the per-scan readings) moved here whole;
 * its testids travelled with the elements.
 *
 * The Transcript tab carries the three transcripts that used to render inside the Cut rail
 * (`engrave-registration-transcript`, `engrave-run-lines`, `engrave-release-notes`), newest last,
 * monospace, content unchanged.
 *
 * The dock self-gates to null until there is content (a bare viewport renders nothing), and
 * collapses to its tab bar when nothing is live (§5): it opens itself while a run or a registration
 * is going, defaulting to the tab that run is about, and the operator can pin it open with a click.
 */

import { useState, type CSSProperties, type JSX } from 'react';
import { useMachineTranscriptStore } from '@/store/machineTranscriptStore';
import { useMachineRunStore } from '@/store/machineRunStore';
import { useEngraveReleaseStore } from '@/store/engraveReleaseStore';
import { useMachineStore } from '@/store/machineStore';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { useRegistrationTouchesStore } from '@/store/registrationTouchesStore';
import { touchVerdict, type LiveTouch } from '@/engine/cnc/registration/liveTouch';
import { TOUCH_VERDICT_COLORS, TOUCH_VERDICT_WORDS } from './touchPalette';

const DOCK: CSSProperties = {
  background: 'rgba(17,23,36,.97)',
  borderTop: '1px solid #2a2f36',
  display: 'flex',
  flexDirection: 'column',
  padding: '4px 8px 8px',
  maxHeight: 220,
};

const TAB_BAR: CSSProperties = { display: 'flex', gap: 4, alignItems: 'center' };

const TAB: CSSProperties = {
  background: '#1a1f25',
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: '#2a2f36',
  color: '#d1d5db',
  borderRadius: 4,
  fontSize: 11,
  padding: '3px 10px',
  cursor: 'pointer',
};

const TAB_ACTIVE: CSSProperties = { ...TAB, background: '#243042', borderColor: '#3a5a7a', color: '#cfe' };

const BODY: CSSProperties = { overflow: 'auto', marginTop: 4 };

const MONO: CSSProperties = {
  fontSize: 10,
  fontFamily: 'monospace',
  whiteSpace: 'pre',
  overflow: 'auto',
  margin: '4px 0',
  color: '#c8d3de',
  maxHeight: 160,
};

const TABLE: CSSProperties = {
  borderCollapse: 'collapse',
  fontSize: 10,
  fontFamily: 'monospace',
  color: '#c8d3de',
};

const CELL: CSSProperties = { padding: '0 10px 0 0', whiteSpace: 'nowrap', verticalAlign: 'top' };

const TABLE_NOTE: CSSProperties = { fontSize: 11, color: '#9aa4b0', margin: '2px 0' };

/** The touched thing in the table's words — the executor's own label where it has one. */
function touchWhere(touch: LiveTouch): string {
  switch (touch.source) {
    case 'surface':
      return touch.label ?? 'the surface';
    case 'spread':
      return touch.label === null ? 'a cut extent' : `extent · ${touch.label}`;
    case 'edge':
      return touch.label ?? 'the edge';
    case 'mount-tap':
      return touch.label ?? 'the mount tap';
  }
}

/**
 * The transcripts the dock can show, keyed by the testid they keep from the rail. Order is the Cut
 * flow's own: register, then run, then release.
 */
export function MachineDock(): JSX.Element | null {
  const registration = useMachineTranscriptStore((s) => s.registration);
  const runLines = useMachineTranscriptStore((s) => s.runLines);
  const releaseNotes = useMachineTranscriptStore((s) => s.releaseNotes);
  const anyRunRunning = useMachineRunStore((s) => Object.values(s.runs).some((r) => r.running));
  const releaseLive = useEngraveReleaseStore((s) =>
    Object.values(s.records).some(
      (r) => r.phase === 'running' || r.phase === 'starting' || r.phase === 'retouch' || r.phase === 'closing',
    ),
  );
  // #519 items 1 and 3 — the live readings and whether a registration owns the machine.
  const registrationActive = useMachineStore((s) => s.registrationActive);
  const liveTouches = useRegistrationTouchesStore((s) => s.touches);
  const liveSpread = useRegistrationTouchesStore((s) => s.spreadSentence);
  const touchesJob = useRegistrationTouchesStore((s) => s.jobId);
  const jobId = useEngraveJobStore((s) => s.job.id);
  // A layer (and its sentence) left from another job is not this job's stock.
  const sameJob = touchesJob === null || touchesJob === jobId;
  const touches = sameJob ? liveTouches : [];
  const spreadSentence = sameJob ? liveSpread : null;
  /** Which tab the operator last chose; null = the default for what is running. */
  const [tab, setTab] = useState<'touches' | 'transcript' | null>(null);
  const [open, setOpen] = useState(false);

  const transcriptContent = registration !== null || runLines !== null || releaseNotes !== null;
  const hasContent = transcriptContent || touches.length > 0 || spreadSentence !== null;
  if (!hasContent) return null;

  // §5 — the dock opens itself while a run (or a registration) is going and collapses to its tab
  // bar when nothing is live; a click pins it open.
  const expanded = anyRunRunning || releaseLive || registrationActive || open;
  // §5 — Touches while a registration runs; otherwise the last tab used (or Transcript).
  const activeTab = tab ?? (registrationActive ? 'touches' : 'transcript');
  const firstSurface = touches.find((t) => t.source === 'surface')?.seq ?? null;

  return (
    <div data-testid="machine-dock" style={DOCK}>
      <div role="tablist" aria-label="Machine dock" style={TAB_BAR}>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'touches'}
          data-testid="machine-dock-touches"
          style={activeTab === 'touches' ? TAB_ACTIVE : TAB}
          onClick={() => {
            setTab('touches');
            setOpen(true);
          }}
        >
          Touches
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'transcript'}
          data-testid="machine-dock-transcript"
          style={activeTab === 'transcript' ? TAB_ACTIVE : TAB}
          onClick={() => {
            setTab('transcript');
            setOpen(true);
          }}
        >
          Transcript
        </button>
        {/* The Camera tab is #519 item 4 (#530) and lands on this bar. */}
      </div>
      {expanded && (
        <div style={BODY}>
          {activeTab === 'touches' && (
            <div data-testid="engrave-registration-touches">
              {touches.length === 0 ? (
                <p style={TABLE_NOTE}>No touches yet — the first reading appears here as it lands.</p>
              ) : (
                <table style={TABLE}>
                  <thead>
                    <tr style={{ color: '#9aa4b0' }}>
                      <th style={{ ...CELL, textAlign: 'left' }}>#</th>
                      <th style={{ ...CELL, textAlign: 'left' }}>scan</th>
                      <th style={{ ...CELL, textAlign: 'right' }}>X</th>
                      <th style={{ ...CELL, textAlign: 'right' }}>Y</th>
                      <th style={{ ...CELL, textAlign: 'right' }}>machine Z</th>
                      <th style={{ ...CELL, textAlign: 'left' }}>verdict</th>
                    </tr>
                  </thead>
                  <tbody>
                    {touches.map((touch) => {
                      const verdict = touchVerdict(touch);
                      return (
                        <tr
                          key={touch.seq}
                          // #519 item 1 — the surface row keeps the rail's testid; the rest are
                          // numbered in the order they landed (the per-scan block became rows).
                          data-testid={
                            touch.source === 'surface' && touch.seq === firstSurface
                              ? 'engrave-registration-surface'
                              : `engrave-registration-touch-${touch.seq}`
                          }
                          data-source={touch.source}
                          data-kind={touch.kind ?? ''}
                          data-verdict={verdict}
                        >
                          <td style={CELL}>{touch.seq}</td>
                          <td style={CELL}>{touchWhere(touch)}</td>
                          <td style={{ ...CELL, textAlign: 'right' }}>{touch.x.toFixed(2)}</td>
                          <td style={{ ...CELL, textAlign: 'right' }}>{touch.y.toFixed(2)}</td>
                          <td style={{ ...CELL, textAlign: 'right' }}>
                            {touch.touched ? touch.z.toFixed(3) : 'no touch'}
                          </td>
                          <td style={{ ...CELL, color: TOUCH_VERDICT_COLORS[verdict] }}>
                            {TOUCH_VERDICT_WORDS[verdict]}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
              {spreadSentence !== null && (
                <p data-testid="engrave-registration-spread-sentence" style={TABLE_NOTE}>
                  {spreadSentence}
                </p>
              )}
            </div>
          )}
          {activeTab === 'transcript' && (
            <>
              {registration !== null && (
                <pre data-testid="engrave-registration-transcript" style={MONO}>
                  {registration}
                </pre>
              )}
              {runLines !== null && (
                <pre data-testid="engrave-run-lines" style={MONO}>
                  {runLines}
                </pre>
              )}
              {releaseNotes !== null && (
                <pre data-testid="engrave-release-notes" style={MONO}>
                  {releaseNotes}
                </pre>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
