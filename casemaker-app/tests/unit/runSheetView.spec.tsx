// @vitest-environment jsdom
// The run sheet's view wiring (#213 §6): the side view of the setup is drawn under section 3 and
// ONLY when the job has sacrificial material. The sheet data and the SVG string are covered by
// `runSheet.spec.ts`; this file proves the view puts it on the page — or leaves it off.

import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { RunSheetView } from '@/components/panels/RunSheetView';
import { buildRunSheet, type RunSheet, type RunSheetGenerated, type RunSheetOptions } from '@/engine/cnc/engrave/runSheet';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';

// #516 item 5 — the default job no longer seeds a cutter; the recommendation names `flat-1.0`.
// These engine tests need the job to name its cutter, so `dj()` applies that recommendation.
function dj(...args: Parameters<typeof defaultEngraveJob>): ReturnType<typeof defaultEngraveJob> {
  const job = defaultEngraveJob(...args);
  job.toolKey = 'flat-1.0';
  return job;
}
import { dedupeFindings, jobTool, validateJob } from '@/engine/cnc/engrave/jobSetup';
import { feedsFor } from '@/engine/cnc/feeds';
import { Z1 } from '@/engine/cnc';
import { validateVise } from '@/engine/cnc/fixture';
import { presetPartOnBoard } from '@/engine/cnc/sacrificial';
import type { EngraveJob } from '@/types/engraveJob';

const NOW = new Date('2026-10-04T00:00:00Z');
const NC = [';@MKR|BEGIN', 'G21 G90', 'T1 M6', 'S12000', 'G1 Z-2.000 F200', 'G1 X10 Y10 F500', 'M5', 'M2'].join('\n');

/** The same stand-in `runSheet.spec.ts` uses: the sheet only reads the generated half's shape. */
function sheetFor(job: EngraveJob, options?: RunSheetOptions): RunSheet {
  const tool = jobTool(job);
  const generated: RunSheetGenerated = {
    findings: dedupeFindings([
      ...validateJob(job),
      ...validateVise(job.stock, job.workholding.vise, job.sacrificial),
    ]),
    feeds: tool ? feedsFor([], job.stock.material, tool, Z1, job.cutOverride) : null,
    cam: { operations: 3, cuttingMoves: 1234, estimatedSeconds: 95, passes: 2 },
    nc: NC,
    verify: {
      ok: true,
      findings: [],
      stats: { lines: 9, cuttingMoves: 2, deepestZ: -2, bbox: { min: [0, 0, -2], max: [10, 10, 0] } },
    },
    frameNc: `${NC}\n;frame\n`,
  };
  return buildRunSheet(job, generated, { diagnostics: [] }, NOW, undefined, options);
}

afterEach(cleanup);

describe('RunSheetView — the stack-up elevation (#213 §6)', () => {
  it('draws the side view when the job has sacrificial material', () => {
    const job = dj();
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
    render(<RunSheetView sheet={sheetFor(dj())} />);
    expect(screen.queryByTestId('run-sheet-stackup')).toBeNull();
    expect(screen.getByTestId('run-sheet-diagram')).toBeTruthy();
  });

  it('draws the cutter profile under the section that names the cutter (#489)', () => {
    render(<RunSheetView sheet={sheetFor(dj())} />);
    const profile = screen.getByTestId('run-sheet-tool-profile');
    expect(profile.querySelector('svg')).not.toBeNull();
    expect(profile.closest('[data-section-id="need"]')).not.toBeNull();
    // The monochrome print drawing carries no app styles or bitmap art.
    expect(profile.innerHTML).toContain('cutter-profile--print');
    expect(profile.innerHTML).not.toContain('<image');
  });

  it('leaves the cutter profile off a job that names no cutter (#489)', () => {
    const job = dj();
    job.tool = null;
    job.toolKey = 'user:not-in-this-house';
    render(<RunSheetView sheet={sheetFor(job)} />);
    expect(screen.queryByTestId('run-sheet-tool-profile')).toBeNull();
  });

  it('prints the machine the job is written for (#347)', () => {
    // The operator's copy is what tells them which machine to set up, so the row is on the page and
    // not only in the data (`runSheet.spec.ts` asserts where the value comes from).
    render(<RunSheetView sheet={sheetFor(dj())} />);
    expect(screen.getByTestId('run-sheet-machine').textContent).toBe(Z1.name);
  });

  // #391 review item 1 — a step that carries a LINE TO SEND has to put it on the page as one. The
  // material-position block is held off (`RunSheetOptions.materialScan`), so the sheet is built with
  // it on to reach such a step: a `G38.2` buried inside a sentence would be a command the operator
  // has to reassemble by hand, which is the bug the review found in the step that preceded it.
  it('puts a step’s sendable line on the page, in its own run (#391)', () => {
    render(<RunSheetView sheet={sheetFor(dj(), { materialScan: true })} />);

    // Every line the block asks the operator to type: the touch itself, the Alarm clear after a
    // miss, and the lift after every touch.
    for (const line of ['G38.2 Z-8 F150', '$X', 'G53 G0 Z-3']) {
      expect(screen.getByText(line).tagName).toBe('CODE');
    }
    expect(screen.getByText('G38.2 Z-8 F150').closest('[data-section-id="origin"]')).not.toBeNull();
  });
});
