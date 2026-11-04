/**
 * #964 — a DECLARATION-level type import. It is erased entirely, so the graph must not follow it.
 */
import type { Value } from './target';

export const declaredValue: Value = 3;
