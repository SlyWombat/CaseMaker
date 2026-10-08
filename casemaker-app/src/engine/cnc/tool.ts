/**
 * The cutting tool, as the `.nc` header describes it (#182, `/Simulation.md` §6).
 *
 * The fields mirror Makera's `;@MKR|TOOL|...` record, because that is what a file we read
 * back carries and therefore what a simulation of a third-party file has to work from. The
 * header is UNTRUSTED: the strings Studio writes for `type=` are known only for flat and
 * ball end mills (`/Makera-Parity.md` §12), and a field can be absent or garbage, so
 * everything here is parsed defensively and anything unidentifiable is REFUSED rather than
 * approximated. Simulating a V-bit as a flat end mill would draw a cut the machine will
 * not make.
 *
 * V1 sweeps a FLAT end mill only (`/Simulation.md` §4.5): its swept volume at constant Z
 * is exact 2D geometry. Every other shape is refused here, by name.
 */

import type { MkrRecord } from './gcode/types';
import { mkrNumber } from './gcode/mkrHeader';

export type ToolShape = 'flat' | 'ball' | 'tapered-ball' | 'engraving' | 'chamfer' | 'drill' | 'thread' | 'bull' | 'unknown';

export interface Tool {
  number: number | null;
  id: string | null;
  name: string;
  /** The `type=` string exactly as written, for diagnostics. */
  typeText: string;
  shape: ToolShape;
  /** Shank diameter, mm. */
  handleDiameter: number | null;
  /** Cutting diameter at the tip, mm. For a flat end mill this IS the cutting diameter. */
  tipDiameter: number | null;
  /** `diameter=`: for engravers, drills and chamfers Makera writes the SHANK here; for flat ends the cutting diameter. */
  diameter: number | null;
  cornerRadius: number | null;
  angle: number | null;
  halfAngle: number | null;
  fluteLength: number | null;
  /** Length to the shoulder: the shank-collision limit. EMPTY for every engraver and chamfer in Makera's catalogue. */
  shoulderLength: number | null;
  stickout: number | null;
  /**
   * Can this cutter plunge straight down without a pilot hole? Only a CENTRE-CUTTING end mill
   * can, and the `.nc` header does not say (#220). Not a field of `MkrRecord`, so a tool parsed
   * from a file is always `null` — unknown, never a guess. A `null` on a job that drills raises
   * `plunge-unproven` (#220): the cut is offered with the uncertainty named, and #208 A1 records
   * the answer for cutters that are actually owned.
   */
  centreCutting: boolean | null;
}

/** Studio's `type=` vocabulary, from the binary's string table (`/Makera-Parity.md` §12). */
export function shapeFromType(typeText: string): ToolShape {
  const s = typeText.trim().toLowerCase();
  if (s === '') return 'unknown';
  if (s.includes('tapered')) return 'tapered-ball';
  if (s.includes('ball')) return 'ball';
  if (s.includes('flat')) return 'flat';
  if (s.includes('engrav')) return 'engraving';
  if (s.includes('chamfer')) return 'chamfer';
  if (s.includes('drill')) return 'drill';
  if (s.includes('thread')) return 'thread';
  if (s.includes('bull')) return 'bull';
  return 'unknown';
}

/**
 * The file's stick-out, or null. `sticklength` is the exposed length the Bit Collar Installer set
 * on the bit (#305 design point 1) — not a catalogue field, which is why Makera's own database
 * leaves `cutterStickoutLength` empty. The file format writes `sticklength=0` for "unset" (Studio
 * does it for every bit whose collar nobody measured), and a 0 mm stick-out is impossible for a
 * cutter whose shoulder alone is 12 mm, so a non-positive value is UNKNOWN. It matters: the
 * holder gate treats a null as "cannot be proven", while a 0 would put the modelled collet nut at
 * the tool tip and manufacture `holder-into-fixture` errors out of nothing.
 */
function stickoutFromRecord(rec: MkrRecord): number | null {
  const v = mkrNumber(rec, 'sticklength') ?? mkrNumber(rec, 'stickout');
  return v !== null && v > 0 ? v : null;
}

/** Build a Tool from a `;@MKR|TOOL|...` record. Never throws; missing fields are null. */
export function toolFromMkrRecord(rec: MkrRecord): Tool {
  const f = rec.fields;
  const typeText = f['type'] ?? '';
  return {
    number: mkrNumber(rec, 'number'),
    id: f['id'] ?? null,
    name: f['name'] ?? '',
    typeText,
    shape: shapeFromType(typeText),
    handleDiameter: mkrNumber(rec, 'handlediameter'),
    tipDiameter: mkrNumber(rec, 'tipdiameter'),
    diameter: mkrNumber(rec, 'diameter'),
    cornerRadius: mkrNumber(rec, 'cornerradius'),
    angle: mkrNumber(rec, 'angle'),
    halfAngle: mkrNumber(rec, 'halfAngle') ?? mkrNumber(rec, 'halfangle'),
    fluteLength: mkrNumber(rec, 'flutelength'),
    shoulderLength: mkrNumber(rec, 'shoulderlength'),
    stickout: stickoutFromRecord(rec),
    // The header says nothing about it, so a parsed tool is UNKNOWN, not "not centre-cutting".
    centreCutting: null,
  };
}

/** A flat end mill of the given cutting diameter, for tests and for the app's own jobs. */
export function flatEndMill(cuttingDiameter: number, opts: Partial<Tool> = {}): Tool {
  return {
    number: 1,
    id: null,
    name: `${cuttingDiameter} mm flat end`,
    typeText: 'Flat End',
    shape: 'flat',
    handleDiameter: 3.175,
    tipDiameter: cuttingDiameter,
    diameter: cuttingDiameter,
    cornerRadius: 0,
    angle: 0,
    halfAngle: 0,
    fluteLength: null,
    shoulderLength: null,
    stickout: null,
    // A generic flat end mill is not proven centre-cutting either: `flatEndMill` is the
    // simulation's assumed cutter, not a catalogue entry with a stated geometry.
    centreCutting: null,
    ...opts,
  };
}

export type RadiusResult = { ok: true; radius: number } | { ok: false; reason: string };

/**
 * The radius the V1 sweep uses, or a refusal naming why. Only a flat end mill qualifies; a
 * flat end mill with a corner radius is a bull nose and is refused too, because its sweep at
 * constant Z is not a capsule.
 */
export function cuttingRadiusForSweep(tool: Tool): RadiusResult {
  if (tool.shape !== 'flat') {
    return { ok: false, reason: `V1 sweeps a flat end mill only; tool "${tool.name}" is type "${tool.typeText || '(missing)'}" (${tool.shape})` };
  }
  if (tool.cornerRadius !== null && tool.cornerRadius > 0) {
    return { ok: false, reason: `tool "${tool.name}" has a corner radius of ${tool.cornerRadius} mm: a bull nose, whose constant-Z sweep is not a capsule` };
  }
  const d = tool.tipDiameter ?? tool.diameter;
  if (d === null || !(d > 0)) {
    return { ok: false, reason: `tool "${tool.name}" has no usable cutting diameter (tipdiameter=${tool.tipDiameter}, diameter=${tool.diameter})` };
  }
  return { ok: true, radius: d / 2 };
}
