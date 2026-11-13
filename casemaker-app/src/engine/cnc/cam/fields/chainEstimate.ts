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

/** #1249 stage 2b — the two rapid rates a hop is priced at, taken from the plan's own RapidEstimate. */
export interface RestRapidRates { xyMmPerMin: number; zMmPerMin: number }

/** #1249 stage 2b — what a banded rest step's hops are priced at: the plan's rapid rates and hop height. */
export interface RestPricing { rapid: RestRapidRates; hopClearanceMm: number }

export interface EstimateStep {
  kind: string;
  cutterKey: string;
  diameterMm: number;
  regionIds: readonly string[];
  /** null when the cutter has no usable feed row. */
  rates: CutterRates | null;
  /** For a 'contour' step: the outline's length and the depth it is cut to. Absent: the step is unpriced. */
  contour?: { perimeterMm: number; depthMm: number };
  /** #1249 stage 2b — the band the previous cutter left this step, summed over its regions (reachBand).
   *  Absent, or an outline of 0: the step keeps the area term. */
  band?: { areaMm2: number; contourLengthMm: number; patches: number };
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
  /** What the estimate priced this step at: the band term when one was used, else the area term. */
  cutSeconds: number;
  /** #1249 stage 2b — the band term's own seconds; 0 when the step took the area term (or is no rest). */
  restSeconds: number;
}

export function estimateChain(
  steps: readonly EstimateStep[],
  pockets: readonly PocketArea[],
  changePrice: (precedingSeconds: number) => number,
  /** #1249 stage 2b — the plan's rapid rates and hop height. Absent: every step keeps the area term. */
  restPricing?: RestPricing,
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
  // #1249 stage 2b — the area a rest step's patches are spread over: the POCKET the job works,
  // not the step's own share of it. A rest step's regions can be slivers of a few mm² scattered
  // across the whole pocket (the tray's Haocher step: 3 small pockets totalling 27 mm²), and the
  // average patch spacing is only meaningful against the pocket they sit in. The analyst's own
  // 2,822-row check used this area; the step's own share lands at 0 % within ×1.5.
  let pocketAreaMm2 = 0;
  for (const pocket of pockets) pocketAreaMm2 += pocket.areaMm2;
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
    // #1249 stage 2b — a rest step WITH a band is priced by the line it follows, not the area it
    // could reach: cut along max(outline, area/step-over) (a thin band is followed, a fat one is
    // cleared like a pocket), one plunge per patch per level, and a hop per patch and one for the
    // way in and out, each hop the plan's Z rapid twice plus the average patch spacing at its XY
    // rapid. A step with no band (outline 0) or no rates keeps the area term above.
    let restSeconds = 0;
    if (
      restPricing !== undefined &&
      step.kind === 'rest' &&
      areaPriceable &&
      rates !== null &&
      step.band !== undefined &&
      step.band.contourLengthMm > 0 &&
      step.band.patches > 0 &&
      rates.plungeFeed > 0 &&
      restPricing.rapid.zMmPerMin > 0 &&
      restPricing.rapid.xyMmPerMin > 0 &&
      Number.isFinite(restPricing.hopClearanceMm) &&
      restPricing.hopClearanceMm >= 0
    ) {
      const patches = step.band.patches;
      const path = Math.max(step.band.contourLengthMm, step.band.areaMm2 / rates.stepOver);
      const cut = (stepLevels * path / rates.feed) * 60;
      const plunges = (patches * stepLevels * rates.stepDown / rates.plungeFeed) * 60;
      const spacing = Math.sqrt(pocketAreaMm2 / Math.max(patches, 1));
      const hop =
        (2 * (stepDepth + restPricing.hopClearanceMm) / restPricing.rapid.zMmPerMin) * 60 +
        (spacing / restPricing.rapid.xyMmPerMin) * 60;
      restSeconds = cut + plunges + (patches + 1) * hop;
      stepSeconds = restSeconds;
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
      restSeconds,
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
