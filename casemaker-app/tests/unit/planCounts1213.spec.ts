/**
 * #1213 — PLANNER v3 SLICE 0: the counts, from one trace file.
 *
 * The planner already writes a `--mem-trace` JSONL row at each pipeline boundary; the one thing it
 * did not record was the simulation it runs on each candidate step (`stampedField`). This file
 * pins the summariser's exact rules (tests A–D) and the new `stamp` row (test E). Measurement
 * only: no posted byte may move.
 */

import { describe, expect, it } from 'vitest';

import { planModelCam } from '@/engine/cnc/cam/model/plan';
import { setMemTraceSink } from '@/engine/cnc/memTrace';
import { parseTrace, summarizeTrace, type TraceRow } from '../../tools/plan-counts/summarize';
import { slopedInput } from './helpers/goalFixtures';

describe('#1213 plan-counts — the summariser', () => {
  it('counts a hand-written trace exactly', () => {
    const rows: TraceRow[] = [
      { t: 0, stage: 'pipeline:start', rss: 100 },
      { t: 10, stage: 'pick:start' },
      { t: 20, stage: 'pick:candidate', level: 'coarse' },
      { t: 30, stage: 'pick:candidate', level: 'full' },
      { t: 40, stage: 'plan:start', plan: 'owned', rss: 500 },
      { t: 50, stage: 'rank:start' },
      { t: 60, stage: 'rank:candidate' },
      { t: 70, stage: 'rank:candidate-inline' },
      { t: 90, stage: 'rank:end' },
      { t: 100, stage: 'chain:start' },
      { t: 110, stage: 'chain:step' },
      { t: 120, stage: 'stamp', cached: 0, ok: 1 },
      { t: 130, stage: 'stamp', cached: 1 },
      { t: 140, stage: 'stamp', cached: 0, ok: 0 },
      { t: 150, stage: 'chain:end', candidates: 7 },
      { t: 160, stage: 'op', kind: 'rough' },
      { t: 170, stage: 'op', kind: 'finish', reused: 1 },
      { t: 200, stage: 'plan:end' },
      { t: 210, stage: 'plan:start', plan: 'ideal' },
      { t: 260, stage: 'plan:end' },
      { t: 270, stage: 'pick:end' },
      { t: 280, stage: 'goal-field' },
      { t: 290, stage: 'sweep:start' },
      { t: 300, stage: 'something-else' },
    ];
    expect(summarizeTrace(rows)).toEqual({
      pipelines: 1,
      pick: { runs: 1, coarse: 1, full: 1, wallMs: 260 },
      plans: { owned: 1, ideal: 1, wallMs: 210 },
      rank: { runs: 1, candidates: 1, inline: 1, wallMs: 40 },
      chain: { runs: 1, stepPlans: 1, candidatesConsidered: 7, wallMs: 50 },
      ops: { planned: 1, reused: 1 },
      stamps: { computed: 2, cached: 1, failed: 1 },
      sweeps: 1,
      goalFields: 1,
      peakRssBytes: 500,
      wallMs: 300,
      incomplete: false,
    });
  });

  it('a run that stops early is marked incomplete', () => {
    const counts = summarizeTrace([
      { t: 0, stage: 'plan:start', plan: 'owned' },
      { t: 100, stage: 'rank:start' },
      { t: 250, stage: 'op' },
    ]);
    expect(counts.incomplete).toBe(true);
    expect(counts.plans.wallMs).toBe(250);
    expect(counts.rank.wallMs).toBe(150);
    expect(counts.ops.planned).toBe(1);
  });

  it('an empty trace is all zeros', () => {
    expect(summarizeTrace([])).toEqual({
      pipelines: 0,
      pick: { runs: 0, coarse: 0, full: 0, wallMs: 0 },
      plans: { owned: 0, ideal: 0, wallMs: 0 },
      rank: { runs: 0, candidates: 0, inline: 0, wallMs: 0 },
      chain: { runs: 0, stepPlans: 0, candidatesConsidered: 0, wallMs: 0 },
      ops: { planned: 0, reused: 0 },
      stamps: { computed: 0, cached: 0, failed: 0 },
      sweeps: 0,
      goalFields: 0,
      peakRssBytes: 0,
      wallMs: 0,
      incomplete: false,
    });
  });

  it('parseTrace skips bad lines', () => {
    const rows = parseTrace('{"t":1,"stage":"op"}\n\nnot json\n{"stage":"op"}\n{"t":2,"stage":"plan:end"}\n');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.t).toBe(1);
    expect(rows[1]?.t).toBe(2);
  });
});

describe('#1213 plan-counts — the stamp row', () => {
  it(
    'the planner writes a stamp row for each simulation it asks for',
    async () => {
      const rows: TraceRow[] = [];
      setMemTraceSink((line) => rows.push(JSON.parse(line) as TraceRow));
      try {
        await planModelCam(slopedInput('fixture-1213'));
      } finally {
        setMemTraceSink(null);
      }
      const stamps = rows.filter((r) => r.stage === 'stamp');
      expect(stamps.length, 'the planner ran no simulation, or the stamp row is missing').toBeGreaterThan(0);
      expect(stamps.every((r) => r.cached === 0 || r.cached === 1), 'a stamp row did not state a cache hit or miss').toBe(true);
      expect(summarizeTrace(rows).stamps.computed).toBeGreaterThanOrEqual(1);
    },
    240_000,
  );
});
