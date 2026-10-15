/**
 * The operator run sheet (#207): the pure structure `buildRunSheet` returns, the SHA-256 that
 * matches the sheet to the file, and the SVG origin diagram.
 *
 * The generated half is STUBBED the way the issue prescribes: `stubGenerated` stands in for #206's
 * `EngraveGenerated`, computing the same `findings`/`feeds` from the job so the sheet is exercised
 * against the real shapes without the generator existing yet.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildRunSheet,
  formatDuration,
  FRAME_Z,
  rapidAssumptionNote,
  runSheetDiagramSvg,
  runSheetFileName,
  runSheetFrameFileName,
  runSheetStackUpSvg,
  sha256Hex,
  type RunSheet,
  type RunSheetGenerated,
  type RunSheetOptions,
  type RunSheetSim,
  type RunSheetStackUp,
} from '@/engine/cnc/engrave/runSheet';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { buildCouponPrograms, type CouponSpec } from '@/engine/cnc/engrave/couponJob';
import { labelJawReach } from '@/engine/cnc/engrave/partPlan';
import { dedupeFindings, jobTool, validateJob } from '@/engine/cnc/engrave/jobSetup';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import { feedsFor } from '@/engine/cnc/feeds';
import { Z1 } from '@/engine/cnc';
import { DEFAULT_VISE, validateVise } from '@/engine/cnc/fixture';
import { presetJawStrips, presetPartOnBoard } from '@/engine/cnc/sacrificial';
import type { EngraveJob } from '@/types/engraveJob';

const NOW = new Date('2026-10-04T00:00:00Z');

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The bench's own committed blank (`docs/bench/165-depth-ladder-row-A.job.json`) — the base job the
 * S3 coupons are carved from (#284): 38.1 × 76.2 × 3.81 mm PLA, clamped with the 2 mm O-flute and
 * standing 1.2 mm proud. Read through the store's schema, the way the app reads it.
 */
function benchJob(): EngraveJob {
  const path = join(APP, '..', 'docs', 'bench', '165-depth-ladder-row-A.job.json');
  const parsed = parseEngraveJob(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.ok) throw new Error(`${path} should parse: ${parsed.errors.join('; ')}`);
  return parsed.job;
}

/** A stand-in for the exact `.nc` text; the sheet only hashes it. */
const NC = [';@MKR|BEGIN', 'G21 G90', 'T1 M6', 'S12000', 'G1 Z-2.000 F200', 'G1 X10 Y10 F500', 'M5', 'G28', 'M2'].join('\n');

const NO_SIM: RunSheetSim = { diagnostics: [] };

/** The generated half #206 will return, stubbed from the job (the issue's "stub the generated half"). */
function stubGenerated(job: EngraveJob, nc: string = NC, frame = true): RunSheetGenerated {
  const tool = jobTool(job);
  return {
    // Both pure passes, merged the way the worker merges them (#353) — the vise validator owns
    // `vise-default`, so `validateJob` alone is no longer the whole list.
    findings: dedupeFindings([
      ...validateJob(job),
      ...validateVise(job.stock, job.workholding.vise, job.sacrificial),
    ]),
    feeds: tool ? feedsFor([], job.stock.material, tool, Z1, job.cutOverride) : null,
    cam: { operations: 3, cuttingMoves: 1234, estimatedSeconds: 95, passes: 2 },
    nc,
    verify: {
      ok: true,
      findings: [],
      stats: { lines: 9, cuttingMoves: 2, deepestZ: -2, bbox: { min: [0, 0, -2], max: [10, 10, 0] } },
    },
    // The frame the app saves beside the job (#244); §6 names it. `frame: false` is the run that
    // never reached the frame — the program failed verification, so no frame exists (#273).
    frameNc: frame ? `${nc}\n;frame\n` : null,
  };
}

function sheetFor(
  job: EngraveJob,
  sim: RunSheetSim | null = NO_SIM,
  nc: string = NC,
  options: RunSheetOptions = {},
): RunSheet {
  return buildRunSheet(job, stubGenerated(job, nc), sim, NOW, undefined, options);
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
    // #242/#281: the note names the cycle estimate and the machine's OWN rapid model, so the
    // printed number cannot be mistaken for a measured cycle time and the rates cannot drift from
    // the ones the estimate was timed with.
    expect(sheet.header.estimatedTimeNote).toBe(rapidAssumptionNote(Z1.rapidEstimate));
    expect(sheet.header.estimatedTimeNote).toContain('cutting + rapids');
    expect(sheet.header.estimatedTimeNote).toContain(`${Z1.rapidEstimate.xyMmPerMin} mm/min XY`);
    expect(sheet.header.estimatedTimeNote).toContain(`${Z1.rapidEstimate.zMmPerMin} mm/min Z`);
    // #347 — which machine the job is written for, read from the JOB rather than from a constant:
    // an operator holding a sheet printed for another machine is the failure this line prevents.
    expect(sheet.header.machine).toBe(Z1.name);
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
    const feeds = feedsFor([], job.stock.material, jobTool(job)!, Z1, job.cutOverride);
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

  it('sets section 3\'s stop threshold to the deepest cut that sweeps over a jaw, plus the clearance', () => {
    // #394 — the stop is printed only for a cut the cutter really gets OVER a jaw (`gap <= radius`,
    // the narrow reading), and the number is the deepest of THOSE. The demo 'CASE' line MEASURES
    // 46.28 mm across the 100 mm plank, 26.9 mm clear of either face, so it is placed over the fixed
    // jaw here to make the stop live at all — under the old ESTIMATE box it read 109.2 mm and
    // reached from anywhere on the blank, which is what put a stop on every sheet.
    const job = defaultEngraveJob();
    job.labels = [{ ...job.labels[0]!, position: { x: 23, y: 43 } }];
    const stopStep = () => section(sheetFor(job), 'load').steps.find((s) => s.text.includes('stop'))!;
    expect(stopStep().text).toContain('less than 3 mm, stop');
    // The stop NAMES the cut that trips it and the jaw, so the operator can see what to look at.
    expect(stopStep().text).toContain('Engrave "CASE" sweeps over the fixed jaw');
    job.labels[0]!.depth = 5; // the deepest cut over a jaw is now 5 -> threshold 6
    expect(stopStep().text).toContain('less than 6 mm, stop');
  });

  it('opens section 8 with the shipped-vise warning only when the vise is a default', () => {
    const def = section(sheetFor(defaultEngraveJob()), 'warnings');
    expect(def.steps[0]!.text).toContain('the shipped defaults, measured once on the reference unit');
    expect(def.steps[0]!.bold).toBe(true);

    const measured = section(sheetFor(defaultEngraveJob({ ...DEFAULT_VISE, source: 'measured' })), 'warnings');
    expect(measured.steps.some((s) => s.text.includes('measured once on the reference unit'))).toBe(false);
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

  // #243 — the run sheet's §8 carries the Simulate panel's own coverage sentence, from the
  // imported builder, so the operator reads what the sweep saw and did NOT see. Every clause
  // comes from what this job and run carried, not from prose.
  it('carries the run coverage sentence in section 8 (#243)', () => {
    const job = defaultEngraveJob();
    const warnings = section(sheetFor(job), 'warnings').steps.map((s) => s.text);
    // The vise envelope `toSetup` hands the sweep is named as the fixture it checked.
    expect(warnings.some((t) => t.startsWith('Checked: the tool against the stock and the modelled fixture'))).toBe(true);
    expect(warnings.some((t) => t.includes('Vise fixed jaw (left)'))).toBe(true);
    // The fixture being the shipped default is said, not implied.
    expect(warnings.some((t) => t.includes('shipped default, not a measurement'))).toBe(true);
    // #314 — the collet nut is NOT named here. Z1 still states no holder, but the nut's
    // placement is derived from the cutter and every obstacle the vise models sits BELOW the
    // stock top, so the nut cannot reach one and the run never raised
    // `holder-vs-fixture-unproven`. A sheet that named it anyway would print a blind spot for a
    // check that was provably moot.
    expect(warnings.some((t) => t.includes('the collet nut'))).toBe(false);
  });

  // #314 — and it IS named where the run says the check was needed and could not be made: the
  // sheet reads the run's own codes, so the sentence follows the geometry, not the machine.
  it('names the collet nut when the run could not prove it (#314)', () => {
    const job = defaultEngraveJob();
    const sim: RunSheetSim = {
      diagnostics: [{ severity: 'warning', code: 'holder-vs-fixture-unproven', message: 'An obstacle rises above the stock top and the collet nut is unmeasured.' }],
    };
    const warnings = section(buildRunSheet(job, stubGenerated(job), sim, NOW), 'warnings').steps.map((s) => s.text);
    expect(warnings.some((t) => t.includes('the collet nut'))).toBe(true);
  });

  it('says a path-only run swept no geometry (#243)', () => {
    const job = defaultEngraveJob();
    const sim: RunSheetSim = { diagnostics: [], outcome: 'path-only' };
    const warnings = section(buildRunSheet(job, stubGenerated(job), sim, NOW), 'warnings').steps.map((s) => s.text);
    expect(warnings.some((t) => t.includes('path-only'))).toBe(true);
    expect(warnings.some((t) => t.startsWith('Checked:'))).toBe(false);
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

  // #273 — a job program the verifier refuses comes back with `nc` and `verify` but NO frame, and
  // the sheet still opens on it (only a stale job is blocked). Sending the operator to a file that
  // was never written is worse than saying nothing.
  it('section 6 does not send the operator after a frame file that was never written', () => {
    const job = defaultEngraveJob();
    const sheet = buildRunSheet(job, stubGenerated(job, NC, false), NO_SIM, NOW);
    const all = section(sheet, 'dry-run').steps.map((s) => s.text).join(' ');
    expect(all).not.toContain(runSheetFrameFileName(job.name));
    expect(all).toContain('no frame file');
    expect(all).toContain('Do not run this file');
    // The section is one bold warning, not a warning plus the steps that assume a frame.
    expect(section(sheet, 'dry-run').steps).toHaveLength(1);
    expect(section(sheet, 'dry-run').steps[0]!.bold).toBe(true);
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

  // #272 — §5 is DERIVED from the workholding and the blank (decision 26), not the hand-written
  // edge find decision 26 superseded. The sequence, the datum it starts from and the residual it
  // leaves all come from `planProbing`; the section's job is to say them in physical words.
  describe('section 5 — the work origin is derived from the workholding (#272)', () => {
    // §5 is two halves: the origin, from the workholding, and the material-position check (#391),
    // which is HELD — `buildRunSheet` prints it only when `RunSheetOptions.materialScan` is set.
    // `SCAN` is how the assertions about that half ask for it; the default is asserted below.
    const SCAN: RunSheetOptions = { materialScan: true };
    const origin = (job: EngraveJob, options: RunSheetOptions = {}): string[] =>
      section(sheetFor(job, NO_SIM, NC, options), 'origin').steps.map((s) => s.text);

    it('names the datum the jaws supply, then one step per touch, then the residual', () => {
      const texts = origin(defaultEngraveJob());
      expect(texts[0]).toBe('The vise already references X and rotation to within ±0.05 mm, before any touch.');

      const touches = texts.filter((t) => t.startsWith('Touch '));
      // The job states no XY tolerance, so every axis the vise leaves open is resolved: a pair on
      // one straight edge for position + rotation, then one closing touch on a perpendicular edge.
      expect(touches).toHaveLength(3);
      expect(touches[0]).toContain('this gives position and rotation');
      expect(touches[2]).toContain('this gives X');
      // Physical landmarks, not coordinates: which side, and how far along it from a named end.
      for (const t of touches) expect(t).toMatch(/the (front|back|left|right) edge — the one /);
      for (const t of touches) expect(t).toMatch(/mm (along it from the |from the )(left|front) end|middle/);

      expect(texts.some((t) => t.startsWith('X0 Y0 Z0 is the top-front-left corner'))).toBe(true);
      expect(texts.find((t) => t.startsWith('X0 Y0 Z0'))).toContain('±0.02 mm in X and Y');
    });

    it('carries the planner’s own caveats — the static-.nc rotation limit and why Z is probed', () => {
      const texts = origin(defaultEngraveJob()).join(' ');
      expect(texts).toContain('a static .nc cannot compensate it');
      expect(texts).toContain('Z is always probed on the engraved face');
    });

    it('prints a refusal as a refusal, rather than a sequence it cannot stand behind', () => {
      // A blank with no edge long enough for the probe: every side is well under the planner's
      // 2× tip-diameter minimum, so no axis can be resolved and the plan refuses.
      const job = defaultEngraveJob();
      job.stock = { length: 1, width: 1, thickness: 3, material: 'pla' };
      const texts = origin(job);
      expect(texts).toHaveLength(1);
      expect(texts[0]).toContain('cannot be registered as set up');
      expect(texts[0]).toContain('no reachable straight edge');
      expect(texts.some((t) => t.startsWith('Touch '))).toBe(false);
    });

    // #391 — the second half of §5: the check the operator can make against the blank ACTUALLY in
    // the jaws, with the wired probe. Every number is the plan's, so these assertions are about the
    // sheet saying them in words a person at the machine can act on (and about it not saying them
    // when they would not be true).
    it('offers the material-position scan, in physical landmarks and the plan’s own numbers', () => {
      const steps = section(sheetFor(defaultEngraveJob(), NO_SIM, NC, SCAN), 'origin').steps;
      const texts = steps.map((s) => s.text);

      // It is an OFFER, and it says why it costs something: a tool change.
      const offer = texts.find((t) => t.startsWith('OPTIONAL, BEFORE THE FIRST CUT'))!;
      expect(offer).toContain('It is Z-only, so it cannot touch a side');
      expect(offer).toContain('one tool change');
      expect(offer).toContain('Skip this if this is the blank you have just set the origin against');

      // #391 review item 2 — what the numbers REST ON comes before the numbers, and the tip leads:
      // it is the one figure every position is derived from. A8 measured it on 2026-10-15, so the
      // step now names a reading where it used to say AS ASSUMED.
      const assume = texts.find((t) => t.startsWith('Before you touch anything'))!;
      expect(assume).toContain('what the numbers below assume');
      expect(texts.some((t) => t.includes('The tip is 2 mm across, measured'))).toBe(true);
      expect(texts.some((t) => t.includes('starts no dome'))).toBe(false);

      // The reference touch everything else is measured from.
      expect(texts.some((t) => t.includes('touch off ONCE on the blank’s top face'))).toBe(true);

      // One step per edge, each naming the side the way a person finds it, and each carrying the
      // four positions and what the reading should be at each — including the miss past a side.
      const checks = texts.filter((t) => t.startsWith('Check '));
      expect(checks).toHaveLength(4);
      expect(checks[0]).toContain('the left edge — the one against the fixed jaw');
      expect(checks[0]).toContain('at the middle of the blank’s width');
      expect(checks[0]).toContain('3 and 1 mm inside');
      expect(checks[0]).toContain('at 0.7 mm outside');
      expect(checks[0]).toContain('the blank’s edge itself');
      // The END edges have a jaw top past them; the SIDE edges have the gap between the jaws, so
      // their outward touch runs to the cap instead — and the sheet says that is expected.
      expect(checks[0]).toContain('the jaw’s top');
      expect(checks.find((t) => t.startsWith('Check the front edge'))).toContain('the expected reading, not a fault');
      for (const id of checks) expect(id).toMatch(/at the middle of the blank’s (width|length)/);

      // The bands are the JOB's figures (#345/#362), not constants in the sheet — and they are PER
      // EDGE, because the dome is a shape (#391 item 4): the sides are judged against 0.38 mm and
      // the ends against 0.15, where the old block quoted one figure for all four.
      const reading = texts.find((t) => t.startsWith('Reading the depths.'))!;
      expect(reading).toContain('within 0.38 mm of the reference is the blank at the left and right edges');
      expect(reading).toContain('0.15 mm at the front and back');
      expect(reading).toContain('3.95 mm or more below is off the blank');
      const compare = steps.find((s) => s.value?.startsWith('allowed '))!;
      expect(compare.value).toBe('allowed 1 mm');
      expect(compare.text).toContain('after the 0.312 mm above is taken back toward the blank');

      // The tool change back, because every Z in the program is the CUTTER's.
      expect(texts[texts.length - 1]).toContain('Put the CUTTER back and measure its length again');

      // What the operator writes down, so the sheet's record column is not empty for this block.
      expect(steps.filter((s) => s.record !== undefined).map((s) => s.record)).toEqual([
        'X where the reading stops being the blank (mm)',
        'X where the reading stops being the blank (mm)',
        'Y where the reading stops being the blank (mm)',
        'Y where the reading stops being the blank (mm)',
        'edge that is out, and by how much (mm)',
      ]);
    });

    // #391 review item 1 — the block named a cap the machine has no field for. A `G38.2` takes a
    // TRAVEL distance, so a step an operator can actually send needs both the line and the height it
    // is sent from, and a touch that finds nothing needs a way back out of the Alarm it leaves.
    it('gives every touch a sendable line, its cap, and the way back from a miss (#391 item 1)', () => {
      const steps = section(sheetFor(defaultEngraveJob(), NO_SIM, NC, SCAN), 'origin').steps;
      const codes = steps.filter((s) => s.code !== undefined);

      // 3 mm of start gap over the blank's top, plus the plan's own cap: 5 mm on this job. The Z word
      // is a travel distance from wherever the tip is, which is why the height is stated at all.
      const send = codes.find((s) => s.code!.startsWith('G38.2'))!;
      expect(send.code).toBe('G38.2 Z-8 F100');
      expect(send.text).toContain('held 3 mm above the top of the blank');
      expect(send.text).toContain('distance the tip may TRAVEL');
      expect(send.text).toContain('runs the 3 mm plus the 5 mm cap');
      expect(send.text).toContain('never sideways at depth');

      // A miss is one of the readings the check looks for, so it says so, and gives the two lines
      // that recover the machine: the Alarm clear, then the lift.
      const miss = codes.find((s) => s.code === '$X')!;
      expect(miss.text).toContain('not a fault');
      expect(miss.text).toContain('ALARM: Probe fail');
      expect(miss.text).toContain('error:Alarm lock');
      const lift = codes.find((s) => s.code === 'G53 G0 Z-3')!;
      expect(lift.text).toContain('after EVERY touch, hit or miss');
      expect(lift.text).toContain('with a jaw beside it');

      // The old cap step is gone: `cap 5 mm below the reference` named a field the console has not
      // got, and the line above carries the same 5 mm as the travel it really is.
      expect(steps.some((s) => s.value?.startsWith('cap '))).toBe(false);
    });

    // #391 review items 3, 5 and 6 — the three ways a step could send an operator the wrong way: a
    // correction that read backwards, a bisection that only went one way, and no answer at all for a
    // first pass that never bracketed the edge.
    it('reads the correction PAST the edge, and says what to do when the pass misses it (#391)', () => {
      const texts = section(sheetFor(defaultEngraveJob(), NO_SIM, NC, SCAN), 'origin').steps.map((s) => s.text);

      // The tip's corner contact sinks the reading a little PAST the real edge, so the edge is
      // measured back toward the blank. The old wording said BEFORE, which is the opposite — and a
      // sheet that is one word out sends the operator to the wrong side of the line they just found.
      const correction = texts.find((t) => t.startsWith('The reading leaves the blank'))!;
      expect(correction).toContain('0.312 mm PAST the real edge');
      expect(correction).toContain('is 0.312 mm INSIDE where the reading changed');
      expect(correction).toContain('back toward the blank');
      expect(correction).not.toContain('BEFORE');

      // Bisection works from either side of the change, and it terminates where the scan's own bias
      // says it can no longer tell — not at an unrelated half-step.
      const bisect = texts.find((t) => t.startsWith('To place an edge more finely'))!;
      expect(bisect).toContain('in either direction');
      expect(bisect).toContain('inward or outward');
      expect(bisect).toContain('no more than 0.312 mm apart');

      // A pass whose four readings are all the blank, or whose innermost is already off it, has
      // nothing to bisect between: the step says which way to step and that a miss counts as off.
      const unbracketed = texts.find((t) => t.startsWith('If the readings do not bracket'))!;
      expect(unbracketed).toContain('ALL FOUR reading the blank');
      expect(unbracketed).toContain('step 2 mm further OUT');
      expect(unbracketed).toContain('step 2 mm back IN');
      expect(unbracketed).toContain('which counts as off the blank');
    });

    it('leaves the block out entirely when the setup cannot support it', () => {
      // The scan needs the blank to stand clear of the jaw tops by more than the dial's own
      // tolerance. A blank 0.05 mm proud cannot be told from the jaw at all, so the plan refuses —
      // and §5 then says so in one step rather than printing an offer it cannot honour. The origin
      // itself still resolves (the jaws reference X and rotation here), which is the point: the two
      // refusals are separate questions.
      const job = defaultEngraveJob({ ...DEFAULT_VISE, stockProud: 0.05 });
      const texts = origin(job, SCAN);
      expect(texts.filter((t) => t.startsWith('Touch '))).toHaveLength(3);
      const refused = texts.filter((t) => t.includes('cannot be checked with the probe'));
      expect(refused).toHaveLength(1);
      expect(refused[0]).toContain('check the blank against it with a rule instead');
      expect(texts.some((t) => t.startsWith('Check '))).toBe(false);
    });

    // #391, review of 36f3837 — the block is HELD: the plan is right, the steps a person would follow
    // are not safe yet (a travel cap with no field behind it, an unmeasured tip stated as measured, a
    // direction that reads backwards). So the sheet stops printing them for EVERY caller, and this is
    // the assertion that keeps it that way. It is the whole of the hold: the origin still prints, and
    // `materialScan.spec.ts` still tests the module the block was made of.
    it('does not print the material-position check unless the caller asks for it (#391 hold)', () => {
      const texts = origin(defaultEngraveJob());
      expect(texts.some((t) => t.startsWith('OPTIONAL, BEFORE THE FIRST CUT'))).toBe(false);
      expect(texts.some((t) => t.startsWith('Check '))).toBe(false);
      expect(texts.filter((t) => t.startsWith('Touch '))).toHaveLength(3);
      // The same job, asked for: the block is there, so the hold is a switch and not a deletion.
      expect(origin(defaultEngraveJob(), SCAN).some((t) => t.startsWith('OPTIONAL, BEFORE THE FIRST CUT'))).toBe(true);
    });
  });

  // #213 §6 — the side view of the setup. It is present ONLY when there is sacrificial material,
  // so a job that does not use it keeps the sheet (and this file's snapshot) byte-identical.
  describe('the stack-up elevation (#213 §6)', () => {
    /** A box of the sheet's stack-up by id, asserting the stack-up is there at all. */
    const box = (stackUp: RunSheetStackUp | undefined, id: string) => {
      expect(stackUp, 'stack-up present').toBeTruthy();
      const b = stackUp!.boxes.find((x) => x.id === id);
      expect(b, `stack-up box ${id}`).toBeTruthy();
      return b!;
    };

    it('is absent from a job with no sacrificial material, and its sheet is unchanged', () => {
      const sheet = sheetFor(defaultEngraveJob());
      expect(sheet.stackUp).toBeUndefined();
      expect('stackUp' in sheet).toBe(false);
      // The wording is the pre-#213 sheet's, untouched.
      expect(JSON.stringify(sheet)).toContain("Z0: the blank's top face");
      expect(JSON.stringify(sheet)).not.toContain('Fix the part to the board');
    });

    it('draws the board, the jaws at its overhang, and the part on top', () => {
      const job = defaultEngraveJob();
      job.sacrificial = presetPartOnBoard(); // 12 mm board, 10 mm overhang all round
      const s = sheetFor(job).stackUp!;
      expect(s.datumZ).toBe(0);

      const under = box(s, 'sacrificial-under');
      expect([under.minX, under.maxX, under.minZ, under.maxZ]).toEqual([-10, 110, -24, -12]);
      expect(under.dimension).toBe('12 mm');
      expect(under.sacrificial).toBe(true);

      // The jaws grip the BOARD's overhang, so their faces move out to ±10 past the part.
      expect(box(s, 'vise-fixed-jaw').maxX).toBe(-10);
      expect(box(s, 'vise-moving-jaw').minX).toBe(110);

      // The part sits on the board, its top face at Z0.
      const part = box(s, 'part');
      expect([part.minX, part.maxX, part.minZ, part.maxZ]).toEqual([0, 100, -12, 0]);
      expect(part.sacrificial).toBe(false);
      expect(part.dimension).toBe('12 mm');
    });

    it('draws a strip between each jaw and the part, flush with the part top', () => {
      const job = defaultEngraveJob();
      job.sacrificial = presetJawStrips(); // 6 mm, flush, left and right
      const s = sheetFor(job).stackUp!;

      const left = box(s, 'sacrificial-left');
      expect([left.minX, left.maxX, left.minZ, left.maxZ]).toEqual([-6, 0, -12, 0]);
      expect(left.dimension).toBe('6 mm');
      const right = box(s, 'sacrificial-right');
      expect([right.minX, right.maxX, right.minZ, right.maxZ]).toEqual([100, 106, -12, 0]);

      // The jaws bear on the strips.
      expect(box(s, 'vise-fixed-jaw').maxX).toBe(-6);
      expect(box(s, 'vise-moving-jaw').minX).toBe(106);
      // No board, so no board box.
      expect(s.boxes.some((b) => b.id === 'sacrificial-under')).toBe(false);
    });

    it('does not draw a front or back strip — it lies behind the part in this view', () => {
      const job = defaultEngraveJob();
      job.sacrificial = {
        ...presetPartOnBoard(),
        sides: {
          left: null,
          right: null,
          front: { thickness: 6, height: 'flush' },
          back: { thickness: 6, height: 'flush' },
        },
      };
      const sheet = sheetFor(job);
      expect(sheet.stackUp!.boxes.map((b) => b.id)).toEqual([
        'sacrificial-under',
        'vise-fixed-jaw',
        'vise-moving-jaw',
        'part',
      ]);
      // They are still named for the operator, in section 1's summary (its `value`, where the
      // one-line description of the sacrificial material lives).
      expect(section(sheet, 'need').steps.some((s) => s.value?.includes('front strip') === true)).toBe(true);
    });

    it('renders one rect per box, each dimension, and the Z0 datum on the SVG', () => {
      const job = defaultEngraveJob();
      job.sacrificial = presetPartOnBoard();
      const svg = runSheetStackUpSvg(sheetFor(job).stackUp!);
      expect((svg.match(/data-stackup-id="/g) ?? []).length).toBe(4);
      expect(svg).toContain('board · 12 mm');
      expect(svg).toContain('part · 12 mm');
      expect(svg).toContain('fixed jaw (left)');
      expect(svg).toContain("Z0 — the part's top face");
      // The viewBox is in millimetres and flipped: Z runs up the page, so its TOP edge is -zmax.
      // X spans the board (−10) and the fixed jaw — 10 mm thick, calipered (#208, 2026-10-13/15),
      // its face on the part's own edge → −20 — with the 6 mm margin → −26; the drawing is 6 mm
      // above the part's top face → the viewBox starts at −6.
      expect(svg).toContain('viewBox="-26 -6 152 44"');
    });

    it('tells the operator to fix the part to the board, and that Z0 is the PART, not the board', () => {
      const job = defaultEngraveJob();
      job.sacrificial = presetPartOnBoard();
      const sheet = sheetFor(job);

      const load = section(sheet, 'load').steps.map((s) => s.text).join(' ');
      expect(load).toContain('Fix the part to the board before loading');
      expect(load).toContain("The part's top face must stand");

      const origin = section(sheet, 'origin').steps.map((s) => s.text).join(' ');
      expect(origin).toContain("Z0: the PART's top face");
      expect(origin).toContain('NOT the board');
      // #272 — X0/Y0 are no longer hand-written prose: the section is derived from the workholding,
      // and a board under the part shifts the jaw FACES without changing what they reference, so
      // the datum sentence is the same one a job without a board gets.
      expect(origin).toContain('The vise already references X and rotation');
    });

    it('names which jaw each strip is gripped by', () => {
      const job = defaultEngraveJob();
      job.sacrificial = presetJawStrips();
      const load = section(sheetFor(job), 'load').steps.map((s) => s.text).join(' ');
      expect(load).toContain('Put the left strip between the fixed jaw and the part');
      expect(load).toContain('Put the right strip between the moving jaw and the part');
    });
  });

  it('snapshots the whole RunSheet for the default job', () => {
    const job = defaultEngraveJob();
    // The default job's label ids come from a random generator; pin them so the snapshot is stable.
    job.labels.forEach((label, i) => {
      label.id = `label-${i}`;
    });
    expect(sheetFor(job)).toMatchSnapshot();
  });

  // #345 — the depth-margins block is GATED: a job with no bound at all (the default above) has
  // nothing for it to say, and its sheet must stay exactly what it was. This is the other half of
  // that pair — the sheet of a job that DOES have a bound, so the block's wording and position are
  // pinned rather than only asserted with a `.toContain`.
  it('snapshots the whole RunSheet for a job with a depth bound (#345)', () => {
    const job = defaultEngraveJob();
    job.labels.forEach((label, i) => {
      label.id = `label-${i}`;
    });
    job.keepOuts = [
      {
        id: 'pocket',
        name: 'Magnet pocket',
        kind: 'rect',
        position: { x: 50, y: 30 },
        rotation: 0,
        enabled: true,
        zCeiling: 10,
        width: 20,
        height: 10,
        cornerRadius: 0,
      },
    ];
    expect(sheetFor(job)).toMatchSnapshot();
  });

  // #362 review, #345's rule — the number says where it came from. On the sheet that means the §7
  // cut step: a depth the app CHOSE (0.51 mm on a badge blank is the case that raised this) is the
  // one an operator may read as a mistake, and the clause is the same one the label's own row shows
  // in the panel. A depth a person typed is theirs and gets no sentence.
  describe('where a label’s depth came from (#362 review)', () => {
    /**
     * The default job with its first label's underside binding: a 12 mm blank that keeps 10 mm → a
     * 2 mm floor. Built ONCE per call so the caller can address `labels[0].id` — the ids are minted
     * per job, so a second `defaultEngraveJob()` would name a different label.
     */
    function undersideJob(claim?: 'computed' | 'user'): EngraveJob {
      const base = { ...defaultEngraveJob(), minFloor: 10 };
      const first = base.labels[0]!;
      return {
        ...base,
        labels: base.labels.map((l) => (l.id === first.id ? { ...l, depth: 2 } : l)),
        ...(claim === undefined ? {} : { sources: { labels: { [first.id]: { depth: claim } } } }),
      };
    }
    const cutStep = (job: EngraveJob, value: string) => {
      const step = section(sheetFor(job), 'cut').steps.find((s) => s.value === value);
      expect(step, `a cut step reading ${value}`).toBeTruthy();
      return step!;
    };

    it('states the binding constraint for a depth the recommendation wrote', () => {
      const step = cutStep(undersideJob('computed'), '2 mm deep');
      expect(step.text).toContain("the blank's 10 mm minimum floor allows 2 mm");
    });

    it('says nothing for a depth the person typed, or one with no provenance at all', () => {
      // The same 2 mm, but nobody claimed it: the depth is the user's own doing, and a sentence
      // explaining their number back to them is noise on a sheet read under a spindle.
      expect(cutStep(undersideJob(), '2 mm deep').text).not.toContain('minimum floor allows');
      expect(cutStep(undersideJob('user'), '2 mm deep').text).not.toContain('minimum floor allows');
    });

    it('does not invent a reason for an app-chosen depth this blank no longer produces', () => {
      // `computed` on a job whose arithmetic has since moved — `setStock` can be edited without
      // re-depthing anything. The sheet says the app chose it and what the blank allows NOW, and
      // never quotes a clause for a number the arithmetic does not produce (which is the failure
      // #345 is about: provenance printed for a value it does not describe).
      const job = undersideJob('computed');
      const stale: EngraveJob = {
        ...job,
        labels: job.labels.map((l) => ({ ...l, depth: 1.5 })),
      };
      const step = cutStep(stale, '1.5 mm deep');
      expect(step.text).toContain('the app recommended this depth for the blank it was taken on');
      expect(step.text).toContain("this blank's arithmetic allows 2 mm");
      expect(step.text).not.toContain('minimum floor allows 2 mm');
    });

    it('clears the cutter by the job’s OWN jaw clearance, not a constant', () => {
      // #394 — the 'CASE' line is moved over the fixed jaw's face, because the stop is only printed
      // for a cut the cutter gets over a jaw and the measured box of a centred line never does.
      const base = defaultEngraveJob(); // deepest cut 2.0 mm, jawClearance 1.0
      const job: EngraveJob = { ...base, labels: [{ ...base.labels[0]!, position: { x: 23, y: 43 } }] };
      const stop = section(sheetFor(job), 'load').steps.find((s) =>
        s.text.includes('would work below the jaw tops'),
      )!;
      expect(stop.text).toContain('less than 3 mm, stop');
      // A blank whose clearance the user raised stops higher — the printout cannot tell the
      // operator to go somewhere the app's own jaw check does not.
      const wider = section(sheetFor({ ...job, jawClearance: 1.5 }), 'load').steps.find((s) =>
        s.text.includes('would work below the jaw tops'),
      )!;
      expect(wider.text).toContain('less than 3.5 mm, stop');
    });

    it('says the jaws set no limit where no cut comes over one (#369, #394)', () => {
      // The line above is on the fixed jaw's face, so the stop is live. Moved clear of it — the XY
      // test #369 added, now read against the MEASURED box (#394) — a number below the face would be
      // a stop the app's own jaw check does not make, so it is dropped and the sentence says why
      // instead of printing a limit nobody has to keep.
      const job = defaultEngraveJob();
      const clear: EngraveJob = {
        ...job,
        labels: [{ ...job.labels[0]!, text: 'Name', size: 8, position: { x: 50, y: 30 } }],
      };
      const step = section(sheetFor(clear), 'load').steps.find((s) =>
        s.text.includes('sweeps over a jaw'),
      )!;
      expect(step.text).toContain('No cut on this job sweeps over a jaw');
      expect(step.text).not.toContain('would work below the jaw tops');
      // The face height the operator records is unchanged: only the "stop below" number goes.
      expect(step.text).toContain('4 mm above the jaw tops');
    });

    it('leaves a coupon cell the cutter clears off the stop, and still warns while the band covers it (#394)', () => {
      // The coupon-shaped case the maintainer ruled on. The #284 coupons cut 11 mm value cells on
      // the as-clamped badge blank — built here the way `scripts/bench-files.ts` builds them, from
      // the bench's own base job — and a cell's MEASURED ink is 33.49 mm across that blank's
      // 38.1 mm: 2.31 mm in from each jaw face. Under the old ESTIMATE box (1.95 em per character,
      // 85.8 mm) every cell "reached" both jaws, so §3 printed "less than 1.8 mm, stop" on every
      // coupon — which a blank standing 1.2 mm proud trips — and on the ladder before it.
      //
      // The rule's two readings separate exactly here. 1.1648 mm is INSIDE the shipped vise's own
      // 0.5 mm band plus the cutter's 1 mm radius — a 1.5 mm reach — which is the reading the
      // WARNING uses and one it may keep raising a band early (decision 28); it is OUTSIDE the
      // radius alone, which is the reading the STOP uses — and a stop is an instruction to a
      // person, not advice.
      //
      // The cell is 11.75 mm, not the bench's own 11: the band went 2 → 0.5 mm on 2026-10-15 when
      // the vise's jaws were calipered (#208), and the reach with it, 3 → 1.5 mm. The coupon's real
      // 11 mm cell now sits 2.31 mm out — clear by 0.81 mm past the reach — and would exercise only
      // the half of the ruling below it. A cell has to come to 11.75 mm for the two readings to
      // part company at all, which is itself the measure of how much the caliper bought.
      const coupon = (size: number): EngraveJob => {
        const spec: CouponSpec = {
          id: '284-pla-feed',
          title: '284 PLA feed coupon',
          parameter: 'feed',
          values: [500],
          base: benchJob(),
          text: { size, pitch: 16 },
          origin: { x: 19.05, y: 68 },
          depth: 0.8,
          font: 'sans-default',
          weight: 'bold',
        };
        return buildCouponPrograms(spec)[0]!.job;
      };
      const stepOf = (job: EngraveJob) =>
        section(sheetFor(job), 'load').steps.find((s) => s.text.includes('sweeps over a jaw'))!;

      const cell = coupon(11.75);
      const reach = labelJawReach(cell, cell.labels[0]!);
      expect(reach.jaw).toBe('fixed');
      expect(reach.gap).toBeCloseTo(1.1648, 3);
      expect(reach.reaches).toBe(true);
      expect(reach.overJaw).toBe(false);
      // The bench's own 11 mm cell, the size the four #284 coupons are cut at, no longer reaches:
      // 2.31 mm is 0.81 mm past the measured band and the radius together. Pinned, because it is a
      // consequence of the caliper rather than of anything this rule does.
      const real = coupon(11);
      expect(labelJawReach(real, real.labels[0]!).gap).toBeCloseTo(2.3064, 3);
      expect(labelJawReach(real, real.labels[0]!).reaches).toBe(false);
      // The warning fires — 0.8 mm of cut plus the job's 1.0 mm of clearance is past the 1.2 mm this
      // blank stands — and the sheet states the stand it must be measured against.
      expect(validateJob(cell).map((f) => f.code)).toContain('stock-proud-too-small');
      expect(stepOf(cell).text).toContain('1.2 mm above the jaw tops');
      // …but the stop is not printed: the geometry says there is nothing under a jaw to trip it, and
      // a number the job cannot trip is a number the operator has to argue with at the machine.
      expect(stepOf(cell).text).toContain('No cut on this job sweeps over a jaw, so there is no stop threshold to check');
      expect(stepOf(cell).text).not.toContain('If it is less than');

      // The other half of the ruling: a cell the cutter clears by MORE than the band raises neither.
      // The same value at 10 mm leaves 3.83 mm on each side, past the 1.5 mm the band and the radius
      // reach together — so the warning goes too, not just the stop.
      const clear = coupon(10);
      expect(labelJawReach(clear, clear.labels[0]!).reaches).toBe(false);
      expect(validateJob(clear).map((f) => f.code)).not.toContain('stock-proud-too-small');
      expect(stepOf(clear).text).toContain('No cut on this job sweeps over a jaw');
    });
  });
});
