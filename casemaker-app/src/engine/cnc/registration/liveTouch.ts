/**
 * #519 item 1 — ONE reading, as it lands. The registration executor emits one of these per probe
 * contact (`ExecDeps.onTouch`), so the viewport can draw the touch and the dock can list it WHILE the
 * run goes, instead of only after `RunResult` exists. Type-only: no machine, no store, no React.
 *
 * FRAMES. `x`/`y` are WORK coordinates — where the touch was commanded, the frame every scene is
 * drawn in and the frame the plan's points are in. `z` is the MACHINE Z the controller's `[PRB:…]`
 * reports (`readings.ts`), labelled as machine wherever it is printed; the run carries no G54 Z, so
 * a work Z is not invented here.
 *
 * VERDICTS. The executor classifies edge touches into four kinds (`TouchKind`); the viewport and the
 * dock print the design's three (§5: stock / miss / off-band). {@link touchVerdict} is the one
 * mapping, so the dot's colour and the table's word cannot disagree.
 */

import type { TouchKind } from './readings';

/** What the reading was: the surface seek, a cut-extent point, an edge scan, or the mount tap. */
export type LiveTouchSource = 'surface' | 'spread' | 'edge' | 'mount-tap';

/** One probe reading as it landed (#519 item 1). */
export interface LiveTouch {
  /** 1-based, in the order the readings landed in this run. */
  seq: number;
  source: LiveTouchSource;
  /** The scan's own words ("the left edge"), the extent's point, or null for the surface/tap. */
  label: string | null;
  /** WORK X, mm — the commanded point. */
  x: number;
  /** WORK Y, mm. */
  y: number;
  /** MACHINE Z, mm, as the PRB reported it. */
  z: number;
  /** False for a `G38.3` miss — a reading, not an alarm (#518). */
  touched: boolean;
  /** An edge scan's classification; null for the other sources (a hit is stock, a miss is miss). */
  kind: TouchKind | null;
}

/** The three verdicts the viewport and the dock print (#519 §5). */
export type TouchVerdict = 'stock' | 'off-band' | 'miss';

/**
 * `TouchKind` (four) → the design's three verdicts. `above` is "something stands above the surface"
 * — off the band the stock lives in; `below` (a jaw top, the edge's roll-off) and `miss` are both
 * "nothing there". A surface or extent reading carries no kind: it touched the stock or it missed.
 */
export function touchVerdict(touch: Pick<LiveTouch, 'kind' | 'touched'>): TouchVerdict {
  if (touch.kind === 'stock') return 'stock';
  if (touch.kind === 'above') return 'off-band';
  if (touch.kind === 'below' || touch.kind === 'miss') return 'miss';
  return touch.touched ? 'stock' : 'miss';
}
