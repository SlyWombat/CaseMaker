/**
 * #421 — the machine strip (§5.8): one switch per machine feature the job uses, each with its default
 * and the reason for it. Presentational: the switches come from the run plan (`engine/cnc/plan`), and
 * a press goes back to whoever owns the plan's overrides — the job flow (#419) mounts this.
 *
 * An unproven capability (the light, until #422's bench check) is NOT drawn. A locked one (auto-level,
 * until #176) is drawn, disabled, with the reason it is locked and what it would choose once proven.
 */

import { useId, type CSSProperties, type JSX } from 'react';
import type { FeatureKind, FeatureSwitch } from '@/engine/cnc/plan';

const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '2px 0 6px 22px' };

export interface MachineStripProps {
  features: readonly FeatureSwitch[];
  /** The operator switched a feature. Absent: the strip is read-only. */
  onToggle?: (feature: FeatureKind, on: boolean) => void;
}

export function MachineStrip({ features, onToggle }: MachineStripProps): JSX.Element {
  // Unique per strip, so two mounted strips never share a reason's id.
  const idBase = useId();
  return (
    <div data-testid="machine-strip">
      {features
        .filter((f) => f.shown)
        .map((f) => (
          <div key={f.feature} data-testid={`machine-strip-${f.feature}`} data-on={f.on ? 'true' : 'false'} data-overridden={f.overridden ? 'true' : 'false'}>
            <label style={{ fontSize: 12 }} title={f.commands}>
              <input
                type="checkbox"
                checked={f.on}
                disabled={!f.available || onToggle === undefined}
                aria-describedby={`${idBase}-${f.feature}-reason`}
                data-testid={`machine-strip-${f.feature}-switch`}
                onChange={(e) => onToggle?.(f.feature, e.target.checked)}
              />{' '}
              {f.label} — {f.on ? 'on' : 'off'}
              {f.overridden ? ` (default ${f.defaultOn ? 'on' : 'off'})` : ' (default)'}
              {!f.available ? ' · locked' : ''}
            </label>
            <p style={MUTED} id={`${idBase}-${f.feature}-reason`} data-testid={`machine-strip-${f.feature}-reason`}>
              {f.reason}
              {f.note !== null ? ` ${f.note}` : ''}
            </p>
          </div>
        ))}
    </div>
  );
}
