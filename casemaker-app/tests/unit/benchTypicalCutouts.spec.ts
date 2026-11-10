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
import { BUDGET_MS, REAL_JOBS, allDiagnostics, cut, j24Location, programText, type Run, cleanupBenchScratch } from './helpers/benchTypicalJobs';
import { resetRegistry } from '@/engine/cnc/toolRegistry';

// #1180 — harness: helpers/benchTypicalJobs.ts; the job families are split so they run in parallel.
afterAll(() => cleanupBenchScratch());
afterEach(() => resetRegistry());

describe('#749 the j24 through cut-out sweeps its 103 repeated footprints', () => {
  it('generates the puck program and reports the exact removal inside the bench budget', async () => {
    const started = Date.now();
    const { code, receipt } = await cut('j24-spoke-wrench-z.json', REAL_JOBS, j24Location());
    const elapsed = Date.now() - started;
    expect(allDiagnostics(receipt), 'the kernel crash must not be reported as a stage error').not.toContain(
      'stage-error',
    );
    expect(code, allDiagnostics(receipt)).toBe(0);
    if (receipt.command !== 'engrave') throw new Error('expected the engrave receipt');
    const program = receipt.details.programs[0]!;
    expect(program.sim, 'the puck program must be swept').not.toBeNull();
    expect(program.sim!.ok, allDiagnostics(receipt)).toBe(true);
    expect(program.sim!.engine).toBe('exact');
    expect(program.sim!.errorCount).toBe(0);
    // One checkpoint per depth pass (the job's 0.2 mm step-down leaves 100) plus the plunge.
    // The old union still returned at 16 passes; this is the count that used to crash.
    expect(program.sim!.count).toBe(103);
    // Exactly the material one column removes — not a sum over stacked duplicates, and not less.
    // A dedupe that dropped a non-nested column would move this by hundreds of mm³.
    expect(program.sim!.removedVolumeMm3).toBeCloseTo(4705.0126, 1);
    expect(elapsed, `cut took ${elapsed} ms`).toBeLessThan(BUDGET_MS);
  }, 150_000);
});

// #746 — A SETUP'S LATER CUTTERS CUT THEIR OWN ITEMS. j19, j24 and j25 each name one setup with
// three cutters and a `toolItems` map, and every one of them was refused before the fix: each item
// assigned to a later cutter was re-planned as a REST pass of the first cutter's design ("rest of
// Bore ⌀14", 10.3 mm deep on 10 mm stock; "rest of Pocket rect 78×48"), a cut-out lost the
// construction outline it follows, and a V-bit after a flat was refused outright. The tests below
// run the committed fixture as ONE job and read the written programs:
//
//   - every cutter gets exactly one program, in the setup's cut order;
//   - the later cutter's program cuts ITS items at THEIR depth — a through item is posted to
//     `thickness + breakthrough` and nothing at the first cutter's through depth leaks into it;
//   - no program calls anything "rest of …" (that was the defect's fingerprint).

describe('#746 a setup’s later cutters cut the items they own, as those items', () => {
  /** Every engrave program the run wrote, in cut order. */
  function programs(run: Run) {
    const { receipt } = run;
    if (receipt.command !== 'engrave' || receipt.details === null) throw new Error('not an engrave receipt');
    return receipt.details.programs;
  }

  /** The cutter key the program's own header states. */
  function cutterOf(nc: string): string {
    return /^;@CM\|TOOL\|key=(.+)$/m.exec(nc)?.[1] ?? 'no tool key';
  }

  /**
   * Every Z word the program posts, exactly as written. `toContain('Z-4')` matched `Z-4.25` too;
   * an exact word cannot (`'-4'` is not `'-4.25'`), so a floor assertion cannot be satisfied by a
   * deeper cut on another item by accident.
   */
  function zWords(nc: string): string[] {
    return [...nc.matchAll(/\bZ(-?\d+(?:\.\d+)?)\b/g)].map((match) => match[1]!);
  }

  it('j19 accuracy sample: four programs, the cut-out last, and the 1.5’s through items stay through', async () => {
    const run = await cut('j19-accuracy-sample.json', REAL_JOBS);
    const text = allDiagnostics(run.receipt);
    // The defect's own refusals: a combined cutaway's operands were dropped from the sub-job, and a
    // later cutter's items were re-planned as "rest of …".
    expect(text, 'the combined cutaway’s construction operands must resolve').not.toContain('item-reference');
    expect(text, 'no item may be re-planned as a rest pass it was not assigned').not.toContain('rest of');
    expect(run.code, text).toBe(0);
    const written = programs(run);
    // #746 CUT-OUTS POST LAST. The 3.175 owns `outline` (the cut-out) but also `skim`, so cutting
    // both in one file would free the part before the 1.5 and the engraver touched it. The cut-out
    // is the setup's final program, on the first cutter again.
    expect(written).toHaveLength(4);
    const nc = written.map((p) => programText(run, p.ncFile));
    expect(nc.map(cutterOf)).toEqual([
      'inv:kz-o-flute-m-3-175-12',
      'inv:kz-o-flute-m-1-5-6',
      'inv:kz-engrave-m-30-0-2',
      'inv:kz-o-flute-m-3-175-12',
    ]);
    // Only the last file cuts the outline free; nothing before it may release the part.
    for (const early of nc.slice(0, 3)) expect(early).not.toContain('Cut out ');
    expect(nc[3]).toContain('Cut out ');
    // The flat cutter that owns the through vectors and bores cuts them THROUGH: 5 mm stock plus
    // the setup's 0.3 mm breakthrough.
    expect(zWords(nc[1]!), 'the 1.5 mm cutter’s through items are posted through the stock').toContain('-5.3');
    // The engraver owns the logo and its frame, at their stated 1.3 mm — not a rest of anything.
    expect(zWords(nc[2]!), 'the engraver’s own floor is exactly 1.3 mm').toContain('-1.3');
  }, 240_000);

  it('j24 spoke wrench: the bore on the 3.175, the notches on the 1.5, the labels on the engraver, the cut-out last', async () => {
    const run = await cut('j24-spoke-wrench.json', REAL_JOBS);
    const text = allDiagnostics(run.receipt);
    // Recorded: `depth-exceeds-stock` on "rest of Bore ⌀14" and "rest of Cut out outside Pocket
    // circle ⌀44" (both 10.3 mm deep on a 10 mm stock), `item-reference` on "puck", and
    // `through-tool-reach` on the later cutter for a cut-out that is the first cutter's.
    for (const code of ['depth-exceeds-stock', 'item-reference', 'through-tool-reach', 'item-detail-lost']) {
      expect(text, `the recorded ${code} refusal must not come back`).not.toContain(code);
    }
    expect(text).not.toContain('rest of');
    expect(run.code, text).toBe(0);
    const written = programs(run);
    expect(written).toHaveLength(4);
    const nc = written.map((p) => programText(run, p.ncFile));
    expect(nc.map(cutterOf)).toEqual([
      'inv:kz-o-flute-m-3-175-12',
      'inv:kz-o-flute-m-1-5-6',
      'inv:kz-engrave-m-30-0-2',
      'inv:kz-o-flute-m-3-175-12',
    ]);
    // The puck cut-out frees the part, so it is the LAST file and no earlier file cuts it.
    for (const early of nc.slice(0, 3)) expect(early).not.toContain('Cut out ');
    expect(nc[3]).toContain('Cut out ');
    // The first cutter owns the bore (⌀14, through): 10 mm stock.
    expect(zWords(nc[0]!), 'the bore is posted through the 10 mm stock').toContain('-10.3');
    // #666 — the recess is a SHAPE pocket in 6061 aluminium cut by a flat end mill, so the first
    // cutter clears it ADAPTIVELY: the real job takes the route the unit fixture does, the run
    // states the plan, and the program names the operation. (The notch and label cutters own
    // vectors and text, not pockets, so they keep their rings.)
    expect(text, 'the recess is cleared adaptively (#666)').toContain('adaptive-clearing');
    // #922 — the CLI's shop now carries the location's real `finish.stockToLeaveMm` (the app always
    // has; see 49b1ff2e, which split j13's program the same way), so the recess's rough pass leaves
    // an allowance and runs a finish pass behind it: the label is `(rough, adaptive)`, not the bare
    // `(adaptive)` a zero allowance would post. Either way the pass is adaptive, never the fallback
    // ring (checked above and below), so the match only pins the suffix, not the optional kind.
    expect(nc[0]).toContain('adaptive)');
    expect(text, 'the planner must not decline the recess').not.toContain('adaptive-fallback');
    // The 1.5 mm cutter owns four 4 mm notches. Its file must NOT carry the first cutter's through
    // depth — that was "rest of Bore ⌀14", refused at 10.3 mm — and its own floor is exactly 4 mm
    // (`Z-4` would also be a prefix of the engraver's `Z-4.25`; the exact word is not).
    const notches = zWords(nc[1]!);
    expect(notches, 'the 1.5’s own floor is exactly 4 mm').toContain('-4');
    expect(notches, 'the first cutter’s through bore must not be re-cut by the 1.5').not.toContain('-10.3');
    expect(notches, 'the engraver’s 4.25 mm floor is not the 1.5’s').not.toContain('-4.25');
    // The engraver owns the labels at 4.25 mm, and nothing else.
    const engraver = zWords(nc[2]!);
    expect(engraver, 'the engraver’s own floor is exactly 4.25 mm').toContain('-4.25');
    expect(engraver).not.toContain('-10.3');
  }, 240_000);

  it('j25 truing wrench: the hole on the 3.175, the rotor slot on the 1.5, the grooves on the engraver, the cut-out last', async () => {
    const run = await cut('j25-truing-wrench.json', REAL_JOBS);
    const text = allDiagnostics(run.receipt);
    // Recorded: the job was refused `setup-rest-unavailable` because the third cutter is a V-bit —
    // it was being asked to be a rest cutter instead of cutting its own grooves.
    expect(text, 'a V-bit that owns items must not be refused as a rest cutter').not.toContain('setup-rest-unavailable');
    expect(text).not.toContain('rest of');
    expect(run.code, text).toBe(0);
    const written = programs(run);
    expect(written).toHaveLength(4);
    const nc = written.map((p) => programText(run, p.ncFile));
    expect(nc.map(cutterOf)).toEqual([
      'inv:kz-o-flute-m-3-175-12',
      'inv:kz-o-flute-m-1-5-6',
      'inv:kz-engrave-m-30-0-2',
      'inv:kz-o-flute-m-3-175-12',
    ]);
    // `bar-out` frees the bar, so it posts after every other cutter.
    for (const early of nc.slice(0, 3)) expect(early).not.toContain('Cut out ');
    expect(nc[3]).toContain('Cut out ');
    // The 1.5 mm cutter owns the rotor slot, a THROUGH vector on 4 mm stock: posted to 4 + 0.3.
    // The through flag is what the defect dropped, and re-planning it as a 4 mm-deep pocket on a
    // 4 mm stock is what `depth-exceeds-stock` refused.
    expect(zWords(nc[1]!), 'the later cutter’s through slot stays through').toContain('-4.3');
    // The engraver owns the three 0.3 mm grooves and cuts them at their own depth.
    const grooves = zWords(nc[2]!);
    expect(grooves, 'the engraver’s own floor is exactly 0.3 mm').toContain('-0.3');
    expect(grooves, 'the engraver must not re-cut the earlier cutters’ work').not.toContain('-4.3');
  }, 240_000);
});

// #747 — THE FRAME'S Z IS THE MACHINE'S, NOT A CONSTANT. `fx-frame-pocket` is a 22.8 mm hardwood
// bracket job whose own program verified, but whose frame trace was refused with five
// `outside-envelope` errors, none of which the receipt carried, and the whole run stopped at
// verify with no file written. The cause is arithmetic, not the fixture: the stub puts every
// blank's top face at the machine's tool-change safe Z, so a frame at work Z 20 lands exactly on
// the envelope's top; for a 22.8 mm blank the WCS origin is -19.999999999999996 and 20 + origin is
// +3.6e-15 mm — outside by femtometres. The frame now traces at the highest work Z that posts
// inside the envelope (19.999 here, machine -0.001), and a frame that cannot be traced at all is
// withheld with its findings on the receipt while the verified program is still written.
