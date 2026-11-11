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

  let cutSeconds = 0;
  let changeSeconds = 0;
  let changes = 0;
  let unpriced = 0;
  let previousKey: string | null = null;
  let runSeconds = 0;

  for (const step of steps) {
    let stepSeconds = 0;
    const rates = step.rates;
    const priceable =
      (step.kind === 'pocket' || step.kind === 'rest') &&
      rates !== null &&
      rates.feed > 0 &&
      rates.stepDown > 0 &&
      rates.stepOver > 0 &&
      step.diameterMm > 0;
    if (!priceable) unpriced += 1;
    if (priceable && rates !== null) {
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
  };
}
