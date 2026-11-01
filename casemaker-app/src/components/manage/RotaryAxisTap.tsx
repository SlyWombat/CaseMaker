/**
 * #607 — "MEASURE THE AXIS": the 4th-axis module's reference tap, from the app.
 *
 * The module's card in Manage › Machines and the Register step of a chuck job both offer it. The
 * operator gives the record's NOMINAL axis (the shipped or last-measured Z, the axis-line Y, the
 * chuck body's radius, and the tap's X along the chuck); the 3D probe then measures the truth with
 * one chord pair and the crown (the shared tap hook's `tapAxis`, over `runRotaryTap`), the measured
 * axis Y, Z and radius are shown beside the check chord's residual, and the reading is written to
 * the active bed profile's `rotaryAxis` datum. The nominal values only place the touches — the
 * datum is the measurement.
 */

import { useState, type CSSProperties, type JSX } from 'react';
import { canReachMachine } from '@/platform/capabilities';
import { probeFor } from '@/engine/cnc/registration/mountContext';
import { registrationSettings } from '@/engine/cnc/registration/settings';
import { jobMachine } from '@/engine/cnc/calibration';
import { machineFrameProblemById } from '@/engine/cnc/machine';
import { useMountTap, useMountTapBusyFlag } from '@/hooks/useMountTap';
import { useShopDefaultsStore } from '@/store/shopDefaultsStore';
import { useSettingsStore } from '@/store/settingsStore';
import type { MachineRecord } from '@/platform/locationClient';

const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '4px 0' };
const OK = '#9fd19b';

const n = (v: number): string => String(Math.round(v * 1000) / 1000);

/**
 * The margin the trial chord keeps above the measured bed surface, mm — the probe body beside the
 * chuck must clear the bed and the headstock (`planRotaryTrial` refuses under the clearance).
 */
export const ROTARY_BED_MARGIN_MM = 12;

export interface RotaryAxisTapProps {
  machine: MachineRecord;
  testIdPrefix?: string;
}

/** #607 — the module's axis-measuring row, shared by the accessory card and the Register step. */
export function RotaryAxisTap({ machine, testIdPrefix = 'rotary-tap' }: RotaryAxisTapProps): JSX.Element | null {
  const defaults = useShopDefaultsStore((s) => s.defaults);
  const calibration = useSettingsStore((s) => s.machineCalibration);
  const tapBusy = useMountTapBusyFlag();

  const target = machine.address;
  const probe = probeFor(machine);
  const frameProblem = machineFrameProblemById(machine.profileId);
  const profile = jobMachine({ machineId: machine.profileId ?? 'Z1' }, calibration);
  const bedProfile = machine.bedProfiles?.find((p) => p.id === machine.activeBedProfileId) ?? null;
  const datum = bedProfile?.datums.rotaryAxis ?? null;
  const surfaceTop = bedProfile?.datums.surfaceTopZ ?? null;

  const api = useMountTap({
    target,
    settings: registrationSettings(defaults, probe).settings,
    floor: profile.envelope.z.min,
    probeId: probe?.id ?? null,
    successNote: 'the axis is recorded',
  });

  const [atX, setAtX] = useState(String(datum?.at?.[0] ?? -150));
  const [axisZ, setAxisZ] = useState(String(datum?.value ?? -50));
  const [axisY, setAxisY] = useState(String(datum?.at?.[1] ?? -180));
  const [radius, setRadius] = useState(String(datum?.radiusMm ?? 40));
  const [error, setError] = useState<string | null>(null);

  // The numbers only place the touches; a non-number is a mistake to name, not to run with.
  const nominal = { x: Number(atX), axisZ: Number(axisZ), axisY: Number(axisY), radiusMm: Number(radius) };

  function measure(): void {
    const allNumbers = [nominal.x, nominal.axisZ, nominal.axisY, nominal.radiusMm].every((v) => Number.isFinite(v));
    if (!allNumbers) {
      setError('the tap’s X, the nominal axis Z and Y and the body radius must be numbers — they only place the touches');
      return;
    }
    if (surfaceTop === null) {
      setError('the bed’s surface has not been measured — the trial chord needs a floor');
      return;
    }
    setError(null);
    const bedClearanceZ = surfaceTop.value + ROTARY_BED_MARGIN_MM;
    void api.tapAxis({
      atX: nominal.x,
      nominal: { axisZ: nominal.axisZ, axisY: nominal.axisY, radiusMm: nominal.radiusMm },
      bedClearanceZ,
      seekFromMachineZ: profile.toolChange.clearanceZ,
      crownBand: {
        min: Math.max(nominal.axisZ - 5, bedClearanceZ),
        max: nominal.axisZ + nominal.radiusMm + 10,
      },
    });
  }

  // Offered only where this build can drive a machine, the machine has an address and a read
  // controller frame, and a measured probe is checked out to it.
  if (frameProblem !== null || !canReachMachine || target === null || probe?.tip == null) return null;

  return (
    <div data-testid={testIdPrefix}>
      <p style={{ fontSize: 12, fontWeight: 600, color: '#c8d3de', margin: '6px 0 0' }}>Measure the 4th axis</p>
      <p style={MUTED}>
        One chord pair on the chuck body and its crown measure the axis. The nominal values only place the touches; the reading is
        the datum.
      </p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ fontSize: 11, color: '#c8d3de' }}>
          Chuck at X{' '}
          <input type="number" data-testid={`${testIdPrefix}-x`} value={atX} disabled={tapBusy} style={{ width: 64 }} onChange={(e) => setAtX(e.target.value)} /> mm
        </label>
        <label style={{ fontSize: 11, color: '#c8d3de' }}>
          nominal Z{' '}
          <input type="number" data-testid={`${testIdPrefix}-z`} value={axisZ} disabled={tapBusy} style={{ width: 64 }} onChange={(e) => setAxisZ(e.target.value)} /> mm
        </label>
        <label style={{ fontSize: 11, color: '#c8d3de' }}>
          Y{' '}
          <input type="number" data-testid={`${testIdPrefix}-y`} value={axisY} disabled={tapBusy} style={{ width: 64 }} onChange={(e) => setAxisY(e.target.value)} /> mm
        </label>
        <label style={{ fontSize: 11, color: '#c8d3de' }}>
          R{' '}
          <input type="number" data-testid={`${testIdPrefix}-r`} value={radius} disabled={tapBusy} style={{ width: 56 }} onChange={(e) => setRadius(e.target.value)} /> mm
        </label>
      </div>
      <button
        type="button"
        className="btn btn--sm"
        data-testid={`${testIdPrefix}-measure`}
        disabled={tapBusy}
        style={{ marginTop: 6 }}
        onClick={measure}
      >
        Measure the axis
      </button>
      {api.prompt !== null && (
        <p className="hint" data-testid={`${testIdPrefix}-prompt`}>
          {api.prompt.text}{' '}
          <button type="button" className="btn btn--sm" data-testid={`${testIdPrefix}-continue`} onClick={() => api.resolve(true)}>
            Continue
          </button>
          <button type="button" className="btn btn--sm" data-testid={`${testIdPrefix}-cancel`} onClick={() => api.resolve(false)}>
            Cancel
          </button>
        </p>
      )}
      {error !== null && (
        <p className="hint" data-testid={`${testIdPrefix}-error`} style={{ color: '#f0b4ad' }}>
          {error}
        </p>
      )}
      {api.axis !== null && (
        <div data-testid={`${testIdPrefix}-result`}>
          <p className="hint" data-testid={`${testIdPrefix}-measured`}>
            The axis — Y {n(api.axis.axisY)}, Z {n(api.axis.axisZ)}, R {n(api.axis.radiusMm)} mm
          </p>
          <p className="hint" data-testid={`${testIdPrefix}-residual`}>
            {api.axis.residualLine ?? `The check chord matches the fitted circle (residual ${n(api.axis.residualMm)} mm).`}
          </p>
        </div>
      )}
      {api.note !== null && (
        <p className="hint" data-testid={`${testIdPrefix}-note`} style={{ color: OK }}>
          {api.note}
        </p>
      )}
    </div>
  );
}
