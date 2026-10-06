// @vitest-environment jsdom
// The run sheet's view wiring (#213 §6): the side view of the setup is drawn under section 3 and
// ONLY when the job has sacrificial material. The sheet data and the SVG string are covered by
// `runSheet.spec.ts`; this file proves the view puts it on the page — or leaves it off.

import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { RunSheetView } from '@/components/panels/RunSheetView';
import { buildRunSheet, type RunSheet, type RunSheetGenerated } from '@/engine/cnc/engrave/runSheet';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { jobTool, validateJob } from '@/engine/cnc/engrave/jobSetup';
import { feedsFor } from '@/engine/cnc/feeds';
import { Z1 } from '@/engine/cnc';
import { presetPartOnBoard } from '@/engine/cnc/sacrificial';
import type { EngraveJob } from '@/types/engraveJob';

const NOW = new Date('2026-10-04T00:00:00Z');
const NC = [';@MKR|BEGIN', 'G21 G90', 'T1 M6', 'S12000', 'G1 Z-2.000 F200', 'G1 X10 Y10 F500', 'M5', 'M2'].join('\n');

/** The same stand-in `runSheet.spec.ts` uses: the sheet only reads the generated half's shape. */
function sheetFor(job: EngraveJob): RunSheet {
  const tool = jobTool(job);
  const generated: RunSheetGenerated = {
    findings: validateJob(job),
    feeds: tool ? feedsFor(job.stock.material, tool, Z1, job.cutOverride) : null,
    cam: { operations: 3, cuttingMoves: 1234, estimatedSeconds: 95, passes: 2 },
    nc: NC,
    verify: {
      ok: true,
      findings: [],
      stats: { lines: 9, cuttingMoves: 2, deepestZ: -2, bbox: { min: [0, 0, -2], max: [10, 10, 0] } },
    },
    frameNc: `${NC}\n;frame\n`,
  };
  return buildRunSheet(job, generated, { diagnostics: [] }, NOW);
}

afterEach(cleanup);

describe('RunSheetView — the stack-up elevation (#213 §6)', () => {
  it('draws the side view when the job has sacrificial material', () => {
    const job = defaultEngraveJob();
    job.sacrificial = presetPartOnBoard();
    render(<RunSheetView sheet={sheetFor(job)} />);

    const stackUp = screen.getByTestId('run-sheet-stackup');
    expect(stackUp.querySelector('svg')).not.toBeNull();
    expect(stackUp.textContent).toContain('board · 12 mm');
    expect(stackUp.textContent).toContain("Z0 — the part's top face");
    // The top-view origin diagram is still there, in its own section.
    expect(screen.getByTestId('run-sheet-diagram').querySelector('svg')).not.toBeNull();
  });

  it('leaves the side view off a job with no sacrificial material', () => {
    render(<RunSheetView sheet={sheetFor(defaultEngraveJob())} />);
    expect(screen.queryByTestId('run-sheet-stackup')).toBeNull();
    expect(screen.getByTestId('run-sheet-diagram')).toBeTruthy();
  });
});
