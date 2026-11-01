/**
 * #840 — A SLOT ALONG A PATH: a `line` whose stated `slotWidth` is wider than the cutter.
 *
 * WHAT IT IS. A line is a trace: the cutter's centre follows it and the groove is one cutter wide.
 * A slot along the same path is a groove of a STATED width. When that width is wider than the
 * cutter cuts at the line's depth, the path is buffered by `width / 2` with round joins and round
 * ends — exactly the union of the capsules a disc of that radius sweeps along the path, which is
 * `traceSweptProfile`'s own construction — and the result is a REGION. It rides the pocket funnel
 * at the line's depth, so the pocket CAM, the region findings and the oracle are a pocket's.
 *
 * THE RULE, one predicate shared by the plan, the stroke-merge check and the row:
 *
 *   - no `slotWidth`            → today's trace, byte for byte;
 *   - a flute                   → the flute (a ramped trace) — the slot is ignored;
 *   - width ≤ the cutter's cut  → the trace (it already cuts that wide, or wider);
 *   - width > the cutter's cut  → the region.
 *
 * The cutter is the job's own (`toolForJob`, the same fallback the prism's ring reads). A job with
 * no cutter yet, or one that cannot trace, takes the region: the width is the designer's statement
 * and the region pipeline judges whether the eventual cutter can open it.
 */

import type { EngraveLineItem, EngraveTraceItem } from '@/types/engraveJob';
import type { Mm } from '@/types/units';
import { traceRadiusAt, type Tool } from '@/engine/cnc/tool';

/** The width the cutter cuts at this depth when it traces, mm, or null when it cannot trace. */
export function traceCutWidth(tool: Tool | null | undefined, depth: Mm): Mm | null {
  if (tool === null || tool === undefined) return null;
  const r = traceRadiusAt(tool, depth);
  return r === null ? null : 2 * r;
}

/**
 * The slot width this item is cut at as a REGION, mm, or null when it stays a trace (see the
 * module's rule). The comparison allows a micron so a slot typed at the cutter's own diameter is
 * a trace, as the issue states.
 */
export function lineSlotWidth(item: EngraveTraceItem, tool: Tool | null | undefined): Mm | null {
  if (item.kind !== 'line' || item.slotWidth === undefined || item.flute !== undefined) return null;
  if (!(Number.isFinite(item.slotWidth) && item.slotWidth > 0)) return null;
  const cut = traceCutWidth(tool, item.depth);
  if (cut !== null && item.slotWidth <= cut + 1e-6) return null;
  return item.slotWidth;
}

const fmt = (n: number): string => String(Number(n.toFixed(3)));

/**
 * The operation's descriptor for a slot, without the `[T#]` prefix or the depth suffix — the
 * contract `itemOperationName` keeps: `[T1]Slot 6 mm along line "grip" (12 points) 1.0mm`.
 */
export function slotOperationName(item: EngraveLineItem, width: Mm): string {
  const named = item.name ? ` "${item.name}"` : '';
  const n = item.points.length;
  return `Slot ${fmt(width)} mm along line${named} (${n} point${n === 1 ? '' : 's'}${item.closed ? ', closed' : ''})`;
}

/** A path's length, mm: its segments plus the closing one for a ring. */
export function pathLength(points: readonly (readonly [number, number])[], closed: boolean): Mm {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]);
  }
  if (closed && points.length >= 2) {
    const a = points[0]!;
    const b = points[points.length - 1]!;
    total += Math.hypot(a[0] - b[0], a[1] - b[1]);
  }
  return total;
}

/** One cutter the row can offer, as the registry lists it. */
export interface SlotCutterOption {
  key: string;
  name: string;
  /** The cutting diameter the record states, mm. */
  diameterMm: Mm;
}

/** What the row states about a line's slot width. */
export type SlotFacts =
  | {
      kind: 'region';
      widthMm: Mm;
      /** The path's own length, mm. */
      lengthMm: Mm;
      /** The cutter's diameter at this depth, mm, or null when the job has no cutter yet. */
      cutterMm: Mm | null;
      /** Contour-parallel rings across the slot (the pocket's own count), or null without a step-over. */
      rings: number | null;
      stepOverMm: Mm | null;
      /** Depth levels to reach the line's depth, or null without a step-down. */
      levels: number | null;
      stepDownMm: Mm | null;
    }
  | {
      kind: 'trace';
      widthMm: Mm;
      cutterMm: Mm;
      /** The widest owned flat that would cut it as a slot, or the narrowest owned one when none is narrower. */
      offer: SlotCutterOption | null;
      /** True when `offer` is narrower than the slot (it would cut it as a region). */
      offerFits: boolean;
    };

/**
 * The row's numbers for a line's slot width, from the same predicate the plan applies. Null when the
 * line states no slot (or is a flute).
 *
 * The RINGS are `pocketLoops`' own count for a band of half-width `w / 2`: rings sit at `r + k·s`
 * from each wall while that is short of the centreline, so `ceil((w/2 − r) / s)`, at least one.
 */
export function slotFacts(
  item: EngraveTraceItem,
  tool: Tool | null | undefined,
  params: { stepOver: Mm; stepDown: Mm } | null,
  owned: readonly SlotCutterOption[],
): SlotFacts | null {
  if (item.kind !== 'line' || item.slotWidth === undefined || item.flute !== undefined) return null;
  const width = item.slotWidth;
  const cutter = traceCutWidth(tool, item.depth);
  const region = lineSlotWidth(item, tool);
  if (region !== null) {
    const r = cutter === null ? null : cutter / 2;
    const s = params !== null && params.stepOver > 0 ? params.stepOver : null;
    const d = params !== null && params.stepDown > 0 ? params.stepDown : null;
    return {
      kind: 'region',
      widthMm: width,
      lengthMm: pathLength(item.points, item.closed),
      cutterMm: cutter,
      rings: r !== null && s !== null ? Math.max(1, Math.ceil((width / 2 - r) / s - 1e-9)) : null,
      stepOverMm: s,
      levels: d !== null ? Math.max(1, Math.ceil(item.depth / d - 1e-9)) : null,
      stepDownMm: d,
    };
  }
  // Width at or below the cutter (`cutter` is known here: a null cutter takes the region).
  const narrower = owned.filter((o) => o.diameterMm < width - 1e-6).sort((a, b) => b.diameterMm - a.diameterMm);
  const nearest = [...owned].sort((a, b) => Math.abs(a.diameterMm - width) - Math.abs(b.diameterMm - width));
  const offer = narrower[0] ?? nearest[0] ?? null;
  return { kind: 'trace', widthMm: width, cutterMm: cutter!, offer, offerFits: narrower[0] !== undefined };
}

/** The row's one-line statement, units on every number. */
export function slotSentence(facts: SlotFacts): string {
  if (facts.kind === 'region') {
    const cutter = facts.cutterMm === null ? 'the job’s cutter' : `the ⌀${fmt(facts.cutterMm)} mm cutter`;
    const rings =
      facts.rings === null || facts.stepOverMm === null
        ? ''
        : ` in ${facts.rings} ring${facts.rings === 1 ? '' : 's'} at ${fmt(facts.stepOverMm)} mm step-over`;
    const levels =
      facts.levels === null || facts.stepDownMm === null
        ? ''
        : `, ${facts.levels} level${facts.levels === 1 ? '' : 's'} of ${fmt(facts.stepDownMm)} mm`;
    return (
      `A ${fmt(facts.widthMm)} mm slot along ${fmt(facts.lengthMm)} mm of path: the path grows ${fmt(facts.widthMm / 2)} mm ` +
      `to each side with round ends, and the region is pocketed by ${cutter}${rings}${levels}.`
    );
  }
  const head =
    `The ⌀${fmt(facts.cutterMm)} mm cutter is not narrower than the ${fmt(facts.widthMm)} mm slot, ` +
    `so the line is traced one cutter wide (${fmt(facts.cutterMm)} mm).`;
  if (facts.offer === null) return head;
  // The registry's name usually carries the size already; add it only when it does not.
  const size = `${fmt(facts.offer.diameterMm)} mm`;
  const named = facts.offer.name.includes(size) ? facts.offer.name : `${facts.offer.name} (⌀${size})`;
  return facts.offerFits
    ? `${head} ${named} would cut it ${fmt(facts.widthMm)} mm wide.`
    : `${head} No cutter you own is narrower than ${fmt(facts.widthMm)} mm; the nearest is ${named}.`;
}
