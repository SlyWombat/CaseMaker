/**
 * The operator run sheet (#207): the pure structure `buildRunSheet` returns, the SHA-256 that
 * matches the sheet to the file, and the SVG origin diagram.
 *
 * The generated half is STUBBED the way the issue prescribes: `stubGenerated` stands in for #206's
 * `EngraveGenerated`, computing the same `findings`/`feeds` from the job so the sheet is exercised
 * against the real shapes without the generator existing yet.
 */

import { describe, it, expect } from 'vitest';
import {
  buildRunSheet,
  formatDuration,
  FRAME_Z,
  RAPID_ASSUMPTION_NOTE,
  runSheetDiagramSvg,
  runSheetFileName,
  runSheetFrameFileName,
  sha256Hex,
  type RunSheet,
  type RunSheetGenerated,
  type RunSheetSim,
} from '@/engine/cnc/engrave/runSheet';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { jobTool, validateJob } from '@/engine/cnc/engrave/jobSetup';
import { feedsFor } from '@/engine/cnc/feeds';
import { Z1 } from '@/engine/cnc';
import { DEFAULT_VISE } from '@/engine/cnc/fixture';
import { presetPartOnBoard } from '@/engine/cnc/sacrificial';
import type { EngraveJob } from '@/types/engraveJob';

const NOW = new Date('2026-10-04T00:00:00Z');

/** A stand-in for the exact `.nc` text; the sheet only hashes it. */
const NC = [';@MKR|BEGIN', 'G21 G90', 'T1 M6', 'S12000', 'G1 Z-2.000 F200', 'G1 X10 Y10 F500', 'M5', 'G28', 'M2'].join('\n');

const NO_SIM: RunSheetSim = { diagnostics: [] };

/** The generated half #206 will return, stubbed from the job (the issue's "stub the generated half"). */
function stubGenerated(job: EngraveJob, nc: string = NC): RunSheetGenerated {
  const tool = jobTool(job);
  return {
    findings: validateJob(job),
    feeds: tool ? feedsFor(job.stock.material, tool, Z1, job.cutOverride) : null,
    cam: { operations: 3, cuttingMoves: 1234, estimatedSeconds: 95, passes: 2 },
    nc,
    verify: {
      ok: true,
      findings: [],
      stats: { lines: 9, cuttingMoves: 2, deepestZ: -2, bbox: { min: [0, 0, -2], max: [10, 10, 0] } },
    },
  };
}

function sheetFor(job: EngraveJob, sim: RunSheetSim | null = NO_SIM, nc: string = NC): RunSheet {
  return buildRunSheet(job, stubGenerated(job, nc), sim, NOW);
}

const section = (sheet: RunSheet, id: string) => {
  const s = sheet.sections.find((x) => x.id === id);
  expect(s, `section ${id}`).toBeTruthy();
  return s!;
};

describe('runSheet (#207)', () => {
  it('hashes with SHA-256 (known vectors)', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('builds the header from the job and the generated file', () => {
    const job = defaultEngraveJob();
    const sheet = sheetFor(job);
    expect(sheet.header.jobName).toBe(job.name);
    expect(sheet.header.generatedOn).toBe('2026-10-04');
    expect(sheet.header.fileName).toBe(runSheetFileName(job.name));
    expect(sheet.header.fileHash).toBe(sha256Hex(NC).slice(0, 8));
    expect(sheet.header.fileHash).toHaveLength(8);
    expect(sheet.header.estimatedTime).toBe('1 min 35 s');
    // #242: the note names the cycle estimate and the assumed rapid rate, so the printed number
    // cannot be mistaken for a measured cycle time.
    expect(sheet.header.estimatedTimeNote).toBe(RAPID_ASSUMPTION_NOTE);
    expect(sheet.header.estimatedTimeNote).toContain('cutting + rapids');
    expect(sheet.header.estimatedTimeNote).toContain('3000 mm/min');
  });

  it('carries the stock, the three depths, stockProud, the feeds and the hash', () => {
    const job = defaultEngraveJob();
    const sheet = sheetFor(job);
    const all = JSON.stringify(sheet);
    expect(all).toContain('100 × 60 × 12 mm softwood');
    expect(all).toContain('2 mm deep');
    expect(all).toContain('1 mm deep');
    expect(all).toContain('0.5 mm deep');
    // stockProud (the default vise's 4 mm) is stated in section 3.
    expect(section(sheet, 'load').steps.some((s) => s.text.includes('4 mm above the jaw tops'))).toBe(true);
    // The feeds come from `feedsFor`.
    const feeds = feedsFor(job.stock.material, jobTool(job)!, Z1, job.cutOverride);
    expect(feeds.ok).toBe(true);
    if (feeds.ok) {
      expect(all).toContain(`${feeds.params.rpm} RPM`);
      expect(all).toContain('500 mm/min feed');
      expect(all).toContain('200 mm/min plunge');
      // The 1 mm cutter takes the 0.8–1.6 mm softwood row, whose step-down is 0.5 mm.
      expect(all).toContain(`2 × ${feeds.params.stepDown} mm passes`);
      expect(all).toContain(`${feeds.params.stepOver} mm step-over`);
    }
  });

  it('changes the file hash when the .nc changes by one character', () => {
    const job = defaultEngraveJob();
    const a = sheetFor(job, NO_SIM, NC);
    const b = sheetFor(job, NO_SIM, NC.replace('X10', 'X11'));
    expect(a.header.fileHash).not.toBe(b.header.fileHash);
    expect(a.header.fileName).toBe(b.header.fileName);
  });

  it('sets section 3\'s stop threshold to the deepest enabled depth plus 1', () => {
    const job = defaultEngraveJob();
    expect(section(sheetFor(job), 'load').steps.find((s) => s.text.includes('stop'))!.text).toContain('3 mm');
    job.labels[2]!.depth = 5; // deepest is now 5 -> threshold 6
    expect(section(sheetFor(job), 'load').steps.find((s) => s.text.includes('stop'))!.text).toContain('6 mm');
  });

  it('opens section 8 with the unmeasured-vise warning only when the vise is a default', () => {
    const def = section(sheetFor(defaultEngraveJob()), 'warnings');
    expect(def.steps[0]!.text).toContain('unmeasured defaults');
    expect(def.steps[0]!.bold).toBe(true);

    const measured = section(sheetFor(defaultEngraveJob({ ...DEFAULT_VISE, source: 'measured' })), 'warnings');
    expect(measured.steps.some((s) => s.text.includes('unmeasured defaults'))).toBe(false);
  });

  it('flags every unverified step with an issue number, and the three assumed sections in full', () => {
    const sheet = sheetFor(defaultEngraveJob());
    let flagged = 0;
    for (const s of sheet.sections) {
      for (const step of s.steps) {
        if (step.unverified !== undefined) {
          expect(step.unverified).toMatch(/#\d+/);
          flagged++;
        }
      }
    }
    expect(flagged).toBeGreaterThan(0);
    for (const id of ['mount', 'cutter', 'origin']) {
      for (const step of section(sheet, id).steps) expect(step.unverified).toBe('#208');
    }
  });

  it('carries verifier and simulation warnings verbatim', () => {
    const job = defaultEngraveJob();
    const sim: RunSheetSim = {
      diagnostics: [
        { severity: 'warning', code: 'fixture-unchecked', message: 'The fixture was not checked.' },
        { severity: 'info', code: 'noise', message: 'An info line that is not a warning.' },
      ],
    };
    const generated = stubGenerated(job);
    generated.verify = {
      ...generated.verify!,
      findings: [{ severity: 'warning', code: 'holder-unproven', line: 12, message: 'The holder is unproven.' }],
    };
    const warnings = section(buildRunSheet(job, generated, sim, NOW), 'warnings').steps.map((s) => s.text);
    expect(warnings).toContain('The fixture was not checked.');
    expect(warnings).toContain('The holder is unproven.');
    expect(warnings.some((t) => t.includes('not a warning'))).toBe(false);
  });

  it('excludes disabled labels from the cut lines and the diagram', () => {
    const job = defaultEngraveJob();
    job.labels[1]!.enabled = false;
    const sheet = sheetFor(job);
    expect(sheet.diagram.items).toHaveLength(2);
    expect(sheet.diagram.items.some((i) => i.name.includes('MAKER'))).toBe(false);
    expect(section(sheet, 'cut').steps.some((s) => s.text.includes('MAKER'))).toBe(false);
  });

  it('draws one rectangle per enabled label, inside the stock, with its depth on it', () => {
    const job = defaultEngraveJob();
    const sheet = sheetFor(job);
    const svg = runSheetDiagramSvg(sheet.diagram);
    expect((svg.match(/data-item-id="/g) ?? []).length).toBe(3);
    expect(svg).toContain('2 mm');
    expect(svg).toContain('1 mm');
    expect(svg).toContain('0.5 mm');
    for (const item of sheet.diagram.items) {
      expect(item.min[0]).toBeGreaterThanOrEqual(0);
      expect(item.min[1]).toBeGreaterThanOrEqual(0);
      expect(item.max[0]).toBeLessThanOrEqual(job.stock.length);
      expect(item.max[1]).toBeLessThanOrEqual(job.stock.width);
    }
  });

  it('mentions sacrificial material only when the job has some', () => {
    expect(JSON.stringify(sheetFor(defaultEngraveJob()))).not.toContain('Sacrificial material');
    const job = defaultEngraveJob();
    job.sacrificial = presetPartOnBoard();
    const need = section(sheetFor(job), 'need');
    expect(need.steps.some((s) => s.text.includes('Sacrificial material'))).toBe(true);
  });

  it('names the file from the job name', () => {
    expect(runSheetFileName('Untitled engrave job')).toBe('Untitled-engrave-job.nc');
    expect(runSheetFileName('  /weird///name  ')).toBe('weird-name.nc');
    expect(runSheetFileName('   ')).toBe('engrave-job.nc');
  });

  // #244 — the frame file sits beside the job, named from the same sanitiser so the two can
  // never disagree or be confused.
  it('names the frame file beside the job', () => {
    expect(runSheetFrameFileName('Untitled engrave job')).toBe('Untitled-engrave-job-frame.nc');
    expect(runSheetFrameFileName('  /weird///name  ')).toBe('weird-name-frame.nc');
    expect(runSheetFrameFileName('   ')).toBe('engrave-job-frame.nc');
  });

  // #244 — §6 no longer tells the operator to raise Z by hand; it names the generated frame file.
  it('section 6 runs the frame file, not a manual Z offset', () => {
    const job = defaultEngraveJob();
    const dryRun = section(sheetFor(job), 'dry-run');
    const all = dryRun.steps.map((s) => s.text).join(' ');
    expect(all).toContain(runSheetFrameFileName(job.name));
    expect(all).toContain(`${FRAME_Z} mm above the work`);
    expect(all).toContain(runSheetFileName(job.name)); // the job file to cut afterwards
    expect(all).not.toContain('Raise the work Z');
    expect(all).not.toContain('restore Z');
  });

  // #215 gap 3: `enabledItems`/`deepestDepth`/`buildDiagram` ignored `job.combined`, so a border
  // or cut-away reached neither the operator's cut lines nor the diagram. The sheet now reads the
  // one `toPartPlan` funnel, so combined items are present and construction/broken items are not.
  it('gives a combined border its cut line and diagram box (#215)', () => {
    const job = defaultEngraveJob();
    job.labels = [];
    job.shapes = [];
    job.combined = [
      {
        id: 'border',
        kind: 'border',
        position: { x: 50, y: 30 },
        rotation: 0,
        depth: 1.5,
        enabled: true,
        inset: 3,
        width: 2,
      },
    ];
    const sheet = sheetFor(job);
    expect(section(sheet, 'cut').steps.some((s) => s.text.includes('border'))).toBe(true);
    expect(section(sheet, 'cut').steps.some((s) => s.value?.includes('1.5 mm deep'))).toBe(true);
    expect(sheet.diagram.items.map((i) => i.id)).toEqual(['border']);
    // inset 3 on a 100 × 60 blank: outer edge at (3, 3)–(97, 57).
    const box = sheet.diagram.items[0]!;
    expect(box.min[0]).toBeCloseTo(3, 6);
    expect(box.min[1]).toBeCloseTo(3, 6);
    expect(box.max[0]).toBeCloseTo(97, 6);
    expect(box.max[1]).toBeCloseTo(57, 6);
  });

  it('leaves a construction item off the cut lines, the diagram and the depth threshold (#215)', () => {
    const job = defaultEngraveJob();
    // A construction label at 9 mm deep: it is only a reference for the cut-away and cuts nothing.
    job.labels = [{ ...job.labels[0]!, id: 'island', text: 'X', depth: 9, construction: true }];
    job.shapes = [];
    job.combined = [
      {
        id: 'panel',
        kind: 'cutaway',
        position: { x: 50, y: 30 },
        rotation: 0,
        depth: 1,
        enabled: true,
        outer: 'island',
        islands: [],
      },
    ];
    const sheet = sheetFor(job);
    expect(sheet.diagram.items.map((i) => i.id)).toEqual(['panel']);
    expect(section(sheet, 'cut').steps.some((s) => s.text.includes('"X"'))).toBe(false);
    expect(section(sheet, 'cut').steps.some((s) => s.text.includes('cutaway'))).toBe(true);
    // The threshold follows the cut-away's 1 mm, not the construction label's 9 mm.
    expect(section(sheet, 'load').steps.find((s) => s.text.includes('stop'))!.text).toContain('2 mm');
  });

  it('drops an item whose reference is broken from the sheet (#215)', () => {
    const job = defaultEngraveJob();
    job.labels = [];
    job.shapes = [];
    job.combined = [
      {
        id: 'frame',
        kind: 'frame',
        position: { x: 50, y: 30 },
        rotation: 0,
        depth: 1,
        enabled: true,
        around: 'does-not-exist',
        gap: 1,
        width: 2,
      },
    ];
    const sheet = sheetFor(job);
    expect(sheet.diagram.items).toEqual([]);
    expect(section(sheet, 'cut').steps.some((s) => s.text.includes('frame'))).toBe(false);
  });

  it('formats a cutting time', () => {
    expect(formatDuration(0)).toBe('0 s');
    expect(formatDuration(95)).toBe('1 min 35 s');
    expect(formatDuration(3700)).toBe('1 h 1 min');
  });

  it('snapshots the whole RunSheet for the default job', () => {
    const job = defaultEngraveJob();
    // The default job's label ids come from a random generator; pin them so the snapshot is stable.
    job.labels.forEach((label, i) => {
      label.id = `label-${i}`;
    });
    expect(sheetFor(job)).toMatchSnapshot();
  });
});
