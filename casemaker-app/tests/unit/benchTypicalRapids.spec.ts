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
import { REAL_JOBS, allDiagnostics, cut, cleanupBenchScratch } from './helpers/benchTypicalJobs';
import { resetRegistry } from '@/engine/cnc/toolRegistry';

// #1180 — harness: helpers/benchTypicalJobs.ts; the job families are split so they run in parallel.
afterAll(() => cleanupBenchScratch());
afterEach(() => resetRegistry());

describe('#738 the real jobs leave no rapid through material', () => {
  // #966 triage — #980: a PNG/photo relief has no path on cam/model today (a flat heightfield;
  // the model engine needs a mesh); parked until #980 restores it.
  it.fails('j07 photo relief (2 mm ball): a gap retract lifts before it travels', async () => {
    // Recorded: "5 rapids pass through material still present ... (first at line 72655)", that
    // line being `G0 X49.5 Z1` straight out of `G1 X49.6 Z-0.794`.
    const { code, receipt } = await cut('j07-photo-relief.json', REAL_JOBS);
    const rapid = receipt.diagnostics.filter((d) => d.code === 'rapid-through-stock');
    expect(rapid, 'the rapids the bench recorded must not come back').toEqual([]);
    expect(code, 'a clean job must not be refused by its own simulation').toBe(0);
  }, 150_000);

  // #966 triage — #980: same as above.
  it.fails('j07 photo relief (1 mm ball): the same roughing hop at the finer cutter', async () => {
    // Recorded: 63 rapids, first at line 26169.
    const { code, receipt } = await cut('j07-photo-relief-1mm-ball.json', REAL_JOBS);
    const rapid = receipt.diagnostics.filter((d) => d.code === 'rapid-through-stock');
    expect(rapid, 'the rapids the bench recorded must not come back').toEqual([]);
    expect(code, 'a clean job must not be refused by its own simulation').toBe(0);
  }, 150_000);

  it('j13 tool tray: the through cuts’ breakthrough keeps the sweep’s floor below them', async () => {
    // Recorded: 10 rapids. This job is 2.5D (no surfacing): its refusals were #734 item 1's false
    // positive, and this test pins the `breakthroughMm` plumbing that cleared them.
    const { code, receipt } = await cut('j13-tool-tray.json', REAL_JOBS);
    const rapid = receipt.diagnostics.filter((d) => d.code === 'rapid-through-stock');
    expect(rapid, 'the rapids the bench recorded must not come back').toEqual([]);
    expect(code, 'a clean job must not be refused by its own simulation').toBe(0);
  }, 150_000);
});

// #739 — RAISED TEXT NARROWER THAN THE CUTTER. j02 clears a 92 × 82 mm panel 1 mm deep with a
// 3.175 mm flat and leaves two construction labels standing: "CNX" at 24 mm survives as three
// separate letters, while "Software" at 14 mm fuses into one blob — the bench saw it and the
// engine said nothing. j04 is the same failure in the coin proxy: "Software" at 3.6 mm with a
// 1 mm flat. The trigger must be the measured geometry, not a size threshold: "CNX" is smaller
// than the cutter in pairwise places (N–X come within 3.11 mm) yet the opening still clears the
// gaps, which is why it must stay silent.

describe('#739 raised text warns when its gaps are narrower than the cutter', () => {
  it('j02 raised CNX: "Software" fuses at the 3.175 mm cutter, and "CNX" is left alone', async () => {
    const { code, receipt } = await cut('j02-raised-cnx.json', REAL_JOBS);
    const fused = receipt.diagnostics.filter((d) => d.code === 'raised-text-fused');
    expect(fused, allDiagnostics(receipt)).toHaveLength(1);
    const warning = fused[0]!;
    expect(warning.severity, 'a narrowed gap is a warning, not a refusal').toBe('warning');
    expect(warning.message).toContain('"Software"');
    expect(warning.message).toContain('14 mm');
    expect(warning.message).toContain('1.08 mm');
    expect(warning.message).toContain('3.175 mm');
    expect(warning.message).toContain('42 mm');
    expect(allDiagnostics(receipt), '"CNX" survives the same cutter and must not be warned about').not.toContain(
      '"CNX"',
    );
    expect(code, 'a warning must not refuse the job').toBe(0);
  }, 150_000);

  it('j04 coin proxy: "Software" at 3.6 mm fuses at the 1 mm corn bit', async () => {
    const { code, receipt } = await cut('j04-coin-pla-proxy.json', REAL_JOBS);
    const fused = receipt.diagnostics.filter((d) => d.code === 'raised-text-fused');
    expect(fused, allDiagnostics(receipt)).toHaveLength(1);
    const warning = fused[0]!;
    expect(warning.message).toContain('"Software"');
    expect(warning.message).toContain('3.6 mm');
    expect(warning.message).toContain('0.278 mm');
    expect(warning.message).toContain('1 mm cutter');
    expect(warning.message).toContain('13 mm');
    // #818 — the ⌀1 rest is the fused result the bench saw: every ridge is 0.242 mm or more, above
    // the 0.15 mm visible width, so all seven pairs stay joined.
    expect(warning.message).toContain('7 of its 7 pinch points stay joined');
    // #765 — the warning names the pinches the cut leaves joined, never the whole word as one blob.
    expect(warning.message).toMatch(/\d+ of its \d+ pinch points? stays? joined/);
    expect(warning.message).toContain('between');
    expect(warning.message).not.toContain('the letters will join');
    expect(allDiagnostics(receipt), '"CNX" at 7 mm survives the same cutter').not.toContain('"CNX"');
    expect(code, 'a warning must not refuse the job').toBe(0);
  }, 150_000);
});

// #760/#765/#766 — THE PICK IS MEASURED. A raised cut-away's detail is what the simulation says
// the cut leaves; the search tries the kind-valid plans (a clearance cutter plus a finer rest, a
// V rest included) and hands back the best POSTING one. These two demo jobs are the acceptance:
// j02's "Software" at 14 mm and the coin's at 3.6 mm both get a rest cutter that separates the
// word (with the pinches that still touch named), and the run still cuts.
