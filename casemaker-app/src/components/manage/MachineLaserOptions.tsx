/**
 * #431 — the probe laser's two user options, on the machine card. Both OFF by default (maintainer
 * decision Q21): the job does not ask for more interaction unless the user turns them on.
 * Point-to-origin's control is in the job's upload panel (#431 slice 2). A session that ended without a
 * home (the panel closed, or a step failed) is shown here too, with Home as a button — never sent unasked.
 */

import { useState } from 'react';
import { useSettingsStore } from '@/store/settingsStore';
import { useLaserHomeStore } from '@/store/laserHomeStore';

export function MachineLaserOptions() {
  const options = useSettingsStore((s) => s.laserOptions);
  const setOptions = useSettingsStore((s) => s.setLaserOptions);
  const pending = useLaserHomeStore((s) => s.pending);
  const home = useLaserHomeStore((s) => s.home);
  const [note, setNote] = useState<string | null>(null);
  return (
    <div className="mlaser" data-testid="manage-laser-options">
      {Object.entries(pending).map(([k, p]) => (
        <div key={k} data-testid="manage-laser-home-owed" className="hint">
          Home the machine at {p.host} before the next step — {p.why}.{' '}
          <button type="button" className="btn btn--sm" data-testid="manage-laser-home" onClick={() => void home(p).then((r) => setNote(r.detail))}>
            Home ($H)
          </button>
        </div>
      ))}
      {note !== null && <p className="hint">{note}</p>}
      <span className="mvacuum-label">Probe laser</span>
      <label className="hint" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input
          type="checkbox"
          data-testid="manage-laser-frame"
          checked={options.frame}
          onChange={(e) => setOptions({ ...options, frame: e.target.checked })}
        />
        Offer &ldquo;Frame with laser&rdquo; before a cut (traces the job&rsquo;s outline with the probe&rsquo;s red dot)
      </label>
      <label className="hint" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input
          type="checkbox"
          data-testid="manage-laser-point-origin"
          checked={options.pointToOrigin}
          onChange={(e) => setOptions({ ...options, pointToOrigin: e.target.checked })}
        />
        Offer laser point-to-origin (±1 mm, chosen — in the job's upload panel)
      </label>
    </div>
  );
}
