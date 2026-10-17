/**
 * The one pure conversion behind the vendor size picker (#466): a row from `/material-specs`, in
 * the shelf's own size fields.
 *
 * ONLY THE SHAPE'S OWN DIMS. A rectangular blank (`R`) is `length × width × height`, and the shelf
 * calls the vendor's height `thickness`; a round bar (`C`) is `diameter × length`. Nothing else is
 * inferred: the vendor's material word maps onto no `STOCK_MATERIALS` entry (that decision is still
 * open on #466), so `material`, `form`, finish and quantity are never part of this answer.
 *
 * It lives in its own file rather than beside the component so the component module exports only
 * components (`react-refresh/only-export-components`), and so the rule can be tested without React.
 */

import type { MaterialSpec } from '@/platform/materialSpecsClient';
import type { SizeField } from '@/platform/stockClient';

/** The size fields the row states, in the shelf's words. Fields it does not state are absent. */
export function specSizeFields(spec: MaterialSpec): Partial<Record<SizeField, number>> {
  const fields: Partial<Record<SizeField, number>> = { length: spec.length };
  if (spec.shape === 'R') {
    if (spec.width != null) fields.width = spec.width;
    if (spec.height != null) fields.thickness = spec.height;
  } else if (spec.diameter != null) {
    fields.diameter = spec.diameter;
  }
  return fields;
}
