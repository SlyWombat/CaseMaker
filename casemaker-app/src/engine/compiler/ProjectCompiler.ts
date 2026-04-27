import type { Project, HatProfile } from '@/types';
import type { BuildPlan, BuildNode, BuildOp } from './buildPlan';
import { union, difference, translate } from './buildPlan';
import { buildOuterShell } from './caseShell';
import { computeBossPlacements, buildBossesUnion } from './bosses';
import { buildLid, computeLidDims } from './lid';
import { buildPortCutoutsForProject } from './ports';
import { buildSlidingRails } from './slidingRails';
import { buildVentilationCutouts } from './ventilation';
import { buildExternalAssetOps } from './externalAssets';
import { buildHatCutoutsForProject } from './hats';
import { buildMountingFeatureOps } from './mountingFeatures';
import { buildDisplayCutoutOps } from './displays';
import { buildFanMountOps } from './fans';
import { buildTextLabelOps } from './textLabels';
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
  } = project;
  const resolveHat = makeHatResolver(project);
  const resolveDisplay = makeDisplayResolver(project);

  const shellOuter = buildOuterShell(board, caseParams, hats ?? [], resolveHat);
  const bossPlacements = computeBossPlacements(board, caseParams);
  const bossOps = buildBossesUnion(bossPlacements);
  const railOps = caseParams.joint === 'sliding' ? buildSlidingRails(board, caseParams) : [];
  const assetOps = buildExternalAssetOps(externalAssets);
  const featureOps = buildMountingFeatureOps(
    mountingFeatures,
    board,
    caseParams,
    hats ?? [],
    resolveHat,
  );
  const displayOps = buildDisplayCutoutOps(board, caseParams, display, resolveDisplay);
  const fanOps = buildFanMountOps(fanMounts, board, caseParams, hats ?? [], resolveHat);
  const textOps = buildTextLabelOps(textLabels, board, caseParams, hats ?? [], resolveHat);

  const additive = [
    shellOuter,
    ...bossOps,
    ...railOps,
    ...assetOps.unionOps,
    ...featureOps.additive,
    ...displayOps.additive,
    ...fanOps.additive,
    ...textOps.additive,
  ];

  const cutoutOps: BuildOp[] = [
    ...buildPortCutoutsForProject(ports, board, caseParams),
    ...buildVentilationCutouts(board, caseParams),
    ...buildHatCutoutsForProject(board, caseParams, hats ?? [], resolveHat),
    ...assetOps.subtractOps,
    ...featureOps.subtractive,
    ...displayOps.subtractive,
    ...fanOps.subtractive,
    ...textOps.subtractive,
  ];

  let shellOp: BuildOp = additive.length > 1 ? union(additive) : shellOuter;
  if (cutoutOps.length > 0) {
    shellOp = difference([shellOp, ...cutoutOps]);
  }

  const nodes: BuildNode[] = [{ id: 'shell', op: shellOp }];

  const lidOp = buildLid(board, caseParams);
  const lidDims = computeLidDims(board, caseParams);
  nodes.push({
    id: 'lid',
    op: translate([0, 0, lidDims.zPosition + lidDims.liftAboveShell], lidOp),
  });

  return { nodes };
}
