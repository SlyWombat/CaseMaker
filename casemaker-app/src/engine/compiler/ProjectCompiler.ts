import type { Project, HatProfile } from '@/types';
import type { BuildPlan, BuildNode, BuildOp } from './buildPlan';
import { union, difference, translate } from './buildPlan';
import { buildOuterShell } from './caseShell';
import { computeBossPlacements, buildBossesUnion } from './bosses';
import { buildLid, computeLidDims } from './lid';
import { buildPortCutoutsForProject } from './ports';
import { applySmartCutoutLayout } from './smartCutoutLayout';
import { buildVentilationCutouts } from './ventilation';
import { buildExternalAssetOps } from './externalAssets';
import { buildHatCutoutsForProject } from './hats';
import { buildMountingFeatureOps } from './mountingFeatures';
import { buildDisplayCutoutOps } from './displays';
import { buildFanMountOps } from './fans';
import { buildTextLabelOps } from './textLabels';
import { buildAntennaOps } from './antennas';
import { buildSnapCatchOps } from './snapCatches';
import { validatePlacements } from './placementValidator';
import { getBuiltinHat } from '@/library/hats';
import { getBuiltinDisplay } from '@/library/displays';
import type { DisplayProfile } from '@/types/display';

function makeHatResolver(project: Project): (id: string) => HatProfile | undefined {
  const customById = new Map((project.customHats ?? []).map((h) => [h.id, h] as const));
  return (id: string) => customById.get(id) ?? getBuiltinHat(id);
}

function makeDisplayResolver(project: Project): (id: string) => DisplayProfile | undefined {
  const customById = new Map((project.customDisplays ?? []).map((d) => [d.id, d] as const));
  return (id: string) => customById.get(id) ?? getBuiltinDisplay(id);
}

export function compileProject(project: Project): BuildPlan {
  const {
    board,
    case: caseParams,
    ports,
    externalAssets,
    hats,
    mountingFeatures,
    display,
    fanMounts,
    textLabels,
    antennas,
  } = project;
  const resolveHat = makeHatResolver(project);
  const resolveDisplay = makeDisplayResolver(project);

  const shellOuter = buildOuterShell(board, caseParams, hats ?? [], resolveHat);
  const bossPlacements = computeBossPlacements(board, caseParams);
  const bossOps = buildBossesUnion(bossPlacements);
  const assetOps = buildExternalAssetOps(externalAssets);
  const featureOps = buildMountingFeatureOps(
    mountingFeatures,
    board,
    caseParams,
    hats ?? [],
    resolveHat,
  );
  const displayOps = buildDisplayCutoutOps(board, caseParams, display, resolveDisplay, hats ?? [], resolveHat);
  const fanOps = buildFanMountOps(fanMounts, board, caseParams, hats ?? [], resolveHat);
  const textOps = buildTextLabelOps(textLabels, board, caseParams, hats ?? [], resolveHat);
  const antennaOps = buildAntennaOps(antennas, board, caseParams, hats ?? [], resolveHat);
  const snapOps = buildSnapCatchOps(caseParams.snapCatches, board, caseParams, hats ?? [], resolveHat);

  const additive = [
    shellOuter,
    ...bossOps,
    ...assetOps.unionOps,
    ...featureOps.additive,
    ...displayOps.additive,
    ...fanOps.additive,
    ...textOps.additive,
    ...snapOps.shellAdd,
  ];

  const smartLayout = applySmartCutoutLayout(
    ports,
    board,
    caseParams,
    hats ?? [],
    resolveHat,
  );

  const cutoutOps: BuildOp[] = [
    ...buildPortCutoutsForProject(smartLayout.ports, board, caseParams),
    ...buildVentilationCutouts(board, caseParams, hats ?? [], resolveHat),
    ...buildHatCutoutsForProject(board, caseParams, hats ?? [], resolveHat),
    ...assetOps.subtractOps,
    ...featureOps.subtractive,
    ...displayOps.subtractive,
    ...fanOps.subtractive,
    ...textOps.subtractive,
    ...antennaOps.subtractive,
    ...snapOps.shellSubtract,
  ];

  let shellOp: BuildOp = additive.length > 1 ? union(additive) : shellOuter;
  if (cutoutOps.length > 0) {
    shellOp = difference([shellOp, ...cutoutOps]);
  }

  const nodes: BuildNode[] = [{ id: 'shell', op: shellOp }];

  let lidOp = buildLid(board, caseParams, hats ?? [], resolveHat);
  if (snapOps.lidAdd.length > 0) {
    lidOp = union([lidOp, ...snapOps.lidAdd]);
  }
  const lidDims = computeLidDims(board, caseParams, hats ?? [], resolveHat);
  nodes.push({
    id: 'lid',
    op: translate([0, 0, lidDims.zPosition + lidDims.liftAboveShell], lidOp),
  });

  const placementReport = validatePlacements(project);
  return { nodes, placementReport, smartCutoutDecisions: smartLayout.decisions };
}
