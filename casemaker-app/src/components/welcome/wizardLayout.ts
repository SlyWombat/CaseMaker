/**
 * #726 W19/P12 — the wizard's phone width.
 *
 * The same number `machineChange.css` uses for its own phone block, so the two overlays of the
 * first-job flow break at one width. The shell reads it for its 16 px content edge and the plain
 * backdrop; Holding reads it to stack its picture under the options.
 */
export const NARROW_QUERY = '(max-width: 560px)';
