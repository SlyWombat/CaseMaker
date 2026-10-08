/**
 * The records this browser has opened (#277). A view of files the operator handed the app, not a
 * second home for machine facts.
 *
 * The rule this pins is whole-or-nothing: a file that does not parse, or that carries readings with
 * no date, must leave the store exactly as it was. A half-applied import would put a "last measured"
 * line under an estimate on the strength of a file the app had already rejected.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { useRunRecordStore } from '@/store/runRecordStore';
import { buildRunRecord, serializeRunRecord, RUN_RECORD_KIND, RUN_RECORD_SCHEMA_VERSION } from '@/engine/cnc/engrave/runRecord';
import { lastTimedRun } from '@/engine/cnc/engrave/runHistory';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';

const NOW = new Date('2026-10-04T00:00:00Z');

/** The record Save writes for the default job, with the bench half filled in. */
function filled(over: Record<string, unknown> = {}): string {
  const job = defaultEngraveJob();
  const built = buildRunRecord(job, {
    findings: [],
    feeds: null,
    cam: { operations: 3, cuttingMoves: 1234, estimatedSeconds: 95, passes: 2 },
    nc: 'G21 G90\nM2\n',
    verify: null,
    frameNc: null,
  }, NOW);
  return serializeRunRecord({
    ...built,
    cutOn: '2026-10-05',
    minutes: 12.5,
    ...over,
  } as typeof built);
}

const HAND_WRITTEN = JSON.stringify({
  kind: RUN_RECORD_KIND,
  schemaVersion: RUN_RECORD_SCHEMA_VERSION,
  job: 'Bench test',
  ncFile: 'Bench-test.nc',
  cutOn: '2026-10-06',
  minutes: 3,
  cutter: { fluteLengthMm: null, stickOutMm: null },
  stockProudMm: null,
  depths: [],
  legible: null,
  finish: null,
  notes: '',
});

describe('runRecordStore (#277)', () => {
  beforeEach(() => {
    // No localStorage in this environment, so this is the store's in-memory half — which is the
    // half the rules live in. Persistence is checked by driving the panel in a browser.
    expect(typeof localStorage).toBe('undefined');
    useRunRecordStore.getState().clear();
  });

  it('keeps a record it could read', () => {
    const result = useRunRecordStore.getState().openText(HAND_WRITTEN);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.run.ncFile).toBe('Bench-test.nc');
    expect(useRunRecordStore.getState().imported.map((r) => r.ncFile)).toEqual(['Bench-test.nc']);
  });

  it('leaves the store untouched when the file is not a record', () => {
    useRunRecordStore.getState().openText(HAND_WRITTEN);
    for (const bad of ['{ not json', '{}', JSON.stringify({ kind: RUN_RECORD_KIND }), '[]']) {
      const result = useRunRecordStore.getState().openText(bad);
      expect(result.ok, bad).toBe(false);
      expect(useRunRecordStore.getState().imported).toHaveLength(1);
    }
  });

  it('accepts the blank record Save writes, and shows nothing from it', () => {
    useRunRecordStore.getState().openText(HAND_WRITTEN);
    // The panel's Save writes exactly this file: a whole record with nothing measured in it. It is
    // not a refusal — it is simply not a result, and `isTimedRun` is what keeps it off the panel.
    const blank = filled({ cutOn: null, minutes: null });
    const result = useRunRecordStore.getState().openText(blank);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.run.cutOn).toBeNull();
      expect(lastTimedRun(result.run.job, useRunRecordStore.getState().imported)).toBeNull();
    }
  });

  it('refuses readings that carry no date, and says so', () => {
    useRunRecordStore.getState().openText(HAND_WRITTEN);
    const before = useRunRecordStore.getState().imported;
    // The same record with its date deleted but its readings left in — the hand-edit the rule is
    // for. Nothing is stored: a file the app rejected changes nothing at all.
    const undated = filled({ cutOn: null });
    const result = useRunRecordStore.getState().openText(undated);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('no cutOn date');
    expect(useRunRecordStore.getState().imported).toEqual(before);
  });

  it('keeps one record per program, the latest open winning', () => {
    const job = defaultEngraveJob();
    const ncFile = buildRunRecord(job, {
      findings: [],
      feeds: null,
      cam: null,
      nc: 'G21 G90\nM2\n',
      verify: null,
      frameNc: null,
    }, NOW).ncFile;

    useRunRecordStore.getState().openText(filled({ cutOn: '2026-10-05', minutes: 10 }));
    useRunRecordStore.getState().openText(filled({ cutOn: '2026-10-07', minutes: 14 }));
    const imported = useRunRecordStore.getState().imported;
    expect(imported).toHaveLength(1);
    expect(imported[0]!.ncFile).toBe(ncFile);
    expect(imported[0]!.minutes).toBe(14);
  });

  it('forgets what was opened here without touching the files', () => {
    useRunRecordStore.getState().openText(HAND_WRITTEN);
    useRunRecordStore.getState().clear();
    expect(useRunRecordStore.getState().imported).toEqual([]);
  });
});
