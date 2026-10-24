/**
 * #519 item 1 — the three touch verdicts' colours, the ONE source for the viewport's dots
 * (`TouchMarkers`) and the legends' swatches (`EngraveLegend`, `SimLegend`): a layer toggle is the
 * legend (§553's rule), so the dot and its swatch must be the same hex.
 */

import type { TouchVerdict } from '@/engine/cnc/registration/liveTouch';

export const TOUCH_VERDICT_COLORS: Record<TouchVerdict, string> = {
  /** On the stock, inside the surface band. */
  stock: '#30a46c',
  /** A hit above the band — something standing on/over the stock. */
  'off-band': '#e0c07a',
  /** Nothing there: a jaw top, the edge's roll-off, or a `G38.3` miss. */
  miss: '#e5484d',
};

/** The words the legend and the dock print, in the same order as the colours. */
export const TOUCH_VERDICT_WORDS: Record<TouchVerdict, string> = {
  stock: 'on the stock',
  'off-band': 'off the band',
  miss: 'miss',
};
