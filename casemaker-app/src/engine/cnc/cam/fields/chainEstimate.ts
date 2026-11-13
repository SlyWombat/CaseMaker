/**
 * #1216 (planner v3, slice 3) — THE SHADOW ESTIMATOR.
 *
 * Prices a cutter chain from the fields instead of from real toolpaths: each cutter pays for what
 * it ADDS over the larger stage before it, at the feed row it really runs, plus the bit changes
 * between cutters. Pure: it imports only the reach type from `./flatReach`, so the planner-side
 * import gate has nothing to object to. Measurement only — nothing decides on this yet.
 */
import type { ReachStep } from './flatReach';

/** One pocket as the estimator sees it. */
export interface PocketArea {
  id: string;
  /** Depth below the stock top, mm (0 or less means one level). */
  depthMm: number;
  /** The pocket's whole area, mm². */
  areaMm2: number;
  /** From flatReach: the area each diameter can clear. */
  reach: readonly ReachStep[];
}

/** The four numbers of a cutter's feed row the estimate uses. */
export interface CutterRates { feed: number; plungeFeed: number; stepDown: number; stepOver: number }

export interface EstimateStep {
  kind: string;
  cutterKey: string;
  diameterMm: number;
  regionIds: readonly string[];
  /** null when the cutter has no usable feed row. */
  rates: CutterRates | null;
  /** For a 'contour' step: the outline's length and the depth it is cut to. Absent: the step is unpriced. */
  contour?: { perimeterMm: number; depthMm: number };
}

export interface ChainEstimate {
  /** Seconds of cutting, pocket and rest steps only. */
  cutSeconds: number;
  /** Seconds of bit changes. */
  changeSeconds: number;
  /** How many bit changes. */
  changes: number;
  /** cutSeconds + changeSeconds. */
  totalSeconds: number;
  /** Pocket area no cutter of the chain reaches, mm². */
  leftoverMm2: number;
  /** Steps the estimate could not price. */
  unpriced: number;
  /** Cutting seconds per cutter, in the order the cutters first appear in the chain. */
  perCutter: { cutterKey: string; cutSeconds: number }[];
  /** #1249 stage 2a — every step's own inputs and priced seconds, for the trace (no value above changes). */
  stepEstimates: StepEstimate[];
}

/** #1249 stage 2a — one step's inputs and its priced seconds, exactly as the estimate used them. */
export interface StepEstimate {
  stepIndex: number;
  kind: string;
  cutterKey: string;
  /** '' for the chain's first step. */
  prevCutterKey: string;
  diameterMm: number;
  prevDiameterMm: number;
  /** The area this step was priced to remove (0 for a contour or an unpriced step). */
  addedAreaMm2: number;
  depthMm: number;
  levels: number;
  feed: number;
  plungeFeed: number;
  stepOver: number;
  stepDown: number;
  cutSeconds: number;
}

export function estimateChain(
  steps: readonly EstimateStep[],
  pockets: readonly PocketArea[],
  changePrice: (precedingSeconds: number) => number,
): ChainEstimate {
  const cleared = new Map<string, number>();
  const pocketById = new Map<string, PocketArea>();
  for (const pocket of pockets) {
    cleared.set(pocket.id, 0);
    pocketById.set(pocket.id, pocket);
  }
  // A diameter is looked up within 1e-9: the same number the reach's own de-duplication uses.
  const reachOf = (pocket: PocketArea, diameterMm: number): number => {
    const step = pocket.reach.find((s) => Math.abs(s.diameterMm - diameterMm) <= 1e-9);
    return step === undefined ? 0 : step.areaMm2;
  };

  const perCutter: { cutterKey: string; cutSeconds: number }[] = [];
  const stepEstimates: StepEstimate[] = [];
  let cutSeconds = 0;
  let changeSeconds = 0;
  let changes = 0;
  let unpriced = 0;
  let previousKey: string | null = null;
  let runSeconds = 0;

  for (const [stepIndex, step] of steps.entries()) {
    let stepSeconds = 0;
    let stepAddedArea = 0;
    let stepDepth = 0;
    let stepLevels = 1;
    const rates = step.rates;
    const prevStep = stepIndex > 0 ? steps[stepIndex - 1]! : null;
    const areaPriceable =
      (step.kind === 'pocket' || step.kind === 'rest') &&
      rates !== null &&
      rates.feed > 0 &&
      rates.stepDown > 0 &&
      rates.stepOver > 0 &&
      step.diameterMm > 0;
    const contourPriceable =
      step.kind === 'contour' &&
      step.contour !== undefined &&
      step.rates !== null &&
      step.rates.feed > 0 &&
      step.rates.stepDown > 0 &&
      step.contour.perimeterMm > 0;
    if (!areaPriceable && !contourPriceable) unpriced += 1;
    if (contourPriceable) {
      const rates = step.rates!;
      const c = step.contour!;
      const levels = c.depthMm > 0 ? Math.ceil(c.depthMm / rates.stepDown) : 1;
      const perLevel = (c.perimeterMm / rates.feed) * 60 + (rates.plungeFeed > 0 ? (rates.stepDown / rates.plungeFeed) * 60 : 0);
      stepSeconds += levels * perLevel;
    }
    if (areaPriceable && rates !== null) {
      for (const id of step.regionIds) {
        const pocket = pocketById.get(id);
        if (pocket === undefined) continue;
        const reach = reachOf(pocket, step.diameterMm);
        const before = cleared.get(id) ?? 0;
        const added = Math.max(0, reach - before);
        if (added > 0) {
          const levels = pocket.depthMm > 0 ? Math.ceil(pocket.depthMm / rates.stepDown) : 1;
          const perLevel =
            (added / rates.stepOver / rates.feed) * 60 +
            (rates.plungeFeed > 0 ? (rates.stepDown / rates.plungeFeed) * 60 : 0);
          stepSeconds += levels * perLevel;
          stepAddedArea += added;
          stepDepth = Math.max(stepDepth, pocket.depthMm);
          stepLevels = Math.max(stepLevels, levels);
        }
        cleared.set(id, Math.max(before, reach));
      }
    }
    // A step it cannot price still costs its bit change (the change is between cutters, not cuts).
    if (previousKey !== null && previousKey !== step.cutterKey) {
      changeSeconds += changePrice(runSeconds);
      changes += 1;
      runSeconds = 0;
    }
    runSeconds += stepSeconds;
    previousKey = step.cutterKey;
    cutSeconds += stepSeconds;
    stepEstimates.push({
      stepIndex,
      kind: step.kind,
      cutterKey: step.cutterKey,
      prevCutterKey: prevStep === null ? '' : prevStep.cutterKey,
      diameterMm: step.diameterMm,
      prevDiameterMm: prevStep === null ? 0 : prevStep.diameterMm,
      addedAreaMm2: stepAddedArea,
      depthMm: stepDepth,
      levels: stepLevels,
      feed: rates?.feed ?? 0,
      plungeFeed: rates?.plungeFeed ?? 0,
      stepOver: rates?.stepOver ?? 0,
      stepDown: rates?.stepDown ?? 0,
      cutSeconds: stepSeconds,
    });
    // Every step lands on its cutter's row — an unpriced one adds 0, so the cutter still appears.
    let entry = perCutter.find((e) => e.cutterKey === step.cutterKey);
    if (entry === undefined) {
      entry = { cutterKey: step.cutterKey, cutSeconds: 0 };
      perCutter.push(entry);
    }
    entry.cutSeconds += stepSeconds;
  }

  let leftoverMm2 = 0;
  for (const pocket of pockets) leftoverMm2 += Math.max(0, pocket.areaMm2 - (cleared.get(pocket.id) ?? 0));

  return {
    cutSeconds,
    changeSeconds,
    changes,
    totalSeconds: cutSeconds + changeSeconds,
    leftoverMm2,
    unpriced,
    perCutter,
    stepEstimates,
  };
}
