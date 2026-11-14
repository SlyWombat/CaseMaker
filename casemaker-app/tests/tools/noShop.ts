/**
 * #1256 — A CALLER WITH NO SHOP SAYS SO, AT THE CALL SITE. The refusal band, the goal cell cap and
 * the tape strip width are required parameters with no default inside the engine, so a test (or a
 * tool) that has no settings map passes the recommendation explicitly. These are the registry's own
 * fallbacks, read the same way the engine reads a missing key.
 */
import { readDefault } from '@/platform/defaultsClient';

export const NO_SHOP = {
  refuse: readDefault(null, 'clamp.refuseFraction').value,
  goalMaxCells: readDefault(null, 'goal.maxCells').value,
  tapeStripWidthMm: readDefault(null, 'tape.stripWidthMm').value,
} as const;
