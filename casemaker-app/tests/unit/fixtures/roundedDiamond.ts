/**
 * #736 — the rounded-diamond outline whose straight sides are TRACED as many short collinear
 * segments.
 *
 * The shape is the diamond sign the real-jobs bench could not tab (j23, `blue_shell_sign`): a
 * square rotated 45°, 78 mm on the square's side, with 4 mm corner fillets, so each of its four
 * straight sides is 70 mm long. Its artwork is Makerables' (CC BY-NC-ND 4.0) and is NOT committed;
 * the job is not committed either, for the same reason. The bench README records how the outline
 * was traced (`docs/bench/2026-10-28-z1-real-jobs/README.md`, j23) and the manifest records its
 * 110 mm span; 78 × √2 = 110.3 mm, so this fixture reproduces that outline from its dimensions:
 * 14 short pieces per straight side, evenly spaced.
 *
 * A traced side is not one segment — it is many, each shorter than a tab span — so tab placement
 * must treat a maximal run of collinear segments as ONE edge (#736). The corner fillets are
 * polygonised at the CAM's own chord tolerance, so their resolution matches the offset paths.
 */

import { segmentsForRadius } from '@/engine/compiler/arcResolution';

/** The straight side, mm. The square before rotation is `SIDE + 2 * FILLET` on a side. */
const SIDE = 70;
/** The corner fillet radius, mm. */
const FILLET = 4;

/**
 * The outline, centred on the origin and rotated 45°, counter-clockwise from the tangent point
 * that starts the bottom straight side. `steps` pieces are emitted per straight side (14 gives
 * 5 mm traced pieces) and every 90° fillet is polygonised at the CAM's arc resolution.
 */
export function roundedDiamondPoints(steps = 14): [number, number][] {
  const half = (SIDE + 2 * FILLET) / 2;
  const arcSteps = segmentsForRadius(FILLET) / 4;
  const points: [number, number][] = [];
  const push = (x: number, y: number): void => {
    // Place the square as the diamond on the blank: rotate 45° about the origin.
    const a = Math.PI / 4;
    points.push([x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)]);
  };
  /** Walk a straight side from `from` to `to`, emitting every traced joint after the start. */
  const side = (from: [number, number], to: [number, number]): void => {
    for (let k = 1; k <= steps; k++) {
      push(from[0] + ((to[0] - from[0]) * k) / steps, from[1] + ((to[1] - from[1]) * k) / steps);
    }
  };
  /** Walk a fillet from `from` radians to `from + 90°` about its centre `(cx, cy)`. */
  const fillet = (cx: number, cy: number, from: number): void => {
    for (let k = 1; k <= arcSteps; k++) {
      const a = from + (k / arcSteps) * (Math.PI / 2);
      push(cx + FILLET * Math.cos(a), cy + FILLET * Math.sin(a));
    }
  };

  const tail = half - FILLET;
  // Bottom side, left to right; bottom-right fillet; right side; top-right fillet; top side
  // right to left; top-left fillet; left side; bottom-left fillet — the last point is the first.
  push(-tail, -half);
  side([-tail, -half], [tail, -half]);
  fillet(tail, -tail, -Math.PI / 2);
  side([half, -tail], [half, tail]);
  fillet(tail, tail, 0);
  side([tail, half], [-tail, half]);
  fillet(-tail, tail, Math.PI / 2);
  side([-half, tail], [-half, -tail]);
  fillet(-tail, -tail, Math.PI);

  // A closed polygon does not repeat its first point: the last fillet ends exactly there.
  const [first] = points;
  return points.filter((p, i) => i === 0 || p[0] !== first![0] || p[1] !== first![1]);
}
