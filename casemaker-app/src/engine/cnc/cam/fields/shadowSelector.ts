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
}

/** Every number a trace row carries is rounded to three decimals (milliseconds stay integers). */
const round3 = (value: number): number => Math.round(value * 1000) / 1000;

/** Writes 'shadow:candidate' rows and one 'shadow:choice' row to the trace. Returns nothing. */
export function traceShadowSelection(input: ShadowInput): void {
  const t0 = performance.now();

  const candidates = candidateSequences(input.demand, input.cutters, input.candidateOpts);

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
  for (const candidate of candidates) {
    const signature = candidate.steps.map((s) => `${s.kind}:${s.cutter.key}`).join('+');
    const steps: EstimateStep[] = candidate.steps.map((s) => ({
      kind: s.kind,
      cutterKey: s.cutter.key,
      diameterMm: cuttingDiameter(s.cutter.tool) ?? 0,
      regionIds: s.regionIds,
      rates: ratesOf(s.cutter.key, s.cutter.tool),
    }));
    const est = estimateChain(steps, pockets, input.changePrice);
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
    });
    estimates.push({ signature, est });
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
}
