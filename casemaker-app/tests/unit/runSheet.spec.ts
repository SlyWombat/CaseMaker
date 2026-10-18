/**
 * The operator run sheet (#207): the pure structure `buildRunSheet` returns, the SHA-256 that
 * matches the sheet to the file, and the SVG origin diagram.
 *
 * The generated half is STUBBED the way the issue prescribes: `stubGenerated` stands in for #206's
 * `EngraveGenerated`, computing the same `findings`/`feeds` from the job so the sheet is exercised
 * against the real shapes without the generator existing yet.
 */

import { describe, it, expect } from 'vitest';
import { SCAN_FALLBACK } from '@/engine/cnc/engrave/materialScan';
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
  runSheetFaceFileName,
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
import { surfaceSpreadPlan, type SurfaceReading } from '@/engine/cnc/engrave/surfaceSpread';
import { dedupeFindings, jobTool, validateJob } from '@/engine/cnc/engrave/jobSetup';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import { feedsFor } from '@/engine/cnc/feeds';
import { Z1 } from '@/engine/cnc';
import { DEFAULT_VISE, validateVise } from '@/engine/cnc/fixture';
import { presetJawStrips, presetPartOnBoard } from '@/engine/cnc/sacrificial';
import type { EngraveJob } from '@/types/engraveJob';
import type { Orientation } from '@/engine/cnc/setups/types';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { ThreadPlanFacts, ThreadSettingsResult } from '@/engine/cnc/cam/threadMill';
import { renderRunSheetMarkdown } from '../../scripts/runSheetMarkdown';

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

  // #470 — the tag means "not walked at the bench". The mount, the cutter fit and the origin were
  // walked at the machine on 2026-10-12, -15 and -16, so they carry no tag; what remains is the
  // held material scan and the rest pass's routine, and both name the bench issue that will
  // confirm them.
  it('tags only what has not been walked at the bench, and names the bench issue', () => {
    const tagged = (sheet: RunSheet) => sheet.sections.flatMap((s) => s.steps).filter((s) => s.unverified !== undefined);
    // A default job carries no tag at all: the mount, the cutter and the origin are walked, and the
    // material scan is held off.
    expect(tagged(sheetFor(defaultEngraveJob()))).toEqual([]);
    // The held material scan is where the tag lives, and it names the bench issue — in the origin
    // section, beside the guidance it qualifies.
    const sheet = sheetFor(defaultEngraveJob(), NO_SIM, NC, { materialScan: true });
    const scan = tagged(sheet);
    expect(scan.length).toBeGreaterThan(0);
    for (const step of scan) expect(step.unverified).toBe('#443');
    for (const id of ['mount', 'cutter']) {
      for (const step of section(sheet, id).steps) expect(step.unverified).toBeUndefined();
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

  // #408 — the two halves of one caveat, and both come from the RUN rather than from prose: which
  // engine swept the material, and the band the oracle judged the prediction to. The second is what
  // makes "matches the prediction" falsifiable to its reader, so a sheet that printed the claim
  // without it would be stating a conclusion with no stated tolerance. What the claim COVERS is
  // named too: a V trace's groove is a different width at every level, so "at every level the plan
  // cuts to, and … one derived level just under the top face" is the difference between a checked
  // shape and a checked centreline. The extra level is stated CONDITIONALLY, because the sheet has
  // no way to know whether this job cuts a trace — and a flat job told it was judged at a groove's
  // mouth would be reading a claim about a check that never happened.
  it('states the sampled engine, the levels checked and the oracle band (#408)', () => {
    const job = defaultEngraveJob();
    const sim: RunSheetSim = { diagnostics: [], engine: 'column', oracleBand: 0.1463 };
    const warnings = section(buildRunSheet(job, stubGenerated(job), sim, NOW), 'warnings').steps.map((s) => s.text);
    expect(warnings.some((t) => t.includes('sampled column engine'))).toBe(true);
    expect(warnings.some((t) => t.includes('every level the plan cuts to'))).toBe(true);
    expect(warnings.some((t) => t.includes('where the job cuts a V-bit trace'))).toBe(true);
    expect(warnings.some((t) => t.includes('just under the top face'))).toBe(true);
    expect(warnings.some((t) => t.includes("The comparison's band is 0.146 mm"))).toBe(true);
  });

  it('claims neither when the run states neither (#408)', () => {
    // An exact sweep that checked no prediction says nothing about a band — and naming one would
    // put a tolerance in the sheet for a comparison the run never made. The levels go with it: a
    // sheet that named them would be describing a check that did not happen.
    const job = defaultEngraveJob();
    const warnings = section(sheetFor(job), 'warnings').steps.map((s) => s.text);
    expect(warnings.some((t) => t.includes('sampled column engine'))).toBe(false);
    expect(warnings.some((t) => t.includes('every level the plan cuts to'))).toBe(false);
    expect(warnings.some((t) => t.includes('band of'))).toBe(false);
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
      // #452 — the planner's own 1 mm coarse step (`registration.coarseStepMm`), not the 2 mm the
      // sheet used to compile: the clear-of-the-edge touch is the tip's radius plus one step in.
      expect(checks[0]).toContain('2 and 1 mm inside');
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

      // What the operator writes down for THIS block — the section's own Z0 blank (#410 review item
      // 1, which is above the offer) is not one of them, so the block is sliced from the offer down.
      const from = steps.findIndex((s) => s.text.startsWith('OPTIONAL, BEFORE THE FIRST CUT'));
      expect(from).toBeGreaterThan(-1);
      expect(steps.slice(from).filter((s) => s.record !== undefined).map((s) => s.record)).toEqual([
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
    // #449/#452 — the sheet's scan is the shop's: a location's step, gap, cap margin and feed are the
    // numbers it prints, passed in (`RunSheetOptions.scan`) because this module runs in the sim worker.
    it('prints the shop’s own scan settings when they are passed', () => {
      const scan = { ...SCAN_FALLBACK, coarseStepMm: 0.5, startGapMm: 4, missMarginMm: 2, touchFeed: 120 };
      const steps = section(sheetFor(defaultEngraveJob(), NO_SIM, NC, { ...SCAN, scan }), 'origin').steps;
      const send = steps.find((s) => s.code?.startsWith('G38.2'))!;
      // 4 mm gap + (4 mm proud + 2 mm margin) cap = 10 mm of travel, at the shop's feed.
      expect(send.code).toBe('G38.2 Z-10 F120');
      expect(send.text).toContain('held 4 mm above the top of the blank');
      const checks = steps.map((s) => s.text).filter((t) => t.startsWith('Check '));
      expect(checks[0]).toContain('1.5 and 1 mm inside');
    });

    it('gives every touch a sendable line, its cap, and the way back from a miss (#391 item 1)', () => {
      const steps = section(sheetFor(defaultEngraveJob(), NO_SIM, NC, SCAN), 'origin').steps;
      const codes = steps.filter((s) => s.code !== undefined);

      // 3 mm of start gap over the blank's top, plus the plan's own cap: 5 mm on this job. The Z word
      // is a travel distance from wherever the tip is, which is why the height is stated at all.
      const send = codes.find((s) => s.code!.startsWith('G38.2'))!;
      // #452 — the planner's own scan feed (`registration.touchFeed`, 150), where the sheet said F100.
      expect(send.code).toBe('G38.2 Z-8 F150');
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

      // A pass whose readings are all the blank, or whose innermost is already off it, has
      // nothing to bisect between: the step says which way to step and that a miss counts as off.
      // "All of them" rather than "all four", because a jaw-referenced edge (#430) has one touch
      // and this pass applies to the scanned edges only.
      const unbracketed = texts.find((t) => t.startsWith('If the readings do not bracket'))!;
      expect(unbracketed).toContain('ALL of them reading the blank');
      expect(unbracketed).toContain('step 1 mm further OUT');
      expect(unbracketed).toContain('step 1 mm back IN');
      expect(unbracketed).toContain('which counts as off the blank');
    });

    // #430 — a blank at or below the jaw tops. The gripped edges are read off the jaw's face, and
    // the sheet has to say so: a step that sent the operator walking outward across those edges
    // would send the tip onto the jaw's top, which then stands ABOVE the blank and reads as stock.
    it('reads the gripped edges off the jaw when the blank sits below the jaw tops (#430)', () => {
      const job = defaultEngraveJob();
      job.stock = { ...job.stock, length: 76, width: 25.35, thickness: 1.5 };
      job.workholding = {
        ...job.workholding,
        kind: 'vise',
        vise: { ...job.workholding.vise, stockProud: -1.6 },
      };
      const texts = origin(job, SCAN);
      // The offer counts the two kinds of edge rather than promising four touches at every one.
      const offer = texts.find((t) => t.startsWith('OPTIONAL, BEFORE THE FIRST CUT'))!;
      expect(offer).toContain('two jaw-referenced edges with one confirming touch each');
      expect(offer).toContain('two scanned edges with four touches each');
      // The gripped edge's step is one confirming touch, named as a reference and fenced off.
      const jawStep = texts.find((t) => t.startsWith('Check the left edge'))!;
      expect(jawStep).toContain('BY REFERENCE rather than by scanning');
      expect(jawStep).toContain('the moving jaw closes onto its width');
      expect(jawStep).toContain('Do NOT touch past this edge');
      expect(jawStep).toContain('the blank’s own top');
      // The free ends keep their outward walk, and the cap is quoted below the BLANK's top.
      expect(texts.some((t) => t.startsWith('Check the back edge') && t.includes('outside'))).toBe(true);
      expect(texts.join(' ')).toContain('below the BLANK’s top');
      // The HIGH signature is stated in the jaw's own sign: above the reference, not below it.
      expect(texts.join(' ')).toContain('1.6 mm ABOVE the reference');
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

  // #489 — the sheet carries the cutter's own side profile, from the same model the app draws.
  // It sits under "What you need" (the section that names the cutter) and is absent when the job
  // names no cutter, so a sheet with nothing to draw stays the sheet it was.
  describe('the cutter profile (#489)', () => {
    it('draws the job tool, monochrome and self-contained, with the V groove at the deepest cut', () => {
      const job = defaultEngraveJob();
      job.tool = flatEndMill(3.175, {
        name: '30° engraving bit',
        typeText: 'Engraving',
        shape: 'engraving',
        tipDiameter: 0.3,
        diameter: 3.175,
        halfAngle: 15,
        angle: 30,
        fluteLength: 6,
        shoulderLength: null,
      });
      const sheet = sheetFor(job);
      expect(sheet.toolProfileSvg).toBeDefined();
      const svg = sheet.toolProfileSvg!;
      expect(svg.startsWith('<svg')).toBe(true);
      expect(svg).toContain('30° engraving bit');
      expect(svg).toContain('AN');
      expect(svg).toContain('D1');
      // The groove is drawn at the job's own deepest cut, not a guessed depth.
      expect(svg).toMatch(/at [\d.]+ mm deep/);
      expect(svg).not.toContain('<image');
      expect(svg).not.toContain('href=');
    });

    it('is absent when the job names no cutter', () => {
      const job = defaultEngraveJob();
      job.tool = null;
      job.toolKey = 'user:not-in-this-house';
      const sheet = sheetFor(job);
      expect('toolProfileSvg' in sheet).toBe(false);
    });

    it('embeds the same drawing in the Markdown, under the cutter section', () => {
      const sheet = sheetFor(defaultEngraveJob());
      const md = renderRunSheetMarkdown(sheet);
      const need = md.indexOf('## 1 · What you need');
      const drawing = md.indexOf(sheet.toolProfileSvg!);
      const mount = md.indexOf('## 2 · Mount the vise');
      expect(need).toBeGreaterThan(-1);
      expect(drawing).toBeGreaterThan(need);
      expect(drawing).toBeLessThan(mount);
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
      expect(load).toContain("The part's top face stands");

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

  // #470 — §3's load line is the FIRST setup's ORIENTATION, not a constant: a remounted stock sits
  // with another stock face up, and a quarter turn puts the other dimension between the jaws.
  it('reads the load line off the setup’s orientation', () => {
    const base = defaultEngraveJob();
    base.stock = { ...base.stock, length: 120, width: 80 };
    const load = (orientation: Orientation) => {
      const job: EngraveJob = {
        ...base,
        setups: [{ id: 'setup-1', orientation, mount: { kind: 'vise' }, itemIds: [], tools: [base.toolKey] }],
      };
      const steps = section(sheetFor(job), 'load').steps;
      return steps.find((s) => s.text.includes('runs left–right'))!;
    };
    // The identity every one-setup job carries: the length between the jaws, top face up.
    const identity = load({ top: 'top', bottom: 'bottom', left: 'left', right: 'right', front: 'front', back: 'back' });
    expect(identity.text).toBe("The blank's length runs left–right between the jaws. The face to be engraved is up.");
    expect(identity.value).toBe('120 mm');
    // Tipped so the stock's FRONT face is up: the length is still the way round the jaws.
    const tipped = load({ top: 'front', bottom: 'back', left: 'left', right: 'right', front: 'top', back: 'bottom' });
    expect(tipped.text).toContain("The stock's front face is up — that is the face to be engraved.");
    expect(tipped.value).toBe('120 mm');
    // Quarter-turned: the WIDTH now runs between the jaws, and the width is the number printed.
    const turned = load({ top: 'top', bottom: 'bottom', left: 'front', right: 'back', front: 'left', back: 'right' });
    expect(turned.text).toContain("The blank's width runs left–right between the jaws.");
    expect(turned.value).toBe('80 mm');
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
     * The default job with its first label at the blank's own ceiling: a 12 mm blank that keeps
     * 10 mm → a 2 mm limit (#440). Built ONCE per call so the caller can address `labels[0].id` —
     * the ids are minted per job, so a second `defaultEngraveJob()` would name a different label.
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
      //
      // #440 — the stale number is 3 mm, DEEPER than the 2 mm the blank keeps above its floor, so
      // the recommendation (2 mm) still differs from it. A stale number BELOW the ceiling would now
      // be a recommendation in its own right — the label's own depth — and the "recommended this for
      // the blank it was taken on" sentence would rightly be withdrawn.
      const job = undersideJob('computed');
      const stale: EngraveJob = {
        ...job,
        labels: job.labels.map((l) => ({ ...l, depth: 3 })),
      };
      const step = cutStep(stale, '3 mm deep');
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
      // Since #488 the blank's height is not a refusal of its own: the cut's swept extent keeps
      // 1.1648 mm clear of the fixed jaw face — past the job's 1.0 mm — so the job is cuttable and
      // the sheet states the clearance it keeps instead of demanding a taller stand.
      expect(validateJob(cell).map((f) => f.code)).not.toContain('vise-jaw-collision');
      expect(stepOf(cell).text).toContain('1.2 mm above the jaw tops');
      expect(stepOf(cell).text).toContain('at least 1 mm clear of the jaws');
      // …but the stop is not printed: the geometry says there is nothing under a jaw to trip it, and
      // a number the job cannot trip is a number the operator has to argue with at the machine.
      expect(stepOf(cell).text).toContain('No cut on this job sweeps over a jaw, so there is no stop threshold to check');
      expect(stepOf(cell).text).not.toContain('If it is less than');

      // The other half of the ruling: a cell the cutter clears by MORE than the band still reaches
      // neither a jaw nor the clearance rule.
      // The same value at 10 mm leaves 3.83 mm on each side, past the 1.5 mm the band and the radius
      // reach together — so the reach goes too, not just the stop.
      const clear = coupon(10);
      expect(labelJawReach(clear, clear.labels[0]!).reaches).toBe(false);
      expect(validateJob(clear).map((f) => f.code)).not.toContain('vise-jaw-collision');
      expect(stepOf(clear).text).toContain('No cut on this job sweeps over a jaw');
      expect(stepOf(clear).text).toContain('at least 1 mm clear of the jaws');
    });
  });
});

// #445 phase B — the run sheet's thread half. A thread program cuts the thread only, so the sheet
// has two things the ordinary job has not: a PILOT the operator must have drilled already (§1), and
// a cut section whose numbers come from the worker's `threadSettings`, never a second resolution.
describe('runSheet — the thread program (#445 B2)', () => {
  /** A 4 mm thread mill: inside M5's ⌀4.134 pilot and wide enough for its radial depth. */
  const MILL: Tool = flatEndMill(4, {
    name: '4 mm thread mill',
    typeText: 'Thread Mill',
    shape: 'thread',
    tipDiameter: 4,
    diameter: 4,
    fluteLength: 20,
  });

  const threadJob = (): EngraveJob => ({
    ...defaultEngraveJob(),
    labels: [],
    shapes: [],
    threads: [
      {
        kind: 'thread',
        id: 'thr-1',
        position: { x: 50, y: 30 },
        enabled: true,
        size: 'M5',
        standard: 'metric',
        classFit: '6H',
        depth: 5,
        through: false,
      },
    ],
    tool: MILL,
  });

  const SETTINGS = {
    radialStepoverMm: 0.3,
    entryRampMm: 0.2,
    bottomClearancePitches: 1,
    pilotTipClearanceMm: 1,
    feed: 300,
    plungeFeed: 100,
    spindleRpm: 6000,
    chordToleranceMm: 0.02,
  };

  const MACHINING: ThreadSettingsResult = {
    settings: SETTINGS,
    sources: {
      radialStepoverMm: 'the shop default',
      entryRampMm: 'the shop default',
      bottomClearancePitches: 'the shop default',
      pilotTipClearanceMm: 'the shop default',
      feed: 'the catalogue row for this cutter and material',
      plungeFeed: 'a labelled placeholder — no catalogue row states a plunge feed',
      spindleRpm: 'the catalogue row for this cutter and material',
      chordToleranceMm: 'the shop default',
    },
    diagnostics: [],
  };

  // The CAM's plan carries no name; the sheet zips it from `plan.threads`, so the name here is
  // only for reading this fixture.
  const FACTS: ThreadPlanFacts & { name: string } = {
    name: 'Thread M5×0.8',
    position: [50, 30],
    size: 'M5',
    major: 5,
    pitch: 0.8,
    minor: 4.134,
    cuttingDiameter: 4,
    threadDepth: 5,
    tipDepth: 5.8,
    runOut: 0.8,
    passRadii: [0.2, 0.5],
    chordsPerTurn: 24,
  };

  const threadSheet = (over: Partial<RunSheetGenerated> = {}): RunSheet => {
    const job = threadJob();
    return buildRunSheet(
      job,
      {
        ...stubGenerated(job),
        // A thread job's `feeds` is null: `feedsFor` refuses a thread mill, and the thread branch
        // resolves `threadSettings` instead. `stubGenerated`'s own feeds call is already that refusal.
        threads: [FACTS],
        threadMachining: MACHINING,
        ...over,
      },
      NO_SIM,
      NOW,
    );
  };

  const texts = (sheet: RunSheet, id: string) => section(sheet, id).steps.map((s) => `${s.text} ${s.value ?? ''}`);

  it('§1 states the pilot, its ISO minor and the tip clearance the drill must leave', () => {
    const need = texts(threadSheet(), 'need');
    const pilot = need.find((t) => t.includes('never the pilot'));
    expect(pilot, 'a pilot step').toBeTruthy();
    expect(pilot).toContain('⌀4.134 mm pilot');
    expect(pilot).toContain('5 mm of thread');
    expect(pilot).toContain('clear the tool tip by 1 mm');
  });

  it('§1 tells an old generated object that the clearance was not recorded, rather than guessing one', () => {
    const pilot = texts(threadSheet({ threadMachining: null }), 'need').find((t) => t.includes('never the pilot'));
    expect(pilot).toContain('the tip clearance was not recorded');
  });

  it('a job with no thread has no pilot step — the sheet is unchanged for every other job', () => {
    const job = defaultEngraveJob();
    expect(texts(sheetFor(job), 'need').some((t) => t.includes('never the pilot'))).toBe(false);
    // …and adding the new fields as nulls changes nothing about that sheet: nothing new is gated on
    // `threads`, so the two builds are the same document.
    const plain: RunSheetGenerated = { ...stubGenerated(job), threads: null, threadMachining: null };
    expect(JSON.stringify(buildRunSheet(job, plain, NO_SIM, NOW))).toBe(JSON.stringify(sheetFor(job)));
  });

  it('§7 prints the worker’s own numbers, their source, one line per thread and the check', () => {
    const cut = texts(threadSheet(), 'cut');
    expect(cut.some((t) => t.includes('6000 RPM · 300 mm/min helical feed · 100 mm/min down the pilot'))).toBe(true);
    expect(cut.some((t) => t.includes('2 radial pass(es) at 0.3 mm inward'))).toBe(true);
    expect(cut.some((t) => t.includes('Where those numbers came from: the catalogue row'))).toBe(true);
    expect(cut.some((t) => t.includes('⌀4.134 mm pilot') && t.includes('2 radial pass(es)'))).toBe(true);
    expect(cut.some((t) => t.includes('5 mm of thread'))).toBe(true);
    expect(cut.some((t) => t.includes('Check the thread with a M5 screw'))).toBe(true);
    // R18 / #460 option (a): the thread and the cutter are on ONE line, so a wrong pairing is
    // caught by eye. The item is still the authority for the pitch; this is the person's guard.
    const threadLine = cut.find((t) => t.includes('Thread M5×0.8'))!;
    expect(threadLine).toContain('4 mm thread mill');
    expect(threadLine).toContain('⌀4 mm cutting');
    expect(threadLine).toContain('M5×0.8 — 4 mm thread mill');
    // The ordinary job's "nothing was resolved" line must NOT appear on a thread job.
    expect(cut.some((t) => t.includes('Cutting parameters were not resolved'))).toBe(false);
  });

  it('§7 says a missing cutting diameter in the same thread line rather than omitting the cutter', () => {
    const job = { ...threadJob(), tool: { ...MILL, tipDiameter: null, diameter: null } };
    const sheet = buildRunSheet(
      job,
      { ...stubGenerated(job), threads: [FACTS], threadMachining: MACHINING },
      NO_SIM,
      NOW,
    );
    const threadLine = texts(sheet, 'cut').find((t) => t.includes('Thread M5×0.8'))!;
    expect(threadLine).toContain('4 mm thread mill (cutting diameter not recorded)');
    expect(threadLine).toContain('⌀4.134 mm pilot');
  });

  it('§7 says so when an old generated object carries no resolved thread numbers', () => {
    const cut = texts(threadSheet({ threadMachining: null, threads: null }), 'cut');
    expect(cut.some((t) => t.includes('were not recorded for this run'))).toBe(true);
    // The plan's own facts still print: the item and its threaded length never depend on the CAM.
    expect(cut.some((t) => t.includes('⌀4.134 mm pilot') && t.includes('pass count was not recorded'))).toBe(true);
    expect(cut.some((t) => t.includes('5 mm of thread'))).toBe(true);
  });

  it('§7 repeats a clamp the machine applied, in the machine’s own words', () => {
    const clamped: ThreadSettingsResult = {
      ...MACHINING,
      diagnostics: [{ severity: 'warning', code: 'rpm-clamped', message: '6,000 RPM was clamped to 5,000 by the Z1.' }],
    };
    const cut = texts(threadSheet({ threadMachining: clamped }), 'cut');
    expect(cut.some((t) => t.includes('clamped to 5,000 by the Z1'))).toBe(true);
  });
});

describe('runSheet — the facing phase (#432 slice 3)', () => {
  const CAM = {
    toolName: '6 mm flat end mill',
    diameterMm: 6,
    passes: 3,
    stepDown: 0.2,
    stepOver: 3,
    rpm: 10000,
    feed: 800,
    plungeFeed: 200,
    air: true,
  };

  /** A job that carries a facing choice, and the finish that put it there. */
  function facingJob(facing: EngraveJob['facing'], finish: 'rough' | 'finished' | 'printed' | 'unknown' = 'rough'): EngraveJob {
    const job = defaultEngraveJob();
    return {
      ...job,
      facing,
      stockEntry: { kind: 'made', shelfId: null, file: null, form: 'plate', finish, conductive: false },
    };
  }

  function generatedWithFacing(job: EngraveJob, over: Partial<RunSheetGenerated> = {}): RunSheetGenerated {
    return { ...stubGenerated(job), ...over };
  }

  const texts = (sheet: RunSheet, id: string) =>
    section(sheet, id).steps.map((s) => `${s.text} ${s.value ?? ''}`);

  it('adds no facing section to a job written before #432 — the key absent means no change', () => {
    const sheet = sheetFor(defaultEngraveJob());
    expect(sheet.sections.some((s) => s.id === 'facing')).toBe(false);
  });

  it('puts the skim between the dry run and the cut, and names its own file, cutter and numbers', () => {
    const job = facingJob({ enabled: true, depth: 0.5 });
    const sheet = buildRunSheet(
      job,
      generatedWithFacing(job, { facingNc: ';face\nG21\n', facingError: null, facingCam: CAM }),
      NO_SIM,
      NOW,
    );
    const ids = sheet.sections.map((s) => s.id);
    expect(ids.indexOf('facing')).toBe(ids.indexOf('dry-run') + 1);
    expect(ids.indexOf('cut')).toBe(ids.indexOf('facing') + 1);

    const steps = texts(sheet, 'facing').join(' | ');
    // The finish and the default's own reason, not a second wording.
    expect(steps).toContain('rough stock');
    expect(steps).toContain('rough stock is faced first, so the top is flat and Z0 is on a cut surface');
    // The depth the whole job is posted from, and the file the operator loads.
    expect(steps).toContain('0.5 mm off the whole top');
    expect(steps).toContain(runSheetFaceFileName(job.name));
    // Its OWN cutter — never the engraving bit. The cutter itself is FITTED in the section before
    // this one (#432 review R1), so the step names which one the file runs rather than "fit it".
    expect(steps).toContain('the facing cutter fitted above');
    expect(steps).toContain('not the engraving bit');
    expect(steps).toContain('6 mm flat end mill');
    expect(steps).toContain('⌀ 6 mm');
    // The worker's numbers, verbatim.
    expect(steps).toContain('10000 RPM · 800 mm/min feed · 200 mm/min plunge · 3 × 0.2 mm passes · 3 mm step-over');
    // And the re-touch that MEASURES the faced top, with the probe — the number written down is
    // the measurement, never the expectation.
    expect(steps).toContain('measure the top the skim left');
    expect(steps).toContain('0.5 mm below your FIRST reading');
    expect(section(sheet, 'facing').steps.some((s) => s.record === 'faced surface Z (mm)')).toBe(true);
  });

  it('says plainly when the facing file was not produced, and does not send anyone to it', () => {
    const job = facingJob({ enabled: true, depth: 0.5 });
    const sheet = buildRunSheet(
      job,
      generatedWithFacing(job, {
        facingNc: null,
        facingError: 'no flat end mill the catalogue recommends for PLA',
        facingCam: null,
      }),
      NO_SIM,
      NOW,
    );
    const steps = section(sheet, 'facing').steps;
    const failure = steps.find((s) => s.text.includes('was not produced'));
    expect(failure?.text).toContain('no flat end mill the catalogue recommends for PLA');
    expect(failure?.text).toContain('top will not be skimmed');
    expect(failure?.bold).toBe(true);
    expect(steps.some((s) => s.text.includes(runSheetFaceFileName(job.name)))).toBe(false);
    // Nothing to measure afterwards: the re-touch's blank is the one a skim would have left.
    expect(steps.some((s) => s.record === 'faced surface Z (mm)')).toBe(false);
  });

  it('states that facing is off, quoting the finish default it overrode', () => {
    const job = facingJob({ enabled: false, depth: 0.5 }, 'finished');
    const sheet = buildRunSheet(job, generatedWithFacing(job), NO_SIM, NOW);
    const steps = section(sheet, 'facing').steps;
    expect(steps).toHaveLength(1);
    expect(steps[0]!.text).toContain('turns it off');
    expect(steps[0]!.text).toContain('a finished face is cut as it is');
    expect(steps[0]!.value).toBe('facing off');
  });

  // #474/#493 — facing is for wood and metal only. A plastic job's sheet says that rather than
  // quoting a finish default, and a job that still carries a pass is called out instead of walked
  // through. #493 widened it to every plastic, printed or purchased.
  it.each([
    ['petg', 'PETG'],
    ['abs', 'ABS'],
    ['acrylic', 'Acrylic'],
  ] as const)('says facing is not offered on %s', (material, label) => {
    const base = facingJob({ enabled: false, depth: 0 });
    const job = { ...base, stock: { ...base.stock, material } };
    const steps = section(buildRunSheet(job, generatedWithFacing(job), NO_SIM, NOW), 'facing').steps;
    expect(steps).toHaveLength(1);
    expect(steps[0]!.text).toContain(`facing is not offered on ${label}: a flat cutter smears a plastic top`);
    expect(steps[0]!.value).toBe('facing off');
  });

  it('calls out a plastic job that still carries a facing pass, without sending anyone through it', () => {
    const base = facingJob({ enabled: true, depth: 0.5 });
    const job = { ...base, stock: { ...base.stock, material: 'pla' as const } };
    const sheet = buildRunSheet(job, generatedWithFacing(job, { facingNc: 'x', facingCam: CAM }), NO_SIM, NOW);
    const steps = section(sheet, 'facing').steps;
    expect(steps).toHaveLength(1);
    expect(steps[0]!.text).toContain('still has a 0.5 mm facing pass');
    expect(steps[0]!.text).toContain('The facing program was not produced');
    expect(steps[0]!.text).toContain('facing is not offered on PLA');
    expect(steps[0]!.text).toContain('turn facing off in the Engrave panel');
    expect(steps[0]!.value).toBe('facing on, not offered');
    expect(steps[0]!.bold).toBe(true);
  });

  it('treats a zero depth as not facing, the way the plan does', () => {
    const job = facingJob({ enabled: true, depth: 0 });
    const sheet = buildRunSheet(job, generatedWithFacing(job), NO_SIM, NOW);
    const steps = section(sheet, 'facing').steps;
    expect(steps).toHaveLength(1);
    expect(steps[0]!.value).toBe('facing off');
  });

  it('says the finish is not recorded when the job carries no stock entry', () => {
    const job = { ...defaultEngraveJob(), facing: { enabled: true, depth: 0.5 } };
    const sheet = buildRunSheet(job, generatedWithFacing(job, { facingNc: 'x', facingCam: CAM }), NO_SIM, NOW);
    expect(texts(sheet, 'facing').join(' ')).toContain('finish is not recorded');
  });

  it('still names the file and the re-touch when an old run carries no facing numbers', () => {
    const job = facingJob({ enabled: true, depth: 0.5 });
    const sheet = buildRunSheet(
      job,
      generatedWithFacing(job, { facingNc: 'x', facingError: null, facingCam: null }),
      NO_SIM,
      NOW,
    );
    const steps = texts(sheet, 'facing').join(' | ');
    expect(steps).toContain(runSheetFaceFileName(job.name));
    expect(steps).toContain('measure the top the skim left');
    expect(steps).not.toContain('step-over');
  });

  // #432 review R1 — the sheet used to stop at the re-touch and never calibrate the engraving
  // cutter, so an operator following it had no Z0 for the engraving program at all. The order is
  // now the one `retouchSurface`/`applyCorrection` run in, and the one the bench used:
  //   probe + Z0 → $H, facing cutter, M491, G10 L2 → face → re-touch with the probe →
  //   $H, engraving cutter, M491, G10 L2 → engrave.
  it('orders the run probe → face → re-touch → engrave, calibrating each cutter before its Z0 is written', () => {
    const job = facingJob({ enabled: true, depth: 0.5 });
    const sheet = buildRunSheet(
      job,
      generatedWithFacing(job, { facingNc: ';face\nG21\n', facingError: null, facingCam: CAM }),
      NO_SIM,
      NOW,
    );

    // The probe sets the origin BEFORE any cutter is fitted, so the two sections swap places — and
    // the sheet says so in both titles, because "fit the cutter" is the one step that must not
    // happen first on this job.
    const ids = sheet.sections.map((s) => s.id);
    expect(ids.indexOf('origin')).toBe(ids.indexOf('load') + 1);
    expect(ids.indexOf('cutter')).toBe(ids.indexOf('origin') + 1);
    expect(sheet.sections.find((s) => s.id === 'origin')!.title).toContain('with the probe');
    expect(sheet.sections.find((s) => s.id === 'cutter')!.title).toBe('5 · Fit the facing cutter and measure its length');
    // The engraving program is still the last thing run, after the section that re-zeros for it.
    expect(ids.indexOf('facing')).toBe(ids.indexOf('dry-run') + 1);
    expect(ids.indexOf('cut')).toBe(ids.indexOf('facing') + 1);

    // 1 · the probe, then Z0 — and the Z0 records the PROBE's reading, not "the tool that made it".
    const origin = section(sheet, 'origin').steps;
    const probeFit = origin.findIndex((s) => s.code === 'M491');
    const z0 = origin.findIndex((s) => s.text.startsWith('Z0:'));
    expect(probeFit).toBeGreaterThanOrEqual(0);
    expect(probeFit).toBeLessThan(z0);
    expect(origin[probeFit]!.record).toBe('the probe’s PRB (mm)');
    expect(origin[z0]!.record).toBe('surface Z (mm) and the probe’s PRB (mm)');
    expect(origin[z0]!.text).toContain('probe it with the probe you just fitted');

    // 2 · home, the FACING cutter, its M491, and its own G10 L2 — from the probe's reading.
    const cutter = section(sheet, 'cutter').steps;
    expect(cutter.slice(0, 3).map((s) => s.code ?? '')).toEqual(['$H', 'M491', '']);
    expect(cutter[1]!.record).toBe('the facing cutter’s PRB (mm)');
    expect(cutter[2]!.value).toBe('Z0 = surface + (facing PRB − probe PRB)');
    expect(cutter[2]!.record).toBe('Z0 for the facing program (mm)');
    expect(cutter[2]!.text).toContain('G10 L2');
    // The engraving cutter is NOT fitted here: that is the fault this spec exists for.
    expect(cutter.some((s) => (s.record ?? '').includes('engraving cutter'))).toBe(false);

    // 3 · face, 4 · re-touch with the probe, 5 · the engraving cutter and its G10 L2.
    const facing = section(sheet, 'facing').steps;
    const faceAt = facing.findIndex((s) => s.text.includes(runSheetFaceFileName(job.name)));
    const retouchAt = facing.findIndex((s) => s.record === 'faced surface Z (mm)');
    const engraveFitAt = facing.findIndex((s) => s.record === 'the engraving cutter’s PRB (mm)');
    const engraveZ0At = facing.findIndex((s) => s.record === 'Z0 for the engraving program (mm)');
    expect(faceAt).toBeGreaterThanOrEqual(0);
    expect(retouchAt).toBeGreaterThan(faceAt);
    expect(engraveFitAt).toBeGreaterThan(retouchAt);
    expect(engraveZ0At).toBeGreaterThan(engraveFitAt);
    // The re-touch is made with the PROBE, not a cutter: it measures the faced top.
    expect(facing[retouchAt]!.text).toContain('fit the wired probe again');
    expect(facing[engraveFitAt]!.code).toBe('M491');
    expect(facing[engraveZ0At]!.value).toBe('Z0 = faced surface + (engraving PRB − probe PRB)');
    expect(facing[engraveZ0At]!.text).toContain('G10 L2');

    // 6 · the cut assumes the Z0 the section above wrote, and refits nothing.
    expect(section(sheet, 'cut').steps.some((s) => s.code === 'M491')).toBe(false);
  });

  it('sends the dry run on to the skim rather than straight to the cut, only on a facing job', () => {
    const plain = texts(sheetFor(defaultEngraveJob()), 'dry-run').join(' ');
    expect(plain).toContain('Otherwise load');
    const job = facingJob({ enabled: true, depth: 0.5 });
    const facing = texts(
      buildRunSheet(job, generatedWithFacing(job, { facingNc: 'x', facingCam: CAM }), NO_SIM, NOW),
      'dry-run',
    ).join(' ');
    expect(facing).toContain('face the top and re-touch Z0 first');
  });
});

// #491 — the sheet's "The cutter" step carries the colour word of the copy the pick would choose.
// The sheet stays pure: the word is handed in (`toolCase`), never read from a registry the bench
// CLI and the sim worker do not have. Absent means the old colourless sentence — never a guess.
describe('#491 the cutter’s case on the run sheet', () => {
  const cutterStep = (options: RunSheetOptions) =>
    section(sheetFor(defaultEngraveJob(), NO_SIM, NC, options), 'need').steps.find((s) =>
      s.text.startsWith('The cutter'),
    )!;

  it('prints the word before the full label name', () => {
    expect(cutterStep({}).text).not.toContain('case');
    expect(cutterStep({ toolCase: 'Yellow case' }).text).toMatch(/^The cutter — Yellow case — .+\.$/);
    expect(cutterStep({ toolCase: 'Yellow case (new) or green case (used)' }).text).toContain(
      'Yellow case (new) or green case (used) —',
    );
  });

  it('leaves a sheet built without the option byte-identical to before the field existed', () => {
    // One job and one generated result: `defaultEngraveJob()` mints fresh label ids each call, so
    // two of them would differ for a reason that has nothing to do with the new option.
    const job = defaultEngraveJob();
    const generated = stubGenerated(job);
    expect(JSON.stringify(buildRunSheet(job, generated, NO_SIM, NOW))).toBe(
      JSON.stringify(buildRunSheet(job, generated, NO_SIM, NOW, undefined, {})),
    );
    expect(cutterStep({}).text).not.toContain('— Yellow');
  });
});


// #475 — Z0 on a bowed blank is measured, not a point. The sheet plans the touches across the cut's
// extents and prints the band; with readings it prints the verdict, and the refusal is the finding's
// own sentence so the paper and the app cannot say two things.
describe('the surface spread (#475)', () => {
  it('plans the cut-extent touches and the Z0 rule on every sheet', () => {
    const job = defaultEngraveJob();
    const steps = section(sheetFor(job), 'origin').steps;
    const all = steps.map((s) => s.text).join('\n');
    expect(all).toContain("The blank's top is measured at 5 points across the cut");
    expect(all).toContain("Surface touch 1 of 5: the cut area's centre");
    expect(all).toContain('Surface touch 5 of 5: the cut area\'s back extent');
    expect(all).toContain('Set Z0 from the LOWEST of these 5 readings');
    expect(all).toContain('A surface spread wider than that band cannot keep every floor past the colour line');
    // No readings: the stop rule quotes the refusal, and does not claim a verdict.
    expect(all).toContain('If the lowest and highest readings differ by more than');
    expect(all).toContain('this blank is bowed <spread> mm across the cut');
    expect(all).not.toContain('Measured: lowest');
  });

  it('prints the measured refusal with the finding’s exact sentence', () => {
    const job = defaultEngraveJob();
    const plan = surfaceSpreadPlan(job)!;
    const readings: SurfaceReading[] = plan.touches.map(() => ({ z: 0, source: 'probe' }));
    readings[readings.length - 1] = { z: -(plan.band.width + 0.01), source: 'stated' };
    const steps = section(sheetFor(job, NO_SIM, NC, { surfaceReadings: readings }), 'origin').steps;
    const spread = Math.round((plan.band.width + 0.01) * 1000) / 1000;
    const refusal = `this blank is bowed ${spread} mm across the cut; the floors cannot stay past the colour line and clear of the pocket`;
    expect(steps.some((s) => s.bold === true && s.text === refusal)).toBe(true);
    expect(steps.map((s) => s.text).join('\n')).toContain('(stated)');
    expect(steps.map((s) => s.text).join('\n')).toContain('Do not run this file');
  });

  it('prints the landing range when the spread fits', () => {
    const job = defaultEngraveJob();
    const plan = surfaceSpreadPlan(job)!;
    const readings: SurfaceReading[] = plan.touches.map(() => ({ z: 0, source: 'probe' }));
    const steps = section(sheetFor(job, NO_SIM, NC, { surfaceReadings: readings }), 'origin').steps;
    const all = steps.map((s) => s.text).join('\n');
    expect(all).toContain('spread 0 mm against the');
    expect(all).toContain('may land from');
    expect(all).toContain('mm below Z0 and nowhere else');
    expect(steps.some((s) => s.bold === true && s.text.startsWith('this blank is bowed'))).toBe(false);
  });
});

// #434 — a drill bit's program is its own file, and the sheet states the drill's numbers: the
// point and its provenance, the peck, the re-entry clearance, the feed and spindle (placeholders),
// and each hole's full-diameter depth against its tip depth. The facts come from the generated
// program, never a second resolution of the shop's defaults.
describe('runSheet — the through cut and its tabs (#218)', () => {
  const ENGR = 'inv:engraver-0.2';
  const program = (nc: string, frameNc: string | null, toolKey: string, extra: object = {}) => ({
    setupIndex: 1,
    toolKey,
    nc,
    frameNc,
    cam: { operations: 2, cuttingMoves: 40, estimatedSeconds: 30, passes: 1 },
    ...extra,
  });
  const sectionText = (sheet: RunSheet, id: string): string =>
    section(sheet, id).steps.map((step) => `${step.text} ${step.value ?? ''}`).join('\n');

  const throughFacts = (): NonNullable<RunSheetGenerated['through']> => ({
    breakthroughMm: 0.3,
    boardThicknessMm: 12,
    cutouts: [
      { id: 'cut-1', name: 'Badge', tabs: { count: 4, widthMm: 4, heightMm: 1 }, spans: 4, unplaceable: 0 },
      { id: 'cut-2', name: 'Insert', tabs: { count: 0, widthMm: 4, heightMm: 1 }, spans: 0, unplaceable: 0 },
    ],
  });

  it('states the breakthrough and the board left under it, and gives tab removal its own step', () => {
    const job = defaultEngraveJob();
    const sheet = buildRunSheet(job, { ...stubGenerated(job), through: throughFacts() }, NO_SIM, NOW);
    const cut = sectionText(sheet, 'cut');
    expect(cut).toContain('cuts 2 pieces out of the blank and through into the board');
    expect(cut).toContain('0.3 mm past the blank\'s underside');
    expect(cut).toContain('the board is 12 mm thick');
    expect(cut).toContain('kerf stops 11.7 mm short of its underside');
    // The tab step is a step of its own, not a sentence inside the breakthrough one.
    expect(cut).toContain('remove the cut-out parts');
    expect(cut).toContain('Badge: 4 tabs, 4 mm wide and 1 mm high');
    expect(cut).toContain('Only after the program ends');
    expect(cut).toContain('4 tabs to cut by hand');
    // The zero-tab cut-out contributes no tab detail.
    expect(cut).not.toContain('Insert:');
  });

  it('omits the tab step when no cut-out has tabs, and says nothing without through facts', () => {
    const job = defaultEngraveJob();
    const noTabs: RunSheetGenerated['through'] = {
      breakthroughMm: 0.3,
      boardThicknessMm: null,
      cutouts: [{ id: 'c', name: 'Part', tabs: { count: 0, widthMm: 4, heightMm: 1 }, spans: 0, unplaceable: 0 }],
    };
    const withNone = sectionText(buildRunSheet(job, { ...stubGenerated(job), through: noTabs }, NO_SIM, NOW), 'cut');
    expect(withNone).toContain('cuts one piece out of the blank');
    expect(withNone).not.toContain('cut the holding tab');
    expect(withNone).not.toContain('board is');

    const plain = sectionText(buildRunSheet(job, stubGenerated(job), NO_SIM, NOW), 'cut');
    expect(plain).not.toContain('through into the board');
  });

  it('prints the facts in a later program’s own section too', () => {
    const job = defaultEngraveJob();
    const sheet = buildRunSheet(
      job,
      {
        ...stubGenerated(job),
        through: null,
        programs: [
          program(NC, `${NC}\n;frame\n`, ENGR),
          program(`${NC}\n;2\n`, `${NC}\n;2\n;frame\n`, ENGR, { through: throughFacts() }),
        ],
      },
      NO_SIM,
      NOW,
    );
    const cut2 = sectionText(sheet, 'cut-2');
    expect(cut2).toContain('through into the board');
    expect(cut2).toContain('4 tabs to cut by hand');
    expect(sectionText(sheet, 'cut')).not.toContain('through into the board');
  });
});

describe('runSheet — the drill program (#434)', () => {
  const DRILL = flatEndMill(3, {
    name: '3 mm drill',
    typeText: 'Drill',
    shape: 'drill',
    tipDiameter: 3,
    diameter: 3,
    angle: null,
    centreCutting: null,
  });

  const drillJob = (): EngraveJob => {
    const base = defaultEngraveJob();
    return {
      ...base,
      labels: [],
      shapes: [],
      drills: [
        {
          id: 'port',
          kind: 'drill',
          name: 'port',
          position: { x: 50, y: 30 },
          rotation: 0,
          depth: 4,
          enabled: true,
          through: false,
        },
      ],
      toolKey: 'inv:drill-3',
      tool: DRILL,
    };
  };

  const withDrill = (job: EngraveJob): RunSheetGenerated => ({
    ...stubGenerated(job),
    drill: {
      toolName: '3 mm drill',
      settings: { peckDiameters: 1, peckClearanceMm: 0.5, pointAngleDeg: 118, plungeFeed: 120, spindleRpm: 9000 },
      sources: {
        peckDiameters: 'chosen for this bench',
        peckClearanceMm: 'chosen for this bench',
        pointAngleDeg: 'chosen for this bench',
        plungeFeed: 'placeholder, not measured',
        spindleRpm: 'placeholder, not measured',
      },
      plans: [
        {
          id: 'port',
          name: 'Drill "port"',
          diameter: 3,
          angle: { deg: 118, from: 'the shop default drill.pointAngleDeg (chosen for this bench)' },
          pointLength: 0.901,
          tipDepth: 4.901,
          peck: 3,
          holes: [[50, 30]],
        },
      ],
      simDrillPoint: { deg: 118, source: 'chosen for this bench' },
    },
  });

  it('§1 states the point and where its angle came from, and §7 prints the drill.* numbers', () => {
    const job = drillJob();
    const sheet = buildRunSheet(job, withDrill(job), NO_SIM, NOW);
    const need = section(sheet, 'need').steps;
    const needText = need.map((s) => `${s.text} ${s.value ?? ''}`).join('\n');
    expect(needText).toContain('The drill’s point');
    expect(needText).toContain('118° included');
    expect(needText).toContain('0.901 mm below the full ⌀3 mm');
    expect(needText).toContain('chosen for this bench');

    const cut = section(sheet, 'cut').steps;
    const cutText = cut.map((s) => `${s.text} ${s.value ?? ''}`).join('\n');
    expect(cutText).toContain('Drill with 3 mm drill');
    expect(cutText).toContain('9000 RPM');
    expect(cutText).toContain('120 mm/min plunge');
    expect(cutText).toContain('pecks of 1 × ⌀3 = 3 mm');
    expect(cutText).toContain('re-entry 0.5 mm');
    expect(cutText).toContain('drill.peckDiameters');
    expect(cutText).toContain('placeholder, not measured');
    // The hole's full-diameter depth and the tip, side by side.
    expect(cutText).toContain('The full ⌀3 mm reaches 4 mm');
    expect(cutText).toContain('tip carries 0.901 mm lower, to 4.901 mm');
    expect(cutText).not.toContain('Cutting parameters were not resolved');
  });

  it('says nothing about a drill on a program that carries no drill facts', () => {
    const job = drillJob();
    const sheet = buildRunSheet(job, stubGenerated(job), NO_SIM, NOW);
    const all = sheet.sections.flatMap((s) => s.steps.map((step) => `${step.text} ${step.value ?? ''}`)).join('\n');
    expect(all).not.toContain('drill.peckDiameters');
    expect(all).not.toContain('The drill’s point');
  });
});

describe('runSheet — every program gets its own Cut section (#419)', () => {
  const ENGR = 'inv:engraver-0.2';
  const DRILL_NC = 'G21 G90\nT2 M6\nS9000\nG1 Z-4.901 F120\nM2';
  const DRILL_FRAME = 'G21 G90\nT2 M6\nG1 Z1.000\nM2';
  const OTHER_NC = 'G21 G90\nT1 M6\nS18000\nG1 Z-0.300 F420\nM2';
  const OTHER_FRAME = 'G21 G90\nT1 M6\nG1 Z1.000\nM2';

  /** A run program as the generated result carries it: its own file, frame and CAM summary. */
  const program = (nc: string, frameNc: string | null, toolKey: string, extra: object = {}) => ({
    setupIndex: 1,
    toolKey,
    nc,
    frameNc,
    cam: { operations: 2, cuttingMoves: 40, estimatedSeconds: 30, passes: 1 },
    ...extra,
  });

  const allText = (sheet: RunSheet): string =>
    sheet.sections.flatMap((s) => s.steps.map((step) => `${step.text} ${step.value ?? ''}`)).join('\n');
  const sectionText = (sheet: RunSheet, id: string): string =>
    section(sheet, id).steps.map((step) => `${step.text} ${step.value ?? ''}`).join('\n');

  // Reuse the drill fixture from #434's block: the same bit, the same numbers, as program 2.
  const drillJob2 = (): EngraveJob => {
    const base = defaultEngraveJob();
    return {
      ...base,
      labels: [],
      shapes: [],
      drills: [
        {
          id: 'port',
          kind: 'drill',
          name: 'port',
          position: { x: 50, y: 30 },
          rotation: 0,
          depth: 4,
          enabled: true,
          through: false,
        },
      ],
      toolKey: 'inv:drill-3',
      tool: flatEndMill(3, {
        name: '3 mm drill',
        typeText: 'Drill',
        shape: 'drill',
        tipDiameter: 3,
        diameter: 3,
        angle: null,
        centreCutting: null,
      }),
    };
  };

  const drillFacts = (): RunSheetGenerated['drill'] => ({
    toolName: '3 mm drill',
    settings: { peckDiameters: 1, peckClearanceMm: 0.5, pointAngleDeg: 118, plungeFeed: 120, spindleRpm: 9000 },
    sources: {
      peckDiameters: 'chosen for this bench',
      peckClearanceMm: 'chosen for this bench',
      pointAngleDeg: 'chosen for this bench',
      plungeFeed: 'placeholder, not measured',
      spindleRpm: 'placeholder, not measured',
    },
    plans: [
      {
        id: 'port',
        name: 'Drill "port"',
        diameter: 3,
        angle: { deg: 118, from: 'the shop default drill.pointAngleDeg (chosen for this bench)' },
        pointLength: 0.901,
        tipDepth: 4.901,
        peck: 3,
        holes: [[50, 30]],
      },
    ],
    simDrillPoint: { deg: 118, source: 'chosen for this bench' },
  });

  it('describes a drill program 2 in its own section and leaves program 1 free of drill facts', () => {
    const job = drillJob2();
    const generated: RunSheetGenerated = {
      ...stubGenerated(job),
      programs: [
        program(NC, `${NC}\n;frame\n`, ENGR),
        program(DRILL_NC, DRILL_FRAME, 'inv:drill-3', { drill: drillFacts() }),
      ],
    };
    const sheet = buildRunSheet(job, generated, NO_SIM, NOW);
    expect(section(sheet, 'cut')).toBeTruthy();
    expect(section(sheet, 'cut-2')).toBeTruthy();

    // The plan's order is the physical order: after program 1, before the warnings.
    const ids = sheet.sections.map((s) => s.id);
    expect(ids.indexOf('cut')).toBeLessThan(ids.indexOf('cut-2'));
    expect(ids.indexOf('cut-2')).toBeLessThan(ids.indexOf('warnings'));
    expect(section(sheet, 'cut-2').title).toContain('program 2');
    expect(section(sheet, 'cut-2').title).toContain('3 mm drill');

    const cut = sectionText(sheet, 'cut');
    expect(cut).not.toContain('Drill with');
    expect(cut).not.toContain('drill.peckDiameters');
    expect(cut).not.toContain(DRILL_NC);

    const cut2 = sectionText(sheet, 'cut-2');
    // Who it is and what it cuts.
    expect(cut2).toContain(`Program 2 is ${DRILL_NC}, the drill program`);
    expect(cut2).toContain('cut with 3 mm drill');
    // The point step, stated once for this program.
    expect(cut2).toContain('The drill’s point');
    expect(cut2).toContain('118° included');
    expect(cut2).toContain('0.901 mm below the full ⌀3 mm');
    // The drill.* numbers and their provenance.
    expect(cut2).toContain('Drill with 3 mm drill');
    expect(cut2).toContain('9000 RPM');
    expect(cut2).toContain('120 mm/min plunge');
    expect(cut2).toContain('pecks of 1 × ⌀3 = 3 mm');
    expect(cut2).toContain('re-entry 0.5 mm');
    expect(cut2).toContain('drill.peckDiameters');
    expect(cut2).toContain('placeholder, not measured');
    // Full-diameter depth against the tip.
    expect(cut2).toContain('The full ⌀3 mm reaches 4 mm');
    expect(cut2).toContain('tip carries 0.901 mm lower, to 4.901 mm');
    // Its own frame and file, never program 1's.
    expect(cut2).toContain(DRILL_FRAME);
    expect(cut2).toContain(DRILL_NC);
    expect(cut2).not.toContain(NC);

    // One copy, in one section: the drill is not also printed under program 1.
    const all = allText(sheet);
    expect(all.split('Drill with 3 mm drill').length - 1).toBe(1);
    expect(all.split('drill.peckDiameters').length - 1).toBe(1);
    // And §1 does not claim a drill point for a run that engraves first.
    expect(sectionText(sheet, 'need')).not.toContain('The drill’s point');

    // The printed sheet carries the section too, under its own heading.
    const md = renderRunSheetMarkdown(sheet);
    expect(md).toContain(`## ${section(sheet, 'cut-2').title}`);
    expect(md).toContain('Drill with 3 mm drill');
  });

  it('gives any later engraving program its own file, frame and CAM estimate', () => {
    const job = defaultEngraveJob();
    const generated: RunSheetGenerated = {
      ...stubGenerated(job),
      programs: [
        program(NC, `${NC}\n;frame\n`, ENGR),
        program(OTHER_NC, OTHER_FRAME, 'inv:o-flute-0.6'),
      ],
    };
    const sheet = buildRunSheet(job, generated, NO_SIM, NOW);
    const cut2 = sectionText(sheet, 'cut-2');
    expect(cut2).toContain(`Program 2 is ${OTHER_NC}`);
    expect(cut2).toContain('cut with inv:o-flute-0.6');
    expect(cut2).toContain(OTHER_FRAME);
    expect(cut2).toContain(OTHER_NC);
    expect(cut2).toContain('2 operations');
    expect(sectionText(sheet, 'cut')).not.toContain(OTHER_NC);
  });

  it('warns, bold, when a later program has no frame file', () => {
    const job = defaultEngraveJob();
    const generated: RunSheetGenerated = {
      ...stubGenerated(job),
      programs: [program(NC, `${NC}\n;frame\n`, ENGR), program(OTHER_NC, null, ENGR)],
    };
    const steps = section(buildRunSheet(job, generated, NO_SIM, NOW), 'cut-2').steps;
    const noFrame = steps.find((s) => s.text.includes('There is no frame file for program 2'));
    expect(noFrame).toBeTruthy();
    expect(noFrame!.bold).toBe(true);
    expect(noFrame!.text).toContain('Do not run');
  });

  it('keeps a list with only program 1 — or no list at all — byte-identical', () => {
    const job = defaultEngraveJob();
    const without = buildRunSheet(job, stubGenerated(job), NO_SIM, NOW);
    const withOne: RunSheetGenerated = {
      ...stubGenerated(job),
      programs: [program(NC, `${NC}\n;frame\n`, ENGR)],
    };
    const one = buildRunSheet(job, withOne, NO_SIM, NOW);
    // No cut-2 (and no other per-program section) when only the first program exists.
    expect(one.sections.map((s) => s.id)).toEqual(without.sections.map((s) => s.id));
    expect(one.sections.map((s) => s.steps)).toEqual(without.sections.map((s) => s.steps));
    expect(one.sections.map((s) => s.title)).toEqual(without.sections.map((s) => s.title));
  });

  it('skips a facing entry when it numbers the engraving programs', () => {
    const job = defaultEngraveJob();
    const generated: RunSheetGenerated = {
      ...stubGenerated(job),
      programs: [
        program('face.nc', 'face.frame.nc', 'inv:face', { kind: 'facing' }),
        program(NC, `${NC}\n;frame\n`, ENGR),
        program(OTHER_NC, OTHER_FRAME, ENGR),
      ],
    };
    const sheet = buildRunSheet(job, generated, NO_SIM, NOW);
    // The face has its own section; the first ENGRAVING file is program 1, so the second is
    // program 2 — not 3.
    expect(section(sheet, 'cut-2')).toBeTruthy();
    expect(sectionText(sheet, 'cut-2')).toContain('Program 2 is');
    expect(sheet.sections.some((s) => s.id === 'cut-3')).toBe(false);
  });
});

// #250 — the roughing and finishing removals are two steps, and the allowance says where its number
// came from. The sheet prints the worker's facts; it never re-resolves the shop default.
describe('runSheet — the finish pass (#250)', () => {
  const finishFacts = (mode: 'rough-and-finish' | 'rough-only' | 'finish-only', ids: readonly string[]) => ({
    stockToLeaveMm: { value: 0.2, source: 'chosen' as const },
    mode,
    itemIds: ids,
  });

  it('prints a roughing and a finishing row for every split item, with the allowance provenance', () => {
    const job = defaultEngraveJob();
    const ids = job.labels.map((l) => l.id);
    const stub = stubGenerated(job);
    const generated: RunSheetGenerated = {
      ...stub,
      finish: finishFacts('rough-and-finish', ids),
      cam: { ...stub.cam!, roughOperations: ids.length, finishOperations: ids.length },
    };
    const cut = section(buildRunSheet(job, generated, NO_SIM, NOW), 'cut').steps.map((s) => s.text);
    expect(cut.filter((t) => t.includes('roughing pass:')).length).toBe(ids.length);
    expect(cut.filter((t) => t.includes('finishing pass:')).length).toBe(ids.length);
    expect(cut.some((t) => t.includes('Finish allowance: the roughing pass leaves 0.2 mm'))).toBe(true);
    expect(cut.some((t) => t.includes('a value chosen for this shop'))).toBe(true);
    expect(cut.some((t) => t.includes('This file follows it with the finishing pass'))).toBe(true);
  });

  it('a rest pair’s first program states only the roughing removal and points at the later file', () => {
    const job = defaultEngraveJob();
    const ids = job.labels.map((l) => l.id);
    const stub = stubGenerated(job);
    const sheet = buildRunSheet(
      job,
      { ...stub, finish: finishFacts('rough-only', ids), cam: { ...stub.cam!, roughOperations: ids.length } },
      NO_SIM,
      NOW,
    );
    const cut = section(sheet, 'cut').steps.map((s) => s.text);
    expect(cut.filter((t) => t.includes('roughing pass:')).length).toBe(ids.length);
    expect(cut.some((t) => t.includes('finishing pass:'))).toBe(false);
    expect(cut.some((t) => t.includes('A later program in this run is the finishing pass'))).toBe(true);
  });
});
