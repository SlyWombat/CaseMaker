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
  chain: { runs: number; stepPlans: number; candidatesConsidered: number; shortlisted: number; wallMs: number };
  ops: { planned: number; reused: number };
  stamps: { computed: number; cached: number; failed: number };
  sweeps: number;
  goalFields: number;
  shadow: {
    choices: number;
    agree: number;
    candidates: number;
    errors: number;
    fieldMs: number;
    estimateMs: number;
    /** #1231 — per shortlist size k (as a string, ascending): how many measurements, how many held the real pick. */
    shortlist: Record<string, { choices: number; held: number }>;
  };
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
  let shortlisted = 0;
  let opsPlanned = 0;
  let opsReused = 0;
  let stampsComputed = 0;
  let stampsCached = 0;
  let stampsFailed = 0;
  let sweeps = 0;
  let goalFields = 0;
  let shadowChoices = 0;
  const shortlistCounts = new Map<number, { choices: number; held: number }>();
  let shadowAgree = 0;
  let shadowCandidates = 0;
  let shadowErrors = 0;
  let shadowFieldMs = 0;
  let shadowEstimateMs = 0;
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
      // #1242 — what the shortlist kept, per choice: the chains that got a real plan.
      case 'shortlist':
        if (typeof row.kept === 'number') shortlisted += row.kept;
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
      case 'shadow:choice':
        shadowChoices += 1;
        if (row.agree === 1) shadowAgree += 1;
        if (typeof row.fieldMs === 'number') shadowFieldMs += row.fieldMs;
        if (typeof row.estimateMs === 'number') shadowEstimateMs += row.estimateMs;
        break;
      case 'shadow:candidate':
        shadowCandidates += 1;
        break;
      case 'shadow:error':
        shadowErrors += 1;
        break;
      case 'shadow:shortlist': {
        // #1231 — per size: how many measurement rows, how many held the real pick.
        if (typeof row.k === 'number') {
          const entry = shortlistCounts.get(row.k) ?? { choices: 0, held: 0 };
          entry.choices += 1;
          if (row.holdsRealPick === 1) entry.held += 1;
          shortlistCounts.set(row.k, entry);
        }
        break;
      }
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
    chain: { runs: chainRuns, stepPlans, candidatesConsidered, shortlisted, wallMs: Math.round(familyWallMs.chain) },
    ops: { planned: opsPlanned, reused: opsReused },
    stamps: { computed: stampsComputed, cached: stampsCached, failed: stampsFailed },
    sweeps,
    goalFields,
    shadow: {
      choices: shadowChoices,
      agree: shadowAgree,
      candidates: shadowCandidates,
      errors: shadowErrors,
      fieldMs: shadowFieldMs,
      estimateMs: shadowEstimateMs,
      shortlist: Object.fromEntries([...shortlistCounts.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => [String(k), v])),
    },
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

/** #1225 — one row per (chain, cutter): the shadow's estimate beside the real planner's seconds. */
export interface CutterRow {
  signature: string;
  cutterKey: string;
  estSeconds: number | null;
  realSeconds: number | null;
  realChangeSeconds: number | null;
}

/**
 * #1225 — ONE ROW PER (chain, cutter): the shadow's estimate beside the real planner's cutting
 * seconds. A chain appears once per choice run in the trace; rows are in trace order. A side that
 * has no number for that cutter is null.
 */
export function cutterRows(rows: readonly TraceRow[]): CutterRow[] {
  const real = new Map<string, Map<string, [number, number]>>();
  const out: CutterRow[] = [];
  for (const row of rows) {
    if (row.stage === 'chain:price' && typeof row.entries === 'string') {
      try {
        const entries = JSON.parse(row.entries) as [string, number, number][];
        real.set(String(row.signature), new Map(entries.map(([key, cut, change]) => [key, [cut, change] as [number, number]])));
      } catch {
        // A malformed row says nothing about any cutter.
      }
    } else if (row.stage === 'shadow:candidate' && typeof row.estEntries === 'string') {
      let est: [string, number][];
      try {
        est = JSON.parse(row.estEntries) as [string, number][];
      } catch {
        continue;
      }
      const signature = String(row.signature);
      const r = real.get(signature);
      const seen = new Set<string>();
      for (const [key, seconds] of est) {
        seen.add(key);
        const pair = r?.get(key);
        out.push({
          signature,
          cutterKey: key,
          estSeconds: seconds,
          realSeconds: pair === undefined ? null : pair[0],
          realChangeSeconds: pair === undefined ? null : pair[1],
        });
      }
      if (r !== undefined) {
        for (const [key, [cut, change]] of r) {
          if (seen.has(key)) continue;
          out.push({ signature, cutterKey: key, estSeconds: null, realSeconds: cut, realChangeSeconds: change });
        }
      }
    } else if (row.stage === 'shadow:choice') {
      real.clear();
    }
  }
  return out;
}
