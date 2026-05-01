import type { Project, HatProfile } from '@/types';
import type { BuildPlan, BuildNode, BuildOp } from './buildPlan';
import { union, difference, translate } from './buildPlan';
import { buildOuterShell } from './caseShell';
import { computeBossPlacements, buildBossesUnion, buildLidBosses, buildBossSupportColumns } from './bosses';
import { buildSealChannel, buildSealTongue, buildGasketBody } from './seal';
import { buildLatchOps } from './latches';
import { buildAlignmentFlange } from './alignmentFlange';
import { buildRuggedOps } from './rugged';
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

  // Issue #105 — pass display so the shell envelope grows when the display
  // PCB is larger than the host (e.g. Pi 7" Touch on a Pi 4B).
  const shellOuter = buildOuterShell(board, caseParams, hats ?? [], resolveHat, display, resolveDisplay);
  const bossPlacements = computeBossPlacements(board, caseParams);
  // Issue #104 — bottom-position bosses fuse with the floor (legacy path).
  // Top-position bosses are emitted into the lid below; the case wall gets
  // tapered support columns instead so the print works without supports.
  const bossOps = buildBossesUnion(bossPlacements);
  const bossSupportColumns = buildBossSupportColumns(bossPlacements, board, caseParams);
  const assetOps = buildExternalAssetOps(externalAssets);
  const featureOps = buildMountingFeatureOps(
    mountingFeatures,
    board,
    caseParams,
    hats ?? [],
    resolveHat,
    display,
    resolveDisplay,
  );
  const displayOps = buildDisplayCutoutOps(board, caseParams, display, resolveDisplay, hats ?? [], resolveHat);
  const fanOps = buildFanMountOps(fanMounts, board, caseParams, hats ?? [], resolveHat, display, resolveDisplay);
  const textOps = buildTextLabelOps(textLabels, board, caseParams, hats ?? [], resolveHat, display, resolveDisplay);
  const antennaOps = buildAntennaOps(antennas, board, caseParams, hats ?? [], resolveHat, display, resolveDisplay);
  const snapOps = buildSnapCatchOps(caseParams.snapCatches, board, caseParams, hats ?? [], resolveHat, display, resolveDisplay);
  // Issue #109 — Pelican-style latches. Striker fuses with shell;
  // each cam arm becomes its own top-level node so it prints as a free part.
  const latchOps = buildLatchOps(caseParams.latches, board, caseParams, hats ?? [], resolveHat, display, resolveDisplay);
  // Pelican alignment brim + tongue/groove around the perimeter (auto-on
  // for shell-mode lids).
  const flangeOps = buildAlignmentFlange(board, caseParams, hats ?? [], resolveHat, display, resolveDisplay);
  // Issue #111 — rugged exterior (corner bumpers, ribbing, feet).
  const ruggedOps = buildRuggedOps(board, caseParams, hats ?? [], resolveHat, display, resolveDisplay);
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
    display,
    resolveDisplay,
  );

  const additive = [
    shellOuter,
    ...bossOps,
    ...bossSupportColumns,
    ...assetOps.unionOps,
    ...featureOps.additive,
    ...displayOps.additive,
    ...fanOps.additive,
    ...textOps.additive,
    ...snapOps.shellAdd,
    ...hingeOps.caseAdditive,
    ...latchOps.caseAdditive,
    ...ruggedOps.caseAdditive,
    ...(flangeOps.caseAdditive ? [flangeOps.caseAdditive] : []),
  ];

  const smartLayout = applySmartCutoutLayout(
    ports,
    board,
    caseParams,
    hats ?? [],
    resolveHat,
    display,
    resolveDisplay,
  );

  // Ventilation cutters split by destination: top-surface vents pierce the
  // LID node (separate mesh below); side / bottom vents pierce the shell.
  // Pre-split they were all routed to the shell and top vents silently
  // dropped because the shell has no material at lid Z.
  const ventCuts = buildVentilationCutouts(board, caseParams, hats ?? [], resolveHat, display, resolveDisplay);

  // Issue #107 — gasket channel cut into the rim top face (waterproof seal).
  const sealChannel = buildSealChannel(board, caseParams, hats ?? [], resolveHat, display, resolveDisplay);
  const cutoutOps: BuildOp[] = [
    ...buildPortCutoutsForProject(smartLayout.ports, board, caseParams),
    ...ventCuts.shellCuts,
    ...(sealChannel ? [sealChannel] : []),
    ...buildHatCutoutsForProject(board, caseParams, hats ?? [], resolveHat),
    ...assetOps.subtractOps,
    ...featureOps.subtractive,
    ...displayOps.subtractive,
    ...fanOps.subtractive,
    ...textOps.subtractive,
    ...antennaOps.subtractive,
    ...snapOps.shellSubtract,
    ...hingeOps.subtractive,
    ...latchOps.caseSubtract,
    ...buildCustomCutouts(caseParams.customCutouts, board, caseParams, hats ?? [], resolveHat, display, resolveDisplay),
  ];

  let shellOp: BuildOp = additive.length > 1 ? union(additive) : shellOuter;
  if (cutoutOps.length > 0) {
    shellOp = difference([shellOp, ...cutoutOps]);
  }

  const nodes: BuildNode[] = [{ id: 'shell', op: shellOp }];

  let lidOp = buildLid(board, caseParams, hats ?? [], resolveHat, display, resolveDisplay);
  const lidDims = computeLidDims(board, caseParams, hats ?? [], resolveHat, display, resolveDisplay);
  // Issue #104 — top-position bosses fuse with the lid mesh, anchored to
  // the lid's WORLD underside Z. The buildLid result is in lid-local
  // coords (the translate([0,0,zPosition], …) below moves it into world).
  // To union the world-coord boss cylinders we have to translate them
  // BACK by lidDims.zPosition first, since the lid op gets translated UP
  // afterward.
  const lidUndersideWorldZ = lidDims.zPosition; // lid-local z=0 sits here
  const lidBossOps = buildLidBosses(bossPlacements, lidUndersideWorldZ);
  if (lidBossOps.length > 0) {
    // Bosses live at world coords; shift them to lid-local before union so
    // the eventual translate([0,0,zPosition], lidOp) lands them correctly.
    const lidBossOpsLocal = lidBossOps.map((op) =>
      translate([0, 0, -lidDims.zPosition], op),
    );
    lidOp = union([lidOp, ...lidBossOpsLocal]);
  }
  if (snapOps.lidAdd.length > 0) {
    lidOp = union([lidOp, ...snapOps.lidAdd]);
  }
  if (hingeOps.lidAdditive.length > 0) {
    lidOp = union([lidOp, ...hingeOps.lidAdditive]);
  }
  // Pelican latch striker tab + post (#109 v2). Built in WORLD coords;
  // shift to lid-local before union so the eventual translate to world
  // by lidDims.zPosition lands it correctly.
  if (latchOps.lidAdditive.length > 0) {
    const lidLatchPartsLocal = latchOps.lidAdditive.map((op) =>
      translate([0, 0, -lidDims.zPosition], op),
    );
    lidOp = union([lidOp, ...lidLatchPartsLocal]);
  }
  // Issue #107 — gasket TONGUE on the lid underside. The tongue op is in
  // world coords; shift to lid-local before union so the eventual
  // translate([0,0,zPosition], lidOp) lands it correctly.
  const sealTongue = buildSealTongue(board, caseParams, hats ?? [], resolveHat, display, resolveDisplay);
  if (sealTongue) {
    const tongueLocal = translate([0, 0, -lidDims.zPosition], sealTongue);
    lidOp = union([lidOp, tongueLocal]);
  }
  // Pelican rugged exterior on the LID (top corner caps + upper ribs +
  // protective ribs flanking each latch). Ops are in lid-LOCAL coords;
  // union into lidOp BEFORE the lid translates to its world Z.
  if (ruggedOps.lidAdditive.length > 0) {
    lidOp = union([lidOp, ...ruggedOps.lidAdditive]);
  }
  // Pelican alignment-flange BRIM on the lid bottom (additive in
  // lid-local coords).
  if (flangeOps.lidAdditive) {
    lidOp = union([lidOp, flangeOps.lidAdditive]);
  }
  // Top-surface vent cuts. ventilation.ts emits the 'top' frame in
  // lid-LOCAL Z (so the difference here actually pierces the lid mesh
  // — pre-fix the cuts were in world coords and removed nothing).
  if (ventCuts.lidCuts.length > 0) {
    lidOp = difference([lidOp, ...ventCuts.lidCuts]);
  }
  // Groove cut into lid brim underside.
  if (flangeOps.lidSubtract) {
    lidOp = difference([lidOp, flangeOps.lidSubtract]);
  }
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

  // Issue #108 — gasket body is its own top-level node so the export
  // pipeline emits it as a separate STL (printed in TPU 95A, not the
  // case body's PLA/PETG). The export pipeline keys off the `gasket`
  // node id.
  const gasketBody = buildGasketBody(board, caseParams, hats ?? [], resolveHat, display, resolveDisplay);
  if (gasketBody) {
    nodes.push({ id: 'gasket', op: gasketBody });
  }
  // Issue #109 — Pelican-style latch arms + print-in-place pins each
  // become their own top-level node so they print as free parts.
  for (const arm of latchOps.armNodes) {
    nodes.push(arm);
  }
  for (const pin of latchOps.pinNodes) {
    nodes.push(pin);
  }
  // Issue #111 — flex bumpers (when enabled) print in TPU as separate
  // slip-on parts.
  for (const b of ruggedOps.bumperNodes) {
    nodes.push(b);
  }

  const placementReport = validatePlacements(project);
  return { nodes, placementReport, smartCutoutDecisions: smartLayout.decisions };
}
