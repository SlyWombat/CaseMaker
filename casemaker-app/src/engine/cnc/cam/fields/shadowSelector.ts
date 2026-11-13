/**
 * #1216 (planner v3, slice 3) — THE SELECTOR IN SHADOW.
 *
 * It prices the same cutter chains the planner prices today, from the fields instead of from real
 * toolpaths, and writes what it would have chosen to the `--mem-trace` file beside what the real
 * planner chose. It changes NO decision: the caller runs it after the real choice is made, and it
 * reads that result only to compare. With no trace sink every row is discarded inside `memTrace`.
 *
 * The imports outside `cam/` are the three the issue allows (tool, feeds, memTrace); everything
 * else is `cam/`'s own, so #1215's import gate stays green.
 */
import type { OffsetFn, Polygons } from '../pocket';
import type { Tool } from '@/engine/cnc/tool';
import { reachBand } from './flatReach';
import { cuttingDiameter } from '@/engine/cnc/tool';
import type { CutParams } from '@/engine/cnc/feeds';
import { memTrace } from '@/engine/cnc/memTrace';
import { candidateSequences, type CutterCandidates, type ConsideredSequence, type SequenceDemand, type SequenceOptions } from '../model/sequence';
import { flatReach, polygonsArea } from './flatReach';
import { estimateChain, type ChainEstimate, type CutterRates, type EstimateStep, type PocketArea } from './chainEstimate';

export interface ShadowInput {
  demand: SequenceDemand;
  cutters: CutterCandidates;
  candidateOpts: Pick<SequenceOptions, 'feedsKind' | 'maxCutters' | 'allowPrimary'>;
  /** Pocket id → its outline. Features with no entry here (e.g. 'facing') are simply not estimated. */
  regions: ReadonlyMap<string, Polygons>;
  offset: OffsetFn;
  paramsFor: ((tool: Tool) => CutParams) | undefined;
  changePrice: (precedingSeconds: number) => number;
  considered: readonly ConsideredSequence[];
  /** The signature of the chain the real planner chose. */
  chosenSignature: string;
  /** The length of the outline the contour step follows, mm; 0 when the job has no contour. */
  contourPerimeterMm: number;
  /** #1249 stage 2a — the real Clipper subtract, for the band figures. Absent: bands are zeros. */
  subtract?: (a: Polygons, b: Polygons) => Polygons;
  /** #1249 stage 2b — the plan's own rapid rates, for a banded rest step's hops. Absent: area term. */
  rapid?: { xyMmPerMin: number; zMmPerMin: number };
  /** #1249 stage 2b — the plan's own hop height above the stock, mm. Absent: area term. */
  hopClearanceMm?: number;
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

/** Writes 'shadow:candidate' rows and one 'shadow:choice' row to the trace. Returns nothing. */
export function traceShadowSelection(input: ShadowInput): void {
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

  const estimates: { signature: string; est: ChainEstimate }[] = [];
  const shortlistRows: ShortlistRow[] = [];
  /** #1249 — one band per (region, previous diameter, diameter), computed once per choice run. */
  const bandCache = new Map<string, { areaMm2: number; contourLengthMm: number; patches: number }>();
  /** #1249 stage 2b — the plan's rates, or none: then every step keeps the area term. */
  const restPricing =
    input.rapid === undefined || input.hopClearanceMm === undefined
      ? undefined
      : { rapid: input.rapid, hopClearanceMm: input.hopClearanceMm };
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
    // #1249 stage 2b — the band the previous cutter left each rest step, attached BEFORE the step
    // is priced: it is what the rest term follows, and the same figures the row below reports.
    for (const [i, stepOfChain] of steps.entries()) {
      if (stepOfChain.kind !== 'rest') continue;
      const prevDiameterMm = i > 0 ? steps[i - 1]!.diameterMm : 0;
      if (!(prevDiameterMm > 0) || !(stepOfChain.diameterMm > 0) || input.subtract === undefined) continue;
      let bandArea = 0;
      let bandContour = 0;
      let bandPatches = 0;
      for (const id of stepOfChain.regionIds) {
        const region = input.regions.get(id);
        if (region === undefined) continue;
        const key = `${id}|${prevDiameterMm}|${stepOfChain.diameterMm}`;
        let band = bandCache.get(key);
        if (band === undefined) {
          band = reachBand(region, prevDiameterMm, stepOfChain.diameterMm, input.offset, input.subtract);
          bandCache.set(key, band);
        }
        bandArea += band.areaMm2;
        bandContour += band.contourLengthMm;
        bandPatches += band.patches;
      }
      stepOfChain.band = { areaMm2: bandArea, contourLengthMm: bandContour, patches: bandPatches };
    }
    const est = estimateChain(steps, pockets, input.changePrice, restPricing);
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
    estimates.push({ signature, est });
    shortlistRows.push({
      signature,
      estLeftoverMm2: est.leftoverMm2,
      estSeconds: est.totalSeconds,
      realRank: real?.rank ?? -1,
      realSeconds: real?.cost ?? -1,
    });
    // #1249 stage 2a — EVERY POCKET AND REST STEP's own inputs, and (for a rest) the band the
    // previous cutter left it: area, outline length and separate patches. Trace-only.
    for (const stepEst of est.stepEstimates) {
      if (stepEst.kind !== 'pocket' && stepEst.kind !== 'rest') continue;
      const band = stepEst.kind === 'rest' ? steps[stepEst.stepIndex]?.band : undefined;
      memTrace('shadow:step', {
        signature,
        stepIndex: stepEst.stepIndex,
        kind: stepEst.kind,
        cutterKey: stepEst.cutterKey,
        prevCutterKey: stepEst.prevCutterKey,
        diameterMm: round3(stepEst.diameterMm),
        prevDiameterMm: round3(stepEst.prevDiameterMm),
        addedAreaMm2: round3(stepEst.addedAreaMm2),
        depthMm: round3(stepEst.depthMm),
        levels: stepEst.levels,
        feed: round3(stepEst.feed),
        plungeFeed: round3(stepEst.plungeFeed),
        stepOverMm: round3(stepEst.stepOver),
        stepDownMm: round3(stepEst.stepDown),
        cutSeconds: round3(stepEst.cutSeconds),
        restSeconds: round3(stepEst.restSeconds),
        bandAreaMm2: round3(band?.areaMm2 ?? 0),
        bandContourLengthMm: round3(band?.contourLengthMm ?? 0),
        bandPatches: band?.patches ?? 0,
      });
    }
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
    pockets: pockets.length,
    fieldMs: Math.round(fieldMs),
    estimateMs: Math.round(performance.now() - t0 - fieldMs),
  });

  // #1231 — what a shortlist of each measured size would have held, beside the candidates' count.
  for (const r of shortlistReport(shortlistRows, SHORTLIST_SIZES)) {
    memTrace('shadow:shortlist', {
      k: r.k,
      holdsRealPick: r.holdsRealPick,
      bestRealRank: r.bestRealRank,
      bestRealSeconds: round3(r.bestRealSeconds),
      candidates: candidates.length,
    });
  }
}
