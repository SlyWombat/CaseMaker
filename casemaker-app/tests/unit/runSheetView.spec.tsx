// @vitest-environment jsdom
// The run sheet's view wiring (#213 §6): the side view of the setup is drawn under section 3 and
// ONLY when the job has sacrificial material. The sheet data and the SVG string are covered by
// `runSheet.spec.ts`; this file proves the view puts it on the page — or leaves it off.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { jobVise } from '@/engine/cnc/fixture';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RunSheetView } from '@/components/panels/RunSheetView';
import { buildRunSheet, type RunSheet, type RunSheetGenerated, type RunSheetOptions } from '@/engine/cnc/engrave/runSheet';
import { nameProgramsForSheet } from '@/engine/cnc/engrave/programFiles';
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
      ...validateVise(job.stock, jobVise(job), job.sacrificial),
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

describe('#513 the sheet’s Bed line', () => {
  it('prints beside the machine, probe and mount, and is absent when no bed was resolved', () => {
    const job = dj();
    const line = 'Vise on the pins; jaw top -56.65 mm measured 2026-10-17; surface top not measured';
    const { unmount } = render(<RunSheetView sheet={sheetFor(job, { bedName: line })} />);
    expect(screen.getByTestId('run-sheet-bed').textContent).toBe(line);
    unmount();
    render(<RunSheetView sheet={sheetFor(job)} />);
    expect(screen.queryByTestId('run-sheet-bed')).toBeNull();
  });
});

describe('#845 the sheet’s Dialect line', () => {
  it('prints when the machine is a GRBL machine, and is absent on a Makera sheet', () => {
    const job = dj();
    const { unmount } = render(<RunSheetView sheet={sheetFor(job, { dialectName: 'GRBL 1.1' })} />);
    expect(screen.getByTestId('run-sheet-dialect').textContent).toBe('GRBL 1.1');
    unmount();
    render(<RunSheetView sheet={sheetFor(job)} />);
    expect(screen.queryByTestId('run-sheet-dialect')).toBeNull();
  });
});

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

// #788 — the step that asks for the probe carries the drawn head diagram, and a sheet without that
// step draws none. The step is injected because the default job's registration plan refuses (it has
// no openings), so its sheet prints the refusal instead of the probe routine.
function sheetWithProbeStep(instrument: 'xyz' | 'z-only' | null = 'xyz'): RunSheet {
  const sheet = sheetFor(dj());
  const first = sheet.sections[0]!;
  const step = { text: 'Fit the probe and touch off ONCE on the top face.', ...(instrument === null ? {} : { probeFit: instrument }) };
  return {
    ...sheet,
    sections: [{ ...first, steps: [...first.steps, step] }, ...sheet.sections.slice(1)],
  };
}

describe('#788 the run sheet draws the head diagram where it asks for the probe', () => {
  it('for the 3D probe: the 3D cable and Makera’s line', () => {
    render(<RunSheetView sheet={sheetWithProbeStep('xyz')} />);
    const diagram = screen.getByTestId('run-sheet-probe-fit');
    expect(diagram.textContent).toContain('3D probe cable in here');
    expect(diagram.textContent).toContain('Unplug the wired probe connector and connect the 3D probe cable.');
    expect(diagram.textContent).toContain('3D Probe Rod');
    expect(diagram.textContent).not.toContain('Plug the wired probe in here.');
    expect(diagram.querySelector('svg')?.getAttribute('aria-label')).toContain('not the 3-pin ionizer port');
  });

  it('for the wired probe V2: the wired probe is plugged in, and the 3D line is absent', () => {
    render(<RunSheetView sheet={sheetWithProbeStep('z-only')} />);
    const diagram = screen.getByTestId('run-sheet-probe-fit');
    expect(diagram.textContent).toContain('wired probe in here');
    expect(diagram.textContent).toContain('Plug the wired probe in here.');
    // Telling a V2 job to unplug the wired probe would unplug the probe the job uses.
    expect(diagram.textContent).not.toContain('Unplug the wired probe connector');
  });

  it('draws nothing when no step asks for a probe', () => {
    render(<RunSheetView sheet={sheetWithProbeStep(null)} />);
    expect(screen.queryByTestId('run-sheet-probe-fit')).toBeNull();
  });
});

// #1093 R3 — the run's file list: one row per program, each with its own Save; the rows print
// without the buttons for a caller that has no bytes, and a one-program sheet has no list at all.
describe('#1093 the sheet’s file list', () => {
  function multiSheet(): RunSheet {
    const job = dj();
    const raw = [1, 2, 3].map((i) => ({
      setupIndex: 1,
      toolKey: 'flat-1.0',
      nc: `G21 G90\n;program ${i}\nM2`,
      frameNc: i === 2 ? 'G21 G90\n;frame\nM2' : null,
      cam: null,
    }));
    const generated = {
      findings: [],
      feeds: null,
      cam: null,
      nc: raw[0]!.nc,
      verify: null,
      frameNc: null,
      programs: nameProgramsForSheet(raw, job.name),
    } as RunSheetGenerated;
    return buildRunSheet(job, generated, { diagnostics: [] }, NOW);
  }

  it('renders one Save per row, named for the program it writes', () => {
    const onSave = vi.fn();
    render(<RunSheetView sheet={multiSheet()} onSaveProgram={onSave} />);
    const files = screen.getByTestId('run-sheet-files');
    expect(files.textContent).toContain('Program 2 is Untitled-job-p2.nc');
    expect(files.textContent).toContain('Untitled-job-p2-frame.nc');
    for (const i of [1, 2, 3]) expect(screen.getByTestId(`run-sheet-save-${i}`)).toBeTruthy();
    fireEvent.click(screen.getByTestId('run-sheet-save-2'));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]![0]).toMatchObject({ number: 2, name: 'Untitled-job-p2.nc', frameName: 'Untitled-job-p2-frame.nc' });
  });

  it('prints the rows without buttons when the caller has no bytes to save', () => {
    render(<RunSheetView sheet={multiSheet()} />);
    expect(screen.getByTestId('run-sheet-file-1')).toBeTruthy();
    expect(screen.queryByTestId('run-sheet-save-1')).toBeNull();
  });

  it('a one-program sheet carries no file list', () => {
    render(<RunSheetView sheet={sheetFor(dj())} onSaveProgram={vi.fn()} />);
    expect(screen.queryByTestId('run-sheet-files')).toBeNull();
  });
});
