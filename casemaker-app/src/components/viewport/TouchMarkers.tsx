/**
 * #519 item 1 — the registration's touches as a viewport layer: one dot at each reading's X Y on the
 * stock, coloured by verdict, with its machine-Z reading beside it (design §6 "Touches").
 *
 * Fed by `registrationTouchesStore`, which the runner fills AS EACH TOUCH LANDS (#519 item 1), so
 * the dots appear during the run and stay afterwards as a layer — the spread the sheet reports can
 * be seen. The dots sit on the stock's top face (work Z = 0): the touch's XY is the fact, and its Z
 * is printed, not used to place the dot (a miss is drawn where it was aimed).
 *
 * The colours come from `touchPalette`, the SAME constants the legends' swatches use — a toggle is
 * the legend, so the dot and its swatch cannot drift apart (#553).
 */

import type { JSX } from 'react';
import { Html } from '@react-three/drei';
import { touchVerdict } from '@/engine/cnc/registration/liveTouch';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { useRegistrationTouchesStore } from '@/store/registrationTouchesStore';
import { TOUCH_VERDICT_COLORS } from './touchPalette';

const DOT_RADIUS_MM = 0.45;
/** Just off the top face, so the dot is not z-fighting with the stock it marks. */
const DOT_LIFT_MM = 0.06;

const LABEL = {
  fontSize: 9,
  fontFamily: 'monospace',
  color: '#e6edf5',
  background: 'rgba(15,20,28,.82)',
  border: '1px solid rgba(120,140,160,.45)',
  borderRadius: 3,
  padding: '1px 4px',
  whiteSpace: 'nowrap' as const,
  pointerEvents: 'none' as const,
};

export function TouchMarkers(): JSX.Element | null {
  const touches = useRegistrationTouchesStore((s) => s.touches);
  const touchesJob = useRegistrationTouchesStore((s) => s.jobId);
  const jobId = useEngraveJobStore((s) => s.job.id);
  // A layer from another job is not this job's stock: never draw it as though it were.
  if (touches.length === 0 || (touchesJob !== null && touchesJob !== jobId)) return null;
  return (
    <group name="machine-touches">
      {touches.map((touch) => {
        const verdict = touchVerdict(touch);
        // A bisection lands several touches within a tenth of a millimetre of each other, so the
        // labels would stack into one unreadable pile. Three heights, taken in sequence, fan them.
        const labelLift = 2.2 + (touch.seq % 3) * 2.6;
        return (
          <group key={touch.seq} position={[touch.x, touch.y, DOT_LIFT_MM]}>
            <mesh>
              <sphereGeometry args={[DOT_RADIUS_MM, 12, 8]} />
              <meshBasicMaterial color={TOUCH_VERDICT_COLORS[verdict]} />
            </mesh>
            <Html position={[0, 0, labelLift]} center style={{ pointerEvents: 'none' }}>
              <div data-testid={`touch-marker-${touch.seq}`} data-verdict={verdict} style={LABEL}>
                #{touch.seq} · Z {touch.z.toFixed(3)}
              </div>
            </Html>
          </group>
        );
      })}
    </group>
  );
}
