/**
 * #528 — the dock band under the viewport: what the machine said, in one place, out of the rail.
 *
 * THIS SLICE is the Transcript tab only. The three transcripts that used to render inside the Cut
 * rail (`engrave-registration-transcript`, `engrave-run-lines`, `engrave-release-notes`) move here,
 * newest last, monospace, content unchanged — the text is written into `machineTranscriptStore` by
 * the rail components exactly as their old `<pre>` rendered it, and this component drops it into a
 * `<pre>` untouched. Later tabs (Touches, Camera — #519 items 1 and 4) land on the same tab bar.
 *
 * The dock self-gates to null until there is transcript content (a bare viewport renders nothing),
 * and collapses to its tab bar when nothing is live (§5): it opens itself while a run is going and
 * the operator can pin the Transcript open afterwards with a click on the tab.
 */

import { useState, type CSSProperties, type JSX } from 'react';
import { useMachineTranscriptStore } from '@/store/machineTranscriptStore';
import { useMachineRunStore } from '@/store/machineRunStore';
import { useEngraveReleaseStore } from '@/store/engraveReleaseStore';

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
  border: '1px solid #2a2f36',
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
  const [open, setOpen] = useState(false);

  const hasContent = registration !== null || runLines !== null || releaseNotes !== null;
  if (!hasContent) return null;

  // §5 — the dock opens itself while a run is going and collapses to its tab bar when nothing is
  // live; a click on the Transcript tab pins it open afterwards.
  const expanded = anyRunRunning || releaseLive || open;

  return (
    <div data-testid="machine-dock" style={DOCK}>
      <div role="tablist" aria-label="Machine dock" style={TAB_BAR}>
        <button
          type="button"
          role="tab"
          aria-selected="true"
          data-testid="machine-dock-transcript"
          style={expanded ? TAB_ACTIVE : TAB}
          onClick={() => setOpen((v) => !v)}
        >
          Transcript
        </button>
        {/* Later tabs (Touches, Camera) land on this bar — #519 items 1 and 4. */}
      </div>
      {expanded && (
        <div style={BODY}>
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
        </div>
      )}
    </div>
  );
}
