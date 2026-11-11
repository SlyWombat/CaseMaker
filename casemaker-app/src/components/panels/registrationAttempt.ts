/**
 * #919 baseline — `planRegistrationAttempt`, moved out of `EngraveSetupsSection.tsx` so that file
 * exports only its component (react-refresh/only-export-components). The logic is unchanged.
 *
 * Plan one setup's registration, or say why it cannot be planned.
 *
 * No number is invented here. The vise surface comes from the MEASURED jaw-top datum when the machine
 * has one (the normal path); the typed seat remains only as the expert override, and the bracket's
 * surface comes from the measured `bracket.seatMachineZ`. The bracket's datum, clamps and arms come
 * from the machine's own anchor and the shop defaults — `anchorFrom` / `bracketExpectedSurface`
 * refuse when the machine has not supplied them.
 */

import { jobMachine } from '@/engine/cnc/calibration';
import type { MachineCalibration } from '@/engine/cnc/calibration';
import { clearanceZOf } from '@/engine/cnc/machine';
import {
  anchorFrom,
  bracketDatum,
  bracketExpectedSurface,
  bracketSettings,
  type BracketSeatDatum,
} from '@/engine/cnc/mounts/bracket';
import type { MountDatum, ProbeSpec, RegistrationPlan } from '@/engine/cnc/registration/plan';
import { cutRegionOf, mountObstaclesFor } from '@/engine/cnc/registration/footprintJob';
import { cutBlankCandidates, cutBlankCandidatesFromMap, stockRaster, type CutProgramInput } from '@/engine/cnc/registration/cutBlank';
import type { FinishedCutMap } from '@/platform/locationClient';
import { cuttingDiameter } from '@/engine/cnc/tool';
import { resolveTool } from '@/engine/cnc/toolRegistry';
import { registrationSettings } from '@/engine/cnc/registration/settings';
import { summarizePlan } from '@/engine/cnc/registration/summary';
import { referenceOpenings, registrationFor, type MountSpec, type Setup } from '@/engine/cnc/setups';
import { holdUncertaintyFor } from '@/engine/cnc/registration/plan';
import { topTouchEdgeMarginsMm } from '@/engine/cnc/registration/cutBlank';
import type { ShopDefaults } from '@/platform/defaultsClient';
import type { EngraveJob } from '@/types/engraveJob';
import type { RegistrationAttempt } from './EngraveSetupRow';

/**
 * The stock the app models is a rectangular prism: its corners are square. The job carries no
 * corner radius, and the registration planner needs one, so this states the geometry rather than
 * inventing a measurement (decision 28).
 */
const STOCK_CORNER_RADIUS_MM = 0;

/** Millimetres to three decimals — the plans' own rounding. */
const r3 = (n: number): number => Math.round(n * 1000) / 1000;

function expectedWords(plan: RegistrationPlan): string {
  const z = `Z from the surface touch, within ±${plan.settings.surfaceToleranceMm} mm`;
  if (plan.bracketOrigin !== null) return `XY from the bracket (${plan.bracketOrigin.from}); ${z}`;
  if (plan.references !== undefined) return `X/Y from the earlier features; ${z}`;
  // #743 — a disc's four rim touches set the centre and read the diameter, so the word is not a
  // list of edges.
  if (plan.disc !== undefined) return `X/Y from the rim's four centre-line touches (centre, and the diameter checked); ${z}`;
  const edges = plan.scans.map((s) => s.edge);
  if (edges.length === 0) return z;
  return `X/Y re-checked on the ${edges.join(' and ')} edge${edges.length === 1 ? '' : 's'}; ${z}`;
}

/**
 * #1179 B — THE CHECK POINTS FOR A CUT BLANK. Only the programs of the SETUP BEING REGISTERED
 * (the analyst's scoping rule, 2026-11-10): a two-sided job's side-1 programs are in side 1's
 * frame, so their footprint and floors are not this face's. The package's cutting footprint grown
 * by each program's cutter radius + 1 mm + the probe tip's radius (the largest owned diameter + 1
 * when a cutter is unknown) and the part's placed silhouette, both from the job; the mount's
 * obstacles and a 3 mm edge margin are excluded. For a later setup the earlier setups' cuts are
 * unknown from this face, so nothing is claimed known there.
 */
function cutBlankCheckPoints(
  job: EngraveJob,
  plan: RegistrationPlan,
  largestOwnedDiameterMm: number,
  finishedHashes: readonly string[],
  setupIndex: number,
  blankMap: FinishedCutMap | null,
): { points: { x: number; y: number; depthMm: number }[]; earlierCutsKnown: boolean; floorsRestricted: string | null } {
  const raster = stockRaster(plan.stock);
  const fallbackRadiusMm = (Number.isFinite(largestOwnedDiameterMm) && largestOwnedDiameterMm > 0 ? largestOwnedDiameterMm : 0) / 2;
  const finished = new Set(finishedHashes);
  const programs: CutProgramInput[] = (job.package?.programs ?? [])
    .filter((program) => (program.frame ?? 'flat') === 'flat')
    .filter((program) => program.setupIndex === setupIndex)
    .map((program) => {
      const tool = resolveTool(program.toolKey);
      const diameter = tool === null ? null : cuttingDiameter(tool);
      return {
        nc: program.nc,
        cutterRadiusMm: diameter === null ? fallbackRadiusMm : diameter / 2,
        finished: finished.has(program.hash),
        // Only a FLAT end mill leaves a flat floor; an unnameable cutter is never trusted flat.
        shape: tool?.shape ?? 'unknown',
      };
    });
  // #1179 stage 2 — THE BLANK'S OWN MAP WINS WHEN IT IS COMPLETE. It is the measured state of
  // THIS face (per setup), at its stored pitch; the package raster below is the fallback for a
  // blank with no id or an `unknown` map (the unknown-cuts footprint path).
  const probe = {
    tipRadiusMm: plan.settings.tipRadiusMm,
    tipLengthMm: plan.probe?.tipLengthMm ?? null,
    bodyDiameterMm: plan.probe?.bodyDiameterMm ?? null,
    // #1200 — the unit's stated lateral uncertainty, so a top touch keeps clear of the edges.
    tipLateralUncertaintyMm: plan.probe?.tipLateralUncertaintyMm ?? null,
  };
  const obstacles = plan.mountObstacles.map((o) => ({ min: o.min, max: o.max }));
  // #1199 field 7 — the shared inset's two inputs, from the plan; absent is refused by the caller.
  const shrinkMm = plan.settings.probeFootprintShrinkMm ?? Number.NaN;
  const holdUncertainty = plan.holdUncertainty as { xMm: number; yMm: number };
  if (blankMap !== null) {
    const fromMap = cutBlankCandidatesFromMap({ map: blankMap, probe, obstacles, shrinkMm, holdUncertainty });
    if (fromMap !== null) {
      return { points: fromMap.points, earlierCutsKnown: true, floorsRestricted: fromMap.floorsRestricted };
    }
    // A map that does not decode is not trusted: the unknown-cuts path, never a half-read map.
    return {
      ...cutBlankCandidates({ raster, programs, probe, fallbackRadiusMm, obstacles, earlierCutsUnknown: true, shrinkMm, holdUncertainty }),
      earlierCutsKnown: false,
    };
  }
  return cutBlankCandidates({
    raster,
    programs,
    shrinkMm,
    holdUncertainty,
    probe: {
      tipRadiusMm: plan.settings.tipRadiusMm,
      tipLengthMm: plan.probe?.tipLengthMm ?? null,
      bodyDiameterMm: plan.probe?.bodyDiameterMm ?? null,
      // #1200 — the same top-touch floor on the raster fallback path.
      tipLateralUncertaintyMm: plan.probe?.tipLateralUncertaintyMm ?? null,
    },
    fallbackRadiusMm,
    obstacles: plan.mountObstacles.map((o) => ({ min: o.min, max: o.max })),
    // A later setup: earlier setups' cuts are not recorded for this face.
    earlierCutsUnknown: setupIndex > 1,
  });
}

export function planRegistrationAttempt(args: {
  job: EngraveJob;
  setup: Setup;
  mount: MountSpec;
  mountDatum: MountDatum | null;
  /** #611 — the datum's `by` when it names a probe other than the one checked out (null otherwise). */
  mountDatumMismatch: string | null;
  /** #640 — the same probe, by NAME, for the sentence (the id stays for the wiring). */
  mountDatumMismatchName: string | null;
  /** #619 — the measured surface-top datum; when present the plan expects the found top, not the ledge estimate.
   *  #1189 — with the probe's reference it was measured at. */
  surfaceTopZ: { value: number; probeRefZ?: number | null } | null;
  /** #509 — the active bed profile's seat beside the bracket (its bracket seat, else its surface top). */
  bracketSeat: BracketSeatDatum | null;
  /**
   * #1070 (C8) — the active bed profile's PLACEMENT SEED for a placed bracket (its inside corner,
   * machine XY, and where the statement came from), or null when the profile states none. Read
   * with `bracketPlacementSeedFor`; ignored by the anchored path.
   */
  placedSeed?: { x: number; y: number; by: 'grid' | 'touch'; measuredAt: string; at: [number, number] | null; probe: string | null } | null;
  probe: ProbeSpec | null;
  /** #603 — the checked-out probe's display name (its product), or null when none is checked out. */
  probeName: string | null;
  /** #599 — the mount tap point (machine XY), or null when the fixed jaw's frame is unknown. */
  mountTap: { x: number; y: number; fromMachineZ: number; label: string } | null;
  defaults: ShopDefaults | null;
  calibration: MachineCalibration | undefined;
  settings: ReturnType<typeof registrationSettings>['settings'];
  /**
   * #1179 B — THIS BLANK HAS BEEN CUT (a finished record on this machine, or the operator says it
   * is not fresh): the bracket's plan carries check points instead of one touch at the cut centre.
   */
  cutBlank?: boolean;
  /**
   * #1179 B — the largest owned cutter's diameter, mm: the growth a program's unknown cutter takes
   * (its radius is half this), per the analyst's ruling.
   */
  largestOwnedDiameterMm?: number;
  /**
   * #1179 stage 2 — THE BLANK'S OWN CUT MAP for the setup being registered, when the record has a
   * `complete` entry for it. The candidates come from the map at its stored pitch; absent, the
   * package footprint's unknown-cuts path runs exactly as before.
   */
  cutBlankMap?: FinishedCutMap | null;
  /**
   * #1179 B — the machine's finished-program hashes (`finishedProgramsFor(target)`): a program of
   * THIS package that is among them is finished, and only finished programs' floors are known.
   */
  finishedHashes?: readonly string[];
  /**
   * #1179 B — the 1-based setup being registered, in the frozen programs' own `setupIndex`
   * numbering. Only that setup's programs are this face's known cuts; a later setup's earlier
   * cuts are not recorded for this face (the analyst, 2026-11-10). Defaults to 1.
   */
  setupIndex?: number;
}): RegistrationAttempt {
  const { job, setup, mount, defaults, calibration } = args;
  // #934 — REGISTRATION FROM EARLIER FEATURES is one of the branches the bench has not run; it is
  // refused by name, not crashed on and not planned as if it were the datum path.
  if (referenceOpenings(setup).openings.length > 0) {
    return {
      kind: 'refused',
      reason: 'registration from earlier features has not been run on this machine yet — register from the fixed jaw and the front edge instead',
    };
  }
  // #934 — THE BRANCHES THE BENCH HAS NOT RUN are refused HERE, at the operator seam, not inside
  // the pure planner: the engine's own specs are the regression suite for the code we keep, and
  // the operator path cannot reach these inputs once this refuses them.
  // #1200 — a 3D unit RESTRICTED TO TOP TOUCHES is a registration instrument: it plans the
  // Z-only routine the wired V2 gets, so nothing about the bench's unrun side-touch branch is
  // reached. An UNRESTRICTED 3D unit stays refused by name (that branch has not been run).
  if (args.probe?.instrument === 'xyz' && args.probe.touches !== 'z-only') {
    return {
      kind: 'refused',
      reason:
        'the 3D probe is not a registration instrument on this machine yet — restrict it to top touches in Manage › Accessories, or fit the wired V2 probe and register again',
    };
  }
  if (job.stock.shape === 'disc') {
    return {
      kind: 'refused',
      reason: 'a disc’s rim registration has not been run on this machine yet — use a rectangular blank',
    };
  }
  // tape registration is hidden (refused by name); a BRACKET job registers on its cut region's
  // footprint (#1070 — the maintainer's rule: find the edges of where it will cut, not the blank's).
  const mountKind: MountSpec['kind'] = mount.kind;
  if (mountKind !== 'vise') {
    if (mountKind === 'tape') {
      return { kind: 'refused', reason: 'registration on tape has not been run on this machine yet — hold the blank in the vise' };
    }
    // #1070 — THE FOOTPRINT PLAN, from the job: two touches per bounding edge at the cut region's
    // extents, the far edges once each, one Z touch per region corner, every position in machine
    // coordinates checked against the soft endstop before a line is sent. The seed places the
    // machine coordinates; the touches derive the origin.
    //
    // A PLACED bracket (6b's ruling, C8) takes its seed from the ACTIVE BED PROFILE's placement of
    // the bracket — a fact of the bench, shared by every job until someone moves it — never from
    // the anchor it is not on. A profile that states none refuses by name, pointing at where the
    // statement lives. The field lives on land7's BracketHold; read it defensively.
    const placed = job.workholding.kind === 'bracket' && (job.workholding.bracket as { placement?: 'anchored' | 'placed' }).placement === 'placed';
    const sizes = bracketSettings(defaults);
    let datum: { x: number; y: number; from: string; offsetMeasured: boolean };
    if (placed) {
      const seed = args.placedSeed ?? null;
      if (seed === null) {
        return {
          kind: 'refused',
          reason:
            'this bracket is screwed down where you put it, and the active bed profile does not state where — ' +
            'measure the bracket’s position into the bed profile’s placement (its five holes on the bed’s hole grid, or one confirmed touch), ' +
            'or put it on the anchor-1 pins',
        };
      }
      datum = {
        x: seed.x,
        y: seed.y,
        from: seed.by === 'grid' ? 'the bed’s hole grid at the bracket’s five holes — the one position the grid admits' : 'the position measured and confirmed in the bed profile’s placement',
        offsetMeasured: seed.by === 'touch',
      };
    } else {
      const anchor = anchorFrom(calibration, job.machineId);
      if (!anchor.ok) return { kind: 'refused', reason: anchor.reason };
      datum = bracketDatum(anchor.anchor, sizes);
    }
    const obstacles = mountObstaclesFor(job, mount, sizes);
    // 6b's ruling (#1070) — THE FIRST BRACKET SEAT IS MEASURED BY THE PROGRAM: when the house has
    // no seat datum (and no legacy default), the press plans ONE bounded Z seek with the wired V2
    // on open wasteboard beside the blank (chosen clear of the head); its reading is written as the bed profile's
    // `bracketSeatZ` and mirrored to the shop default. The band is the 2026-11-07-derived seat,
    // VERIFIED by the seek.
    const dims0 = { x: job.stock.length, y: job.stock.width, z: job.stock.thickness };
    const under0 = mount.board === true ? (job.sacrificial?.under?.thickness ?? 0) : 0;
    const expected0 = bracketExpectedSurface(defaults, dims0.z, under0, args.bracketSeat);
    // #1189 — A DATUM MEASURED BEFORE THE PROBE WAS LAST FITTED IS NOT TRUSTED ACROSS THE REFIT.
    // The seat is a raw machine Z: a probe refitted (the bench, 2026-11-10) makes every surface
    // trigger by the seating difference, so the old number can stop a good blank or accept a
    // wrong one. The card does NOT plan the registration touch on it: it asks for the SEAT to be
    // measured again — the same one-touch seat-seek plan a machine with no seat gets — and that
    // press writes the seat with the probe's reference, after which registration plans normally.
    // #1201 — NO TRUSTED SEAT IS NOT A BLOCKER. A seat measured before the probe's last fitting
    // (#1189) is not used for the band; the top is measured ON THE BLANK, as the vendor does. The
    // seat itself is a BED-SETUP datum now (Manage > the machine's bed, with the bed clear); the
    // Register card never offers that touch.
    const trustedSeat = expected0.ok && expected0.expectedSurface.probeRefZ !== null;
    if (!trustedSeat) {
      // The bed's known floor: the seat on file if any (even a legacy one — as a FLOOR it can only
      // stop the seek early, never certify a top), else the bed's surface top, else the machine's
      // own work floor. The seek accepts contact anywhere above floor + margin.
      const floorDatum =
        args.bracketSeat !== null
          ? args.bracketSeat.value
          : args.surfaceTopZ !== null
            ? args.surfaceTopZ.value
            : jobMachine(job, calibration).envelope.z.min;
      const marginMm = 1;
      const clearance = clearanceZOf(jobMachine(job, calibration)) ?? 0;
      const floorMin = r3(floorDatum + marginMm);
      const ceiling = r3(clearance - args.settings.parkAboveSurfaceMm);
      if (!Number.isFinite(clearance) || !(floorMin < ceiling)) {
        return {
          kind: 'refused',
          reason: 'the machine’s clearance does not bound a top seek above the bed — check the machine frame, then register again',
        };
      }
      // The GUARDED seek's bound is the floor itself, not the expected-top seek's travel cap: the
      // probe is over the stock and stops on contact; the floor only stops a missing blank. The
      // card states the floor, so a long descent is a stated one.
      // THE TWO TOUCH POINTS, both INSIDE the stock footprint (the #1199 guard's rule): the
      // machining area's path-origin corner, inset by the edge margin + the probe tip, and the
      // area's centre. The area is the cut region when the job states one, else the blank.
      const region = cutRegionOf(job);
      const area = region ?? { minX: 0, minY: 0, maxX: dims0.x, maxY: dims0.y };
      // #1199 field 7 — THIS GUARDED TOUCH'S INSET IS THE SHARED ONE, per axis: the tip radius, the
      // unit's lateral uncertainty and the HOLD's placement uncertainty, floored by the registry
      // shrink; the job's edge margin is an extra term. The old `max(1, tip + edgeMargin)` let a
      // touch sit closer to an edge than the guard would allow.
      const guardedHold = holdUncertaintyFor({
        mount: 'bracket',
        settings: args.settings,
        stock: { xMin: 0, yMin: 0, xMax: dims0.x, yMax: dims0.y, cornerRadius: 0 },
      });
      const guardedFloor = args.settings.probeFootprintShrinkMm;
      if (guardedHold === null || guardedFloor === undefined) {
        return {
          kind: 'refused',
          reason:
            'the hold’s placement uncertainty is not stated for this machine, so a guarded top touch cannot be placed — ' +
            'state the bracket fit (and the placement keys) and plan again',
        };
      }
      const guardedMargins = topTouchEdgeMarginsMm(
        { tipRadiusMm: args.settings.tipRadiusMm, tipLateralUncertaintyMm: args.probe?.tipLateralUncertaintyMm ?? 0 },
        { floorMm: guardedFloor, hold: guardedHold },
      );
      const insetX = Math.max(job.edgeMargin, guardedMargins.xMm);
      const insetY = Math.max(job.edgeMargin, guardedMargins.yMm);
      const ix = Math.min(insetX, Math.max(0.001, (area.maxX - area.minX) / 2));
      const iy = Math.min(insetY, Math.max(0.001, (area.maxY - area.minY) / 2));
      const clampToStock = (x: number, y: number): { x: number; y: number } => ({
        x: r3(Math.min(Math.max(x, 0.001), dims0.x - 0.001)),
        y: r3(Math.min(Math.max(y, 0.001), dims0.y - 0.001)),
      });
      const originPoint = clampToStock(area.minX + ix, area.minY + iy);
      let centrePoint = clampToStock((area.minX + area.maxX) / 2, (area.minY + area.maxY) / 2);
      if (Math.abs(centrePoint.x - originPoint.x) < 1 && Math.abs(centrePoint.y - originPoint.y) < 1) {
        centrePoint = clampToStock(originPoint.x + Math.min(1, (dims0.x - originPoint.x) / 2), originPoint.y);
      }
      // The plan's frame comes from the ordinary builder with the floor as a NOMINAL seat (its
      // expected surface is discarded below); the guarded band and the checks are this branch's.
      const bracketHold = guardedHold ?? undefined;
      const built = registrationFor(
        setup,
        mount,
        {
          // #1199 field 7 — the hold's own placement uncertainty.
          holdUncertainty: bracketHold,
          // #1201 — THE GUARDED CONTRACT: no expected surface, a floor and a margin.
          guarded: { floorMachineZ: r3(floorDatum), marginMm, seatIgnored: args.bracketSeat !== null ? 'legacy' : 'absent' },
          seekFromMachineZ: clearance,
          cornerRadius: 0,
          bracketOrigin: datum,
          mountObstacles: obstacles,
          mountTap: null,
          probe: args.probe,
          cutCentre: { x: centrePoint.x, y: centrePoint.y },
        },
        args.settings,
      ).plan;
      if (!built.ok) return { kind: 'refused', reason: built.reason };
      const seatIgnored: 'legacy' | 'absent' = args.bracketSeat !== null ? 'legacy' : 'absent';
      const seatWord =
        seatIgnored === 'legacy'
          ? 'the seat on file was measured before the probe’s last fitting and is not used'
          : 'the bed states no seat';
      const plan: RegistrationPlan = {
        ...built.plan,
        surfacePoint: originPoint,
        surfaceChecks: [
          { x: originPoint.x, y: originPoint.y, depthMm: 0 },
          { x: centrePoint.x, y: centrePoint.y, depthMm: 0 },
        ],
        mountTap: null,
        notes: [
          ...built.plan.notes,
          `${seatWord}; the top is measured on the blank at two points, and the bed’s floor at machine Z ${r3(floorDatum)} bounds the seek`,
        ],
      };
      return {
        kind: 'plan',
        method: 'bracket',
        plan,
        summary: summarizePlan(plan),
        expected: 'the top on the blank, from two touches that must agree',
      };
    }
    // #1133 — THE PLAN IS THE SURFACE TOUCH. A bracket hold fixes X, Y and rotation (repeat
    // 0.05 mm, fit 0.1 mm), so with the seat measured there is nothing to find: no edge scans, no
    // corner derivation, and no mount tap (the seat datum the profile holds IS the reference — a
    // tap would re-measure it). #1070's footprint find was the vise's kind of plan.
    // #1133 review — the ONE touch is at the CUT AREA'S centre, not the blank's (the bench job's
    // is (77.34, 63)): the region's own centre, when the job states a region.
    const region = cutRegionOf(job);
    // #1199 field 7 — this branch shares the bracket's hold figure.
    const bracketHold2 = holdUncertaintyFor({
      mount: 'bracket',
      settings: args.settings,
      stock: { xMin: 0, yMin: 0, xMax: dims0.x, yMax: dims0.y, cornerRadius: 0 },
    }) ?? undefined;
    const result = registrationFor(
      setup,
      mount,
      {
        ...(region === null ? {} : { cutCentre: { x: (region.minX + region.maxX) / 2, y: (region.minY + region.maxY) / 2 } }),
        // `registrationFor` adds the stock's height this way up to the seat; take it back off the
        // expected surface so the two statements cannot drift.
        seatMachineZ: expected0.expectedSurface.machineZ - dims0.z,
        // #1189 — the seat datum's reference, so the executor corrects the band once the probe's
        // M491 is known (the bench's refit shift).
        seatProbeRefZ: expected0.expectedSurface.probeRefZ,
        seatProbeRefLabel: 'the seat',
        holdUncertainty: bracketHold2,
        seekFromMachineZ: clearanceZOf(jobMachine(job, calibration)) ?? 0,
        cornerRadius: 0,
        bracketOrigin: datum,
        mountObstacles: obstacles,
        mountTap: null,
        probe: args.probe,
      },
      args.settings,
    ).plan;
    if (!result.ok) return { kind: 'refused', reason: result.reason };
    // #1179 B — A CUT BLANK MEASURES ITS TOP ON WOOD THAT IS STILL THERE. The check points come
    // from the package's own cutting footprint (a flat floor's depth is known and the executor
    // compares implied tops); no point at all keeps today's single touch, whose miss then offers
    // the bracket's own top — the derived path, the last resort.
    if (args.cutBlank === true && result.plan.holdUncertainty === undefined) {
      return {
        kind: 'refused',
        reason:
          'the hold’s placement uncertainty is not recorded for this plan, so a top touch cannot be placed on the blank — ' +
          'set the hold’s figure (its placement keys) and plan again',
      };
    }
    const checks =
      args.cutBlank === true
        ? cutBlankCheckPoints(job, result.plan, args.largestOwnedDiameterMm ?? 0, args.finishedHashes ?? [], args.setupIndex ?? 1, args.cutBlankMap ?? null)
        : { points: [], earlierCutsKnown: true, floorsRestricted: null };
    const plan =
      checks.points.length === 0
        ? result.plan
        : {
            ...result.plan,
            surfaceChecks: checks.points,
            ...(checks.earlierCutsKnown ? {} : { surfaceChecksUnknown: true as const }),
            ...(checks.floorsRestricted === null ? {} : { surfaceChecksProbeNote: checks.floorsRestricted }),
          };
    return {
      kind: 'plan',
      method: 'bracket',
      plan,
      summary: summarizePlan(plan),
      expected: expectedWords(plan),
    };
  }
  // #845 — a stated machine has no clearance to seek from; the preview it places a tap with is
  // only run where a connected Makera machine exists, and the 0 is never used to place a touch.
  const seekFromMachineZ = clearanceZOf(jobMachine(job, calibration)) ?? 0;
  let input: Parameters<typeof registrationFor>[2];

  // #1133 — the old #607 bracket branch that stood here (its front-arm tap and edge scans) was
  // unreachable: every bracket mount returns from the branch above. It is gone with the edge finds
  // it carried; `bracketRegistration1133.spec.ts` pins that a bracket plan has no scans.
  if (mount.kind === 'vise' && args.mountDatum !== null) {
    // #598 — the datum path: no seat input; the surface is the measured jaw top + the stock's proud
    // height (`registrationFor` works it out), and the probe is carried for the record. #599 — the
    // mount tap needs the fixed jaw's machine XY; without a frame there is nothing to tap.
    if (args.mountTap === null) {
      return { kind: 'refused', reason: 'place the vise, or register once from the fixed jaw, so the app knows where it is' };
    }
    // #1189 — a datum measured before the probe was last fitted cannot anchor the band. The
    // surface top is the expected top when present; the jaw top is the seek's floor and ceiling
    // datum, so BOTH have to carry a reference. Ask for the one-touch re-measure and stop.
    if (args.surfaceTopZ !== null && args.surfaceTopZ.probeRefZ == null) {
      return {
        kind: 'refused',
        reason:
          'the surface top on file was measured before the probe was last fitted, so it cannot anchor a surface band now — ' +
          'measure it again with the probe as it sits (Manage › the machine › Run a surface registration), then register again',
      };
    }
    if (args.mountDatum.probeRefZ == null) {
      return {
        kind: 'refused',
        reason:
          'the jaw top on file was measured before the probe was last fitted, so it cannot bound the surface seek now — ' +
          'tap the fixed jaw again with the probe as it sits (Manage › the machine › Tap the fixed jaw), then register again',
      };
    }
    input = {
      seekFromMachineZ,
      cornerRadius: STOCK_CORNER_RADIUS_MM,
      mountDatum: args.mountDatum,
      surfaceTopZ: args.surfaceTopZ,
      probe: args.probe,
      mountTap: args.mountTap,
      // #1199 field 7 — the vise's own placement uncertainty, across and along the jaws.
      holdUncertainty:
        holdUncertaintyFor({
          mount: 'vise',
          settings: args.settings,
          // A vise's figure is its across/along terms; the stock box is not consulted.
          stock: { xMin: 0, yMin: 0, xMax: 0, yMax: 0, cornerRadius: 0 },
        }) ?? undefined,
    };
  } else {
    // The vise with no measured jaw-top datum: THE TAP IS THE PROCEDURE (#934 hides the typed-seat
    // override, so there is no other path to a seat here).
    // #611 — a datum tapped by a probe other than the one now checked out names which probe tapped
    // it and offers the tap with the current probe; an absent datum keeps the plain ask.
    if (args.mountDatumMismatch !== null) {
      const current = args.probeName !== null ? `the ${args.probeName} now checked out` : 'the probe now checked out';
      return {
        kind: 'need-datum',
        message: `the jaw top was tapped by ${args.mountDatumMismatchName}, not ${current} — tap the fixed jaw with the current probe first`,
        mountTap: args.mountTap,
      };
    }
    return {
      kind: 'need-datum',
      message: 'tap the jaw first — run the registration: its first touch is that tap',
      mountTap: args.mountTap,
    };
  }

  // #743 D-2 — the disc wiring stays in the planner; #934 refuses a disc at the top of this
  // function, so the operator path never reaches the rim routine.

  const result = registrationFor(setup, mount, input, args.settings).plan;
  if (!result.ok) return { kind: 'refused', reason: result.reason };
  return {
    kind: 'plan',
    method: mount.kind,
    plan: result.plan,
    summary: summarizePlan(result.plan),
    expected: expectedWords(result.plan),
  };
}
