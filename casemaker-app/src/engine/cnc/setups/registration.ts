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

/** #598 — the surface the stock's top is expected at: the datum's jaw top + proud, or the seat + height. */
function expectedSurface(
  setup: Setup,
  dims: { x: number; y: number; z: number },
  datum: MountDatum | null,
  seatMachineZ: number | undefined,
): { machineZ: number; from: string } {
  if (datum !== null) {
    return {
      machineZ: datum.jawTopZ + (dims.z - LEDGE_STEP),
      from: `the measured jaw top at machine Z ${datum.jawTopZ} + the stock's ${dims.z - LEDGE_STEP} mm proud (setup ${setup.index})`,
    };
  }
  return {
    machineZ: (seatMachineZ ?? NaN) + dims.z,
    from: `the seat at machine Z ${seatMachineZ} + the stock's ${dims.z} mm this way up (setup ${setup.index})`,
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
    /** The checked-out probe, carried on the plan for the record. */
    probe?: ProbeSpec | null;
    bracketOrigin?: BracketOrigin;
    /** Bracket (#427): the clamps and arms as placed, and whether to take the confirming touch. */
    mountObstacles?: PlanObstacle[];
    bracketConfirm?: boolean;
  },
  settings: RegistrationSettings,
): { plan: PlanResult; references: ReferenceFeature[] } {
  const dims = machineSize(setup.rotation, setup.stockBefore.bounds);
  const datum = mount.kind === 'vise' ? (input.mountDatum ?? null) : null;
  const plan = planRegistration(
    {
      stock: { xMin: 0, yMin: 0, xMax: dims.x, yMax: dims.y, cornerRadius: input.cornerRadius },
      mount: mount.kind,
      expectedSurface: expectedSurface(setup, dims, datum, input.seatMachineZ),
      seekFromMachineZ: input.seekFromMachineZ,
      mountDatum: datum,
      probe: input.probe ?? null,
      fixtureBelowSurfaceMm: mount.kind === 'vise' && datum === null ? dims.z - LEDGE_STEP : undefined,
      bracketOrigin: input.bracketOrigin,
      mountObstacles: input.mountObstacles,
      bracketConfirm: input.bracketConfirm,
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
    if (c.opensTo.length > 1 && c.connected === true) openings.push({ itemId: c.id, name: c.name, ...f });
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
    /** The checked-out probe, carried on the plan for the record. */
    probe?: ProbeSpec | null;
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
  return planReferences(
    {
      stock: { xMin: 0, yMin: 0, xMax: dims.x, yMax: dims.y, cornerRadius: input.cornerRadius },
      mount: mount.kind,
      expectedSurface: expectedSurface(setup, dims, datum, input.seatMachineZ),
      seekFromMachineZ: input.seekFromMachineZ,
      mountDatum: datum,
      probe: input.probe ?? null,
      fixtureBelowSurfaceMm: mount.kind === 'vise' && datum === null ? dims.z - LEDGE_STEP : undefined,
      ...(input.cutCentre ? { cutCentre: input.cutCentre } : {}),
      openings,
      blind,
    },
    settings,
  );
}
