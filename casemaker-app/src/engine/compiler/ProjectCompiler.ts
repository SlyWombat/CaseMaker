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
import { buildHingeOps } from './hinges';
import { buildCustomCutouts } from './customCutouts';
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
  // Issue #92 — barrel hinge. caseAdditive joins the shell pre-cavity-cut so
  // the through-hole bores cleanly through both the wall and the knuckle;
  // lidAdditive is unioned with the lid op (pre-drilled in lid-local coords);
  // subtractive joins cutoutOps to drill the shell side.
  const hingeOps = buildHingeOps(
    caseParams.hinge,
    board,
    caseParams,
    hats ?? [],
    resolveHat,
  );

  const additive = [
    shellOuter,
    ...bossOps,
    ...assetOps.unionOps,
    ...featureOps.additive,
    ...displayOps.additive,
    ...fanOps.additive,
    ...textOps.additive,
    ...snapOps.shellAdd,
    ...hingeOps.caseAdditive,
  ];

  const smartLayout = applySmartCutoutLayout(
    ports,
    board,
    caseParams,
    hats ?? [],
    resolveHat,
  );

  // Ventilation cutters split by destination: top-surface vents pierce the
  // LID node (separate mesh below); side / bottom vents pierce the shell.
  // Pre-split they were all routed to the shell and top vents silently
  // dropped because the shell has no material at lid Z.
  const ventCuts = buildVentilationCutouts(board, caseParams, hats ?? [], resolveHat);

  const cutoutOps: BuildOp[] = [
    ...buildPortCutoutsForProject(smartLayout.ports, board, caseParams),
    ...ventCuts.shellCuts,
    ...buildHatCutoutsForProject(board, caseParams, hats ?? [], resolveHat),
    ...assetOps.subtractOps,
    ...featureOps.subtractive,
    ...displayOps.subtractive,
    ...fanOps.subtractive,
    ...textOps.subtractive,
    ...antennaOps.subtractive,
    ...snapOps.shellSubtract,
    ...hingeOps.subtractive,
    ...buildCustomCutouts(caseParams.customCutouts, board, caseParams, hats ?? [], resolveHat),
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
  if (hingeOps.lidAdditive.length > 0) {
    lidOp = union([lidOp, ...hingeOps.lidAdditive]);
  }
  if (ventCuts.lidCuts.length > 0) {
    lidOp = difference([lidOp, ...ventCuts.lidCuts]);
  }
  const lidDims = computeLidDims(board, caseParams, hats ?? [], resolveHat);
  // Issue #91 — lid is emitted at its ASSEMBLED Z position. The scene layer
  // (SceneMeshes) applies the exploded lift dynamically based on viewMode,
  // so toggling Complete / Exploded doesn't require a full recompile.
  nodes.push({
    id: 'lid',
    op: translate([0, 0, lidDims.zPosition], lidOp),
  });

  // Issue #92 — print-in-place pin lives as its own top-level node so the
  // shell's cutoutOps difference can't drill it back out. Slicers print it
  // as a free body captured by the surrounding knuckles (the bore is wider
  // than the pin by knuckleClearance/2 + 0.1 mm of slop).
  if (hingeOps.pinNode) {
    nodes.push({ id: 'hinge-pin', op: hingeOps.pinNode });
  }

  const placementReport = validatePlacements(project);
  return { nodes, placementReport, smartCutoutDecisions: smartLayout.decisions };
}
