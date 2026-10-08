/**
 * The run record (#277): the file the app writes beside the `.nc`, and the one rule that keeps a
 * measurement a measurement.
 *
 * The half that matters here is not JSON plumbing — it is that the app writes a file whose every
 * measured field is blank, that the blanks are the SAME LIST the printed run sheet asks for, and
 * that `parseRunRecord` refuses a record which carries readings but no date. That last one is the
 * acceptance criterion: without it a hand-edit could put an undated number in front of the operator
 * looking exactly like a bench result.
 */

import { describe, it, expect } from 'vitest';

import {
  buildRunRecord,
  isMeasuredRun,
  isTimedRun,
  parseRunRecord,
  parseRunRecordText,
  runRecordFileName,
  RUN_RECORD_INSTRUCTIONS,
  RUN_RECORD_KIND,
  RUN_RECORD_SCHEMA_VERSION,
  serializeRunRecord,
  type RunRecord,
} from '@/engine/cnc/engrave/runRecord';
import {
  buildRunSheet,
  recordDepths,
  runSheetFileName,
  sha256Hex,
  type RunSheetGenerated,
  type RunSheetSim,
} from '@/engine/cnc/engrave/runSheet';
import { toPartPlan } from '@/engine/cnc/engrave/partPlan';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { jobTool, validateJob } from '@/engine/cnc/engrave/jobSetup';
import { feedsFor } from '@/engine/cnc/feeds';
import { Z1 } from '@/engine/cnc';
import type { EngraveJob } from '@/types/engraveJob';

const NOW = new Date('2026-10-04T00:00:00Z');
const NC = [';@MKR|BEGIN', 'G21 G90', 'T1 M6', 'G1 Z-2.000 F200', 'M2'].join('\n');
const NO_SIM: RunSheetSim = { diagnostics: [] };

/** The generated half, stubbed from the job exactly as `runSheet.spec.ts` does. */
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
      stats: { lines: 5, cuttingMoves: 2, deepestZ: -2, bbox: { min: [0, 0, -2], max: [10, 10, 0] } },
    },
    frameNc: `${nc}\n;frame\n`,
  };
}

describe('runRecord (#277)', () => {
  // -------------------------------------------------------------------------------------------
  // The name — the record sits BESIDE the program and cannot be mistaken for it
  // -------------------------------------------------------------------------------------------

  it('names the record after the program it describes', () => {
    expect(runRecordFileName('CNC 2 acceptance')).toBe('CNC-2-acceptance-run.json');
    expect(runRecordFileName('')).toBe('engrave-job-run.json');
    // Same stem as the `.nc`, so the pair travels together and neither can be renamed alone.
    const stem = runSheetFileName('My Job').slice(0, -3);
    expect(runRecordFileName('My Job')).toBe(`${stem}-run.json`);
  });

  // -------------------------------------------------------------------------------------------
  // Building — the app writes only what it knows
  // -------------------------------------------------------------------------------------------

  it('fills the app half and leaves every measured field blank', () => {
    const job = defaultEngraveJob();
    const generated = stubGenerated(job);
    const run = buildRunRecord(job, generated, NOW);
    const tool = jobTool(job)!;

    expect(run.kind).toBe(RUN_RECORD_KIND);
    expect(run.schemaVersion).toBe(RUN_RECORD_SCHEMA_VERSION);
    expect(run.job).toBe(job.name);
    expect(run.ncFile).toBe(runSheetFileName(job.name));
    expect(run.ncHash).toBe(sha256Hex(NC).slice(0, 8));
    expect(run.tool).toBe(tool.name);
    expect(run.cuttingDiameter).toBe(tool.tipDiameter ?? tool.diameter);
    expect(run.estimatedSeconds).toBe(95);
    expect(run.generatedOn).toBe('2026-10-04');
    expect(run.instructions).toBe(RUN_RECORD_INSTRUCTIONS);

    // The measured half: a person's, and blank. Not a zero, not an estimate — `null`.
    expect(run.cutOn).toBeNull();
    expect(run.minutes).toBeNull();
    expect(run.cutter).toEqual({ fluteLengthMm: null, stickOutMm: null });
    expect(run.stockProudMm).toBeNull();
    expect(run.legible).toBeNull();
    expect(run.finish).toBeNull();
    expect(run.notes).toBe('');
    expect(run.depths.every((d) => d.measured === null)).toBe(true);

    // And it is not a result: the app has measured nothing.
    expect(isMeasuredRun(run)).toBe(false);
    expect(isTimedRun(run)).toBe(false);
  });

  it('carries one blank per row the printed run sheet asks the operator to fill', () => {
    const job = defaultEngraveJob();
    const run = buildRunRecord(job, stubGenerated(job), NOW);
    const plan = toPartPlan(job);

    // The sheet's §9 opens with one "measured floor depth" blank per cut item; the record's depths
    // array must be that same list — same order, same names, same posted depths. Nothing in the
    // record can answer a row the sheet did not print.
    const sheet = buildRunSheet(job, stubGenerated(job), NO_SIM, NOW);
    const record = sheet.sections.find((s) => s.id === 'record')!;
    const depthRows = record.steps.filter((s) => s.text.startsWith('Measured floor depth — '));
    expect(depthRows.map((s) => s.text)).toEqual(
      run.depths.map((d) => `Measured floor depth — ${d.name}`),
    );
    expect(depthRows.length).toBeGreaterThan(0);
    expect(run.depths.map((d) => d.id)).toEqual(recordDepths(plan).map((d) => d.id));
    expect(run.depths.map((d) => d.planned)).toEqual(recordDepths(plan).map((d) => d.depth));
    // §9's three fixed rows follow the depth blanks — legible, finish, notes.
    expect(record.steps.slice(depthRows.length).map((s) => s.record)).toEqual([
      'yes / no',
      'clean / fuzzy / burnt',
      'notes',
    ]);
  });

  it('keeps an estimate of zero rather than reading it as absent', () => {
    const job = defaultEngraveJob();
    const generated = stubGenerated(job);
    const run = buildRunRecord(job, { ...generated, cam: { ...generated.cam!, estimatedSeconds: 0 } }, NOW);
    expect(run.estimatedSeconds).toBe(0);
    const back = parseRunRecord(JSON.parse(serializeRunRecord(run)));
    expect(back.ok && back.run.estimatedSeconds).toBe(0);
  });

  it('round trips through its own text, unchanged', () => {
    const job = defaultEngraveJob();
    const run = buildRunRecord(job, stubGenerated(job), NOW);
    const text = serializeRunRecord(run);
    expect(text.endsWith('\n')).toBe(true);
    const back = parseRunRecordText(text);
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.run).toEqual(run);
  });

  // -------------------------------------------------------------------------------------------
  // The rule: readings need a date
  // -------------------------------------------------------------------------------------------

  /** A built record with `over` applied — the hand-edit at the bench, in memory. */
  function edited(over: Partial<RunRecord>): RunRecord {
    const job = defaultEngraveJob();
    return { ...buildRunRecord(job, stubGenerated(job), NOW), ...over };
  }

  it('accepts a dated record with its readings', () => {
    const run = edited({
      cutOn: '2026-10-05',
      minutes: 12.5,
      cutter: { fluteLengthMm: 12, stickOutMm: 18 },
      stockProudMm: 3,
      depths: edited({}).depths.map((d) => ({ ...d, measured: d.planned - 0.1 })),
      legible: true,
      finish: 'clean',
      notes: 'second pass was quieter',
    });
    const back = parseRunRecord(JSON.parse(serializeRunRecord(run)));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.run.cutOn).toBe('2026-10-05');
    expect(back.run.minutes).toBe(12.5);
    expect(back.run.finish).toBe('clean');
    expect(isMeasuredRun(back.run)).toBe(true);
    expect(isTimedRun(back.run)).toBe(true);
  });

  it('refuses readings that carry no cut date', () => {
    // Every single reading, each on its own — a record with one of these and no `cutOn` is the
    // exact hand-edit that would smuggle an unmeasured number into the app.
    const cuts: Partial<RunRecord>[] = [
      { minutes: 12.5 },
      { stockProudMm: 3 },
      { legible: true },
      { legible: false },
      { finish: 'clean' },
      { cutter: { fluteLengthMm: 12, stickOutMm: null } },
      { cutter: { fluteLengthMm: null, stickOutMm: 18 } },
    ];
    for (const over of cuts) {
      const result = parseRunRecord(edited(over));
      expect(result.ok, JSON.stringify(over)).toBe(false);
      if (!result.ok) expect(result.reason).toContain('no cutOn date');
    }
    // A measured floor depth counts too.
    const base = edited({});
    const measured = { ...base, depths: base.depths.map((d) => ({ ...d, measured: 1 })) };
    const result = parseRunRecord(measured);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('no cutOn date');
  });

  it('lets a note stand alone — a note is not a reading', () => {
    // "Aborted at load" is a real record of a real attempt with nothing measured. It needs no date.
    const back = parseRunRecord(edited({ notes: 'aborted at load — vise slipped' }));
    expect(back.ok).toBe(true);
    if (back.ok) {
      expect(back.run.minutes).toBeNull();
      expect(isMeasuredRun(back.run)).toBe(false);
    }
  });

  it('will not show an undated record as a timed run', () => {
    expect(isTimedRun(edited({ cutOn: null, minutes: 12 }))).toBe(false);
    expect(isTimedRun(edited({ cutOn: '2026-10-05', minutes: null }))).toBe(false);
    expect(isTimedRun(edited({ cutOn: '2026-10-05', minutes: 0 }))).toBe(false);
    expect(isTimedRun(edited({ cutOn: '2026-10-05', minutes: 0.5 }))).toBe(true);
  });

  // -------------------------------------------------------------------------------------------
  // Refusals — strict, whole-or-nothing, and never coerced
  // -------------------------------------------------------------------------------------------

  it('refuses anything that is not a run record', () => {
    for (const raw of [null, 42, 'a run', [], [{}], {}]) {
      const r = parseRunRecord(raw);
      expect(r.ok, JSON.stringify(raw)).toBe(false);
      if (!r.ok) expect(r.reason).toContain('not a Case Maker run record');
    }
    const wrongKind = parseRunRecord({ ...edited({}), kind: 'casemaker-feeds' });
    expect(wrongKind.ok).toBe(false);
  });

  it('refuses a version it does not read, by number', () => {
    const r = parseRunRecord({ ...edited({}), schemaVersion: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('version 2');
    const missing = parseRunRecord({ ...edited({}), schemaVersion: undefined });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toContain('missing');
  });

  it('refuses a record that does not say which job or which program it is', () => {
    expect(parseRunRecord({ ...edited({}), job: '  ' }).ok).toBe(false);
    expect(parseRunRecord({ ...edited({}), ncFile: '' }).ok).toBe(false);
  });

  it('refuses a malformed date rather than defaulting it', () => {
    for (const cutOn of ['5 Oct 2026', '2026/10/05', '20261005', 20261005, '']) {
      const r = parseRunRecord({ ...edited({}), cutOn });
      expect(r.ok, String(cutOn)).toBe(false);
    }
  });

  it('refuses readings of the wrong shape', () => {
    const cases: Array<[string, unknown]> = [
      ['minutes', -1],
      ['minutes', 0],
      ['minutes', '12'],
      ['stockProudMm', '3'],
      ['legible', 'yes'],
      ['finish', 'shiny'],
      ['notes', ['a', 'b']],
    ];
    for (const [field, value] of cases) {
      const r = parseRunRecord({ ...edited({ cutOn: '2026-10-05' }), [field]: value });
      expect(r.ok, `${field}=${JSON.stringify(value)}`).toBe(false);
    }
  });

  it('refuses a broken cutter section or depths array', () => {
    const base = edited({ cutOn: '2026-10-05' });
    expect(parseRunRecord({ ...base, cutter: null }).ok).toBe(false);
    expect(parseRunRecord({ ...base, cutter: { fluteLengthMm: 'x', stickOutMm: null } }).ok).toBe(false);
    expect(parseRunRecord({ ...base, depths: 'none' }).ok).toBe(false);
    expect(parseRunRecord({ ...base, depths: [null] }).ok).toBe(false);
    expect(parseRunRecord({ ...base, depths: [{ id: 'a', name: 'A' }] }).ok).toBe(false);
    expect(parseRunRecord({ ...base, depths: [{ id: 'a', name: 'A', planned: '2', measured: null }] }).ok).toBe(
      false,
    );
    expect(parseRunRecord({ ...base, depths: [{ id: 'a', name: 'A', planned: 2, measured: -1 }] }).ok).toBe(false);
  });

  it('refuses text that is not JSON, with a reason instead of a throw', () => {
    const r = parseRunRecordText('{ not json');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('not valid JSON');
  });

  it('reads a record missing the app-only fields without inventing them', () => {
    // The app's half is a record of what the APP knew; a record written at the bench from the
    // template may simply not carry it. The person's half is still stated in full — a field that is
    // absent is refused rather than read as blank, which is what the next test pins down.
    const r = parseRunRecord({
      kind: RUN_RECORD_KIND,
      schemaVersion: RUN_RECORD_SCHEMA_VERSION,
      job: 'Bench test',
      ncFile: 'Bench-test.nc',
      cutOn: '2026-10-05',
      minutes: 4,
      cutter: { fluteLengthMm: null, stickOutMm: null },
      stockProudMm: null,
      depths: [],
      legible: null,
      finish: null,
      notes: '',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.run.tool).toBeNull();
    expect(r.run.cuttingDiameter).toBeNull();
    expect(r.run.estimatedSeconds).toBeNull();
    expect(r.run.depths).toEqual([]);
    expect(r.run.instructions).toBe(RUN_RECORD_INSTRUCTIONS);
  });

  it('refuses a structural field that is absent, rather than reading it as blank', () => {
    // Deleting a key is not the same as the key being blank, and the parser will not guess which one
    // someone meant for the fields whose VALUE carries a judgement (`legible`, `finish`) or the
    // record's shape (`cutter`, `depths`, `notes`). The app always writes every field, so an absent
    // one is a hand-edit.
    const full: Record<string, unknown> = { ...edited({ cutOn: '2026-10-05' }) };
    for (const field of ['cutOn', 'legible', 'finish', 'notes', 'cutter', 'depths']) {
      const partial = { ...full };
      delete partial[field];
      const r = parseRunRecord(partial);
      expect(r.ok, `${field} absent`).toBe(false);
    }
  });

  it('reads an absent measurement as "not recorded", which is what it is', () => {
    // The other half of the rule, and the reason the two are different: a wall clock nobody wrote
    // down is not a wrong value, it is a blank — and `isTimedRun` is what keeps it off the panel.
    const full: Record<string, unknown> = { ...edited({ cutOn: '2026-10-05', minutes: 12 }) };
    for (const field of ['minutes', 'stockProudMm']) delete (full as Record<string, unknown>)[field];
    const r = parseRunRecord(full);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.run.minutes).toBeNull();
    expect(r.run.stockProudMm).toBeNull();
    expect(isTimedRun(r.run)).toBe(false);
  });
});
