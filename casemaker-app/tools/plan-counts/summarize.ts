/**
 * #1213 — PLANNER v3 SLICE 0: turn a `--mem-trace` JSONL file into the counts the slice needs.
 *
 * The planner writes one row per pipeline boundary (`src/engine/cnc/memTrace.ts`); this module
 * counts them and adds the wall time each family spent between its own `:start` / `:end` rows.
 * Measurement only — it imports nothing from `src/`.
 */

/** One line of a `--mem-trace` file. */
export interface TraceRow {
  t: number;
  stage: string;
  rss?: number;
  [key: string]: number | string | boolean | undefined;
}

export interface PlanCounts {
  /** Rows with stage 'pipeline:start'. */
  pipelines: number;
  pick: { runs: number; coarse: number; full: number; wallMs: number };
  plans: { owned: number; ideal: number; wallMs: number };
  rank: { runs: number; candidates: number; inline: number; wallMs: number };
  chain: { runs: number; stepPlans: number; candidatesConsidered: number; wallMs: number };
  ops: { planned: number; reused: number };
  stamps: { computed: number; cached: number; failed: number };
  sweeps: number;
  goalFields: number;
  /** Largest `rss` seen, bytes; 0 when no row has one. */
  peakRssBytes: number;
  /** last row's t minus first row's t; 0 for fewer than two rows. */
  wallMs: number;
  /** True when a ':start' row has no matching ':end' row (the run stopped early). */
  incomplete: boolean;
}

/** The four families whose start/end rows carry a phase wall time. */
const FAMILIES = ['pick', 'plan', 'rank', 'chain'] as const;
type Family = (typeof FAMILIES)[number];

export function summarizeTrace(rows: readonly TraceRow[]): PlanCounts {
  let pipelines = 0;
  let pickRuns = 0;
  let pickCoarse = 0;
  let pickFull = 0;
  let owned = 0;
  let ideal = 0;
  let rankRuns = 0;
  let rankCandidates = 0;
  let rankInline = 0;
  let chainRuns = 0;
  let stepPlans = 0;
  let candidatesConsidered = 0;
  let opsPlanned = 0;
  let opsReused = 0;
  let stampsComputed = 0;
  let stampsCached = 0;
  let stampsFailed = 0;
  let sweeps = 0;
  let goalFields = 0;
  let peakRssBytes = 0;

  const stacks: Record<Family, number[]> = { pick: [], plan: [], rank: [], chain: [] };
  const familyWallMs: Record<Family, number> = { pick: 0, plan: 0, rank: 0, chain: 0 };

  const close = (family: Family, t: number): void => {
    const startedAt = stacks[family].pop();
    if (startedAt !== undefined) familyWallMs[family] += t - startedAt;
  };

  for (const row of rows) {
    switch (row.stage) {
      case 'pipeline:start':
        pipelines += 1;
        break;
      case 'pick:start':
        pickRuns += 1;
        stacks.pick.push(row.t);
        break;
      case 'pick:end':
        close('pick', row.t);
        break;
      case 'pick:candidate':
        if (row.level === 'full') pickFull += 1;
        else pickCoarse += 1;
        break;
      case 'plan:start':
        if (row.plan === 'ideal') ideal += 1;
        else owned += 1;
        stacks.plan.push(row.t);
        break;
      case 'plan:end':
        close('plan', row.t);
        break;
      case 'rank:start':
        rankRuns += 1;
        stacks.rank.push(row.t);
        break;
      case 'rank:end':
        close('rank', row.t);
        break;
      case 'rank:candidate':
        rankCandidates += 1;
        break;
      case 'rank:candidate-inline':
        rankInline += 1;
        break;
      case 'chain:start':
        chainRuns += 1;
        stacks.chain.push(row.t);
        break;
      case 'chain:end':
        close('chain', row.t);
        if (typeof row.candidates === 'number') candidatesConsidered += row.candidates;
        break;
      case 'chain:step':
        stepPlans += 1;
        break;
      case 'op':
        if (row.reused === 1) opsReused += 1;
        else opsPlanned += 1;
        break;
      case 'stamp':
        if (row.cached === 1) stampsCached += 1;
        else if (row.cached === 0) {
          stampsComputed += 1;
          if (row.ok === 0) stampsFailed += 1;
        }
        break;
      case 'sweep:start':
        sweeps += 1;
        break;
      case 'goal-field':
        goalFields += 1;
        break;
      default:
        // Any other stage is ignored.
        break;
    }
    if (typeof row.rss === 'number') peakRssBytes = Math.max(peakRssBytes, row.rss);
  }

  let incomplete = false;
  if (rows.length > 0) {
    const lastT = rows[rows.length - 1]!.t;
    for (const family of FAMILIES) {
      if (stacks[family].length === 0) continue;
      for (const startedAt of stacks[family]) familyWallMs[family] += lastT - startedAt;
      incomplete = true;
    }
  }

  return {
    pipelines,
    pick: { runs: pickRuns, coarse: pickCoarse, full: pickFull, wallMs: Math.round(familyWallMs.pick) },
    plans: { owned, ideal, wallMs: Math.round(familyWallMs.plan) },
    rank: { runs: rankRuns, candidates: rankCandidates, inline: rankInline, wallMs: Math.round(familyWallMs.rank) },
    chain: { runs: chainRuns, stepPlans, candidatesConsidered, wallMs: Math.round(familyWallMs.chain) },
    ops: { planned: opsPlanned, reused: opsReused },
    stamps: { computed: stampsComputed, cached: stampsCached, failed: stampsFailed },
    sweeps,
    goalFields,
    peakRssBytes,
    wallMs: rows.length < 2 ? 0 : Math.round(rows[rows.length - 1]!.t - rows[0]!.t),
    incomplete,
  };
}

/** Parse a `--mem-trace` file's text: one JSON object per line. Blank lines and lines that are not
 * valid JSON objects with a numeric `t` and a string `stage` are skipped, never thrown on. */
export function parseTrace(text: string): TraceRow[] {
  const rows: TraceRow[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
    const candidate = parsed as Record<string, unknown>;
    if (typeof candidate.t !== 'number' || typeof candidate.stage !== 'string') continue;
    rows.push(parsed as TraceRow);
  }
  return rows;
}
