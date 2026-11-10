/**
 * #1117 — THE FREEING CONTOUR AGAINST THE VISE'S JAWS, AT PLAN STAGE.
 *
 * A vise job frees its part with a contour that follows the goal's silhouette. When that
 * silhouette sits closer to the stock's edge than the cutter's SHANK radius, the tip clears the
 * jaw and the shank does not — ref-tray70: 2 mm of rim, a 2 mm tip, a 6 mm shank. Before this
 * check the operator got one simulation error per sweep checkpoint (~29) AFTER the program had
 * posted; this one sentence, raised before anything posts, names the shank radius, the rim and the
 * jaw, and the ways out.
 *
 * SCOPE: THE FREEING CONTOUR ONLY. Every other op near a jaw — pockets, finishes, rest passes —
 * and every clamp/bracket op stays the verifier's and the sweep's backstop, unchanged.
 *
 * The swath is each consecutive move pair grown by the shank radius plus the job's jaw clearance
 * (the same square grow `inPath.ts` uses, erring toward a finding) and clipped against each jaw
 * bar: x inward from the stock edge by the jaw's own thickness, y over `jawStartY .. jawStartY +
 * jawLength`, and only the moves that reach BELOW the jaw tops (`stockProud` under the stock top).
 */
import type { CamMove } from '@/engine/cnc/cam/ir';
import type { JobFinding } from '@/engine/cnc/engrave/jobSetup';
import type { ViseParams } from '@/types/engraveJob';
import type { Vec3 } from '@/types/units';
import { clipToRect } from './inPath';

export interface JawClearanceInput {
  /** The stock's X and Y, mm — the jaw faces sit at the stock's own edges. */
  stock: { length: number; width: number };
  /** The job's vise (its own numbers, mm). The jaw tops are `stockProud` below the stock top. */
  vise: Pick<ViseParams, 'fixedJawThickness' | 'movingJawThickness' | 'jawLength' | 'jawStartY' | 'stockProud'>;
  /** The plan's freeing-contour moves, in the work frame (Z = 0 at the stock top). */
  contour: readonly CamMove[];
  /** The cutter's largest radial reach below the jaw top — the shank, never the tip, mm. */
  shankRadiusMm: number;
  /** The job's jaw clearance (`job.jawClearance`), mm — the same growth the verifier applies. */
  clearanceMm?: number;
}

const fmt = (n: number): string => String(Math.round(n * 1000) / 1000);

/**
 * The one finding, or null. Raises on the FIRST jaw entry in contour order — the earliest place
 * the operator would need to know — and states every number it judged.
 */
export function contourJawClearanceFinding(input: JawClearanceInput): JobFinding | null {
  const { stock, vise, contour, shankRadiusMm } = input;
  if (contour.length < 2 || !(shankRadiusMm > 0)) return null;
  const grow = shankRadiusMm + (input.clearanceMm ?? 0);
  const jawTopZ = -vise.stockProud;
  const jaws = [
    {
      label: 'fixed jaw (left)',
      min: [-vise.fixedJawThickness, vise.jawStartY] as [number, number],
      max: [0, vise.jawStartY + vise.jawLength] as [number, number],
    },
    {
      label: 'moving jaw (right)',
      min: [stock.length, vise.jawStartY] as [number, number],
      max: [stock.length + vise.movingJawThickness, vise.jawStartY + vise.jawLength] as [number, number],
    },
  ];
  // The rim the sentence names: the contour's closest approach to the stock's boundary, XY.
  let rim = Number.POSITIVE_INFINITY;
  for (const m of contour) {
    rim = Math.min(rim, m.x, stock.length - m.x, m.y, stock.width - m.y);
  }
  if (!Number.isFinite(rim)) return null;
  for (let i = 1; i < contour.length; i++) {
    const a = contour[i - 1]!;
    const b = contour[i]!;
    // Above the jaw tops the shank passes over them: only a move that reaches below counts.
    if (Math.min(a.z, b.z) > jawTopZ + 1e-9) continue;
    const from: Vec3 = [a.x, a.y, a.z];
    const to: Vec3 = [b.x, b.y, b.z];
    for (const jaw of jaws) {
      const hit = clipToRect(from, to, [jaw.min[0] - grow, jaw.min[1] - grow], [jaw.max[0] + grow, jaw.max[1] + grow]);
      if (hit === null) continue;
      const reach = Math.max(0, shankRadiusMm - rim);
      return {
        severity: 'error',
        code: 'clamp-in-path',
        // The message says WHERE it was found: at plan stage, before anything posted — the plan
        // refuses, so the sweep never sees the collision to report checkpoint by checkpoint.
        message:
          `The freeing contour runs ${fmt(rim)} mm from the stock’s edge, and the cutter’s ${fmt(shankRadiusMm * 2)} mm shank ` +
          `reaches ${fmt(reach)} mm past it into the vise’s ${jaw.label} below the jaw top — found at plan stage, so nothing was posted. ` +
          `Fit a cutter whose shank is no wider than ${fmt(rim * 2)} mm, use a larger stock, or hold the job on tape.`,
      };
    }
  }
  return null;
}
