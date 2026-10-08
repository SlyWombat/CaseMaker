/**
 * The machine's own coordinate frame, as a saved record with provenance (#279, decision 28).
 *
 * ## What this is for
 *
 * `machine.ts` ships a profile built from Makera's `configZ1.default` — a STOCK Z1. The bench
 * machine is not stock: `/sd/config.txt` is a *calibration* of those defaults, and it has moved
 * `anchor1` by 1.51 mm on X (#208 B6/B7). That matters because three positions are derived from
 * it — `sensor` (where `M6` drives Z down to touch off the tool setter), `changePosition` (where
 * the head parks for a manual change) and `anchor2` — and the emulator animates a predicted
 * tool-length probe toward them.
 *
 * #279's decision was **default + override**: the profile keeps the vendor's defaults, this
 * module holds a machine's own read of the same {@link CoordinateFrame}, and
 * {@link resolveMachine} layers one over the other. That is decision 28's shape applied to a
 * machine instead of a vise — a shipped default, a saved measurement, and the source travelling
 * with the numbers so neither can be mistaken for the other.
 *
 * ## What it deliberately does NOT do
 *
 * Nothing here invents a number. A read is only ever what the controller answered, a partial
 * read is dropped WHOLE rather than half-applied (the same rule `parseVise` follows: a partial
 * obstacle model is more dangerous than none — and a partial FRAME is worse than a whole one,
 * because every position derived from it would silently mix two machines), and a calibration
 * read from a different machine is reported as ignored rather than quietly used.
 *
 * The read is `config-get sd <key>`, one key at a time: `config-get-all` does not exist on this
 * firmware, and the one-argument effective-value form answers from a cache that is EMPTY on this
 * build (Z1-Bridge-Protocol §5). `sd` is `/sd/config.txt`, the vendor's override file — so a key
 * is read from the file this machine's calibration actually lives in, and a key that is missing
 * there is a key we could not read rather than one that is unset.
 */

import type { Vec2 } from '@/types/units';
import {
  MACHINES,
  deriveCoordinateFrame,
  type CoordinateFrame,
  type MillProfile,
  type SoftEndstop,
} from './machine';

/**
 * The configuration keys a calibration is read from, in the CONTROLLER's own vocabulary.
 *
 * One place, because the same strings are needed by the reader, by the refusal messages, and by
 * anything that later asks the machine the same questions. A key that answers *"not in config"*
 * is a key we have not read, never a key the machine does not have.
 *
 * `rotation_offset_*` is deliberately absent: it is part of the machine's calibration on this
 * machine (12.0/85.5 → −7.5/69.0), but nothing in this repo derives a position from it yet, and
 * a field with no consumer is a number waiting to be trusted for the wrong reason.
 */
export const CALIBRATION_KEYS = {
  anchor1X: 'coordinate.anchor1_x',
  anchor1Y: 'coordinate.anchor1_y',
  anchor2OffsetX: 'coordinate.anchor2_offset_x',
  anchor2OffsetY: 'coordinate.anchor2_offset_y',
  toolrackOffsetX: 'coordinate.toolrack_offset_x',
  toolrackOffsetY: 'coordinate.toolrack_offset_y',
  clearanceX: 'coordinate.clearance_x',
  clearanceY: 'coordinate.clearance_y',
  clearanceZ: 'coordinate.clearance_z',
  toolrackZ: 'coordinate.toolrack_z',
  softEndstopEnable: 'soft_endstop.enable',
  softEndstopXMin: 'soft_endstop.x_min',
  softEndstopYMin: 'soft_endstop.y_min',
  softEndstopZMin: 'soft_endstop.z_min',
} as const;

/** Every key a complete read asks for, in the order a bench read reports them. */
export const CALIBRATION_KEY_LIST: readonly string[] = Object.values(CALIBRATION_KEYS);

/**
 * A machine's own `coordinate.*` frame and soft endstops, as READ from it (#279).
 *
 * `source` and `measuredAt` are not decoration: this is a record of a moment on one machine, and
 * a frame with no date is a claim that it is still true. The machine's `id` travels with the
 * numbers for the same reason a `MACHINES` key does — a second Z1 on a different bench is a
 * different frame, and applying one to the other is the failure this whole module guards.
 */
export interface MachineCalibration {
  /** The `MACHINES` id the read was taken on. Applied only to that machine. */
  machineId: string;
  /** The controller's `coordinate.*` group, exactly as it answered. */
  frame: CoordinateFrame;
  /** The controller's soft endstops, exactly as it answered. RECORDED, not enforced (see `machine.ts`). */
  softEndstop: SoftEndstop;
  /** Where the read was taken, e.g. `config-get sd on 192.168.10.43`. Never empty. */
  source: string;
  /** ISO 8601 timestamp of the read. */
  measuredAt: string;
}

/** What a read produces: the calibration, or the keys that stopped it being one. */
export type CalibrationRead =
  | { ok: true; calibration: MachineCalibration }
  | { ok: false; missing: string[]; malformed: string[] };

export interface CalibrationReadOptions {
  /** The `MACHINES` id this machine resolved to. */
  machineId: string;
  /** ISO 8601 timestamp of the read. Taken by the caller, so this stays pure. */
  measuredAt: string;
  /** The address the controller answered on. Named in `source`. */
  host?: string;
}

/** A finite number, or null for anything the controller could answer that is not one. */
function numberOr(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number(raw.trim());
  return raw.trim().length > 0 && Number.isFinite(n) ? n : null;
}

/** `true`/`false` as the controller spells them, or null. */
function boolOr(raw: string | undefined): boolean | null {
  const v = raw?.trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

/**
 * Turn the controller's answers into a calibration.
 *
 * `replies` is keyed by the configuration key NAME (`CALIBRATION_KEYS.anchor1X`), holding the
 * value verbatim — `"-190.89"`, `"true"` — so nothing between the socket and here has to agree
 * about formatting. Every key in `CALIBRATION_KEY_LIST` must be present and parse, or the read
 * fails; the failure names the keys rather than producing a frame with holes in it.
 */
export function calibrationFromReplies(
  replies: ReadonlyMap<string, string>,
  opts: CalibrationReadOptions,
): CalibrationRead {
  const missing: string[] = [];
  const malformed: string[] = [];

  /** The key's value, recorded as missing when the controller did not answer it. */
  const text = (key: string): string | undefined => {
    const raw = replies.get(key);
    if (raw === undefined || raw.trim().length === 0) {
      if (!missing.includes(key)) missing.push(key);
      return undefined;
    }
    return raw;
  };
  const num = (key: string): number => {
    const raw = text(key);
    const n = numberOr(raw);
    if (raw !== undefined && n === null) malformed.push(key);
    return n ?? 0;
  };
  const bool = (key: string): boolean => {
    const raw = text(key);
    const b = boolOr(raw);
    if (raw !== undefined && b === null) malformed.push(key);
    return b ?? false;
  };

  const frame: CoordinateFrame = {
    anchor1: [num(CALIBRATION_KEYS.anchor1X), num(CALIBRATION_KEYS.anchor1Y)] as Vec2,
    anchor2Offset: [num(CALIBRATION_KEYS.anchor2OffsetX), num(CALIBRATION_KEYS.anchor2OffsetY)] as Vec2,
    toolrackOffset: [num(CALIBRATION_KEYS.toolrackOffsetX), num(CALIBRATION_KEYS.toolrackOffsetY)] as Vec2,
    clearanceXY: [num(CALIBRATION_KEYS.clearanceX), num(CALIBRATION_KEYS.clearanceY)] as Vec2,
    clearanceZ: num(CALIBRATION_KEYS.clearanceZ),
    toolrackZ: num(CALIBRATION_KEYS.toolrackZ),
  };
  const softEndstop: SoftEndstop = {
    enabled: bool(CALIBRATION_KEYS.softEndstopEnable),
    xMin: num(CALIBRATION_KEYS.softEndstopXMin),
    yMin: num(CALIBRATION_KEYS.softEndstopYMin),
    zMin: num(CALIBRATION_KEYS.softEndstopZMin),
    source: readSource(opts),
  };

  if (missing.length > 0 || malformed.length > 0) return { ok: false, missing, malformed };

  const draft = { machineId: opts.machineId, frame, softEndstop, source: readSource(opts), measuredAt: opts.measuredAt };
  // The reader's own output goes through the loader's validator, so a bug here cannot produce a
  // payload that `parseMachineCalibration` would reject on the next load.
  const parsed = parseMachineCalibration(draft);
  if (!parsed.ok) return { ok: false, missing: [], malformed: [parsed.reason] };
  return { ok: true, calibration: parsed.calibration };
}

/** `config-get sd on <host>` — the one place the sentence a saved record carries is written. */
export function readSource(opts: { host?: string }): string {
  return opts.host === undefined || opts.host.trim().length === 0
    ? 'config-get sd (read on the machine)'
    : `config-get sd on ${opts.host.trim()}`;
}

/** What `parseMachineCalibration` found. */
export type CalibrationParse =
  | { ok: true; calibration: MachineCalibration }
  | { ok: false; reason: string };

/**
 * Validate a stored calibration payload (#279). Returns the record, or a reason a human reads.
 *
 * Whole-or-nothing, as `parseVise` is: a payload missing one key is dropped rather than
 * half-honoured, because a frame with one vendor value in it would be a machine of its own.
 */
export function parseMachineCalibration(raw: unknown): CalibrationParse {
  if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'not an object' };
  const o = raw as Record<string, unknown>;
  if (typeof o.machineId !== 'string' || o.machineId.length === 0) {
    return { ok: false, reason: 'no machine id' };
  }
  if (typeof o.source !== 'string' || o.source.length === 0) {
    return { ok: false, reason: 'no source: a calibration has to say where it was read' };
  }
  if (typeof o.measuredAt !== 'string' || o.measuredAt.length === 0) {
    return { ok: false, reason: 'no date: a calibration is a record of a moment' };
  }
  const frame = o.frame;
  if (typeof frame !== 'object' || frame === null) return { ok: false, reason: 'no coordinate frame' };
  const f = frame as Record<string, unknown>;

  /** First problem wins: it is the one a human should fix first. */
  let failure: string | null = null;
  const fail = (reason: string): null => {
    failure ??= reason;
    return null;
  };
  const numField = (v: unknown, what: string): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : fail(`${what} is not a number`);

  const pair = (v: unknown, what: string): Vec2 | null => {
    if (!Array.isArray(v) || v.length !== 2) return fail(`${what} is not a pair`);
    const a = numField(v[0], `${what}[0]`);
    const b = numField(v[1], `${what}[1]`);
    return a === null || b === null ? null : ([a, b] as Vec2);
  };

  const anchor1 = pair(f.anchor1, 'anchor1');
  const anchor2Offset = pair(f.anchor2Offset, 'anchor2Offset');
  const toolrackOffset = pair(f.toolrackOffset, 'toolrackOffset');
  const clearanceXY = pair(f.clearanceXY, 'clearanceXY');
  const clearanceZ = numField(f.clearanceZ, 'clearanceZ');
  const toolrackZ = numField(f.toolrackZ, 'toolrackZ');

  const endstop = o.softEndstop;
  if (typeof endstop !== 'object' || endstop === null) return { ok: false, reason: 'no soft endstops' };
  const e = endstop as Record<string, unknown>;
  const enabled = e.enabled;
  if (typeof enabled !== 'boolean') return { ok: false, reason: 'softEndstop.enabled is not true or false' };
  const xMin = numField(e.xMin, 'softEndstop.xMin');
  const yMin = numField(e.yMin, 'softEndstop.yMin');
  const zMin = numField(e.zMin, 'softEndstop.zMin');
  if (typeof e.source !== 'string') return { ok: false, reason: 'softEndstop.source is not a string' };

  if (
    failure !== null ||
    anchor1 === null ||
    anchor2Offset === null ||
    toolrackOffset === null ||
    clearanceXY === null ||
    clearanceZ === null ||
    toolrackZ === null ||
    xMin === null ||
    yMin === null ||
    zMin === null
  ) {
    return { ok: false, reason: failure ?? 'a frame value is missing' };
  }

  return {
    ok: true,
    calibration: {
      machineId: o.machineId,
      frame: { anchor1, anchor2Offset, toolrackOffset, clearanceXY, clearanceZ, toolrackZ },
      softEndstop: { enabled, xMin, yMin, zMin, source: e.source },
      source: o.source,
      measuredAt: o.measuredAt,
    },
  };
}

/**
 * The profile a job should be verified, simulated and run against (#279).
 *
 * The shipped profile when there is no calibration or when the saved one belongs to a DIFFERENT
 * machine; otherwise the same profile with every position that comes out of the frame replaced.
 * What is NOT replaced is the point as much as what is: the work envelope, the spindle ceiling,
 * the dialect and the probe feeds are the machine MODEL's, not its calibration's, and a saved
 * read must not be able to move a limit it was never a measurement of.
 */
export function resolveMachine(
  base: MillProfile,
  calibration?: MachineCalibration | null,
): MillProfile {
  if (!calibration || calibration.machineId !== base.id) return base;
  const derived = deriveCoordinateFrame(calibration.frame);
  return {
    ...base,
    anchor1: calibration.frame.anchor1,
    anchor2: derived.anchor2,
    softEndstop: calibration.softEndstop,
    toolChange: {
      ...base.toolChange,
      clearanceZ: calibration.frame.clearanceZ,
      clearanceXY: calibration.frame.clearanceXY,
      changePosition: derived.changePosition,
      sensor: derived.sensor,
      sensorZ: calibration.frame.toolrackZ,
    },
  };
}

/**
 * The profile for a `MACHINES` id, resolved against a saved calibration. `undefined` for an id
 * we do not know — the same answer `MACHINES[id]` gives, never a fallback to the Z1's numbers.
 */
export function resolvedMachineById(
  id: string,
  calibration?: MachineCalibration | null,
): MillProfile | undefined {
  const base = MACHINES[id];
  return base === undefined ? undefined : resolveMachine(base, calibration);
}

/** Which frame is in force, for a panel or a wizard to print. */
export interface CalibrationNotice {
  severity: 'info' | 'warning';
  code: 'machine-calibrated-frame' | 'machine-vendor-frame' | 'machine-calibration-ignored';
  message: string;
}

/**
 * One sentence saying which frame is in force and where its numbers came from (#279).
 *
 * Decision 28's rule, and the reason this function exists at all: provenance is SHOWN, never
 * assumed. Someone reading a predicted probe position has to be able to tell whether they are
 * looking at the vendor's default or at their own machine's own configuration — and a saved
 * calibration that is being ignored has to say so rather than quietly do nothing.
 */
export function machineCalibrationNotice(
  base: MillProfile,
  calibration?: MachineCalibration | null,
): CalibrationNotice {
  if (calibration && calibration.machineId !== base.id) {
    return {
      severity: 'warning',
      code: 'machine-calibration-ignored',
      message:
        `A calibration read from machine "${calibration.machineId}" is saved, but this job runs on ` +
        `the ${base.name} ("${base.id}") — it is NOT being used. Positions are the vendor's defaults.`,
    };
  }
  if (calibration) {
    const when = calibration.measuredAt.slice(0, 10);
    return {
      severity: 'info',
      code: 'machine-calibrated-frame',
      message:
        `Machine positions come from this machine's own configuration (${calibration.source}, read ` +
        `${when}): the anchors, the tool-length sensor and the change position are where THIS machine ` +
        `says they are, not the vendor's defaults.`,
    };
  }
  return {
    severity: 'warning',
    code: 'machine-vendor-frame',
    message:
      `Machine positions are the vendor's shipped defaults — this machine's own configuration has ` +
      `not been read, and on a calibrated machine the anchors and the tool-length sensor sit ` +
      `elsewhere (#279, #208 B6/B7).`,
  };
}
