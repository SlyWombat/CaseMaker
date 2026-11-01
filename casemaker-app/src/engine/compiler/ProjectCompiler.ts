import type { Project, HatProfile } from '@/types';
import { TOOLBOX_WALL_T } from '@/types';
import type { Aabb, BuildPlan, BuildNode, BuildOp, SplitOffer } from './buildPlan';
import { union, difference, translate, aabbOfOp, cube } from './buildPlan';
import { buildOuterShell } from './caseShell';
import { computeBossPlacements, buildBossesUnion, buildLidBosses } from './bosses';
import { buildSealChannel, buildSealTongue, buildGasketBody } from './seal';
import { buildLatchOps } from './latches';
import { buildAlignmentFlange } from './alignmentFlange';
import { buildRuggedOps } from './rugged';
import { buildFullLidFrictionLip, buildLid, computeLidDims } from './lid';
import { lidCavityHeight } from './lidMode';
import { buildPortCutoutOp, buildPortCutoutsForProject } from './ports';
import { applySmartCutoutLayout } from './smartCutoutLayout';
import { buildVentilationCutouts } from './ventilation';
import { buildExternalAssetOps } from './externalAssets';
import { buildHatCutoutsForProject, computeHatBaseZ } from './hats';
import { buildMountingFeatureOps } from './mountingFeatures';
import { buildDisplayCutoutOps } from './displays';
import { buildFanMountOps } from './fans';
import { buildTextLabelOps } from './textLabels';
import { buildAntennaOps } from './antennas';
import { buildSnapCatchOps } from './snapCatches';
import { buildBoardSnapOps } from './boardSnap';
import { buildSecondaryMountOps } from './secondaryMounts';
import { buildHingeOps } from './hinges';
import { buildCustomCutouts } from './customCutouts';
import { buildMagnetOps, faceSizeForProject } from './magnets';
import { boardFootprint, buildCaseDividerOps } from './caseDividers';
import { buildStandNodes } from './stand';
import { buildRackNodes, buildRackSplitNodes, rackSplitOffers } from './rack';
import { rectFitsBed, resolvePrinter } from './rackFit';
import {
  DEFAULT_SPLIT_SCREW,
  LUG_LAP,
  buildShellSplit,
  canSplitShell,
  planShellJoint,
} from './shellSplit';
import { buildLidSplit, canSplitLid, lidJointSide, planLidJoint } from './lidSplit';
import { buildBadgeNodes } from './badge';
import { buildInsertNodes } from './insert';
import { buildBlankNodes } from './blank';
import { buildToolboxNodes, TOOLBOX_BIN_NODE_ID } from './toolbox';
import { buildStackConnector, stackConnectorWanted, stackPadCutouts } from './stackConnector';
import { buildStackGroove, buildStackRidge, stackRegisterWanted } from './stackRegister';
import { ClashEnv, dividerClashStatements, hatBeyondHost, magnetClashStatements, type ClashStatement } from './caseClashes';
import { feature, featureOfOps } from './interiorClash';
import { resolveMountingPosition } from './hatOrientation';
import { cavityOriginXY } from '@/engine/coords';
import type { ShellJointPlan } from './shellSplit';
import { computeShellDims } from './caseShell';
import { lidIsRecessed } from './lidMode';
import { derivedKind } from './archetype';
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
  // Issue #167 — one place decides which archetype this is; the three branches
  // below used to each read their own `enabled` flag.
  const kind = derivedKind(project);

  // Mini-rack archetype: an assembly of side panels + plates + accessories,
  // no PCB and no shell at all. Unlike the stand it needs no board data, so
  // this branch never falls through.
  if (kind === 'rack' && caseParams.rack) {
    const rackPrinter = resolvePrinter(project);
    const rackNodes = buildRackNodes(caseParams.rack, rackPrinter);
    // #266 — the rack's own parts split through the same project switch as the
    // case's. The offer is metadata arithmetic; the pieces are built only when
    // the split is asked for.
    const rackOffers = rackSplitOffers(caseParams.rack, rackPrinter);
    if (caseParams.splitForPrint === true) {
      rackNodes.push(...buildRackSplitNodes(caseParams.rack, rackPrinter));
    }
    return {
      nodes: rackNodes,
      placementReport: validatePlacements(project),
      smartCutoutDecisions: [],
      rackSplitOffers: rackOffers,
    };
  }

  // Desk-stand archetype: a frame + tilted foot, no cavity and no lid. Every
  // feature compiler below assumes a box shell around a PCB, so the stand
  // takes its own path rather than trying to make fourteen of them no-op.
  if (kind === 'stand' && caseParams.stand) {
    const standNodes = buildStandNodes(board, caseParams.stand);
    if (standNodes) {
      return {
        nodes: standNodes,
        placementReport: validatePlacements(project),
        // No smart cutout layout runs for a stand (no walls to lay ports out
        // on), but the field is part of every plan's contract.
        smartCutoutDecisions: [],
      };
    }
    // Board isn't a finished enclosure module — fall through to the normal
    // shell so the user still gets geometry rather than an empty viewport.
  }

  // Stacking-toolbox archetype (issue #155): the project is a MODULE FAMILY —
  // a bin and a shallow lid, each a single printed part, no cavity shell and no
  // board. Like the badge, an unbuildable parameter set falls through rather
  // than emptying the viewport.
  if (kind === 'toolbox' && caseParams.toolbox) {
    const toolboxNodes = buildToolboxNodes(caseParams.toolbox);
    if (toolboxNodes) {
      // #854 item 3 — the toolbox uses the same stacking connector: its bin's
      // own walls ARE the module's outside, so the sockets go on them, the
      // keys ride in the export as their own parts, and the same report feeds
      // the connector section. The lid is a separate module and carries none:
      // a socket spans one part's height.
      const toolbox = caseParams.toolbox;
      const toolboxConnector = buildStackConnector(caseParams.stackConnector, {
        outerX: toolbox.width,
        outerY: toolbox.depth,
        shellTop: toolbox.height,
        top: toolbox.height,
        wall: TOOLBOX_WALL_T,
        cornerRadius: 0,
        caseFit: caseParams.fit,
      });
      const bin = toolboxNodes.find((n) => n.id === TOOLBOX_BIN_NODE_ID);
      if (bin && (toolboxConnector.shellAdd.length > 0 || toolboxConnector.shellCut.length > 0)) {
        let op = bin.op;
        if (toolboxConnector.shellAdd.length > 0) op = union([op, ...toolboxConnector.shellAdd]);
        if (toolboxConnector.shellCut.length > 0) op = difference([op, ...toolboxConnector.shellCut]);
        bin.op = op;
      }
      toolboxNodes.push(...toolboxConnector.keyNodes);
      return {
        nodes: toolboxNodes,
        placementReport: validatePlacements(project),
        smartCutoutDecisions: [],
        ...(toolboxConnector.report ? { connector: toolboxConnector.report } : {}),
      };
    }
  }

  // Name-badge archetype (issue #167): the whole project is the two-colour
  // badge blank — two parts, no cavity, no lid, no board. Like the stand, an
  // unbuildable parameter set falls through rather than emptying the viewport.
  if (kind === 'badge' && caseParams.badge) {
    const badgeNodes = buildBadgeNodes(caseParams.badge);
    if (badgeNodes) {
      return {
        nodes: badgeNodes,
        placementReport: validatePlacements(project),
        smartCutoutDecisions: [],
      };
    }
  }

  // Tool-insert archetype (issue #158): a single pocketed plate — no cavity,
  // no lid, no board. It builds whenever the plate has extent, so it only
  // falls through on a non-positive dimension (a hand-edited project), never
  // on an empty or over-full item list: those still yield a plate carrying the
  // pockets that fit, with `insertProblem` naming the rest for the panel.
  if (kind === 'insert' && caseParams.insert) {
    const insertNodes = buildInsertNodes(caseParams.insert);
    if (insertNodes) {
      return {
        nodes: insertNodes,
        placementReport: validatePlacements(project),
        smartCutoutDecisions: [],
      };
    }
  }

  // Bare-blank archetype (issue #280): the whole project is the blank — one
  // part, no cavity, no lid, no board. Like the badge, an unbuildable parameter
  // set falls through rather than emptying the viewport.
  if (kind === 'blank' && caseParams.blank) {
    const blankNodes = buildBlankNodes(caseParams.blank);
    if (blankNodes) {
      return {
        nodes: blankNodes,
        placementReport: validatePlacements(project),
        smartCutoutDecisions: [],
      };
    }
  }

  // Issue #105 — pass display so the shell envelope grows when the display
  // PCB is larger than the host (e.g. Pi 7" Touch on a Pi 4B).
  const shellOuter = buildOuterShell(board, caseParams, hats ?? [], resolveHat, display, resolveDisplay);
  const bossPlacements = computeBossPlacements(board, caseParams);
  // Issue #104 — bottom-position bosses fuse with the floor (legacy path).
  // Top-position bosses are emitted into the lid below; the case wall gets
  // tapered support columns instead so the print works without supports.
  const bossOps = buildBossesUnion(bossPlacements);
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
  const textOps = buildTextLabelOps(
    textLabels,
    board,
    caseParams,
    hats ?? [],
    resolveHat,
    display,
    resolveDisplay,
    project.customFonts ?? [],
  );
  const antennaOps = buildAntennaOps(antennas, board, caseParams, hats ?? [], resolveHat, display, resolveDisplay);
  const snapOps = buildSnapCatchOps(caseParams.snapCatches, board, caseParams, hats ?? [], resolveHat, display, resolveDisplay);
  // Issue #109 — Pelican-style latches. Striker fuses with shell;
  // each cam arm becomes its own top-level node so it prints as a free part.
  const latchOps = buildLatchOps(caseParams.latches, board, caseParams, hats ?? [], resolveHat, display, resolveDisplay);
  // Pelican alignment brim + tongue/groove around the perimeter (auto-on
  // for shell-mode lids).
  const flangeOps = { ...buildAlignmentFlange(board, caseParams, hats ?? [], resolveHat, display, resolveDisplay) };
  // Board-retention snap fingers (when boardRetention='snap'). Emitted
  // on the cavity walls; auto-skipped when boardRetention is anything else.
  const boardSnapOps = buildBoardSnapOps(board, caseParams, hats ?? [], resolveHat, display, resolveDisplay);
  // Snap-clip mounts for secondary boards (e.g. SlyTherm's MSR-2), fused with
  // the shell. Empty unless board.secondaryBoardMounts is set.
  const secondaryMountOps = buildSecondaryMountOps(board, caseParams);
  // Issue #111 — rugged exterior (corner bumpers, ribbing, feet).
  const ruggedOps = buildRuggedOps(board, caseParams, hats ?? [], resolveHat, display, resolveDisplay);
  // A connector socket that asks for a pad cut-out notches the brim and the
  // ribbing where it stands. Nothing changes unless a socket asks for one.
  const connectorOn = stackConnectorWanted(caseParams.stackConnector);
  const shellDimsEarly = connectorOn
    ? computeShellDims(board, caseParams, hats ?? [], resolveHat, display, resolveDisplay)
    : null;
  const lidDimsEarly = computeLidDims(board, caseParams, hats ?? [], resolveHat, display, resolveDisplay);
  const connectorTop = shellDimsEarly
    ? lidIsRecessed(caseParams)
      ? shellDimsEarly.outerZ
      : lidDimsEarly.zPosition + lidDimsEarly.z
    : 0;
  const padCuts = shellDimsEarly
    ? stackPadCutouts(caseParams.stackConnector, {
        outerX: shellDimsEarly.outerX,
        outerY: shellDimsEarly.outerY,
        top: connectorTop,
        wall: caseParams.wallThickness,
        cornerRadius: caseParams.cornerRadius,
      })
    : [];
  if (padCuts.length > 0) {
    const toLid = padCuts.map((op) => translate([0, 0, -lidDimsEarly.zPosition], op));
    if (flangeOps.caseAdditive) flangeOps.caseAdditive = difference([flangeOps.caseAdditive, ...padCuts]);
    if (flangeOps.lidAdditive) flangeOps.lidAdditive = difference([flangeOps.lidAdditive, ...toLid]);
    ruggedOps.caseAdditive = ruggedOps.caseAdditive.map((op) => difference([op, ...padCuts]));
    ruggedOps.lidAdditive = ruggedOps.lidAdditive.map((op) => difference([op, ...toLid]));
  }
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

  // Issue #152 — magnet pockets and the swappable nameplate. Every list is
  // empty for a project with neither, so its plan is unchanged.
  const magnetOps = buildMagnetOps(
    board,
    caseParams,
    hats ?? [],
    resolveHat,
    display,
    resolveDisplay,
    project.customFonts ?? [],
  );
  // Issue #150 — the floor socket grid and its drop-in dividers. Both lists
  // are empty for a project with no enabled grid, so its plan is unchanged.
  const dividerOps = buildCaseDividerOps(project);

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
    ...latchOps.caseAdditive,
    ...ruggedOps.caseAdditive,
    ...(flangeOps.caseAdditive ? [flangeOps.caseAdditive] : []),
    ...boardSnapOps.caseAdditive,
    ...secondaryMountOps.caseAdditive,
    ...magnetOps.shellAdd,
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

  // Port cutouts double as ventilation keep-outs: vent cells too close to a
  // port opening can sever an island of wall into a loose part (QA: chevron
  // + Pi 4B front ports).
  const portCutOps = buildPortCutoutsForProject(smartLayout.ports, board, caseParams);
  const ventKeepOuts = portCutOps
    .map(aabbOfOp)
    .filter((b): b is Aabb => b !== null);

  // Ventilation cutters split by destination: top-surface vents pierce the
  // LID node (separate mesh below); side / bottom vents pierce the shell.
  // Pre-split they were all routed to the shell and top vents silently
  // dropped because the shell has no material at lid Z.
  const ventCuts = buildVentilationCutouts(board, caseParams, hats ?? [], resolveHat, display, resolveDisplay, ventKeepOuts);

  // Issue #107 — gasket channel cut into the rim top face (waterproof seal).
  const sealChannel = buildSealChannel(board, caseParams, hats ?? [], resolveHat, display, resolveDisplay);
  const customCutOps = buildCustomCutouts(caseParams.customCutouts, board, caseParams, hats ?? [], resolveHat, display, resolveDisplay);
  const cutoutOps: BuildOp[] = [
    ...portCutOps,
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
    ...customCutOps,
    ...magnetOps.shellCut,
    ...dividerOps.floorCut,
  ];

  // The shared clash pass (interiorClash.ts) — only for a case with magnets,
  // dividers or a connector, so every other project compiles exactly as before.
  const lidZ = lidDimsEarly.zPosition;
  const toWorld = (ops: BuildOp[]): BuildOp[] => ops.map((op) => translate([0, 0, lidZ], op));
  const magnetsOn = magnetOps.facts.pockets.length > 0;
  const dividersOn =
    caseParams.floorGrid?.enabled === true && (caseParams.dividers ?? []).some((d) => d.enabled);
  const baseLidOp = buildLid(board, caseParams, hats ?? [], resolveHat, display, resolveDisplay);
  const env = new ClashEnv();
  if (magnetsOn || dividersOn || connectorOn) {
    const enabledPorts = smartLayout.ports.filter((p) => p.enabled);
    env
      .addFeatures('board', () => {
        const o = cavityOriginXY(caseParams);
        const z = caseParams.floorThickness + board.defaultStandoffHeight;
        const pcb = board.pcb.size;
        const ops: BuildOp[] = [translate([o.x, o.y, z], cube([pcb.x, pcb.y, pcb.z]))];
        for (const c of board.components)
          ops.push(translate([o.x + c.position.x, o.y + c.position.y, z + c.position.z], cube([c.size.x, c.size.y, c.size.z])));
        return [featureOfOps('board', 'board', 'the board', ops)];
      })
      .add('standoff', 'standoffs', 'a board standoff', () => [
        ...bossOps,
        ...buildLidBosses(
          bossPlacements,
          lidZ,
          caseParams.floorThickness + board.defaultStandoffHeight + board.pcb.size.z + 0.3,
        ),
      ])
      .addFeatures('port', () =>
        enabledPorts.flatMap((p) => {
          const op = buildPortCutoutOp(p, board, caseParams);
          return op ? [featureOfOps(`port:${p.id}`, 'port', `the ${p.kind} cutout`, [op])] : [];
        }),
      )
      .add('latch', 'latches', 'a latch', () => [...latchOps.caseAdditive, ...latchOps.caseSubtract, ...latchOps.lidAdditive])
      .add('hinge', 'hinge', 'the hinge', () => [...hingeOps.caseAdditive, ...hingeOps.subtractive, ...toWorld(hingeOps.lidAdditive)])
      .add('lid', 'lid', 'the lid', () => toWorld([baseLidOp]))
      .add('lid-lip', 'lid-lip', "the lid's friction lip", () => {
        if (caseParams.joint !== 'snap-fit' || caseParams.snapType !== 'full-lid') return [];
        const lip = buildFullLidFrictionLip(board, caseParams, hats ?? [], resolveHat, display, resolveDisplay);
        return lip ? toWorld([lip]) : [];
      })
      .addFeatures('vent', () => {
        const floorTop = caseParams.floorThickness + 1.5;
        const bottom = ventCuts.shellCuts.filter((op) => (aabbOfOp(op)?.max[2] ?? Infinity) <= floorTop);
        const side = ventCuts.shellCuts.filter((op) => !bottom.includes(op));
        return [
          ...(bottom.length ? [featureOfOps('vents-bottom', 'vent', 'a bottom vent', bottom)] : []),
          ...(side.length ? [featureOfOps('vents-side', 'vent', 'a side vent', side)] : []),
        ];
      })
      .addFeatures('hat', () => {
        const baseZ = computeHatBaseZ(board, caseParams, hats ?? [], resolveHat);
        const host = boardFootprint(board, caseParams, display, resolveDisplay);
        const o = cavityOriginXY(caseParams);
        const out = [];
        for (const h of hats ?? []) {
          const prof = resolveHat(h.hatId);
          const z0 = baseZ.get(h.id);
          if (!prof || z0 === undefined || !h.enabled) continue;
          const pos = resolveMountingPosition(prof, h);
          const turned = pos.rotation === 90 || pos.rotation === 270;
          const w = turned ? prof.pcb.size.y : prof.pcb.size.x;
          const d = turned ? prof.pcb.size.x : prof.pcb.size.y;
          const cx = o.x + prof.pcb.size.x / 2 + pos.offset.x + (h.offsetOverride?.x ?? 0);
          const cy = o.y + prof.pcb.size.y / 2 + pos.offset.y + (h.offsetOverride?.y ?? 0);
          const tallest = prof.components.reduce((m, c) => Math.max(m, c.position.z + c.size.z), prof.pcb.size.z);
          const shapes = hatBeyondHost(
            { x0: cx - w / 2, y0: cy - d / 2, x1: cx + w / 2, y1: cy + d / 2 },
            host,
            z0,
            z0 + tallest,
          );
          if (shapes.length) out.push(feature(`hat:${h.id}`, 'hat', `the ${prof.name} board`, shapes));
        }
        return out;
      })
      .add('magnet', 'magnets', 'a magnet pocket', () => [
        ...magnetOps.shellAdd,
        ...magnetOps.shellCut,
        ...toWorld([...magnetOps.lidAdd, ...magnetOps.lidCut]),
      ])
      .add('nameplate', 'nameplate', 'the nameplate', () => (magnetOps.nameplate ? [magnetOps.nameplate.op] : []))
      .add('floor-grid', 'floor-grid', 'the floor grid', () => dividerOps.floorCut)
      .add('brim', 'brim', 'the alignment brim', () => [
        ...(flangeOps.caseAdditive ? [flangeOps.caseAdditive] : []),
        ...(flangeOps.lidAdditive ? toWorld([flangeOps.lidAdditive]) : []),
      ])
      .add('ribbing', 'ribbing', 'the rugged ribbing', () => [...ruggedOps.caseAdditive, ...toWorld(ruggedOps.lidAdditive)])
      .add('other', 'mounting', 'a mounting feature', () => [...featureOps.additive, ...featureOps.subtractive])
      .add('other', 'fan', 'a fan mount', () => [...fanOps.additive, ...fanOps.subtractive])
      .add('other', 'display', 'the display opening', () => [...displayOps.additive, ...displayOps.subtractive])
      .add('other', 'label', 'a label', () => [...textOps.additive, ...textOps.subtractive])
      .add('other', 'antenna', 'an antenna', () => antennaOps.subtractive)
      .add('other', 'snap', 'a snap catch', () => [...snapOps.shellAdd, ...snapOps.shellSubtract])
      .add('other', 'custom', 'a custom cutout', () => customCutOps)
      .add('other', 'board-snap', 'the board-snap clips', () => boardSnapOps.caseAdditive)
      .add('other', 'secondary', 'a secondary-board mount', () => secondaryMountOps.caseAdditive);
  }

  // Issue #149 — the stacking connector's sockets. Everything it returns is
  // empty when the project asks for no connector, and every splice below is
  // guarded, so an unconnected project's plan stays byte-identical.
  const connector = (() => {
    if (!connectorOn || !shellDimsEarly) {
      return buildStackConnector(undefined, { outerX: 0, outerY: 0, shellTop: 0, top: 0, wall: 0, cornerRadius: 0 });
    }
    const dims = shellDimsEarly;
    // The connector's keep-outs, named as its statements always have. Ports
    // are one feature so a socket on two ports says "a port cutout" once.
    const keepOuts = [
      featureOfOps('k:ports', 'port', 'a port cutout', portCutOps),
      featureOfOps('k:vents', 'vent', 'a vent', [...ventCuts.shellCuts, ...toWorld(ventCuts.lidCuts)]),
      featureOfOps('k:bosses', 'standoff', 'a board boss', bossOps),
      ...env.of('hinge', 'latch', 'brim', 'ribbing', 'magnet', 'nameplate', 'floor-grid', 'other'),
    ].filter((k) => k.shapes.length > 0);
    return buildStackConnector(
      caseParams.stackConnector,
      {
        outerX: dims.outerX,
        outerY: dims.outerY,
        shellTop: dims.outerZ,
        top: connectorTop,
        wall: caseParams.wallThickness,
        cornerRadius: caseParams.cornerRadius,
        caseFit: caseParams.fit,
      },
      keepOuts,
    );
  })();
  additive.push(...connector.shellAdd);
  cutoutOps.push(...connector.shellCut);

  // #854 item 2 — registration: a ridge on the lid's top and a groove in the
  // floor's underside, so a stack squares itself before any key goes in. The
  // ridge is in lid-local coordinates (the lid's own top); the groove is a
  // cutter in the case frame, where z = 0 is the floor's underside.
  const register = (() => {
    if (!stackRegisterWanted(caseParams.stackConnector)) return { ridge: null, groove: null };
    const dims = computeShellDims(board, caseParams, hats ?? [], resolveHat, display, resolveDisplay);
    const lidLocal = computeLidDims(board, caseParams, hats ?? [], resolveHat, display, resolveDisplay);
    const frame = {
      outerX: dims.outerX,
      outerY: dims.outerY,
      cornerRadius: caseParams.cornerRadius,
      wallThickness: caseParams.wallThickness,
      floorThickness: caseParams.floorThickness,
      lidTopZ: lidLocal.z,
    };
    return { ridge: buildStackRidge(frame), groove: buildStackGroove(frame) };
  })();
  if (register.groove !== null) cutoutOps.push(register.groove);

  let shellOp: BuildOp = additive.length > 1 ? union(additive) : shellOuter;
  if (cutoutOps.length > 0) {
    shellOp = difference([shellOp, ...cutoutOps]);
  }

  const nodes: BuildNode[] = [{ id: 'shell', op: shellOp }];

  // Issue #148 — a bolted split of the shell, for a project whose bed the shell
  // does not fit.
  //
  // The DECISION is made on every compile where the shell does not fit the bed
  // (footprint or height), and
  // reported as `splitOffer`; only the GEOMETRY is gated on `splitForPrint`.
  // That split exists because the two halves cost very different things: bounds
  // and seam placement are metadata arithmetic (`aabbOfOp` never evaluates
  // Manifold), while the cuts and their laps are real work. So the export modal
  // can offer the split the ENGINE can actually deliver — an offer derived from
  // "the shell is bigger than the bed" instead would appear whenever the box
  // overruns, including when every seam is blocked by the case's own board
  // bosses, and the user would tick a box that builds nothing.
  //
  // A SEALED shell is refused rather than warned about: the seam cuts the
  // gasket channel and gives away the drop resistance #107/#108 were for.
  //
  // The seam is kept out of the features a case would be ruined by cutting in
  // two — ports, vents, bosses, latches, hinges, snaps, displays, fan mounts.
  // Deliberately NOT keep-outs: the perimeter brim, the rugged ribs and feet,
  // and engraved labels. Every one of those spans a whole face, so a keep-out
  // built from its bounding box would forbid every seam there is; the seam
  // crosses them (as it must) and the user sees that in the preview.
  const splitPrinter = resolvePrinter(project);
  const shellBounds = splitPrinter ? aabbOfOp(shellOp) : null;
  let splitOffer: SplitOffer | undefined;
  let splitJoint: ShellJointPlan | null = null;
  if (shellBounds && splitPrinter) {
    const splitWidth = shellBounds.max[0] - shellBounds.min[0];
    const splitDepth = shellBounds.max[1] - shellBounds.min[1];
    const splitHeight = shellBounds.max[2] - shellBounds.min[2];
    const overBed = !rectFitsBed(splitWidth, splitDepth, splitPrinter.x, splitPrinter.y);
    // Height is reported on its own: a shell that fits the bed flat but is too
    // TALL is a problem the user would otherwise meet at the slicer, and no
    // seam can help it, so "split is not the answer" is exactly what they need
    // to hear.
    if (splitHeight > splitPrinter.z) {
      splitOffer = { state: 'tooTall' };
    } else if (overBed) {
      const keepOut: Aabb[] = [
        ...portCutOps,
        ...ventCuts.shellCuts,
        ...bossOps,
        ...latchOps.caseAdditive,
        ...hingeOps.caseAdditive,
        ...hingeOps.subtractive,
        ...latchOps.caseSubtract,
        ...snapOps.shellAdd,
        ...boardSnapOps.caseAdditive,
        ...secondaryMountOps.caseAdditive,
        ...featureOps.additive,
        ...displayOps.additive,
        ...displayOps.subtractive,
        ...fanOps.additive,
        ...fanOps.subtractive,
        ...assetOps.unionOps,
        ...magnetOps.shellAdd,
        ...magnetOps.shellCut,
        ...connector.shellAdd,
      ]
        .map(aabbOfOp)
        .filter((b): b is Aabb => b !== null);
      const request = {
        shellOp,
        bounds: shellBounds,
        printer: splitPrinter,
        keepOut,
      };
      if (!canSplitShell(caseParams.seal?.enabled === true)) {
        splitOffer = { state: 'sealed' };
      } else {
        // The plan is what the builder would work out anyway, so it is handed
        // over rather than recomputed.
        const joint = planShellJoint(request);
        if (joint && caseParams.splitForPrint === true) splitJoint = joint;
        if (!joint) {
          splitOffer = { state: 'blocked' };
        } else {
          const screwLabel = `${DEFAULT_SPLIT_SCREW}×${LUG_LAP * 2} socket cap`;
          splitOffer = {
            state: 'available',
            pieces: joint.pieces.length,
            screws: joint.screwCount,
            screwLabel,
          };
          if (caseParams.splitForPrint === true) {
            const split = buildShellSplit(request, joint);
            if (split) nodes.push(...split.nodes);
          }
        }
      }
    }
  }

  let lidOp = baseLidOp;
  // #854 item 2 — the registration ridge rides on the lid's top, in lid-local
  // coordinates exactly as the lid's other features are added.
  if (register.ridge !== null) lidOp = union([lidOp, register.ridge]);
  const lidDims = computeLidDims(board, caseParams, hats ?? [], resolveHat, display, resolveDisplay);
  // Issue #104 — top-position bosses fuse with the lid mesh, anchored to
  // the lid's WORLD underside Z. The buildLid result is in lid-local
  // coords (the translate([0,0,zPosition], …) below moves it into world).
  // To union the world-coord boss cylinders we have to translate them
  // BACK by lidDims.zPosition first, since the lid op gets translated UP
  // afterward.
  const lidUndersideWorldZ = lidDims.zPosition; // lid-local z=0 sits here
  // Issue #162 — lid-anchored bosses stop just above the board top, the same
  // anchor the #21 lid clamping posts use, so the board is clamped between
  // its floor standoff and the lid boss rather than floating.
  const lidBossBottomZ =
    caseParams.floorThickness + board.defaultStandoffHeight + board.pcb.size.z + 0.3;
  const lidBossOps = buildLidBosses(bossPlacements, lidUndersideWorldZ, lidBossBottomZ);
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
  // Issue #179 — `+z` text labels belong to the lid, not the shell. The
  // ops are already in lid-LOCAL coords (built against the lid's outer top
  // surface), so they join the lid op BEFORE the world-Z lift below.
  if (textOps.lidAdditive.length > 0) {
    lidOp = union([lidOp, ...textOps.lidAdditive]);
  }
  if (textOps.lidSubtractive.length > 0) {
    lidOp = difference([lidOp, ...textOps.lidSubtractive]);
  }
  // Issue #152 — magnet bosses and pockets in the lid, LID-LOCAL like the
  // `+z` text labels above.
  if (magnetOps.lidAdd.length > 0) {
    lidOp = union([lidOp, ...magnetOps.lidAdd]);
  }
  if (magnetOps.lidCut.length > 0) {
    lidOp = difference([lidOp, ...magnetOps.lidCut]);
  }
  // Groove cut into lid brim underside.
  if (flangeOps.lidSubtract) {
    lidOp = difference([lidOp, flangeOps.lidSubtract]);
  }
  // Issue #149 — the lid's share of a socket that spans the shell/lid seam.
  // Built in world coordinates, so shifted to lid-local like the latch parts.
  if (connector.lidAdd.length > 0) {
    const toLid = (op: BuildOp): BuildOp => translate([0, 0, -lidDims.zPosition], op);
    lidOp = difference([union([lidOp, ...connector.lidAdd.map(toLid)]), ...connector.lidCut.map(toLid)]);
  }
  // Issue #91 — lid is emitted at its ASSEMBLED Z position. The scene layer
  // (SceneMeshes) applies the exploded lift dynamically based on viewMode,
  // so toggling Complete / Exploded doesn't require a full recompile.
  nodes.push({
    id: 'lid',
    op: translate([0, 0, lidDims.zPosition], lidOp),
  });

  // #265 — THE LID'S OWN SPLIT, the same offer/report contract as the shell's
  // (#148): decided on every over-bed compile, built only when `splitForPrint`
  // is on. Planned in LID-LOCAL coordinates (the lid op as built), because the
  // keep-outs below are local; the pieces are lifted to the lid's assembled Z
  // exactly as the whole lid is, so they replace it in the scene.
  //
  // Keep-outs are the lid's LOCALISED features only: hinge knuckles, latch
  // strikers and snap arms. The gasket tongue, flange brim, vents, labels and
  // rugged ribs cross the whole lid and are NOT keep-outs — a seam must cross
  // them (the #148 rule), and a sealed lid is refused anyway.
  let lidSplitOffer: SplitOffer | undefined;
  if (splitPrinter) {
    const lidLocalBounds = aabbOfOp(lidOp);
    if (lidLocalBounds) {
      const lidW = lidLocalBounds.max[0]! - lidLocalBounds.min[0]!;
      const lidD = lidLocalBounds.max[1]! - lidLocalBounds.min[1]!;
      const lidHgt = lidLocalBounds.max[2]! - lidLocalBounds.min[2]!;
      const lidKeepOut: Aabb[] = [
        ...snapOps.lidAdd,
        ...hingeOps.lidAdditive,
        ...latchOps.lidAdditive.map((op) => translate([0, 0, -lidDims.zPosition], op)),
        ...lidBossOps.map((op) => translate([0, 0, -lidDims.zPosition], op)),
      ]
        .map(aabbOfOp)
        .filter((b): b is Aabb => b !== null);
      if (lidHgt > splitPrinter.z) {
        lidSplitOffer = { state: 'tooTall' };
      } else if (!rectFitsBed(lidW, lidD, splitPrinter.x, splitPrinter.y)) {
        const request = {
          lidOp,
          bounds: lidLocalBounds,
          printer: splitPrinter,
          side: lidJointSide(caseParams),
          cavityHeightMm: lidCavityHeight(caseParams),
          keepOut: lidKeepOut,
        };
        if (!canSplitLid(caseParams.seal?.enabled === true)) {
          lidSplitOffer = { state: 'sealed' };
        } else {
          const joint = planLidJoint(request);
          if (!joint) {
            lidSplitOffer = { state: 'blocked' };
          } else {
            lidSplitOffer = {
              state: 'available',
              pieces: joint.pieces.length,
              screws: joint.screwCount,
              screwLabel: `${DEFAULT_SPLIT_SCREW}×${LUG_LAP * 2} socket cap`,
            };
            if (caseParams.splitForPrint === true) {
              const split = buildLidSplit(request, joint);
              if (split !== null) {
                for (const n of split.nodes) {
                  nodes.push({ ...n, op: translate([0, 0, lidDims.zPosition], n.op) });
                }
              }
            }
          }
        }
      }
    }
  }

  // Issue #92 — print-in-place pin lives as its own top-level node so the
  // shell's cutoutOps difference can't drill it back out. Slicers print it
  // as a free body captured by the surrounding knuckles (the bore is wider
  // than the pin by knuckleClearance/2 + 0.1 mm of slop).
  if (hingeOps.pinNode) {
    nodes.push({ id: 'hinge-pin', op: hingeOps.pinNode });
  }

  // Issue #152 — the nameplate prints as its own part.
  if (magnetOps.nameplate) {
    nodes.push(magnetOps.nameplate);
  }

  // Issue #108 — gasket body is its own top-level node so the export
  // pipeline emits it as a separate STL (printed in TPU 95A, not the
  // case body's PLA/PETG). Issue #168 moved the "which node goes in its
  // own file" decision off the node id and onto `material.separateFile`:
  // the export path no longer hard-codes a special case, and the flag sits
  // on the node where the reason for it is.
  const gasketBody = buildGasketBody(board, caseParams, hats ?? [], resolveHat, display, resolveDisplay);
  if (gasketBody) {
    nodes.push({ id: 'gasket', op: gasketBody, material: { separateFile: true } });
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
  // Issue #149 — the connector keys print as their own flat parts.
  nodes.push(...connector.keyNodes);

  // Issue #150 — each divider is a free part, dropped into the finished case.
  for (const d of dividerOps.nodes) {
    nodes.push(d);
  }

  // The clash statements for magnets and dividers. Informational only: the
  // nodes above are already what gets built.
  const statements: ClashStatement[] = [];
  if (magnetsOn) {
    const sideEnv = env.of('board', 'standoff', 'latch', 'hinge', 'lid');
    statements.push(
      ...magnetClashStatements({
        facts: magnetOps.facts,
        lidZ,
        faceExtent: (face) => faceSizeForProject(project, face),
        origin: (source) => {
          if (source === 'nameplate') return caseParams.nameplate ? [caseParams.nameplate.u, caseParams.nameplate.v] : null;
          const m = (caseParams.magnetPockets ?? []).find((x) => x.id === source);
          return m ? [m.u, m.v] : null;
        },
        shellEnv: sideEnv,
        lidEnv: env.of('board', 'standoff', 'latch', 'hinge'),
        ports: env.of('port'),
      }),
    );
  }
  if (dividersOn) {
    const seams =
      splitJoint && shellBounds
        ? splitJoint.seams.map((seam) => {
            const b = shellBounds;
            const lo: [number, number, number] = [b.min[0], b.min[1], b.min[2]];
            const hi: [number, number, number] = [b.max[0], b.max[1], b.max[2]];
            lo[seam.axis] = seam.at - 0.5;
            hi[seam.axis] = seam.at + 0.5;
            const name = seam.axis === 0 ? 'X' : 'Y';
            return featureOfOps(
              `seam:${seam.axis}:${seam.at}`,
              'seam',
              `the split-for-print seam at ${name} ${Math.round(seam.at * 10) / 10} mm`,
              [translate(lo, cube([hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]]))],
            );
          })
        : [];
    statements.push(...dividerClashStatements(project, [...env.of('lid-lip', 'vent', 'hat'), ...seams]));
  }

  const placementReport = validatePlacements(project);
  return {
    nodes,
    placementReport,
    smartCutoutDecisions: smartLayout.decisions,
    splitOffer,
    ...(connector.report ? { connector: connector.report } : {}),
    ...(statements.length > 0 ? { clashes: { statements } } : {}),
    lidSplitOffer,
  };
}
