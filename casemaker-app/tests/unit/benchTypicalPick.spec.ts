// #1180 — split out of benchTypicalJobs.spec.ts (348 s in ONE file = one worker). The harness is
// shared (helpers/benchTypicalJobs.ts); these tests are moved verbatim, counts unchanged.
// #734 — the typical Z1 jobs that `docs/bench/2026-10-27-z1-typical-jobs` records are run through
// the same `casemaker cut` pipeline the exercise used, so a defect the bench found is a test here
// rather than a note in a manifest.
//
// The job JSONs stay where the bench put them: this spec reads them from `docs/bench`, and never
// rewrites them. The bench's own location document is not committed (it is the operator's machine),
// so the cutters those jobs name are built here from the same inventory entries the exercise used.
// The rest of the document is the committed test fixture.
//
// #738 — the follow-up exercise's jobs (`2026-10-28-z1-real-jobs`) join the same harness: the
// relief jobs' rapids-through-stock refusal was a surfacing CAM defect, and the tool tray was the
// #734 item-1 false positive. Their two ball-nose cutters are added to the same location document.

import { afterEach, afterAll, describe, expect, it } from 'vitest';
import { REAL_JOBS, SCRATCH, allDiagnostics, cut, pickedVariant, cleanupBenchScratch } from './helpers/benchTypicalJobs';
import { resetRegistry } from '@/engine/cnc/toolRegistry';

// #1180 — harness: helpers/benchTypicalJobs.ts; the job families are split so they run in parallel.
afterAll(() => cleanupBenchScratch());
afterEach(() => resetRegistry());

describe('#760/#766 the measured pick gives raised text a cutter that fits its gaps', () => {
  it('j02 with no cutter named: a finer rest separates "Software", and the run says how it chose', async () => {
    const variant = pickedVariant('j02-raised-cnx.json', REAL_JOBS);
    const { code, receipt, progress } = await cut(variant, SCRATCH);
    expect(code, allDiagnostics(receipt)).toBe(0);
    const lines = progress.join('\n');
    expect(lines).toContain('Chosen by simulation');
    expect(lines).toContain('rest —');
    // The 1.08 mm gaps are wider than the rest cutter the search finds (a V or a 1 mm flat), so
    // the raised warning has nothing to say once the finding is judged at the rest's width.
    expect(
      allDiagnostics(receipt),
      'the rest cutter separates "Software", so no raised-text warning belongs on this run',
    ).not.toContain('raised-text-fused');
  }, 150_000);

  it('the coin disc with no cutter named: the pick names the pinches that still touch, and "CNX" is left alone', async () => {
    const variant = pickedVariant('j04-coin-disc-pla.json', REAL_JOBS);
    const { code, receipt, progress } = await cut(variant, SCRATCH);
    expect(code, allDiagnostics(receipt)).toBe(0);
    const lines = progress.join('\n');
    expect(lines, 'the pick is measured and explained').toContain('Chosen by simulation');
    // The chosen rest states the raised pinches: how many, where, and the tightest gap.
    expect(lines).toMatch(/pinches? in clear stay joined/);
    expect(lines).toContain('0.278 mm');
    // Judged at the FINEST cutter that cuts the item (the rest), not the clearance cutter: "CNX"
    // survives that width and must not be warned about.
    const fused = receipt.diagnostics.filter((d) => d.code === 'raised-text-fused');
    for (const warning of fused) expect(warning.message).not.toContain('"CNX"');
    // #765 — a warning that does fire names the pinches it leaves, not "the letters will join".
    for (const warning of fused) {
      expect(warning.message).toMatch(/pinch points? stays? joined/);
      expect(warning.message).not.toContain('the letters will join');
    }
    expect(allDiagnostics(receipt), '"CNX" at 7 mm survives the rest cutter').not.toContain('"CNX"');
  }, 150_000);
});

// #749 — A THROUGH CUT-OUT REPEATS ONE FOOTPRINT AT EVERY STEP-DOWN. j24 cuts a puck out of
// 60×60×10 mm 6061 with the 3.175 mm metal O-flute: one closed contour at every pass, so the
// sweep's columns are identical in XY and nested in Z. On the bench that exhausted the wasm heap
// (`RuntimeError: memory access out of bounds`, 4.3 GB, ~100 s); the direct reduction's 64
// columns cost 1 067 840 triangles. The sweep now unions one column per footprint, so the job
// generates, verifies and simulates. The bench recorded no removal for it (it crashed); this is
// the exact sweep's clipped volume for this job's own toolpath, identical over three CLI runs.
