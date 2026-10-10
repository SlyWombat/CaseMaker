/**
 * Saying what a printed box code was read as (#309, tracking #212), and naming a shape.
 *
 * The reading is PROVISIONAL (`registerCutter.parseBoxCode`, #208 A7 — one label known), so the
 * panel has to show it as a reading rather than a fact: the user is the only one who can see the
 * box, and a sentence like "ball nose, 1 mm, 4 mm" is what they check it against. Everything the
 * code did not state is left out rather than filled with a `—`, because this is prose, not a table.
 */

import type { ToolShape } from '@/engine/cnc/tool';
import type { BoxCode } from '@/engine/cnc/registerCutter';
import { mm } from '../display';

/** Shape names as a person says them. Used by the reading below and the Type door's select. */
export const SHAPE_LABELS: Record<ToolShape, string> = {
  flat: 'flat end mill',
  ball: 'ball nose',
  'tapered-ball': 'tapered ball nose',
  engraving: 'engraving cutter',
  chamfer: 'chamfer mill',
  drill: 'drill',
  thread: 'thread mill',
  bull: 'bull nose',
  unknown: 'unknown shape',
};

/** The shapes the Type door offers. `unknown` is a state the parser produces, not a choice. */
export const TYPABLE_SHAPES: readonly ToolShape[] = [
  'flat',
  'ball',
  'tapered-ball',
  'engraving',
  'chamfer',
  'drill',
  'thread',
  'bull',
];

/** `ball nose, 1 mm, 4 mm` — only the parts the label actually stated. */
export function describeReading(box: BoxCode): string {
  const parts: string[] = [];
  if (box.shape !== 'unknown') parts.push(SHAPE_LABELS[box.shape]);
  if (box.tipDiameter !== null) parts.push(`${mm(box.tipDiameter)} mm tip`);
  if (box.fluteLength !== null) parts.push(`${mm(box.fluteLength)} mm flute`);
  return parts.length > 0 ? parts.join(', ') : 'nothing that names a cutter';
}
