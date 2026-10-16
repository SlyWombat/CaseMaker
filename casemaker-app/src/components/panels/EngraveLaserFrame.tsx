import { useState, type CSSProperties, type JSX } from 'react';
import { runLaserFrame, type XYBounds } from '@/platform/machineLaser';

/**
 * #431 — "Frame with laser": trace the program's XY extent with the probe's laser before cutting.
 *
 * A user option, OFF by default (maintainer decision Q21): it renders only when the setting is on.
 * It moves the head, so it is armed by one tick naming the two things only the person can see — the
 * 3D probe is in the spindle (the laser lives in the probe) and they are at the machine.
 */

const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '4px 0' };

export function EngraveLaserFrame({
  host,
  port,
  bounds,
}: {
  host: string;
  port: number;
  bounds: XYBounds | null;
}): JSX.Element {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function frame(): Promise<void> {
    if (bounds === null || busy) return;
    setBusy(true);
    setNote('Framing — the head lifts, the laser comes on and traces the job, then it homes…');
    const r = await runLaserFrame({ host, port }, bounds);
    setNote(
      r.kind === 'framed'
        ? r.homed
          ? 'Framed. The laser is off and the machine is homed.'
          : 'Framed and the laser is off, but the home was not answered — home it before the next step.'
        : r.kind === 'failed'
          ? `${r.detail}${r.laserOff ? ' The laser is off.' : ' The laser may still be on — send M832 or switch it off at the machine.'}`
          : r.detail,
    );
    setArmed(false);
    setBusy(false);
  }

  return (
    <div data-testid="engrave-laser-frame" style={{ marginTop: 8 }}>
      <label style={{ ...MUTED, display: 'flex', gap: 6, alignItems: 'center' }}>
        <input
          type="checkbox"
          data-testid="engrave-laser-frame-arm"
          checked={armed}
          disabled={busy || bounds === null}
          onChange={(e) => setArmed(e.target.checked)}
        />
        The 3D probe is in the spindle, and I am at the machine
      </label>
      <button
        type="button"
        data-testid="engrave-laser-frame-run"
        disabled={!armed || busy || bounds === null}
        title="Lift, switch the probe laser on (M831), trace the program's outline, laser off (M832), home"
        style={{ width: '100%', padding: 7, marginTop: 4 }}
        onClick={() => void frame()}
      >
        {busy ? 'Framing…' : 'Frame with laser'}
      </button>
      {bounds === null && (
        <p style={MUTED} data-testid="engrave-laser-frame-none">
          The program has no moves to frame.
        </p>
      )}
      {note !== null && (
        <p style={MUTED} data-testid="engrave-laser-frame-note">
          {note}
        </p>
      )}
    </div>
  );
}
