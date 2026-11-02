// #877 — A STATED MACHINE'S RUN SHEET IS THE OPERATOR'S OWN SENDER'S. The body used to print the
// Z1's probe fitting, `M491` tool-length calibration and PRB arithmetic on a Shapeoko, where none
// of that exists: the owner zeroes in UGS/Candle/gSender. This spec pins the sender's body, the
// origin convention it names, and — as a control — that a Makera machine's sheet is unchanged.
import { describe, expect, it } from 'vitest';

import { SHAPEOKO_4, Z1, workOriginOf, type MillModel } from '@/engine/cnc/machine';
import { buildRunSheet, type RunSheetGenerated } from '@/engine/cnc/engrave/runSheet';
import { renderRunSheetMarkdown } from '../../scripts/runSheetMarkdown';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { dedupeFindings, jobTool, validateJob } from '@/engine/cnc/engrave/jobSetup';
import { feedsFor } from '@/engine/cnc/feeds';
import type { EngraveJob } from '@/types/engraveJob';

const NOW = new Date('2026-11-01T12:00:00.000Z');
const NC = [';@MKR|BEGIN', 'G21 G90', 'G1 Z-2.000 F200', 'G1 X10 Y10 F500', 'M5', 'M30'].join('\n');

function dj(): EngraveJob {
  const job = defaultEngraveJob();
  job.toolKey = 'flat-1.0';
  return job;
}

function markdownFor(job: EngraveJob, statedOrigin?: ReturnType<typeof workOriginOf>): string {
  const tool = jobTool(job);
  const generated: RunSheetGenerated = {
    findings: dedupeFindings(validateJob(job)),
    feeds: tool ? feedsFor([], job.stock.material, tool, Z1, job.cutOverride) : null,
    cam: { operations: 3, cuttingMoves: 1234, estimatedSeconds: 95, passes: 2 },
    nc: NC,
    verify: {
      ok: true,
      findings: [],
      stats: { lines: 6, cuttingMoves: 2, deepestZ: -2, bbox: { min: [0, 0, -2], max: [10, 10, 0] } },
    },
    frameNc: null,
  };
  const sheet = buildRunSheet(job, generated, { diagnostics: [] }, NOW, undefined, {
    dialectName: 'GRBL 1.1',
    ...(statedOrigin === undefined ? {} : { statedOrigin }),
  });
  return renderRunSheetMarkdown(sheet);
}

/** A stated machine run from its owner's sender: the words that are Makera's alone. */
function makeraWords(text: string): string[] {
  return ['M491', 'PRB', 'Studio', 'Z1', 'Makera', 'wired probe', 'tool-length calibration'].filter((w) => text.includes(w));
}

describe('#877 — the run sheet body on a stated machine', () => {
  it('speaks the sender’s zero, with the G10 line only as an aside', () => {
    const md = markdownFor(dj(), workOriginOf(SHAPEOKO_4));
    expect(md).toContain('Zero X, Y and Z in your sender');
    expect(md).toContain('front-left corner');
    expect(md).toContain('G10 L20 P1 X0 Y0 Z0');
    expect(md).toContain('The file is posted against G54');
    // The G10 line is the SECOND way, not the instruction: the zero is set in the sender first.
    expect(md.indexOf('Zero X, Y and Z in your sender')).toBeLessThan(md.indexOf('G10 L20 P1 X0 Y0 Z0'));
  });

  it('has none of the Z1’s probe, tool-length calibration or PRB vocabulary', () => {
    const md = markdownFor(dj(), workOriginOf(SHAPEOKO_4));
    expect(makeraWords(md)).toEqual([]);
  });

  it('names the centre convention for a machine that states one', () => {
    // Every shipped preset is front-left; a centre-zero machine states its own convention (#845).
    const centre: MillModel = { ...SHAPEOKO_4, workOrigin: 'top-centre' };
    const md = markdownFor(dj(), workOriginOf(centre));
    expect(md).toContain('XY centre');
    expect(md).toContain('G54 · stock centre');
  });

  it('a Makera machine’s sheet keeps its own body — the M491 steps are still there', () => {
    const md = markdownFor(dj());
    expect(md).toContain('M491');
    expect(md).toContain('PRB');
    expect(md).toContain('The Z1 low-profile vise');
  });
});
