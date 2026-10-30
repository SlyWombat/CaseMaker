/**
 * The mount context both the Setups row and the machine card's Bed block read: the probe checked out
 * to a machine, its measured jaw-top datum, and the machine-XY point a "tap the fixed jaw" touches.
 *
 * Shared (#603) so the machine card offers the same tap the Setups row got in #599, computed from
 * one set of rules rather than two copies that can drift.
 */

import type { MachineRecord } from '@/platform/locationClient';
import type { ShopDefaults } from '@/platform/defaultsClient';
import { probeInstrument, type MountDatum, type PlanMountTap, type ProbeSpec } from '@/engine/cnc/registration/plan';
import { accessoriesFor, useLocationStore } from '@/store/locationStore';
import { newestViseRegistration, viseFrameFromRegistration, type RegistrationSource } from '@/platform/bedProfiles';
import { Z1_VISE } from '@/engine/cnc/fixture';
import type { MachineCalibration } from '@/engine/cnc/calibration';
import {
  anchorFrom,
  bracketArmTop,
  bracketDatum,
  bracketSeat,
  bracketSettings,
  bracketTapPoint,
  bracketTopMachineZ,
} from '@/engine/cnc/mounts/bracket';
import { viseTapPoint } from '@/engine/cnc/mounts/vise';

/** A finite number out of an accessory's open `unit` map, or null. */
export function mountNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** #595 — the mount kinds whose tap records a reading on the unit, and the `unit` key it lands on. */
export type TappableMountKind = 'vise' | 'bracket';

export const MOUNT_TAP_UNIT_KEY: Record<TappableMountKind, string> = {
  vise: 'jawTopZ',
  bracket: 'bracketTopZ',
};

/** The words the record's history line and the Manage rail use for each tapped surface. */
export const MOUNT_TAP_WORD: Record<TappableMountKind, string> = {
  vise: 'jaw top',
  bracket: 'bracket top',
};

/**
 * #595 — one tapped reading on the mount's OWN record: a machine-frame Z with the date, the probe
 * that took it and the XY it touched. It mirrors the bed profile's `MeasuredDatum` and adds
 * `machineId`: a jaw top is the jaw top on the machine it was tapped on, so a unit checked out to a
 * different machine cannot anchor that machine's plan from this reading.
 */
export interface MountUnitReading {
  value: number;
  measuredAt: string;
  by: string;
  at: [number, number] | null;
  machineId: string;
}

/** Read a mount's unit entry when it has the shape a tap writes; anything else is not a reading. */
export function mountUnitReading(v: unknown): MountUnitReading | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  const value = mountNum(r.value);
  if (value === null || typeof r.measuredAt !== 'string' || typeof r.by !== 'string' || typeof r.machineId !== 'string') {
    return null;
  }
  const at =
    Array.isArray(r.at) && r.at.length === 2 && mountNum(r.at[0]) !== null && mountNum(r.at[1]) !== null
      ? ([mountNum(r.at[0])!, mountNum(r.at[1])!] as [number, number])
      : null;
  return { value, measuredAt: r.measuredAt, by: r.by, at, machineId: r.machineId };
}

/**
 * #598 — the probe checked out to `machine`, or null when there is none. #525 — a probe whose tip
 * has never been measured comes back with `tip: null` rather than null: the caller can then say
 * "measure this probe's tip" instead of silently planning with the shop's wired-probe numbers. The
 * instrument is the variant's (`probeInstrument`), so the planner and the executor know whether
 * the probe touches sideways.
 */
export function probeFor(machine: MachineRecord | null): ProbeSpec | null {
  if (machine === null) return null;
  const acc = accessoriesFor(machine).find((a) => a.kind === 'probe');
  if (acc === undefined) return null;
  const diameterMm = mountNum(acc.unit.tipDiameterMm);
  const rimOffsetMm = mountNum(acc.unit.rimOffsetMm);
  const rimOffsetUncertaintyMm = mountNum(acc.unit.rimOffsetUncertaintyMm);
  const variant = acc.variant ?? null;
  const tip =
    diameterMm === null || rimOffsetMm === null || rimOffsetUncertaintyMm === null
      ? null
      : { diameterMm, rimOffsetMm, rimOffsetUncertaintyMm };
  return { id: acc.id, variant, instrument: probeInstrument(variant), tip };
}

/** #603 — the checked-out probe's display name (its product), or null when none is checked out. */
export function probeNameFor(machine: MachineRecord | null): string | null {
  if (machine === null) return null;
  const acc = accessoriesFor(machine).find((a) => a.kind === 'probe');
  return acc === undefined ? null : (acc.product ?? 'probe');
}

/**
 * #640 — an accessory's display name for a stored `by` id, or the id itself when the accessory is no
 * longer in the location (an operator reading a stale datum still needs to see WHICH probe it was,
 * and an id is all we have then). Searches EVERY accessory, not `accessoriesFor(machine)`: the
 * probe that tapped a datum may have been put away since, and that is exactly when the sentence
 * must still name it.
 */
export function accessoryNameFor(id: string): string {
  const accessories = useLocationStore.getState().location?.accessories ?? [];
  return accessories.find((a) => a.id === id)?.product ?? id;
}

/** #604 — the mount accessory's name for the job's holding kind, or the kind word when none is checked out. */
export function mountNameFor(machine: MachineRecord | null, kind: string): string {
  if (machine === null) return kind;
  return accessoriesFor(machine).find((a) => a.kind === kind)?.product ?? kind;
}

/**
 * #601 — write the probe's last M491 length and M119 rest reading onto the probe checked out to
 * `machine`. The executor only measures; this is the accessory write the follow-up asks for, in the
 * same location-write shape the datum uses. No-op with no machine or no checked-out probe.
 */
export async function recordProbeReading(
  machine: MachineRecord | null,
  probe: { lengthZ: number; rest: string },
): Promise<void> {
  if (machine === null) return;
  const acc = accessoriesFor(machine).find((a) => a.kind === 'probe');
  if (acc === undefined) return;
  const now = new Date().toISOString();
  const rest = /Probe:\s*([01])\b/.exec(probe.rest)?.[1] ?? probe.rest;
  await useLocationStore.getState().saveAccessory({
    ...acc,
    unit: { ...acc.unit, lastM491: { z: probe.lengthZ, at: now }, lastM119Rest: rest },
    history: [...acc.history, { at: now, what: `probe length ${probe.lengthZ} mm, rest ${rest}` }],
  });
}

/**
 * #595 — write a mount tap's reading onto the MOUNT checked out to `machine`: the vise's `jawTopZ`
 * or the bracket's `bracketTopZ`, as a {@link MountUnitReading} with provenance `probed:<date>` and
 * a history line. The bed profile's datum still lands through its own update; this is the unit's
 * own record — the one that travels with the accessory and the one `mountDatumFor` prefers. No-op
 * with no machine or no accessory of that kind checked out.
 */
export async function recordMountReading(
  machine: MachineRecord | null,
  kind: TappableMountKind,
  reading: { z: number; at: { x: number; y: number } },
  probeId: string | null,
): Promise<void> {
  if (machine === null) return;
  const acc = accessoriesFor(machine).find((a) => a.kind === kind);
  if (acc === undefined) return;
  const now = new Date().toISOString();
  const key = MOUNT_TAP_UNIT_KEY[kind];
  const by = probeId ?? 'wired-probe';
  const value: MountUnitReading = {
    value: reading.z,
    measuredAt: now,
    by,
    at: [reading.at.x, reading.at.y],
    machineId: machine.id,
  };
  const instrument = probeId === null ? 'the wired probe' : accessoryNameFor(probeId);
  await useLocationStore.getState().saveAccessory({
    ...acc,
    unit: { ...acc.unit, [key]: value },
    provenance: { ...acc.provenance, [key]: `probed:${now}` },
    history: [...acc.history, { at: now, what: `${MOUNT_TAP_WORD[kind]} ${reading.z} mm tapped with ${instrument}` }],
  });
}

/**
 * #595 — the checked-out VISE's own tapped jaw top, when it may anchor `machine`'s plan: the
 * reading must be from THIS machine and, like the bed datum (#611), from the probe checked out now.
 */
function viseUnitDatum(machine: MachineRecord): MountDatum | null {
  const acc = accessoriesFor(machine).find((a) => a.kind === 'vise');
  if (acc === undefined) return null;
  const reading = mountUnitReading(acc.unit[MOUNT_TAP_UNIT_KEY.vise]);
  if (reading === null || reading.machineId !== machine.id) return null;
  const checkedOut = probeFor(machine)?.id ?? null;
  if (checkedOut !== null && reading.by !== checkedOut) return null;
  return { jawTopZ: reading.value, measuredAt: reading.measuredAt, by: reading.by };
}

/**
 * #598/#595 — the jaw-top datum: the checked-out vise's own tapped record first, else the active
 * bed profile's datum (the machine's copy, for a house whose tap predates the unit record), or null
 * when neither may anchor this plan.
 */
export function mountDatumFor(machine: MachineRecord | null): MountDatum | null {
  if (machine === null) return null;
  const unit = viseUnitDatum(machine);
  if (unit !== null) return unit;
  if (machine.bedProfiles === undefined || machine.activeBedProfileId === undefined) return null;
  const profile = machine.bedProfiles.find((p) => p.id === machine.activeBedProfileId);
  const datum = profile?.datums.viseJawTopZ ?? null;
  if (datum === null) return null;
  // #611 — the datum is the jaw top as SEEN THROUGH the probe that tapped it (a raw MPos reading);
  // a different probe now checked out reads a different jaw top, so the datum cannot anchor this
  // probe's plan and reads as absent. With no probe accessory checked out there is nothing to
  // compare against, so the datum stands.
  const checkedOut = probeFor(machine)?.id ?? null;
  if (checkedOut !== null && datum.by !== checkedOut) return null;
  return { jawTopZ: datum.value, measuredAt: datum.measuredAt, by: datum.by };
}

/**
 * #611 — the jaw-top datum's `by` when it names a probe other than the one checked out to `machine`
 * (`mountDatumFor` then returns null). The caller uses it to say which probe tapped the datum and to
 * offer the tap with the current probe. Null when the datum matches or is absent.
 */
export function mountDatumMismatch(machine: MachineRecord | null): string | null {
  if (machine === null) return null;
  // A unit reading that matches the checked-out probe is the datum the plan uses; there is no
  // mismatch to report even if the older bed copy names another probe.
  if (viseUnitDatum(machine) !== null) return null;
  const acc = accessoriesFor(machine).find((a) => a.kind === 'vise');
  const unit = acc === undefined ? null : mountUnitReading(acc.unit[MOUNT_TAP_UNIT_KEY.vise]);
  // A reading from another machine is not this machine's datum: say nothing about its probe unless
  // it is the probe checked out now (the same guard the bed datum gets).
  if (unit !== null && unit.machineId === machine.id) {
    const checkedOut = probeFor(machine)?.id ?? null;
    if (checkedOut !== null && unit.by !== checkedOut) return unit.by;
  }
  if (machine.bedProfiles === undefined || machine.activeBedProfileId === undefined) return null;
  const profile = machine.bedProfiles.find((p) => p.id === machine.activeBedProfileId);
  const datum = profile?.datums.viseJawTopZ ?? null;
  if (datum === null) return null;
  const checkedOut = probeFor(machine)?.id ?? null;
  return checkedOut !== null && datum.by !== checkedOut ? datum.by : null;
}

/** #619 — the active bed profile's measured surface-top datum, or null when it has none. */
export function surfaceTopDatumFor(machine: MachineRecord | null): { value: number; measuredAt: string; by: string; at: [number, number] | null } | null {
  if (machine === null || machine.bedProfiles === undefined || machine.activeBedProfileId === undefined) return null;
  const profile = machine.bedProfiles.find((p) => p.id === machine.activeBedProfileId);
  const datum = profile?.datums.surfaceTopZ ?? null;
  if (datum === null) return null;
  // #632 — the same rule the jaw-top datum has had since #611: the reading is the surface as seen
  // THROUGH the probe that took it (a raw MPos number), so a different probe checked out cannot
  // anchor its expected surface on it. With no probe accessory checked out there is nothing to
  // compare against, and the datum stands. (The datum still carries no stock-thickness key — a
  // surface top from a thinner blank is a separate note on #632, not a one-line guard.)
  const checkedOut = probeFor(machine)?.id ?? null;
  if (checkedOut !== null && datum.by !== checkedOut) return null;
  return datum;
}

/**
 * #599/#607 — the mount tap point (machine XY) for the VISE, from the bed placement or the newest
 * registration, with the #607 fields filled in for the executor and the write-back.
 */
export function mountTapFor(
  machine: MachineRecord | null,
  registrations: RegistrationSource[],
  seekFromMachineZ: number,
  jawStartY: number,
): PlanMountTap | null {
  if (machine === null) return null;
  const profile = machine.bedProfiles?.find((p) => p.id === machine.activeBedProfileId);
  const placement = profile?.placements.find((p) => p.where.kind === 'pins' && p.where.pins === 'vise');
  const viseAcc = accessoriesFor(machine).find((a) => a.kind === 'vise');
  const jawBarWidth = mountNum(viseAcc?.constants.jawBarWidth) ?? Z1_VISE.fixedJawThickness;
  const jawLength = mountNum(viseAcc?.constants.jawLength) ?? Z1_VISE.jawLength;

  // The frame source order: the measured placement frame, else the newest usable registration, else none.
  const f = placement?.frame ?? null;
  let frame: { fixedJawFaceX: number; jawStartY: number } | null;
  if (f !== null && f.fixedJawFaceX !== null && f.jawStartY !== null) {
    frame = { fixedJawFaceX: f.fixedJawFaceX, jawStartY: f.jawStartY };
  } else {
    const reg = newestViseRegistration(registrations, machine.address);
    frame = reg === null ? null : viseFrameFromRegistration(reg, jawStartY);
  }
  if (frame === null) return null;
  const point = viseTapPoint(frame, { jawBarWidth, jawLength });
  // #607 — the reading IS the jaw-top datum, and the executor bounds the touch by the stored one
  // (null: no datum yet, so a plan that reaches here is on the typed-seat path and taps nothing).
  return {
    x: point.x,
    y: point.y,
    fromMachineZ: seekFromMachineZ,
    label: 'the vise fixed-jaw top',
    reference: 'vise-jaw-top',
    expectZ: mountDatumFor(machine)?.jawTopZ ?? null,
    datumOffsetMm: 0,
  };
}

/**
 * #607 — the BRACKET's tap: its front arm's top face (`bracketTapPoint`), and the seat the reading
 * measures back (the top less the arm's measured height above the seat).
 *
 * The placement comes from the machine's own anchor + the bracket's offsets — the same pair the
 * plan's `bracketExpectedSurface` uses, so the tap cannot aim at a corner the plan does not believe
 * in.
 *
 * TWO MEASUREMENTS ARE REQUIRED, and with either missing there is NO tap (null), not a guessed one:
 *  - `bracket.seatMachineZ` — the seat beside the bracket (`bracketSeat`); the plan refuses without
 *    it, so this is always present when a plan exists;
 *  - `bracket.armTopMm` — the arm's OWN top face above that seat, touched at this very point with the
 *    slots checked clear. `bracket.heightMm` is NOT it: that number goes to the screw heads' tops
 *    where they stand higher. A tap against the wrong surface would write a seat wrong by the
 *    difference, so until the bench records this the bracket tap stays dormant and the plan runs the
 *    untapped, measured-seat path it always did.
 */
export function bracketTapFor(args: {
  calibration: MachineCalibration | null | undefined;
  machineId: string;
  seekFromMachineZ: number;
  defaults: ShopDefaults | null;
}): PlanMountTap | null {
  const anchor = anchorFrom(args.calibration, args.machineId);
  if (!anchor.ok) return null;
  const seat = bracketSeat(args.defaults);
  const armTop = bracketArmTop(args.defaults);
  if (seat === null || armTop === null) return null;
  const sizes = bracketSettings(args.defaults);
  const datum = bracketDatum(anchor.anchor, sizes);
  const point = bracketTapPoint(datum, sizes.settings);
  return {
    x: point.x,
    y: point.y,
    fromMachineZ: args.seekFromMachineZ,
    // The arm named the way the operator sees it — the same words `bracketObstacles` gives it.
    label: 'the bracket’s front arm (along the front edge, nearest you)',
    reference: 'bracket-seat',
    expectZ: bracketTopMachineZ(seat.value, armTop.value),
    datumOffsetMm: armTop.value,
  };
}
