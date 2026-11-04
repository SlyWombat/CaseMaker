/**
 * #964 — an INLINE type import. Under `verbatimModuleSyntax` this still emits a module load
 * (`import {} from './target'`), so the graph must follow it as a value edge.
 */
import { type Value } from './target';

export const inlineValue: Value = 2;
