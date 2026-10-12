/**
 * Saying what a printed box code was read as (#309, tracking #212), and naming a shape.
 *
 * The reading says what the LABEL printed, which since 2026-10-12 is a settled format rather than a
 * guess at one (`registerCutter.parseBoxCode`, #378) — but a settled format is still a reading and
 * not a fact about the cutter in the box: the user is the only one who can see it, and a sentence
 * like "ball nose, 1 mm, 4 mm" is what they check it against. Everything the code did not state is
 * left out rather than filled with a `—`, because this is prose, not a table.
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

/**
 * `engraving cutter, 30°, 0.3 mm tip` — only the parts the label actually stated. The order is the
 * order the code prints its numbers in: the type word, then the metal marker, then an angle, then a
 * thread spec, then the tip and the flute (`C1-BIT-ENGRAVE-30-0.3`, `C1-BIT-THREAD-M5-15`,
 * `C1-BIT-BALL-NOSE-1-4`).
 *
 * The metal LINE is said because it is the one thing about a cutter that its numbers do not carry:
 * a box printed `-M-` is a bit ground for aluminium, and a user checking a box against a row they
 * are about to register needs to see which line they are holding (#379 review).
 *
 * The angle is NOT written through `mm` below: it is degrees, and a dimension formatter would put a
 * trailing `.0` on a whole 30° and read as a length beside the tip. It keeps the degree sign for the
 * same reason. A thread SPEC is a designation and not a measurement either — `M5` is a size, and
 * `M5 thread` is what the user compares against the box.
 */
export function describeReading(box: BoxCode): string {
  const parts: string[] = [];
  if (box.shape !== 'unknown') parts.push(SHAPE_LABELS[box.shape]);
  if (box.metal) parts.push('metal line');
  if (box.includedAngle !== null) parts.push(`${box.includedAngle}°`);
  if (box.threadSpec !== null) parts.push(`${box.threadSpec} thread`);
  if (box.tipDiameter !== null) parts.push(`${mm(box.tipDiameter)} mm tip`);
  if (box.fluteLength !== null) parts.push(`${mm(box.fluteLength)} mm flute`);
  return parts.length > 0 ? parts.join(', ') : 'nothing that names a cutter';
}
