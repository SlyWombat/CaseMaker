/**
 * #1216 (planner v3, slice 3) — THE SELECTOR IN SHADOW.
 *
 * It prices the same cutter chains the planner prices today, from the fields instead of from real
 * toolpaths, and writes what it would have chosen to the `--mem-trace` file beside what the real
 * planner chose. It changes NO decision: the caller runs it after the real choice is made, and it
 * reads that result only to compare. With no trace sink every row is discarded inside `memTrace`.
 *
 * #1242 — THE ESTIMATE IS ITS OWN FUNCTION. `estimateCandidates` is pure (no trace, no dependence
 * on the real choice) and is what the shortlist reads before any chain is planned for real; the
 * tracing wrapper below calls it (or reuses the caller's copy) and writes the same rows as before,
 * #1231's `shadow:shortlist` rows included.
 *
 * The imports outside `cam/` are the three the issue allows (tool, feeds, memTrace); everything
 * else is `cam/`'s own, so #1215's import gate stays green.
 */
import type { OffsetFn, Polygons } from '../pocket';
import type { Tool } from '@/engine/cnc/tool';
import { cuttingDiameter } from '@/engine/cnc/tool';
import type { CutParams } from '@/engine/cnc/feeds';
import { memTrace } from '@/engine/cnc/memTrace';
import { candidateSequences, type CandidateSequence, type CutterCandidates, type ConsideredSequence, type SequenceDemand, type SequenceOptions } from '../model/sequence';
import { flatReach, polygonsArea } from './flatReach';
import { estimateChain, type ChainEstimate, type CutterRates, type EstimateStep, type PocketArea } from './chainEstimate';

export interface EstimateInput {
  demand: SequenceDemand;
  cutters: CutterCandidates;
  candidateOpts: Pick<SequenceOptions, 'feedsKind' | 'maxCutters' | 'allowPrimary'>;
  /** Pocket id → its outline. Features with no entry here (e.g. 'facing') are simply not estimated. */
  regions: ReadonlyMap<string, Polygons>;
  offset: OffsetFn;
  paramsFor: ((tool: Tool) => CutParams) | undefined;
  changePrice: (precedingSeconds: number) => number;
  /** The length of the outline the contour step follows, mm; 0 when the job has no contour. */
  contourPerimeterMm: number;
}

export interface ShadowInput extends EstimateInput {
  considered: readonly ConsideredSequence[];
  /** The signature of the chain the real planner chose. */
  chosenSignature: string;
  /**
   * #1242 — estimates the caller already computed (the shortlist reads them before the real
   * choice, so a traced plan need not pay for them twice). Absent → computed here.
   */
  estimates?: CandidateEstimates;
  /**
   * #1242's amended rule — the leftover tolerance in mm² (`plan.leftoverEquivalencePct / 100 ×`
   * the goal's covered area), for LIST B: the fastest chains whose estimated leftover is within it
   * of the smallest. Absent or 0 → list B is empty and its fields report -1/0.
   */
  toleranceMm2?: number;
}

/** One candidate's cheap estimate, by its signature (the candidate list's own order kept below). */
export interface CandidateEstimate {
  signature: string;
  est: ChainEstimate;
}

/** What one estimate pass produces: the candidates, their estimates, and the costs of the pass. */
export interface CandidateEstimates {
  candidates: CandidateSequence[];
  estimates: CandidateEstimate[];
  /** How many pocket regions the estimate had a reach field for. */
  pockets: number;
  /** Milliseconds spent building the pocket fields (diameters, reach, areas). */
  fieldMs: number;
  /** Milliseconds spent estimating the candidates. */
  estimateMs: number;
}

/** Every number a trace row carries is rounded to three decimals (milliseconds stay integers). */
const round3 = (value: number): number => Math.round(value * 1000) / 1000;

/** The shortlist sizes the measurement reports. A measurement's own list, not a setting: C3 registers the one it uses. */
export const SHORTLIST_SIZES: readonly number[] = [1, 3, 5, 8, 12];

export interface ShortlistRow {
  signature: string;
  estLeftoverMm2: number;
  estSeconds: number;
  /** The real planner's rank for this chain, 1 = its choice; -1 when the real planner did not rank it. */
  realRank: number;
  realSeconds: number;
}

export interface ShortlistResult {
  k: number;
  /** 1 when the real planner's choice (rank 1) is among the first k by the estimate. */
  holdsRealPick: 0 | 1;
  /** The best real rank among the first k; -1 when none of them was ranked. */
  bestRealRank: number;
  /** That chain's real seconds; -1 when none. */
  bestRealSeconds: number;
}

/** #1231 — WOULD THE K BEST-ESTIMATED CHAINS HAVE HELD THE REAL PICK? The same order the shadow's
 * own choice uses (leftover to a hundredth, then seconds, then the signature), then per size the
 * best real rank among the first k. Pure: the input is never reordered. */
export function shortlistReport(rows: readonly ShortlistRow[], sizes: readonly number[]): ShortlistResult[] {
  const ordered = [...rows].sort((a, b) => {
    const leftoverA = Math.round(a.estLeftoverMm2 * 100);
    const leftoverB = Math.round(b.estLeftoverMm2 * 100);
    if (leftoverA !== leftoverB) return leftoverA - leftoverB;
    if (a.estSeconds !== b.estSeconds) return a.estSeconds - b.estSeconds;
    return a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0;
  });
  const out: ShortlistResult[] = [];
  for (const k of sizes) {
    const top = ordered.slice(0, k).filter((r) => r.realRank >= 1);
    if (top.length === 0) {
      out.push({ k, holdsRealPick: 0, bestRealRank: -1, bestRealSeconds: -1 });
      continue;
    }
    let best = top[0]!;
    for (const r of top) {
      if (r.realRank < best.realRank) best = r;
    }
    out.push({
      k,
      holdsRealPick: best.realRank === 1 ? 1 : 0,
      bestRealRank: best.realRank,
      bestRealSeconds: best.realSeconds,
    });
  }
  return out;
}

export interface ShortlistResultB {
  k: number;
  /** 1 when the real planner's choice (rank 1) is among the first k of list B. */
  holdsRealPickB: 0 | 1;
  /** The best real rank among list B's first k; -1 when none of them was ranked or the list is empty. */
  bestRealRankB: number;
}

/** #1242 (the amended rule) — LIST B, THE FAST ONES: among the rows whose estimated leftover is no
 * more than the smallest plus `toleranceMm2`, the first k by (estimated seconds, signature), and
 * the best real rank among them. Pure: the input is never reordered. `toleranceMm2 <= 0` (or no
 * rows) makes every list empty. */
export function shortlistReportB(rows: readonly ShortlistRow[], sizes: readonly number[], toleranceMm2: number): ShortlistResultB[] {
  const out: ShortlistResultB[] = [];
  let eligible: ShortlistRow[] = [];
  if (toleranceMm2 > 0 && rows.length > 0) {
    const smallest = Math.min(...rows.map((r) => r.estLeftoverMm2));
    const floor = smallest + toleranceMm2;
    eligible = rows
      .filter((r) => r.estLeftoverMm2 <= floor)
      .slice()
      .sort((a, b) => {
        if (a.estSeconds !== b.estSeconds) return a.estSeconds - b.estSeconds;
        return a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0;
      });
  }
  for (const k of sizes) {
    const top = eligible.slice(0, k).filter((r) => r.realRank >= 1);
    if (top.length === 0) {
      out.push({ k, holdsRealPickB: 0, bestRealRankB: -1 });
      continue;
    }
    let best = top[0]!;
    for (const r of top) {
      if (r.realRank < best.realRank) best = r;
    }
    out.push({ k, holdsRealPickB: best.realRank === 1 ? 1 : 0, bestRealRankB: best.realRank });
  }
  return out;
}

/**
 * #1242 — THE CHEAP ESTIMATE OF EVERY CANDIDATE CHAIN, as a pure function: estimated leftover in
 * mm², estimated seconds and the count of steps it could not price, per signature. No trace and no
 * knowledge of the real choice: the shortlist reads this before any chain is planned for real, and
 * the shadow wrapper below writes it beside the real planner's result.
 */
export function estimateCandidates(input: EstimateInput): CandidateEstimates {
  const t0 = performance.now();

  const candidates = candidateSequences(input.demand, input.cutters, input.candidateOpts);
  // planner v3 C1 — the depth the freeing contour is cut to, for its contour price.
  const contourDepthMm = input.demand.features.filter((f) => f.kind === 'contour').reduce((m, f) => Math.max(m, f.depthMm), 0);

  // The diameters the candidate steps would ask for — collected once, because flatReach costs two
  // Clipper offsets per diameter per pocket.
  const diameters: number[] = [];
  for (const candidate of candidates) {
    for (const step of candidate.steps) {
      if (step.kind !== 'pocket' && step.kind !== 'rest') continue;
      const diameter = cuttingDiameter(step.cutter.tool);
      if (typeof diameter !== 'number' || !(diameter > 0)) continue;
      if (!diameters.some((known) => Math.abs(known - diameter) <= 1e-9)) diameters.push(diameter);
    }
  }

  const pockets: PocketArea[] = [];
  for (const feature of input.demand.features) {
    const region = input.regions.get(feature.id);
    if (region === undefined) continue;
    pockets.push({
      id: feature.id,
      depthMm: feature.depthMm,
      areaMm2: polygonsArea(region),
      reach: flatReach(region, diameters, input.offset),
    });
  }

  const fieldMs = performance.now() - t0;

  // One feed-row question per cutter; a throwing `paramsFor` is one unpriced step, never a crash.
  const ratesByKey = new Map<string, CutterRates | null>();
  const ratesOf = (key: string, tool: Tool): CutterRates | null => {
    const cached = ratesByKey.get(key);
    if (cached !== undefined || ratesByKey.has(key)) return cached ?? null;
    let rates: CutterRates | null = null;
    if (input.paramsFor !== undefined) {
      try {
        const params = input.paramsFor(tool);
        rates = { feed: params.feed, plungeFeed: params.plungeFeed, stepDown: params.stepDown, stepOver: params.stepOver };
      } catch {
        rates = null;
      }
    }
    ratesByKey.set(key, rates);
    return rates;
  };

  const estimates: CandidateEstimate[] = [];
  for (const candidate of candidates) {
    const signature = candidate.steps.map((s) => `${s.kind}:${s.cutter.key}`).join('+');
    const steps: EstimateStep[] = candidate.steps.map((s) => ({
      kind: s.kind,
      cutterKey: s.cutter.key,
      diameterMm: cuttingDiameter(s.cutter.tool) ?? 0,
      regionIds: s.regionIds,
      rates: ratesOf(s.cutter.key, s.cutter.tool),
      ...(s.kind === 'contour' && input.contourPerimeterMm > 0
        ? { contour: { perimeterMm: input.contourPerimeterMm, depthMm: contourDepthMm } }
        : {}),
    }));
    estimates.push({ signature, est: estimateChain(steps, pockets, input.changePrice) });
  }

  return {
    candidates,
    estimates,
    pockets: pockets.length,
    fieldMs,
    estimateMs: performance.now() - t0 - fieldMs,
  };
}

/** Writes 'shadow:candidate', one 'shadow:choice' and #1231's 'shadow:shortlist' rows. Returns nothing. */
export function traceShadowSelection(input: ShadowInput): void {
  const computed = input.estimates ?? estimateCandidates(input);
  const { candidates, estimates, pockets, fieldMs, estimateMs } = computed;

  const shortlistRows: ShortlistRow[] = [];
  for (const { signature, est } of estimates) {
    const real = input.considered.find(
      (row) => row.steps.map((s) => `${s.kind}:${s.cutterKey}`).join('+') === signature,
    );
    memTrace('shadow:candidate', {
      signature,
      estSeconds: round3(est.totalSeconds),
      estCutSeconds: round3(est.cutSeconds),
      estChanges: est.changes,
      estLeftoverMm2: round3(est.leftoverMm2),
      unpriced: est.unpriced,
      realSeconds: real?.cost ?? -1,
      realEstimateSeconds: real?.estimateSeconds ?? -1,
      realLeftoverCells: real?.leftoverCells ?? -1,
      realRank: real?.rank ?? -1,
      estEntries: JSON.stringify(est.perCutter.map((e) => [e.cutterKey, Math.round(e.cutSeconds * 1000) / 1000])),
    });
    shortlistRows.push({
      signature,
      estLeftoverMm2: est.leftoverMm2,
      estSeconds: est.totalSeconds,
      realRank: real?.rank ?? -1,
      realSeconds: real?.cost ?? -1,
    });
  }

  // The shadow's own choice: leftover to a hundredth of a mm², then seconds, then the signature.
  const ranked = [...estimates].sort((a, b) => {
    const leftoverA = Math.round(a.est.leftoverMm2 * 100);
    const leftoverB = Math.round(b.est.leftoverMm2 * 100);
    if (leftoverA !== leftoverB) return leftoverA - leftoverB;
    if (a.est.totalSeconds !== b.est.totalSeconds) return a.est.totalSeconds - b.est.totalSeconds;
    return a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0;
  });
  const shadowSignature = ranked.length === 0 ? '' : ranked[0]!.signature;

  memTrace('shadow:choice', {
    shadow: shadowSignature,
    real: input.chosenSignature,
    agree: shadowSignature === input.chosenSignature ? 1 : 0,
    candidates: candidates.length,
    pockets,
    fieldMs: Math.round(fieldMs),
    estimateMs: Math.round(estimateMs),
  });

  // #1231 — what a shortlist of each measured size would have held, beside the candidates' count.
  // #1242's amended rule adds list B's pair to the same row; #1231's fields are untouched.
  const bByK = new Map(shortlistReportB(shortlistRows, SHORTLIST_SIZES, input.toleranceMm2 ?? 0).map((r) => [r.k, r]));
  for (const r of shortlistReport(shortlistRows, SHORTLIST_SIZES)) {
    const b = bByK.get(r.k);
    memTrace('shadow:shortlist', {
      k: r.k,
      holdsRealPick: r.holdsRealPick,
      bestRealRank: r.bestRealRank,
      bestRealSeconds: round3(r.bestRealSeconds),
      bestRealRankB: b?.bestRealRankB ?? -1,
      holdsRealPickB: b?.holdsRealPickB ?? 0,
      candidates: candidates.length,
    });
  }
}
