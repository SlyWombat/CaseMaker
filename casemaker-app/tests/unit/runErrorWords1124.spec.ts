// #1124 (the landing ruling) — the planner's own out-of-memory failure, in the operator's words:
// the raw allocation text becomes a named cause with the remedy; ordinary run errors are untouched.
import { describe, expect, it } from 'vitest';

import { operatorRunError } from '@/components/panels/runErrorWords';
import { PLANNER_OUT_OF_MEMORY_SENTENCE } from '@/engine/cnc/rendererBits';

describe('#1124 — a planner out-of-memory failure is named', () => {
  it('maps the browser allocation failure to the memory sentence', () => {
    expect(operatorRunError('Array buffer allocation failed')).toBe(PLANNER_OUT_OF_MEMORY_SENTENCE);
    expect(operatorRunError('RangeError: Array buffer allocation failed')).toBe(PLANNER_OUT_OF_MEMORY_SENTENCE);
    expect(operatorRunError('RuntimeError: memory access out of bounds')).toBe(PLANNER_OUT_OF_MEMORY_SENTENCE);
    expect(operatorRunError('Cannot enlarge memory arrays')).toBe(PLANNER_OUT_OF_MEMORY_SENTENCE);
    expect(operatorRunError('the wasm heap is out of memory')).toBe(PLANNER_OUT_OF_MEMORY_SENTENCE);
  });

  it('leaves ordinary run errors alone (the #931 mapping still applies)', () => {
    const sweep = operatorRunError('the sweep refused: the cutter drives 0.477 mm³ into the fixture');
    expect(sweep).not.toBe(PLANNER_OUT_OF_MEMORY_SENTENCE);
    expect(sweep).toContain('0.477');
    expect(sweep).toContain('would cut');
    // A sentence that merely mentions memory is not an allocation failure.
    expect(operatorRunError('close other tabs to free memory')).toBe('close other tabs to free memory');
  });
});
