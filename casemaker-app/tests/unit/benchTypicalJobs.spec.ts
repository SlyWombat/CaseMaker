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

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, afterAll, describe, expect, it } from 'vitest';
import { tl } from './helpers/manifoldExec';
import { BUDGET_MS, REAL_JOBS, SCRATCH, allDiagnostics, benchEngraver, benchJob, cut, vertexCount, cleanupBenchScratch } from './helpers/benchTypicalJobs';
import { resetRegistry } from '@/engine/cnc/toolRegistry';
import { makeClipperOffset } from '@/engine/cnc/cam/engraveJob';
import { pocketLoops } from '@/engine/cnc/cam/pocket';
import { engraveRegions } from '@/workers/sim/engraveGenerate';
import { renderReceipt } from '../../src/platform/headless/receipt';
import { parseEngraveJob } from '@/store/engraveJobSchema';

// #1180 — harness: helpers/benchTypicalJobs.ts; the job families are split so they run in parallel.
afterAll(() => cleanupBenchScratch());
afterEach(() => resetRegistry());

describe('#734 the typical jobs run clean through the cut pipeline', () => {
  it('j17 PLA proxy: no rapid crosses material still present, so the cut is not refused', async () => {
    // The bench recorded: {"code":"rapid-through-stock","sentence":"7 rapids pass through
    // material still present at that point in the program (first at line 976)"} — the job's own
    // through cuts reach `thickness + breakthrough`, and the sweep's floor did not.
    const { code, receipt } = await cut('j17-faceplate-proxy.json');
    const rapid = receipt.diagnostics.filter((d) => d.code === 'rapid-through-stock');
    expect(rapid, 'the false rapids the bench recorded must not come back').toEqual([]);
    expect(code, 'a clean job must not be refused by its own simulation').toBe(0);
  }, 120_000);

  it('j05 V-carve region: a pocket ring is offset from the original region, so its vertices cannot compound', () => {
    // The bench job's "OPEN" glyph outline is ONE region of 555 vertices. `pocketLoops` used to
    // offset each ring from the PREVIOUS ring, and Clipper's round joins at the glyph's reflex
    // corners add vertices that the next offset doubles again: at this pitch (a coarse 0.5 mm
    // cutter / 0.4 mm step-over, chosen so the old growth is visible in milliseconds) the old
    // rings grow 494 → 886 → 1678 → 3262, and at the job's real 0.15 mm pitch a ring reached
    // 342 494 vertices — which is why the cut never finished. Each ring now offsets the ORIGINAL
    // region and stays near the input's own count (measured 494–553 here). A ring carrying more
    // than twice the input is the compounding defect, not a legitimate offset.
    const job = benchJob('j05-two-colour-sign-adjusted.json');
    const { regions } = engraveRegions(tl, job, benchEngraver(0.3));
    expect(regions.length).toBeGreaterThan(0);
    const region = regions[0]!.polygons;
    const inputVerts = vertexCount(region);
    expect(inputVerts).toBeGreaterThan(300); // the real glyph outline, not a stand-in

    const rings = pocketLoops(region, 0.5, 0.4, makeClipperOffset(tl));
    expect(rings.length).toBeGreaterThan(1);
    rings.forEach((ring, k) => {
      expect(vertexCount(ring), `ring ${k} of ${rings.length}`).toBeLessThanOrEqual(2 * inputVerts);
    });
  });

  it('j05 two-colour sign: the 30° 0.3 V-bit job finishes inside the 600 s budget', async () => {
    const started = Date.now();
    const { code, receipt } = await cut('j05-two-colour-sign-adjusted.json');
    const elapsed = Date.now() - started;
    const errors = receipt.diagnostics.filter((d) => d.severity === 'error');
    expect(errors, 'the bench job must cut without an error diagnostic').toEqual([]);
    expect(code, 'a clean job must complete, not be refused').toBe(0);
    expect(elapsed, `cut took ${elapsed} ms`).toBeLessThan(BUDGET_MS);
  }, 150_000);

  it('j11 inlay female: the 5.1 mm pocket is cut to the cutter’s 4.992 mm cone and stated (#741, #786 slice 3)', async () => {
    // The bench's own recipe asks for a 5.1 mm pocket with a 30° × 0.5 mm engraver whose cone
    // reaches its ⌀3.175 mm body at 4.9916 mm. #786 slice 3 — the cut stops at the cone and the
    // sentence states the shortfall; the program IS written. j05 above still pins the ring-growth
    // fix.
    const { code, receipt } = await cut('j11-inlay-female.json');
    const depth = receipt.diagnostics.filter((d) => d.code === 'vcarve-depth-beyond-cone');
    expect(depth.map((d) => d.severity), JSON.stringify(receipt.diagnostics)).toEqual(['warning']);
    expect(depth[0]!.message).toContain('5.1 mm');
    expect(depth[0]!.message).toContain('4.992 mm');
    expect(receipt.command).toBe('engrave');
    if (receipt.command !== 'engrave') return;
    expect(receipt.details.programs.length, 'the clamped job writes its program').toBeGreaterThan(0);
    expect(code, 'a warned job exits zero').toBe(0);
  }, 60_000);
});

// #738 — THE REAL JOBS' RAPIDS. The bench refused four jobs for `rapid-through-stock`. Splitting
// the refusal by cause is the point of these tests:
//
//   j13 tool tray (10 rapids) — #734 item 1's false positive, not a CAM defect: a taped through
//     cut reaches `thickness + breakthrough`, and the sweep's floor was the blank's bottom. The
//     fix that passes `breakthroughMm` to the sweep clears it; it is pinned here so it cannot
//     regress.
//   j06 wolf and j07 photo relief (16, 5 and 63 rapids) — ONE genuine surfacing CAM defect:
//     `roughingMoves` emerged from a gap with a single `G0 X.. Z..` rapid instead of the house
//     two-move hop (a Z-only retract, then the XY traverse at `HOP_Z`), so the tool climbed away
//     diagonally through material still standing beside the cut. Both goals run through the same
//     `surface3d.ts` pass. j06's STL bytes are deliberately not committed (the exercise README
//     says how to rebuild them), so its committed job cannot be surfaced by a test; the IR-level
//     rule is asserted for the same code path in `surface3d.spec.ts`.
//
// The exercise ran each job under a 600 s timeout. The surfacing jobs measured here generate in
// 1.3–2.0 s and sweep in 5.8–6.6 s (j06's uncommitted bench copy: 10.5 s), so 150 s is ample.

describe('#747 the frame is traced inside the envelope, and never gates a verified program', () => {
  it('fx-frame-pocket (22.8 mm hardwood): the frame is written at a reachable Z', async () => {
    const { code, receipt } = await cut('fx-frame-pocket.json', REAL_JOBS);
    if (receipt.command !== 'engrave') throw new Error('expected the engrave receipt');
    // Before #747: exit 1, stage verify, "the frame file has 5 verifier error(s)", no program and
    // no frame file in `outputs`, and the five findings absent from `diagnostics`.
    expect(code, allDiagnostics(receipt)).toBe(0);
    expect(receipt.refusals, allDiagnostics(receipt)).toEqual([]);
    expect(receipt.diagnostics.filter((d) => d.message.includes('outside-envelope'))).toEqual([]);
    expect(receipt.details.programs[0]!.frameFile).toBe('fx-frame-pocket-frame.nc');
    const frame = receipt.outputs.find((o) => o.path.endsWith('-frame.nc'));
    expect(frame, 'the frame file the operator loads must be written').toBeDefined();
    // The POSTED height, to the dialect's three decimals: 19.999 + the 22.8 mm WCS origin is
    // machine Z -0.001, inside the envelope; 20 would be +3.6e-15 and refused.
    const frameText = readFileSync(frame!.path, 'utf8');
    expect(frameText).toContain('G0 Z19.999');
    // ... and the sheet prints the height in the file, never the 20 mm constant.
    const sheetPath = receipt.outputs.find((o) => o.path.endsWith('-run-sheet.md'))!.path;
    expect(readFileSync(sheetPath, 'utf8')).toContain('19.999 mm above the work');
  }, 150_000);

  it('a frame that leaves the envelope is WITHHELD with its findings on the receipt, and the program is still written', async () => {
    // The forced case: a 200 mm blank fills the envelope exactly, its under-board overhangs 6 mm
    // to the right, and a 5 mm pocket sits at the right edge. The job's own cutter CENTRE path
    // stays inside (machine X <= 0), so its verifier passes; the frame is the cutter's FOOTPRINT,
    // grown by its radius, and reaches machine X +1.494 — outside. The overhang keeps the depth
    // limit positive where the footprint reaches, so `cut-outside-stock` stays happy: this is the
    // frame's failure alone.
    const parsed = parseEngraveJob(JSON.parse(readFileSync(join(REAL_JOBS, 'fx-frame-pocket.json'), 'utf8')));
    if (!parsed.ok) throw new Error(parsed.errors.join('; '));
    const job = parsed.job;
    job.name = 'fx-frame-outside';
    job.stock.length = 200;
    job.stock.thickness = 12;
    if (job.sacrificial?.under == null) throw new Error('the fixture must carry its under-board');
    job.sacrificial.under.thickness = 3;
    job.sacrificial.under.overhang = { left: 0, right: 6, front: 0, back: 0 };
    const hold = job.workholding;
    if (hold.kind !== 'bracket') throw new Error('the fixture must hold with the bracket');
    const shape = job.shapes[0]!;
    if (shape.kind !== 'circle') throw new Error('the fixture shape must be the circle pocket');
    shape.diameter = 5;
    shape.depth = 2;
    shape.position = { x: 199, y: 67 };
    // #1068 — the clamps must clear the pocket this test draws (a ⌀5 at (199, 67) on the right
    // edge): the CLI now checks the mount it states, and a right clamp at 67 would sit over it.
    for (const clamp of hold.bracket.clamps) clamp.at = clamp.edge === 'back' ? 100 : 20;
    writeFileSync(join(SCRATCH, 'fx-frame-outside.json'), JSON.stringify(job, null, 2));

    const { code, receipt } = await cut('fx-frame-outside.json', SCRATCH);
    if (receipt.command !== 'engrave') throw new Error('expected the engrave receipt');
    // Before #747 this run STOPPED: the frame's two errors made the whole result `ok: false`, no
    // program was written, and the findings never reached the receipt.
    expect(code, allDiagnostics(receipt)).toBe(0);
    expect(receipt.refusals, allDiagnostics(receipt)).toEqual([]);
    const program = receipt.details.programs[0]!;
    expect(program.frameFile, 'a refused frame is withheld, not handed over').toBeNull();
    expect(receipt.outputs.some((o) => o.path.endsWith('-frame.nc')), 'no frame file may be written').toBe(false);
    expect(
      receipt.outputs.some((o) => o.path.endsWith('.nc') && !o.path.endsWith('-frame.nc')),
      'the verified program itself is still written',
    ).toBe(true);
    // The frame's findings, with their machine coordinates, are on the receipt as the FRAME'S —
    // `source: 'frame'`, so they cannot be read as the program's — and, the frame being withheld,
    // demoted to warnings: the program itself passed and is still runnable.
    const frameErrors = receipt.diagnostics.filter(
      (d) => d.source === 'frame' && d.message.includes('outside-envelope'),
    );
    expect(frameErrors.length, allDiagnostics(receipt)).toBeGreaterThan(0);
    expect(frameErrors[0]!.severity).toBe('warning');
    expect(frameErrors[0]!.message).toContain("leaves the Makera Z1's envelope");
    // The TEXT receipt prints them, labelled as the frame's, as well as carrying them as data.
    const rendered = renderReceipt(receipt).join('\n');
    expect(rendered).toContain('     frame warn  runner-error: outside-envelope:');
    // ... and why the frame is absent: a warning, because the program never depended on the trace.
    const withheld = receipt.diagnostics.find((d) => d.code === 'no-frame');
    expect(withheld, allDiagnostics(receipt)).toBeDefined();
    expect(withheld!.severity).toBe('warning');
    expect(withheld!.source).toBe('frame');
    expect(withheld!.message).toContain('withheld');
    expect(rendered).toContain('     frame warn  no-frame: The frame file was withheld');
    // The sheet says the program can still be cut, rather than "do not run this file".
    const sheetPath = receipt.outputs.find((o) => o.path.endsWith('-run-sheet.md'))!.path;
    const sheet = readFileSync(sheetPath, 'utf8');
    expect(sheet).toContain('itself passed verification, so it can still be cut');
    expect(sheet).not.toContain('Do not run this file');
  }, 150_000);
});

// #766 slice E — THE DEMO SET. The 2026-10-29 demo re-run (`results8`) ran the fifty recordings
// in `docs/bench/2026-10-28-z1-real-jobs` with each job's cutter REMOVED, so the app chooses as a
// demo visitor would. Nine stopped posting under the measured search that had posted under the
// rules before it; the fix (19f18d40) makes the measured search never do worse than the rule, and
// the rows below pin what it chooses now.
//
// THE WOLF PAIR IS NOT HERE. Its 24 MB mesh bytes are not committed with the corpus document (the
// demo run used a scratch copy that carried them), so the committed job cannot generate at all.
// The goal-item seam its refusal named is covered by the photo-relief rows (a PNG relief) and the
// mouse shell (a 1.2 MB STL); the two coaster rows that complete the nine exist only in the demo
// scratch set. Every row here records the cutter the search chose and the fidelity it measured, so
// a choice that drifts — a different cutter, a lower score, a refusal — turns the gate red.

/**
 * The bench location plus ONE cutter: a ball whose flute reaches j27's 26 mm stock. The demo
 * library holds such a cutter; every ball in the bench fixture is 12 mm or shorter, and the reach
 * filter then leaves the 26 mm job with no candidate plan at all — a library limit, not the
 * search behaviour this suite pins. The catalogue is the bench one in the same directory.
 */

