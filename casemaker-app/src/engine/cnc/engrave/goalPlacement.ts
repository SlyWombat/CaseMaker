/**
 * #876 — THE NUMERIC PANEL'S PLACEMENT ACTIONS AND THE FIT SENTENCE.
 *
 * Four presses, each one document write: Centre in stock, Drop to floor, Flush to top and Reset
 * rotation. The stock is the frame (X/Y from its front-left corner, Z from its top face, the
 * app's existing placement frame), and the fit sentence states the placed bounding box against
 * the stock's room — INFORM, never refuse: "fits the stock with 2.1 mm to spare in X", or
 * "6.3 mm too tall: Resize to fit, or Cut the top 6.3 mm".
 *
 * Decisions (design note, approved): the floor allowance is 0 mm — the part's bottom at the
 * blank's bottom face — and the stock's room is the blank less the job's edge margin in X/Y, the
 * stock thickness in Z. "Cut the top N mm" means SINK the goal by N, not scale it.
 *
 * Pure, so the actions and the sentence are tested without a canvas.
 */
import { placedSize } from '@/engine/cnc/engrave/targetScale';
import { turnsPatch } from '@/engine/cnc/engrave/goalOrientation';
import type { EngraveTargetObject } from '@/types/engraveJob';

/** The blank a mesh is placed on — the same four numbers the row's Fit to the stock uses. */
export interface GoalStock {
  length: number;
  width: number;
  thickness: number;
  edgeMargin: number;
}

const fmt1 = (n: number): string => `${Number(n.toFixed(1))}`;
/** An overhang in mm to two decimals: 0.05 never prints as "0.0", and 1.59 µm never refuses. */
const fmt2 = (n: number): string => n.toFixed(2);

/**
 * #1045 — THE ONE "FITS THE BLANK" TOLERANCE, shared by the panel's overhang row and the CAM seam.
 *
 * The two readings of one goal differ: the PANEL reads the document's stored size (three decimals,
 * as Fit to the stock wrote it), the SEAM re-measures the mesh's own vertices through `placeTarget`.
 * On j28 those differ by 1.59 µm (stored 66.404 against the mesh's true 66.4040059 at scale
 * 36/66.404) — below both float32's resolution at 66 mm and anything a display can show, yet the
 * seam's 1e-6 tolerance refused it and printed "0.0 mm past the left edge". 0.01 mm is two orders
 * above that noise and far below anything a cutter notices: a goal within it of the edge fits
 * everywhere. Used as {@link goalStockOverhang}'s default and at the CAM seam in
 * `engraveGenerate.ts`; a real miss still refuses, and its sentence prints two decimals.
 */
export const GOAL_FIT_TOLERANCE_MM = 0.01;

/** Centre the placed bounding box in the stock's X/Y. */
export function centreInStockPatch(stock: GoalStock): { position: { x: number; y: number } } {
  return { position: { x: stock.length / 2, y: stock.width / 2 } };
}

/**
 * Drop the part so its bottom sits on the stock's bottom face, plus the floor allowance (0 mm by
 * decision: the part's bottom at the blank's bottom). `position.z` is the placed bbox's TOP, so
 * the top is set to the placed height less the stock thickness.
 */
export function dropToFloorPatch(
  target: Pick<EngraveTargetObject, 'format' | 'scale' | 'size' | 'rotation' | 'rotationX' | 'rotationY'>,
  stock: GoalStock,
  floorAllowanceMm = 0,
): { position: { z: number } } {
  const height = placedSize(target).z;
  return { position: { z: Number((height - stock.thickness + floorAllowanceMm).toFixed(3)) } };
}

/** Flush to top: the placed bbox's top at the stock's top face (Z0). */
export function flushToTopPatch(): { position: { z: number } } {
  return { position: { z: 0 } };
}

/** Reset rotation: the identity turn, stored the way the document always has (0 about X/Y is absent). */
export function resetRotationPatch() {
  return turnsPatch({ x: 0, y: 0, z: 0 });
}

/**
 * #949 — A GOAL THAT DOES NOT FIT THE BLANK IS REFUSED, not clipped.
 *
 * The sampler clips a goal's grid to the stock (#784), and a clipped goal's finish pass runs
 * exactly along the stock edge — where the vise's jaws are, so the fixture check refuses the
 * program anyway (#923). The refusal belongs here, before the toolpath is built, with the overhang
 * named per side: the operator scales the figure in the app (the stick-scale figures already are)
 * or re-places it. A goal that fits is untouched; the tolerance absorbs float noise at an exact
 * edge, not a real overhang.
 *
 * `rect` is the blank's top-face rectangle in the WORK frame — the same clip the sampler uses —
 * so a goal is judged against the stock the program would really cut on.
 */
export interface GoalOverhang {
  fits: boolean;
  /** The sides the goal extends past, by how much (mm). Empty when it fits. */
  sides: { side: 'left' | 'right' | 'front' | 'back'; mm: number }[];
  /** The CAM's refusal sentence, naming the overhang and the fixes. Empty when the goal fits. */
  sentence: string;
}

export function goalStockOverhang(
  target: Pick<
    EngraveTargetObject,
    'format' | 'scale' | 'size' | 'rotation' | 'rotationX' | 'rotationY' | 'position'
  > & { name?: string },
  rect: { xMin: number; xMax: number; yMin: number; yMax: number },
  toleranceMm = GOAL_FIT_TOLERANCE_MM,
): GoalOverhang {
  const size = placedSize(target);
  const gxMin = target.position.x - size.x / 2;
  const gxMax = target.position.x + size.x / 2;
  const gyMin = target.position.y - size.y / 2;
  const gyMax = target.position.y + size.y / 2;
  const sides = (
    [
      { side: 'left' as const, mm: rect.xMin - gxMin },
      { side: 'right' as const, mm: gxMax - rect.xMax },
      { side: 'front' as const, mm: rect.yMin - gyMin },
      { side: 'back' as const, mm: gyMax - rect.yMax },
    ] as const
  ).filter((s) => s.mm > toleranceMm);
  if (sides.length === 0) return { fits: true, sides: [], sentence: '' };
  const list =
    sides.length === 1
      ? `${fmt2(sides[0]!.mm)} mm past the ${sides[0]!.side} edge`
      : `${sides
          .slice(0, -1)
          .map((s) => `${fmt2(s.mm)} mm past the ${s.side} edge`)
          .join(', ')} and ${fmt2(sides.at(-1)!.mm)} mm past the ${sides.at(-1)!.side} edge`;
  return {
    fits: false,
    sides: sides.map((s) => ({ ...s })),
    sentence:
      `The goal object "${target.name ?? 'the goal object'}" is larger than the blank: ${list}. A goal clipped to the ` +
      "stock would run its finish along the stock's edge, where the mount holds it, so it is " +
      'refused: move it inward, scale it down (Fit to the stock), or use a larger blank.',
  };
}

export interface GoalFit {
  fits: boolean;
  /** The axis with the least room when it fits, or the axis that is over when it does not. */
  axis: 'x' | 'y' | 'z';
  /** Millimetres of spare (fits) or over (miss). */
  mm: number;
  /** The one-line fact the row prints. */
  sentence: string;
}

/**
 * The fit fact: the placed bounding box against the stock's room. The old size note said what the
 * part measures; this says whether the blank holds it and by how much.
 */
export function goalFit(
  target: Pick<EngraveTargetObject, 'format' | 'scale' | 'size' | 'rotation' | 'rotationX' | 'rotationY'>,
  stock: GoalStock,
): GoalFit {
  const size = placedSize(target);
  const room = {
    x: stock.length - 2 * stock.edgeMargin,
    y: stock.width - 2 * stock.edgeMargin,
    z: stock.thickness,
  };
  const over = { x: size.x - room.x, y: size.y - room.y, z: size.z - room.z };
  const axes = ['x', 'y', 'z'] as const;
  const worstOver = axes.reduce((a, b) => (over[b] > over[a] ? b : a));
  // #1045 — the same tolerance the seam uses, so the panel's fit row and the CAM's fit check
  // cannot disagree about a goal that is within float noise of the room.
  if (over[worstOver] > GOAL_FIT_TOLERANCE_MM) {
    const mm = Number(over[worstOver].toFixed(1));
    const word = worstOver === 'z' ? 'tall' : worstOver === 'x' ? 'wide' : 'long';
    return {
      fits: false,
      axis: worstOver,
      mm,
      sentence:
        worstOver === 'z'
          ? `${fmt1(mm)} mm too tall: Resize to fit, or Cut the top ${fmt1(mm)} mm`
          : `${fmt1(mm)} mm too ${word}: Resize to fit`,
    };
  }
  const slack = { x: room.x - size.x, y: room.y - size.y, z: room.z - size.z };
  const tightest = axes.reduce((a, b) => (slack[b] < slack[a] ? b : a));
  const mm = Number(slack[tightest].toFixed(1));
  return {
    fits: true,
    axis: tightest,
    mm,
    sentence: `fits the stock with ${fmt1(mm)} mm to spare in ${tightest.toUpperCase()}`,
  };
}
