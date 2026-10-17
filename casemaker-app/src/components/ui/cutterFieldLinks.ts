import type { CutterField } from '@/engine/cnc/cutterProfile';

/**
 * Whether a field the caller highlighted is the one a dimension or edge is drawn from (#489).
 *
 * `diameter` and `handleDiameter` are one measurement on every V-bit, drill and thread: the body is
 * the shank, and the Type door's only box for it is `shank ⌀` (`registerCutter.toolFromSpec` writes
 * that box into both `handleDiameter` and `diameter`). So the DC dimension and the shank box light
 * each other up. On a flat or a ball, DC is the tip and `diameter` is not in the drawing, so this
 * alias never links two different measurements.
 */
export function cutterFieldsLinked(active: CutterField | null, field: CutterField): boolean {
  if (active === null) return false;
  if (active === field) return true;
  return (
    (active === 'handleDiameter' && field === 'diameter') ||
    (active === 'diameter' && field === 'handleDiameter')
  );
}
