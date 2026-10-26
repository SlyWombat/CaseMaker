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
 * The EXACT sweeper takes a FLAT end mill only (`/Simulation.md` §4.5): its swept volume at
 * constant Z is exact 2D geometry, and `cuttingRadiusForSweep` refuses every other shape by name.
 * The column engine sweeps the rest it has a model for (#405 the V-bit, #382 the drill's point and
 * the thread mill's envelope); a ball or a bull nose is still refused everywhere (#222).
 */

import type { MkrRecord } from './gcode/types';
import { mkrNumber } from './gcode/mkrHeader';
import { isVShape, grooveRadiusAt, vCone, type VCone } from './vProfile';

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
  /** Tip → the collet nut's face at the seating this file records. Recorded, never a sweep input (#314). */
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
  // A corn bit IS a flat end mill, and Makera classifies it as one: its own database files the
  // twenty of them under the "Corn Bits" group INSIDE category 1, "Flat End" (#377). The geometry
  // the CAM cares about — a flat tip of the stated diameter — is the same for both, so the shape is
  // the same and only the chip-breaker teeth differ.
  //
  // Whole-word, unlike every check around it. Those are substrings because their words are long
  // enough to carry ("chamfer" cannot hide inside another word); `corn` is short enough to be
  // swallowed by a longer one, and "Corner Radius End Mill" is a real thing another header could
  // send — so `\b` keeps it from reading as a corn bit and keeps that word `unknown`.
  if (/\bcorn\b/.test(s)) return 'flat';
  // A single-flute "O" end mill is a flat end (#379): Makera files it in the "Single Flute Non
  // Metal" group under family "Flat End". Anchored to the START of the word, because a bare `flute`
  // would swallow "Two Flute Ball Nose" (a ball) — and, at the start, `O FLUTE` is what the box
  // code joins for these and what a store title leads with.
  if (/^o\s+flute\b/.test(s)) return 'flat';
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
 * cutter whose shoulder alone is 12 mm, so a non-positive value is UNKNOWN.
 *
 * #314 made it recorded-but-not-used: it round-trips through the file (`restart.ts`) and stays in
 * `Tool`, because it says what the job was generated with and the collar makes a seating
 * repeatable — but it is no longer a SWEEP INPUT. The nut's worst-case placement is derived from
 * the cutter's own shoulder length, so a 0 can no longer put a modelled nut at the tool tip and
 * manufacture `holder-into-fixture` errors out of nothing.
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

/**
 * Is this cutter on Makera's "for Metal" line, as stated by its NAME?
 *
 * The line is spelled two ways in a name, and Makera uses both:
 *
 *   - the `(Metal)` SUFFIX on a catalogue ROW's name (`3.175*12mm Flat End(Metal)`, the row the
 *     built-in `flat-3.175x12-metal` was copied from, the convention `catalogue.rs` records, #379
 *     review). Anchored to the END, so a name that merely mentions metal is not caught;
 *   - the phrase `for Metal` that the printed BOX LABEL carries (`Single Flute Engraving Bit for
 *     Metal - 1/8" Shank 60° * 0.1mm`, the maintainer's own 60° engraver). This is the form that
 *     reaches a JOB: an owned cutter is filed under an `inv:` key with `id = null` and the label's
 *     text as its name (`toolRegistry.inventoryEntryFor`), so no code is in the `Tool` to read and
 *     the name is the only statement left. The phrase is matched whole, followed by a delimiter, so
 *     a name like "for metal-free plastics" is not a claim about the line.
 *
 * The line has a THIRD statement — the printed BOX CODE's `-M-` segment (`C1-BIT-ENGRAVE-M-…`, read
 * by `registerCutter.parseBoxCode`) — which `registerCutter.isMetalTool` asks alongside this one,
 * for a `Tool` that carries a code as its `id` and a renamed or shortened name. The name reading
 * lives here alone so the two readers cannot drift about what a name means: two regexes would be
 * two chances to disagree about which line a cutter is on.
 */
export function isMetalCutterName(name: string): boolean {
  const n = name.trim();
  return /\(metal\)$/i.test(n) || /\bfor\s+metal\b(?![\w-])/i.test(n);
}

/**
 * The included cone angle a vendor LABEL states, or null when it states none (#658).
 *
 * A Makera catalogue row's `angle` field is empty for engravers — the angle lives only in the
 * label's text (`4*0.5mm*30º Engraving(Metal)`, `Single Flute Engraving Bit … 60° * 0.1mm`). The
 * degree sign is what makes the angle unambiguous against the other numbers the same string
 * carries: `3.175*1*4mm` names a 4 mm FLUTE (a length, no degree sign) and `3.175*12mm Flat End` a
 * 12 mm flute, so neither reads an angle. A number immediately before `°` or `º` is the included
 * angle, the number the operator knows it by.
 */
export function parseLabelAngle(text: string): number | null {
  const match = text.match(/(\d+(?:\.\d+)?)\s*[°º]/);
  if (match === null) return null;
  const angle = Number(match[1]);
  return Number.isFinite(angle) && angle > 0 ? angle : null;
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
 * The tool's cutting diameter, best effort: `tipDiameter` when it states one (the tip is what
 * cuts), `diameter` otherwise, `null` when it states neither.
 *
 * The ONE copy of this rule (#316 review). The header matcher, the sweep, the verifier, the run
 * sheet, the run record, the tool recommendation, the engravability findings and every place a
 * tool is listed or described all ask this function — `??` chains that could drift apart are
 * chances to disagree about which cutter a file names, and about whether two entries are the same
 * cutter at all.
 */
export function cuttingDiameter(tool: Tool): number | null {
  return tool.tipDiameter ?? tool.diameter;
}

/**
 * #699 — the cutting size the record honestly STATES, mm, or null when it states none.
 *
 * `cuttingDiameter` is a best effort and is right for matching a FILE against a cutter: a
 * `diameter=` on a flat end is its cut. For the SHANK-diameter kinds it is not. Makera writes the
 * 3.175 mm shank into `diameter` for an engraver, a drill and a chamfer, and the size that cuts is
 * `tipDiameter` or nothing. A chamfer's missing tip is a POINT in the geometry (`vCone` reads it
 * that way, #669), but a point is not a size a recommendation can state: a V-carve's groove width
 * at the colour plane IS the design, so a cutter that cannot say how wide it is cannot be the
 * computed pick.
 *
 * Zero and negative are unstated, not a size. The one rule, shared by the display form (#651/#687,
 * which needs an honest name) and the recommendation (#699, which needs a defensible default):
 * what the record says it cuts with.
 */
export const SHANK_DIAMETER_KINDS: ReadonlySet<ToolShape> = new Set(['engraving', 'chamfer', 'drill']);

export function statedCuttingSize(tool: Tool): number | null {
  const diameter = SHANK_DIAMETER_KINDS.has(tool.shape) ? tool.tipDiameter : (tool.tipDiameter ?? tool.diameter);
  return diameter === null || diameter <= 0 ? null : diameter;
}

/**
 * The vendor `g_ID` a tool actually STATES, or null when it has none (#316 review).
 *
 * `Tool.id` is the `id=` field verbatim, and a cutter with no vendor id does not leave the field
 * out: the post writes `id=${ir.tool.id ?? 0}` (`post/z1.ts`), so **`0` is the file's way of saying
 * "no `g_ID`"** — the clone and the hand-typed definition that #212 keeps the id off — and an empty
 * field says the same. A zero is therefore not an identity: `t_MakeraCutterList.g_ID` values are
 * long numbers, and no row anywhere carries `0`.
 *
 * It matters on both sides. In the matcher, a zero id must not let the id rung pair two ABSENCES and
 * call the result exact; in `headerSignature`, a file filed under `id=0` would share one remembered
 * pick with every other no-id file whatever shape it is — a 3.175 flat and a 6.35 ball — so each
 * reopen would overwrite the other's answer and neither would come back.
 *
 * The ONE copy of this rule, shared by the header matcher and `feeds.ts`, so two places cannot
 * disagree about whether a file named a cutter.
 */
export function vendorId(tool: Tool): string | null {
  const id = tool.id;
  return id === null || id === '' || id === '0' ? null : id;
}

/**
 * The radius the V1 sweep uses, or a refusal naming why. Only a flat end mill qualifies; a
 * flat end mill with a corner radius is a bull nose and is refused too, because its sweep at
 * constant Z is not a capsule.
 *
 * This is the EXACT 2.5D sweeper's contract and NOTHING else's (#405). A V-bit has no single
 * flat radius — its cutting width is a function of depth — so it is refused here by name and
 * simulated by the column engine's cone profile instead. Lifting THIS refusal is exactly what
 * the issue's `tool.ts` header forbids ("never simulate a V-bit as a flat end mill"): every
 * caller that needs a trace-capable cutter asks {@link cuttingForTrace}.
 */
export function cuttingRadiusForSweep(tool: Tool): RadiusResult {
  if (tool.shape !== 'flat') {
    return { ok: false, reason: `V1 sweeps a flat end mill only; tool "${tool.name}" is type "${tool.typeText || '(missing)'}" (${tool.shape})` };
  }
  if (tool.cornerRadius !== null && tool.cornerRadius > 0) {
    return { ok: false, reason: `tool "${tool.name}" has a corner radius of ${tool.cornerRadius} mm: a bull nose, whose constant-Z sweep is not a capsule` };
  }
  const d = cuttingDiameter(tool);
  if (d === null || !(d > 0)) {
    return { ok: false, reason: `tool "${tool.name}" has no usable cutting diameter (tipdiameter=${tool.tipDiameter}, diameter=${tool.diameter})` };
  }
  return { ok: true, radius: d / 2 };
}

/**
 * The cutter a TRACE path takes (#405): a flat end mill, OR a V-bit whose cone the column engine
 * can sweep. A trace follows the line, so nothing is offset from it and this is not a sweep
 * radius in `cuttingRadiusForSweep`'s sense — it is the geometry the two consumers that need it
 * read: the CAM's validation, and the `columnEngine`'s cone profile.
 *
 * `flat` carries the same radius `cuttingRadiusForSweep` would give (a bull nose is still refused,
 * for the same reason: its constant-Z sweep is not a capsule). `v` carries the CONE — the tip
 * radius and the flank angle — because that is what a V trace's cut actually depends on.
 *
 * A REGION (a label, a shape) is still flat-only: opening a glyph needs ONE cutting width, and a
 * V-bit's width is a function of depth, so a region item with a V tool is refused by name and the
 * medial-axis V-carve that would lift it stays in #221. This function does not know which kind of
 * item asked; the callers that build regions keep asking `cuttingRadiusForSweep`.
 */
export type TraceTool = { shape: 'flat'; radius: number } | { shape: 'v'; cone: VCone };
export type TraceToolResult = { ok: true; tool: TraceTool } | { ok: false; reason: string };

export function cuttingForTrace(tool: Tool): TraceToolResult {
  if (isVShape(tool)) {
    const cone = vCone(tool);
    if (cone === null) {
      return {
        ok: false,
        reason:
          `tool "${tool.name}" (${tool.typeText || tool.shape}) states no usable cone: a V trace needs a` +
          ` tip diameter (tipdiameter=${tool.tipDiameter}) and an angle (halfAngle=${tool.halfAngle}, angle=${tool.angle})`,
      };
    }
    return { ok: true, tool: { shape: 'v', cone } };
  }
  const flat = cuttingRadiusForSweep(tool);
  return flat.ok ? { ok: true, tool: { shape: 'flat', radius: flat.radius } } : flat;
}

/** Is this tool a cone the trace path takes? The one predicate the routing and the findings share. */
export function isVTraceTool(tool: Tool): boolean {
  const r = cuttingForTrace(tool);
  return r.ok && r.tool.shape === 'v';
}

/**
 * The half-opening a TRACE with this tool cuts at `depth` below the tip plane, mm — or `null` when
 * the tool cannot trace at all.
 *
 * ONE statement of a question three readers ask (#405): the region a trace's cut sweeps (the void
 * check's, and the oracle's), the stroke-merge check (#219) and the jaw reach (#369). A flat end
 * mill's answer does not depend on the depth, which is why the pre-#405 code could carry a single
 * radius around; a V-bit's does — the groove opens as it deepens — so the depth is an argument and
 * the callers that know an item's own depth pass it.
 */
export function traceRadiusAt(tool: Tool, depth: number): number | null {
  const r = cuttingForTrace(tool);
  if (!r.ok) return null;
  return r.tool.shape === 'v' ? grooveRadiusAt(r.tool.cone, depth) : r.tool.radius;
}

/** The drill-point angles a drill can have, degrees included — the one range the CAM and the sim check. */
export const DRILL_POINT_RANGE_DEG = { min: 60, max: 150 } as const;

/**
 * The included point angle a drill is assumed to have when neither its own record nor the shop's
 * `drill.pointAngleDeg` states one (chosen, not measured — #434 phase 1). It lives here, beside the
 * range and the resolver, rather than in `cam/drillBit.ts`, because `engrave/jobSetup.ts` needs the
 * same number for its depth checks and must not import the defaults client (the worker runs it).
 * `KNOWN_DEFAULTS`' fallback is this same value; the two are pinned equal in `camDrillBit.spec.ts`.
 */
export const DRILL_POINT_FALLBACK_DEG = 118;

export type DrillPointResult = { ok: true; deg: number; from: string; stated: boolean } | { ok: false; reason: string };

/**
 * The tip's depth below the full-diameter point: `(d / 2) / tan(angle / 2)`.
 *
 * The geometry is the drill's, not the CAM's: the planner states a blind hole's tip depth with it,
 * the simulator sweeps the point with it, and `validateJob` holds the tip to the blank's floor with
 * it. It is here for the same reason {@link DRILL_POINT_FALLBACK_DEG} is: `jobSetup` needs it and
 * importing `cam/drillBit` there would drag `defaultsClient` into the worker's realm.
 */
export function pointLength(diameter: number, includedAngleDeg: number): number {
  return diameter / 2 / Math.tan(((includedAngleDeg / 2) * Math.PI) / 180);
}

/**
 * A drill's INCLUDED point angle, and where it came from (#382, #434) — or why there is none.
 *
 * The drill's own `angle` when its record states one (a 0 is unset, as everywhere in this vocabulary),
 * else the shop's `drill.pointAngleDeg` as the caller read it, with that reading's source. The ONE
 * statement of the rule: the #434 CAM plans a hole's tip depth from it and the column engine sweeps
 * the point from it, so the planned point and the simulated point cannot disagree.
 */
export function drillPointAngle(tool: Tool, fallback: { deg: number; source: string }): DrillPointResult {
  const stated = tool.angle !== null && tool.angle > 0;
  const deg = stated ? (tool.angle as number) : fallback.deg;
  const from = stated
    ? `${tool.name}'s own record`
    : `the shop default drill.pointAngleDeg (${fallback.source} — the drill states none)`;
  if (!(deg >= DRILL_POINT_RANGE_DEG.min && deg <= DRILL_POINT_RANGE_DEG.max)) {
    return { ok: false, reason: `a ${deg}° point angle (${from}) is not a drill's — ${DRILL_POINT_RANGE_DEG.min} to ${DRILL_POINT_RANGE_DEG.max}° is` };
  }
  return { ok: true, deg, from, stated };
}
