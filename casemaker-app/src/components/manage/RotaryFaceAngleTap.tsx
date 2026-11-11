/**
 * #1059 — "MEASURE THE FACE ANGLE": level a SQUARE stock in the 4th axis, from the Register step.
 *
 * `$H` leaves A's zero unmeasured (Rotary.md §9) and a square bar clamped by eye is not flat-up.
 * The vendor's own procedure is two probe touches on the top face at ±d either side of the axis;
 * the step turns A by the measured tilt and writes the levelled position as the A work zero
 * (`G10 L20 P0 A0`), so the job's A words need no offset afterwards.
 *
 * The row offers itself only where the whole step can actually run: a machine this build can
 * drive with a read frame, a measured probe checked out, the job in the chuck, SQUARE stock, and
 * the axis already measured. Every placement and every safety rule is `planFaceAngle`'s; this
 * component only collects the numbers it cannot know (the jaws' face X and the lever arm d).
 */

import { useState, type CSSProperties, type JSX } from 'react';
import { canReachMachine } from '@/platform/capabilities';
import { probeFor } from '@/engine/cnc/registration/mountContext';
import { registrationSettings } from '@/engine/cnc/registration/settings';
import { softLimitsOf } from '@/engine/cnc/registration/footprintJob';
import { jobMachine } from '@/engine/cnc/calibration';
import { clearanceZOf, machineFrameProblemById } from '@/engine/cnc/machine';
import { SAFE_Z } from '@/engine/cnc/cam/ir';
import { rotaryFreeSpan, rotaryMapOf } from '@/engine/cnc/rotary/wrap';
import { FACE_ANGLE_D_MM } from '@/engine/cnc/registration/faceAngle';
import { useMountTap, useMountTapBusyFlag } from '@/hooks/useMountTap';
import { useShopDefaultsStore } from '@/store/shopDefaultsStore';
import { useSettingsStore } from '@/store/settingsStore';
import type { MachineRecord } from '@/platform/locationClient';
import type { EngraveJob } from '@/types/engraveJob';

const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '4px 0' };
const OK = '#9fd19b';

const n = (v: number): string => String(Math.round(v * 1000) / 1000);

export interface RotaryFaceAngleTapProps {
  machine: MachineRecord;
  job: EngraveJob;
  testIdPrefix?: string;
}

export function RotaryFaceAngleTap({ machine, job, testIdPrefix = 'rotary-face-angle' }: RotaryFaceAngleTapProps): JSX.Element | null {
  const defaults = useShopDefaultsStore((s) => s.defaults);
  const calibration = useSettingsStore((s) => s.machineCalibration);
  const tapBusy = useMountTapBusyFlag();

  const target = machine.address;
  const probe = probeFor(machine);
  const frameProblem = machineFrameProblemById(machine.profileId);
  const profile = jobMachine({ machineId: machine.profileId ?? 'Z1' }, calibration);
  const settings = registrationSettings(defaults, probe).settings;
  const bedProfile = machine.bedProfiles?.find((p) => p.id === machine.activeBedProfileId) ?? null;
  const axisDatum = bedProfile?.datums.rotaryAxis ?? null;
  const map = rotaryMapOf(job);
  const seekZ = clearanceZOf(profile);

  const api = useMountTap({
    clearanceZ: seekZ ?? 0,
    target,
    settings,
    floor: profile.envelope.z.min,
    probeId: probe?.id ?? null,
    successNote: 'the face angle is recorded',
  });

  const [jawFaceX, setJawFaceX] = useState(String(axisDatum?.at?.[0] ?? -150));
  const [d, setD] = useState(String(FACE_ANGLE_D_MM));
  const [error, setError] = useState<string | null>(null);

  // The step is for SQUARE stock only, and only once the axis it measures against exists.
  if (map === null || map.section.kind !== 'rect') return null;
  if (frameProblem !== null || !canReachMachine || target === null || probe?.tip == null) return null;
  if (axisDatum === null) {
    return (
      <p style={MUTED} data-testid={`${testIdPrefix}-needs-axis`}>
        Measure the 4th axis first: the face angle is levelled against the axis line the tap measures.
      </p>
    );
  }

  const free = rotaryFreeSpan(map);

  function measure(): void {
    const faceX = Number(jawFaceX);
    const lever = Number(d);
    if (!Number.isFinite(faceX) || !Number.isFinite(lever)) {
      setError('the jaws’ face X and the lever arm must be numbers — they only place the touches');
      return;
    }
    setError(null);
    void api.tapFaceAngle({
      inputs: {
        axis: { axisY: axisDatum!.at?.[1] ?? 0, axisZ: axisDatum!.value },
        section: map!.section,
        jawFaceX: faceX,
        freeEndMm: free.to,
        probeRadiusMm: settings.tipRadiusMm,
        clearanceAboveStockMm: SAFE_Z,
        machineClearanceZ: seekZ,
        parkAboveSurfaceMm: settings.parkAboveSurfaceMm,
        bandAllowanceMm: settings.surfaceToleranceMm + 1,
        softLimits: softLimitsOf(calibration),
        maxDeg: settings.faceAngleMaxDeg,
      },
      touchFeed: settings.touchFeed,
    });
  }

  return (
    <div data-testid={testIdPrefix} style={{ marginTop: 6 }}>
      <p style={{ fontSize: 12, fontWeight: 600, color: '#c8d3de', margin: '6px 0 0' }}>Measure the face angle</p>
      <p style={MUTED}>
        Two touches either side of the axis level the stock; A turns by the measured tilt and the levelled position becomes its zero. The
        head lifts clear of the corners before every turn, and a tilt past {n(settings.faceAngleMaxDeg)}° is refused, not turned.
      </p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ fontSize: 11, color: '#c8d3de' }}>
          Jaws’ face at X{' '}
          <input
            type="number"
            data-testid={`${testIdPrefix}-x`}
            value={jawFaceX}
            disabled={tapBusy}
            style={{ width: 64 }}
            onChange={(e) => setJawFaceX(e.target.value)}
          />{' '}
          mm
        </label>
        <label style={{ fontSize: 11, color: '#c8d3de' }}>
          Lever ±{' '}
          <input type="number" data-testid={`${testIdPrefix}-d`} value={d} disabled={tapBusy} style={{ width: 56 }} onChange={(e) => setD(e.target.value)} /> mm
        </label>
      </div>
      <button type="button" className="btn btn--sm" data-testid={`${testIdPrefix}-measure`} disabled={tapBusy} onClick={measure} style={{ marginTop: 6 }}>
        Measure the face angle
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
      {error !== null && <p style={{ ...MUTED, color: '#e0a0a0' }} data-testid={`${testIdPrefix}-error`}>{error}</p>}
      {api.faceAngle !== null && (
        <p style={{ ...MUTED, color: OK }} data-testid={`${testIdPrefix}-reading`}>
          Levelled in {api.faceAngle.passes} {api.faceAngle.passes === 1 ? 'pair' : 'pairs'}: {n(api.faceAngle.thetaDeg)}° of turn, {n(api.faceAngle.residualMm)} mm
          residual.
        </p>
      )}
      {api.note !== null && <p style={MUTED} data-testid={`${testIdPrefix}-note`}>{api.note}</p>}
    </div>
  );
}
