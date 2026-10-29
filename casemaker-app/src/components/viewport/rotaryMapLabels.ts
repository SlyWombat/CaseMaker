/**
 * #716 — WHICH OF THE MAP'S LABELS SURVIVE A SMALL SCREEN (review of slice 1: they collided at 390 px).
 *
 * The map's labels are DOM boxes projected from world anchors, so their sizes are the font's, not
 * the job's: on a phone the whole map is about 210 px wide while "tailstock 75–85 mm" is about
 * 116 px, and labels that sit on different anchors overlap. Rather than shrink the type — the
 * words are what make the map readable at all — the map keeps the labels that fit and drops the
 * ones that would collide, in a stated priority order (an operator keeps the band's millimetres;
 * the seam's 0° is repeated by the ruler and the seam line).
 *
 * This module is the arithmetic only: rects in, hidden ids out, no React and no canvas. The
 * component measures and projects; the spec proves the choice.
 */

/** One measured label, centred on the canvas pixel its anchor projects to. */
export interface MapLabelRect {
  id: string;
  /** Lower wins when two labels collide: 5 a band, 10 a ruler's end, 20 a ruler tick, 40 the seam. */
  priority: number;
  /** Centre, canvas pixels. */
  cx: number;
  cy: number;
  width: number;
  height: number;
}

export interface MapLabelBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * The rectangle the label's box covers, grown by `pad` on every side. A pad of 1–2 px is the
 * rounding error between `offsetWidth` (integer) and the DOM's fractional layout, so a pair the
 * layout calls clear cannot be a sub-pixel overlap on screen.
 */
export function mapLabelBox(rect: MapLabelRect, pad = 0): MapLabelBox {
  return {
    left: rect.cx - rect.width / 2 - pad,
    top: rect.cy - rect.height / 2 - pad,
    right: rect.cx + rect.width / 2 + pad,
    bottom: rect.cy + rect.height / 2 + pad,
  };
}

/** Strict overlap: boxes that only share an edge do not collide. */
export function boxesOverlap(a: MapLabelBox, b: MapLabelBox): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/**
 * Greedy placement in priority order: each label takes its box if no KEPT box collides with it,
 * and is hidden otherwise. Deterministic — equal priorities fall back to the id — so a re-layout
 * at the same camera hides exactly the same set.
 *
 * Greedy rather than per-pair: a label that collides with a kept one does not reserve space, so a
 * later label that would have fitted beside the hidden one still appears. With 13 labels the
 * difference between this and an optimal packing is not worth a search.
 */
export function hiddenMapLabels(rects: readonly MapLabelRect[], pad = 1): Set<string> {
  const ordered = [...rects].sort(
    (a, b) => a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const kept: MapLabelBox[] = [];
  const hidden = new Set<string>();
  for (const rect of ordered) {
    const box = mapLabelBox(rect, pad);
    if (kept.some((k) => boxesOverlap(k, box))) hidden.add(rect.id);
    else kept.push(box);
  }
  return hidden;
}
