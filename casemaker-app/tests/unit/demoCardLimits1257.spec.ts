/**
 * #1257 — THE DEMO BUILDER'S PER-CARD LIMITS, pinned by the builder's own stdlib-only self-tests
 * (docs/bench/2026-10-28-z1-real-jobs/tools/test_limits.py): limit = max(600 s, 1.5 × the card's own reference), the
 * default and the "no reference" list, an over-limit card recording both numbers and the last phase it reached, the
 * reference table never rewritten by a run, and the build saying so when --references is absent. The made-up figures
 * in the script are not vendor numbers. The comparison side (the share-of-limit list, the over-limit lines) is
 * pinned in baselineCompare.spec.ts.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const TOOLS = join(__dirname, '..', '..', '..', 'docs', 'bench', '2026-10-28-z1-real-jobs', 'tools');

describe('#1257 demo card limits (the builder\'s self-tests)', () => {
  it('test_limits.py passes', () => {
    const out = execFileSync('python3', ['-I', join(TOOLS, 'test_limits.py')], { cwd: TOOLS, encoding: 'utf8', timeout: 120_000, env: { ...process.env, PYTHONPATH: TOOLS } });
    for (const name of [
      'test_limits_per_card',
      'test_derive_and_table_is_never_rewritten_by_a_run',
      'test_over_limit_records_both_numbers_and_the_last_phase',
      'test_last_phase_maps_stages_and_says_when_there_is_no_trace',
      'test_build_says_so_when_there_is_no_reference_data_and_records_the_file_when_there_is',
    ]) {
      expect(out).toContain(`ok ${name}`);
    }
  });
});
