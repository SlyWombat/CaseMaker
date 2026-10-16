/**
 * #431 — the probe laser's two user options, on the machine card. Both OFF by default (maintainer
 * decision Q21): the job does not ask for more interaction unless the user turns them on.
 * Point-to-origin is stored but has no control in the job yet (a later slice of #431).
 */

import { useSettingsStore } from '@/store/settingsStore';

export function MachineLaserOptions() {
  const options = useSettingsStore((s) => s.laserOptions);
  const setOptions = useSettingsStore((s) => s.setLaserOptions);
  return (
    <div className="mlaser" data-testid="manage-laser-options">
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
        Offer laser point-to-origin (±1 mm, chosen — not yet in the job)
      </label>
    </div>
  );
}
