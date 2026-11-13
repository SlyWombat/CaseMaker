/**
 * #1237 — THE PLANNER-READ SHOP SETTINGS, in one list.
 *
 * The planner reads these keys: some through the live defaults source (`planModelCam`'s seven,
 * `rotaryMapOf`'s limits, `runTotals`'s bit-change rule, the probe residuals), some through the
 * shop object the generator carries (`feeds.ts`'s reach margin, the facing/rest/drill numbers).
 * The receipt states every one that differs from its recommendation, so an operator can see which
 * shop settings shaped the plan. `plannerDefaults1237.spec.ts` scans the planning sources and
 * fails when a read site exists whose key is missing here (or a key here that nothing reads), so
 * this list cannot drift.
 */
import { KNOWN_DEFAULTS, type ShopDefaults } from './defaultsClient';
import { provenance, provenanceForDefault, type ReceiptProvenance } from './headless/receipt';

export const PLANNER_DEFAULTS_KEYS: readonly string[] = [
  'bitChange.attendedChangeSeconds',
  'bitChange.attendedMinutes',
  'bitChange.returnMinutes',
  'bitChange.walkAwayMinutes',
  'bore.rampAngleDeg',
  'bracket.repeatMm',
  'clamps.maxCount',
  'drill.peckClearanceMm',
  'engrave.lostDetailWarnRatio',
  'facing.marginMm',
  'facing.retouchToleranceMm',
  'facing.roughMm',
  'facing.unknownMm',
  'finish.stockToLeaveMm',
  'goal.passCoverage',
  'plan.cutIntoFloorMm',
  'plan.leftoverEquivalencePct',
  'plan.leftoverTallMm',
  'probe.colletMatchMm',
  'reach.marginMm',
  'registration.chuckAxisResidualMm',
  'registration.faceAngleBallClearanceMm',
  'registration.faceAngleLevelBandMm',
  'registration.probeResidualMm',
  'registration.viseJawResidualMm',
  'registration.wiredProbeZResidualMm',
  'relief.planningPitchMm',
  'rest.overlapMm',
  'rest.thirdToolPct',
  'rest.visibleDepthMm',
  'rotary.jawKeepOutMm',
  'rotary.tailstockBandMm',
  'rotary.tailstockBodyMm',
  'rotary.tailstockCentreMm',
  'rotary.tailstockHousingRadiusMm',
  'rotary.turnClearanceMm',
  'setups.minGripMm',
  'setups.remountMinutes',
  'setups.reregisterMinutes',
  'stock.defaultPlateThicknessMm',
  'tape.holdRatio',
  // #1206 — the freeing contour's unsupported-span limit (read by planModelCam from its input).
  'tabs.maxSpanMm',
  'toolChange.seconds',
  'vise.defaultStockProudMm',
  'vise.minCoverageFraction',
  'vise.uncertaintyMm',
];

/**
 * #1237 — WHAT THE RECEIPT SAYS ABOUT THOSE SETTINGS.
 *
 * With a location: every planner key whose value there differs from its recommendation, with the
 * value and the location's own source ('located' for a seeded or chosen value, 'measured', or
 * 'typed'). At the recommendation: nothing, because there is nothing to explain.
 *
 * With no location: every key at its recommendation, source 'seeded' — the receipt states that
 * the planner ran on the recommendations rather than leaving the reader to assume it.
 */
export function plannerDefaultsProvenance(
  defaults: ShopDefaults | null,
  options: { withLocation: boolean },
): ReceiptProvenance[] {
  const out: ReceiptProvenance[] = [];
  for (const key of PLANNER_DEFAULTS_KEYS) {
    const known = KNOWN_DEFAULTS[key];
    if (known === undefined) continue;
    if (!options.withLocation) {
      out.push(provenance(key, known.fallback, known.unit, 'seeded'));
      continue;
    }
    const entry = defaults?.[key];
    if (entry === undefined || typeof entry.value !== 'number' || entry.value === known.fallback) continue;
    out.push(provenanceForDefault(key, entry.value, entry.unit ?? known.unit, entry.source));
  }
  return out;
}
