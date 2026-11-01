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
  if (over[worstOver] > 1e-6) {
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
