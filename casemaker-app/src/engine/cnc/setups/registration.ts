/**
 * Registration after a remount (#428 → #430): the #430 planner's input for a setup's up face, and the
 * features cut in earlier setups that pass through to it — candidate references (#429).
 *
 * The EXPECTED SURFACE is the caller's to state (#430: never G54 Z): this takes the machine Z of what
 * the stock SITS on — the vise's ledge, the board's top — and adds the stock's height this way up.
 * `seekFromMachineZ` is likewise the caller's: the resolved machine's `toolChange.clearanceZ`, the
 * height the probe seeks from and the bound nothing may stand above (`plan.ts`). It is REQUIRED — a
 * forgotten one would let a clamp reach the travel height unnoticed.
 */

import { LEDGE_STEP } from '../fixture';
import { planReferences, planRegistration, type BracketOrigin, type MountDatum, type PlanObstacle, type PlanResult, type ProbeSpec, type ReferenceOpening, type RegistrationSettings } from '../registration';
import { machineSize, toMachine, type Vec } from './orient';
import type { MountSpec, Setup } from './types';

export interface ReferenceFeature {
  itemId: string;
  name: string;
  /** Its centre in the new setup's work XY (origin at the stock's front-left corner as mounted). */
  at: { x: number; y: number };
}

/** Earlier cuts that open to BOTH an earlier face and this up face — through features visible now. */
export function referenceFeatures(setup: Setup): ReferenceFeature[] {
  const b = setup.stockBefore.bounds;
  return setup.stockBefore.cuts
    .filter((c) => c.opensTo.includes(setup.faceUp) && c.opensTo.length > 1)
    .map((c) => {
      const centre: Vec = [0, 1, 2].map((i) => (c.box.min[i]! + c.box.max[i]!) / 2) as Vec;
      const p = toMachine(setup.rotation, b, centre);
      return { itemId: c.id, name: c.name, at: { x: Math.round(p[0] * 1000) / 1000, y: Math.round(p[1] * 1000) / 1000 } };
    });
}

/** #513 — the surface's own words, for the sentence that names where a datum was measured. */
const SURFACE_WORD: Readonly<Record<string, string>> = {
  'bare-bed': 'the bare bed',
  wasteboard: 'the wasteboard',
  'fixture-plate': 'the fixture plate',
  'vacuum-bed': 'the vacuum bed',
};

/** #598 — the surface the stock's top is expected at: the datum's jaw top + proud, or the seat + height. */
function expectedSurface(
  setup: Setup,
  dims: { x: number; y: number; z: number },
  datum: MountDatum | null,
  surfaceTopZ: { value: number; measuredAt?: string; surface?: string; probeRefZ?: number | null } | null,
  seatMachineZ: number | undefined,
  seatProbeRefZ: number | null,
  seatProbeRefLabel: string | null,
): {
  machineZ: number;
  from: string;
  /** #1189 — the datum reference the expected Z was computed at, and its words. */
  probeRefZ: number | null;
  probeRefLabel: string | null;
  /** #1189 — the jaw datum's own reference when the seek's floor comes from it (surface top above). */
  floorProbeRefZ: number | null;
} {
  // #619 — a measured surface top beats the ledge estimate: the next plan expects the top that was
  // actually found, not `jawTop + (thickness − ledgeStep)`.
  // #513 — and the sentence names the DATUM: the bed profile's surface top, which surface it was
  // taken on, and the day (a machine Z without its date is a claim about the wrong morning).
  if (surfaceTopZ !== null) {
    const on = surfaceTopZ.surface === undefined ? null : (SURFACE_WORD[surfaceTopZ.surface] ?? null);
    const day = surfaceTopZ.measuredAt === undefined ? null : surfaceTopZ.measuredAt.slice(0, 10);
    return {
      machineZ: surfaceTopZ.value,
      from:
        `the bed profile’s surface top${on === null ? '' : ` on ${on}`} at machine Z ${surfaceTopZ.value}` +
        `${day === null ? '' : `, measured ${day}`} (setup ${setup.index})`,
      probeRefZ: surfaceTopZ.probeRefZ ?? null,
      probeRefLabel: 'the surface top',
      // The floor is the jaw's when a jaw datum is under the surface (#1189: its own reference).
      floorProbeRefZ: datum === null ? null : (datum.probeRefZ ?? null),
    };
  }
  if (datum !== null) {
    return {
      machineZ: datum.jawTopZ + (dims.z - LEDGE_STEP),
      from: `the measured jaw top at machine Z ${datum.jawTopZ} + the stock's ${dims.z - LEDGE_STEP} mm proud (setup ${setup.index})`,
      probeRefZ: datum.probeRefZ ?? null,
      probeRefLabel: 'the jaw top',
      floorProbeRefZ: datum.probeRefZ ?? null,
    };
  }
  return {
    machineZ: (seatMachineZ ?? NaN) + dims.z,
    from: `the seat at machine Z ${seatMachineZ} + the stock's ${dims.z} mm this way up (setup ${setup.index})`,
    probeRefZ: seatProbeRefZ,
    probeRefLabel: seatProbeRefLabel,
    floorProbeRefZ: null,
  };
}

export function registrationFor(
  setup: Setup,
  mount: MountSpec,
  input: {
    /** Vise/tape, legacy expert path: the machine Z of the surface the stock sits on. Absent on the datum path. */
    seatMachineZ?: number;
    /** The resolved machine's `toolChange.clearanceZ`: the seek height, and the bound nothing may exceed. */
    seekFromMachineZ: number;
    cornerRadius: number;
    /** Vise (#598): the measured jaw-top datum; the expected surface is `jawTopZ + (dims.z − LEDGE_STEP)`. */
    mountDatum?: MountDatum | null;
    /** #619 — the measured surface-top datum; when present it beats the ledge estimate for the expected surface.
     *  #513 — it also carries the surface it was taken on and the day, for the sentence.
     *  #1189 — and the probe reference it was measured at. */
    surfaceTopZ?: { value: number; measuredAt?: string; surface?: string; probeRefZ?: number | null } | null;
    /**
     * #1189 — the reference of the datum behind `seatMachineZ` (the bracket's measured seat), and
     * its words in the correction sentence. Null/absent when the expectation has no datum.
     */
    seatProbeRefZ?: number | null;
    seatProbeRefLabel?: string | null;
    /** The checked-out probe, carried on the plan for the record. */
    probe?: ProbeSpec | null;
    /** #599 — the mount tap point (machine XY), computed by the caller from the bed placement. */
    mountTap?: { x: number; y: number; fromMachineZ: number; label: string } | null;
    /** #1133 — where the surface touch should land, work XY: the cut area's centre. */
    cutCentre?: { x: number; y: number };
    /**
     * #1201 — a GUARDED top seek: no expected surface. The band is the bed's floor + margin to the
     * machine's clearance less the park height; the plan's checks prove the reading.
     */
    guarded?: { floorMachineZ: number; marginMm: number; seatIgnored?: 'legacy' | 'absent' };
    bracketOrigin?: BracketOrigin;
    /** Bracket (#427): the clamps and arms as placed, and whether to take the confirming touch. */
    mountObstacles?: PlanObstacle[];
    bracketConfirm?: boolean;
    /**
     * #743 D-2 — the stock is a disc and this is its stated diameter: the plan scans all four rim
     * edges through the centre-lines instead of the rectangle's one-sided edges.
     */
    disc?: { diameterMm: number };
    /** #1199 field 7 — the hold's own placement uncertainty, resolved by the caller. */
    holdUncertainty?: import('../registration/plan').HoldPlacementUncertainty;
  },
  settings: RegistrationSettings,
): { plan: PlanResult; references: ReferenceFeature[] } {
  const dims = machineSize(setup.rotation, setup.stockBefore.bounds);
  const datum = mount.kind === 'vise' ? (input.mountDatum ?? null) : null;
  // #1201 — a guarded plan has no expected surface; the placeholder is never read (the band comes
  // from `guarded`), and NaN keeps a caller that forgets from silently planning a wrong band.
  const expected =
    input.guarded !== undefined
      ? { machineZ: Number.NaN, from: 'the top on the blank (guarded)', probeRefZ: null, probeRefLabel: null, floorProbeRefZ: null }
      : expectedSurface(
          setup,
          dims,
          datum,
          input.surfaceTopZ ?? null,
          input.seatMachineZ,
          input.seatProbeRefZ ?? null,
          input.seatProbeRefLabel ?? null,
        );
  const plan = planRegistration(
    {
      stock: { xMin: 0, yMin: 0, xMax: dims.x, yMax: dims.y, cornerRadius: input.cornerRadius },
      mount: mount.kind,
      expectedSurface: { machineZ: expected.machineZ, from: expected.from },
      probeRefZ: expected.probeRefZ,
      probeRefLabel: expected.probeRefLabel,
      floorProbeRefZ: expected.floorProbeRefZ,
      seekFromMachineZ: input.seekFromMachineZ,
      ...(input.holdUncertainty === undefined ? {} : { holdUncertainty: input.holdUncertainty }),
      mountDatum: datum,
      probe: input.probe ?? null,
      mountTap: input.mountTap ?? null,
      fixtureBelowSurfaceMm: mount.kind === 'vise' && datum === null ? dims.z - LEDGE_STEP : undefined,
      stockThicknessMm: dims.z,
      bracketOrigin: input.bracketOrigin,
      mountObstacles: input.mountObstacles,
      bracketConfirm: input.bracketConfirm,
      ...(input.guarded === undefined ? {} : { guarded: input.guarded }),
      // #743 — a disc keeps its own four-edge plan; a rectangle's input has no `disc`.
      ...(input.disc !== undefined ? { disc: input.disc } : {}),
      ...(input.cutCentre !== undefined ? { cutCentre: input.cutCentre } : {}),
    },
    settings,
  );
  return { plan, references: referenceFeatures(setup) };
}

/** A cut's footprint in the setup's work XY, and how deep it reaches below the face now up. */
function footprint(setup: Setup, c: Setup['stockBefore']['cuts'][number]): { min: [number, number]; max: [number, number]; depth: number } {
  const b = setup.stockBefore.bounds;
  const dims = machineSize(setup.rotation, b);
  const pts: Vec[] = [];
  for (const x of [c.box.min[0], c.box.max[0]]) for (const y of [c.box.min[1], c.box.max[1]]) for (const z of [c.box.min[2], c.box.max[2]]) pts.push(toMachine(setup.rotation, b, [x, y, z]));
  const r = (n: number) => Math.round(n * 1000) / 1000;
  return {
    min: [r(Math.min(...pts.map((p) => p[0]))), r(Math.min(...pts.map((p) => p[1])))],
    max: [r(Math.max(...pts.map((p) => p[0]))), r(Math.max(...pts.map((p) => p[1])))],
    depth: r(dims.z - Math.min(...pts.map((p) => p[2]))),
  };
}

/**
 * The openings earlier setups cut through to this setup's up face, as footprints in its work XY with
 * their own depth (#429) — only removals that say they are ONE connected opening; a group's bounding
 * box would put a scan's mid-line through the solid stock between its holes. Everything else open to
 * the face now up is returned as `blind`: no scan starts, and no surface touch lands, on it.
 */
export function referenceOpenings(setup: Setup): { openings: ReferenceOpening[]; blind: { min: [number, number]; max: [number, number] }[]; refused: string[] } {
  const openings: ReferenceOpening[] = [];
  const blind: { min: [number, number]; max: [number, number] }[] = [];
  const refused: string[] = [];
  for (const c of setup.stockBefore.cuts.filter((k) => k.opensTo.includes(setup.faceUp))) {
    const f = footprint(setup, c);
    if (c.opensTo.length > 1 && c.connected === true) {
      openings.push({
        itemId: c.id,
        name: c.name,
        ...f,
        ...(c.roundDiameterMm === undefined ? {} : { roundMm: c.roundDiameterMm }),
      });
    }
    else {
      blind.push({ min: f.min, max: f.max });
      if (c.opensTo.length > 1) refused.push(`${c.name}: not marked as one connected opening, so its outline is not known well enough to scan`);
    }
  }
  return { openings, blind, refused };
}

/** #429 — the registration plan for a setup that registers on the openings earlier setups cut. */
export function referenceRegistrationFor(
  setup: Setup,
  mount: MountSpec,
  input: {
    /** Vise/tape, legacy expert path: the machine Z of the surface the stock sits on. Absent on the datum path. */
    seatMachineZ?: number;
    seekFromMachineZ: number;
    cornerRadius: number;
    /** Vise (#598): the measured jaw-top datum. */
    mountDatum?: MountDatum | null;
    /** #619 — the measured surface-top datum; when present it beats the ledge estimate for the expected surface. */
    surfaceTopZ?: { value: number; measuredAt?: string; surface?: string } | null;
    /** The checked-out probe, carried on the plan for the record. */
    probe?: ProbeSpec | null;
    /** #599 — the mount tap point (machine XY), computed by the caller from the bed placement. */
    mountTap?: { x: number; y: number; fromMachineZ: number; label: string } | null;
    cutCentre?: { x: number; y: number };
  },
  settings: RegistrationSettings,
): PlanResult {
  const dims = machineSize(setup.rotation, setup.stockBefore.bounds);
  const { openings, blind, refused } = referenceOpenings(setup);
  if (openings.length === 0) {
    return { ok: false, reason: `no earlier cut can be a reference: ${refused.join('; ') || 'none passes through to this face'}` };
  }
  const datum = mount.kind === 'vise' ? (input.mountDatum ?? null) : null;
  const expected = expectedSurface(setup, dims, datum, input.surfaceTopZ ?? null, input.seatMachineZ, null, null);
  return planReferences(
    {
      stock: { xMin: 0, yMin: 0, xMax: dims.x, yMax: dims.y, cornerRadius: input.cornerRadius },
      mount: mount.kind,
      expectedSurface: { machineZ: expected.machineZ, from: expected.from },
      probeRefZ: expected.probeRefZ,
      probeRefLabel: expected.probeRefLabel,
      floorProbeRefZ: expected.floorProbeRefZ,
      seekFromMachineZ: input.seekFromMachineZ,
      mountDatum: datum,
      probe: input.probe ?? null,
      mountTap: input.mountTap ?? null,
      fixtureBelowSurfaceMm: mount.kind === 'vise' && datum === null ? dims.z - LEDGE_STEP : undefined,
      ...(input.cutCentre ? { cutCentre: input.cutCentre } : {}),
      openings,
      blind,
      // #743 P-8 — the turn is judged across the WORK this setup cuts, not the whole blank: the
      // error a turn leaves is proportional to the distance from where the correction is taken,
      // and beyond this setup's own items nothing is cut.
      spanMm: workSpan(setup),
    },
    settings,
  );
}

/**
 * The extent this setup's own cuts span in its mounted work XY, mm — the largest of the two
 * axes. Null when the setup states no own item with a box (the planner then uses the stock).
 */
function workSpan(setup: Setup): number | undefined {
  const own = new Set(setup.itemIds);
  const items = setup.stockAfter.cuts.filter((c) => own.has(c.id) && !c.facing);
  if (items.length === 0) return undefined;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const bounds = setup.stockBefore.bounds;
  for (const item of items) {
    for (const x of [item.box.min[0], item.box.max[0]]) {
      for (const y of [item.box.min[1], item.box.max[1]]) {
        const p = toMachine(setup.rotation, bounds, [x, y, item.box.max[2]]);
        minX = Math.min(minX, p[0]);
        maxX = Math.max(maxX, p[0]);
        minY = Math.min(minY, p[1]);
        maxY = Math.max(maxY, p[1]);
      }
    }
  }
  if (!(maxX > minX || maxY > minY)) return undefined;
  return Math.max(maxX - minX, maxY - minY);
}
