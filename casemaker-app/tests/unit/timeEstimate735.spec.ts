// #735 item 4 — the predicted time is the TOOLPATH's cycle time, and j02's source figure is not
// the same measurement.
//
// The bench set records CNX Software's j02 (letters milled into a plastic sheet) as "app feeds
// 12000/500/200, 2 x 0.5 mm; source 12000/500/150, 0.5 mm stepdown, 7-10 min; app predicts
// 2.0 min". The issue reads the gap as our estimate being too low. This spec profiles the fixture
// with the cutter it names and pins what the model actually times:
//
//   * 1 operation, 1494 feed moves — 2 x 0.5 mm into a 1 mm deep pocket;
//   * 792.246 mm of XY cutting plus 28 mm of Z plunge (16 plunges at F200) — 95.07 s + 8.40 s =
//     103.47 s with NO acceleration at all;
//   * 88.370 mm of XY rapid on the Z1's own rapid model (1200 mm/min XY, 600 Z, 150 mm/s^2);
//   * 120.391 s total = "2 min 0 s" = the manifest's 2.0 min.
//
// The 17 s between the closed form and the estimate is the model's deliberate cost: 162 feed runs
// each pay a start and a stop (56 of them end inside v^2/a = 0.463 mm, so they never reach F500),
// and every rapid is its own trapezoid (#281). It is the same run model whose badge evidence is
// quoted in `JUNCTION_CORNER_DEG` (165 s modelled / ~255 s measured at F1000, 249 s with the 10°
// corner rule). The post carries one `T1 M6` and the vacuum's M331/M332 and no G4 dwell; the model
// charges nothing for them (as its doc now says), but a tool change and vacuum-on are seconds — not
// the five minutes by which the source band exceeds this program.
//
// The source's 7-10 min at 500 mm/min is 3500-5000 mm of path — 4.4-6.3x this program's 792 mm —
// or, held to this path, a feed of 79-113 mm/min. Either way the source ran a different or much
// slower program than the fixture describes: the two figures are not like-for-like, and nothing in
// the evidence shows the model wrong. The pin below is the #735 conclusion: if a CAM or model
// change moves these numbers, the "no defect" verdict is re-opened rather than silently kept.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRunSheet, formatDuration } from '@/engine/cnc/engrave/runSheet';
import { flatEndMill } from '@/engine/cnc/tool';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import type { EngraveJob } from '@/types/engraveJob';
import { generate } from './helpers/engravePipeline';
import { tl } from './helpers/manifoldExec';

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH = resolve(HERE, '../../../docs/bench/2026-10-27-z1-typical-jobs/jobs');

/** The fixture's cutter: the bench set's 3.175 mm O-flute, 25 mm of flute. */
function benchJob(): EngraveJob {
  const parsed = parseEngraveJob(
    JSON.parse(readFileSync(resolve(BENCH, 'j02-letters-plastic.json'), 'utf8')),
  );
  if (!parsed.ok) throw new Error(`the bench fixture no longer parses: ${JSON.stringify(parsed.errors)}`);
  return { ...parsed.job, tool: flatEndMill(3.175, { fluteLength: 25, handleDiameter: 3.175 }) };
}

describe('#735 item 4 — j02’s predicted time is the toolpath’s cycle time', () => {
  it('pins the measured breakdown: 792 mm cutting, 88 mm rapid, 120.391 s = the sheet’s 2 min 0 s', () => {
    const job = benchJob();
    const g = generate(tl, job);
    expect(g.ok, `${g.stage}: ${JSON.stringify(g.errors)}`).toBe(true);
    const cam = g.cam!;

    // The program: one text pocket at 2 passes of 0.5 mm one millimetre deep.
    expect(cam.operations).toBe(1);
    expect(cam.cuttingMoves).toBe(1494);
    expect(cam.passes).toBe(2);
    expect(cam.passSteps).toEqual([{ stepMm: 0.5, passes: 2 }]);

    // The travel the model times. These are the numbers a changed model or CAM would move.
    expect(cam.cutMm).toBeCloseTo(792.2462876250668, 6);
    expect(cam.rapidMm).toBeCloseTo(88.37017435417084, 6);
    expect(cam.estimatedSeconds).toBeCloseTo(120.3911614112349, 6);

    // ...and the model's own overhead stays the planning margin it claims to be. With no
    // acceleration the same travel is 792.246 mm at F500 plus 28 mm of plunge at F200 (16 plunges,
    // measured from the IR) = 103.47 s. The estimate is 16.92 s over that: 162 feed runs' start and
    // stop (56 under v²/a = 0.463 mm) plus every rapid's own trapezoid (9.69 s of the 120.39).
    const noAccel = cam.cutMm! / (500 / 60) + 28 / (200 / 60);
    expect(cam.estimatedSeconds - noAccel).toBeGreaterThan(10);
    expect(cam.estimatedSeconds - noAccel).toBeLessThan(20);

    // 2.0065 min rounds to the manifest's predicted 2.0 min.
    expect(Math.round((cam.estimatedSeconds / 60) * 10) / 10).toBe(2.0);

    // The operator sees the same figure in the file's header and on the sheet's header — one
    // number, three surfaces (`estimateIRCycleSeconds`' contract).
    expect(g.nc).toContain(';@MKR|TIME|seconds=120');
    expect(formatDuration(cam.estimatedSeconds)).toBe('2 min 0 s');
    const sheet = buildRunSheet(job, g, null);
    expect(sheet.header.estimatedTime).toBe('2 min 0 s');
    // ...and the note beside it says what the number is: the Z1's rapid model, a planning estimate.
    expect(sheet.header.estimatedTimeNote).toContain('1200 mm/min XY');
    expect(sheet.header.estimatedTimeNote).toContain('a planning estimate, not a measured cycle time');
  });

  it('the source band implies 4.4–6.3× this cutting path at its own 500 mm/min — not like-for-like', () => {
    // 7 min at 500 mm/min is 3500 mm of path; 10 min is 5000 mm. The fixture's whole XY cutting is
    // 792.246 mm. The shortest quoted run therefore covers at least 4.4× our path, and 4× is the
    // margin this pin keeps: if the CAM ever produces a path that long, the conclusion changes from
    // "different programs" to "our path is missing something", and this test must be revisited.
    // (The sign is not affected by the 28 mm of plunge the XY figure excludes.)
    const g = generate(tl, benchJob());
    const cutMm = g.cam!.cutMm!;
    expect(cutMm).toBeCloseTo(792.2462876250668, 6);
    expect(cutMm * 4).toBeLessThan((7 * 60 * 500) / 60);
  });
});
