/**
 * The Z1 post-processor (#173): toolpath IR → `.nc`.
 *
 * The IR (#172) is fully resolved and machine-independent: every axis is on every move, Z is
 * a work coordinate (0 = stock top, cuts negative), and the feeds are already on the moves.
 * This module is the ONLY place any of that becomes the Z1's dialect:
 *
 *  - the `;@MKR|` header the machine's UI reads (field for field, as Studio writes it), plus ONE
 *    `;@CM|` record of our own — `;@CM|TOOL|key=` (#332), which names the cutter by our registry
 *    key and which Studio ignores,
 *  - the machine-frame Z conversion is NOT here: the file's Z is work Z, and the controller
 *    supplies the offset exactly as it does for Studio's own files. The file assumes the
 *    operator set the origin (#207) — it emits NO probing or origin-setting command
 *    (decision 26: Smoothieware has no variables, so a static file cannot compute one), and
 *  - the body: the preamble, the modal sticky moves, and Studio's own ending.
 *
 * THE Z CONTRACT. Z = 0 is the probed TOP face of the part, and every cut is a negative Z
 * measured down from it. Nothing in the file references total part thickness — not nominal,
 * not measured — because the blank is printed engraved-face-down and the thickness error all
 * sits at the back face (decision 24). `PostContext.zDatum` is a required literal for exactly
 * this reason: a caller cannot post a file without stating the datum the Zs are measured from.
 *
 * THE ROTARY DIALECT (#240, `/Rotary.md` R6). A rotary-frame IR with the `'rotary-axis'` datum
 * is posted by its own emitter, in the vendor's rotary structure (`Rotation/NefertitiRough.nc`):
 * `%`, the plane/unit/work-offset line, `M5`, the tool change, the spindle, a fed line to the
 * safe height, `G01 Y0 Z<safe>`, the moves with A modal and Y never a word, then the firmware's
 * `G92.4A0S0` unwind as the LAST motion, `M9`, `M5`, `M30`. Work Z is the distance above the
 * axis, so the stock's surface is at Z = radius and "safe" is the radius plus `ir.safeZ`.
 *
 * NO `;@MKR` HEADER ON A ROTARY FILE. The vendor's rotary output carries none, and the round
 * stock's `STOCK`/`ORIGIN` forms are §9's open question. FOR THE BENCH, as a candidate only: the
 * decompiled Studio writer carries `;@MKR|STOCK|id=cylinder|diameter=<D>|length=<L>` — the field
 * ORDER there is INFERRED and has never been seen in a generated file, and no ORIGIN record for a
 * round job has been observed at all. Until a Studio-generated rotary `.nc` is read, this post
 * writes no `;@MKR` line whatsoever and says its provenance in `;@CM|` comments, because writing
 * the guessed form would be the invention the evidence rule forbids (§9).
 *
 * PROVENANCE. Every machine number comes from the `MillProfile` (#184); nothing about the
 * machine is typed here. The STRUCTURE — the header field list, the body order, the ending —
 * is written from `/Fabrication.md` §2 and the issue's implementation spec, which read it off
 * Studio's one Z1-generated sample; the rotary structure is read off the vendor's rotary files.
 * No vendor line is copied into this file.
 */

import type { CamMove, CamOperation, ToolpathIR } from '../cam/ir';
import { estimateIRCycleSeconds } from '../cam/ir';
import type { MillProfile } from '../machine';
import { surfaceLift, type SurfaceFrame } from '../engrave/surfacePlane';
import { formatFixed, sanitizeMkrValue } from './format';

/**
 * The context the post cannot get from the IR alone (#173).
 *
 * `zDatum` is deliberately a literal type: posting requires stating the datum every Z is
 * measured from, so the old failure mode — silently assuming the face is at Z0 — is a type
 * error, not a runtime accident. There are exactly two legal values (#237, `/Rotary.md` §3.3):
 * `'probed-top-face'` for the flat frame, and `'rotary-axis'` for the rotary frame (Z = radius
 * from the axis). Each is legal only with its own frame (#240): the flat emitter refuses the
 * rotary datum and the rotary emitter refuses the flat one, so a frame error is never a silent
 * posting.
 */
export interface PostContext {
  jobName: string;
  /** X, Y, Z in mm. The STOCK record's cuboid; NOT a depth input. */
  stock: { length: number; width: number; thickness: number };
  /** Free text for the `MKR MATERIAL` line. */
  materialName: string;
  /** The datum every Z in the file is measured from. Two legal values; see above. */
  zDatum: 'probed-top-face' | 'rotary-axis';
  /** Where X0 Y0 is. V1 supports one. */
  origin: 'topFrontLeft';
  /** package.json version. */
  camVersion: string;
  /**
   * The registry key of the job's cutter (#332) — the key `toolForJob` resolved, not the `Tool`'s
   * own fields. Required, like `zDatum`, because it is a statement the file has to make and the
   * post cannot derive it: the IR carries a MATERIALISED cutter, and a clone or a hand-typed
   * definition has no vendor `g_ID` for the `MKR` line to name (#212).
   */
  toolKey: string;
  /**
   * #624 — the fitted surface the FEED Zs were lifted against, when the program was posted via
   * {@link applySurfaceLift}. After #608 the local stock top is `lift(x, y)`, not work Z0, so the
   * air-cut check must judge a feed against that local top: a feed at `−depth + lift` is above 0
   * AND a correct cut whenever `lift > depth`. Absent (a flat post), the top is Z0 as before.
   */
  surface?: SurfaceFrame | null;
}

export type PostResult = { ok: true; text: string } | { ok: false; errors: string[] };

/**
 * Which of this FILE's two vacuum words it writes (#419 decision 4 / Q-E).
 *
 * A job cut as ONE program per tool leaves the vacuum ON across the bit change: the machine's mode
 * is a state, not a per-file promise, and switching it off between two files would let the chips
 * settle into the work while the operator changes the cutter. So the words are spread across the
 * RUN rather than repeated in every file:
 *
 *  - `'whole'` — this is the only program: on at the preamble, off at the ending. TODAY'S FILE,
 *    byte for byte, which is why it is the default.
 *  - `'first'` — the run's first program: on, and no off.
 *  - `'middle'` — neither word.
 *  - `'last'`  — the run's last program: no on, and an off at the ending.
 *  - `'none'`  — neither word, and `ir.air` is not consulted. The FRAME file uses this (Q-F): an
 *    air trace cuts nothing, so it neither wants the vacuum nor may it leave the mode changed for
 *    whatever the operator runs next.
 */
export type VacuumSpan = 'whole' | 'first' | 'middle' | 'last' | 'none';

/** Post-level options that are about this file's PLACE in a run, not about the machine. */
export interface PostOptions {
  /** Defaults to `'whole'` — a standalone file, as every file this app wrote before #419 was. */
  vacuum?: VacuumSpan;
}

/**
 * The CAM id the header claims. Whether the machine accepts a non-Studio id is #208 D1;
 * keeping it a single constant makes that answer a one-line change.
 */
export const CAM_ID = 'CaseMaker';
export const CAM_NAME = 'Case Maker';

/**
 * Studio's own end-of-program retract, `G0 Z15` (`Z1/TopClamp.nc`'s closing lines, verbatim).
 * It is above any work this post emits, and it is what the machine's reader was written for;
 * do not "improve" it to the IR's `safeZ`.
 */
export const FINAL_RETRACT_Z = 15;

/** One `;@MKR|` record: the tag, then `key=value` fields joined by `|`. */
function mkr(tag: string, ...fields: string[]): string {
  return fields.length === 0 ? `;@MKR|${tag}` : `;@MKR|${tag}|${fields.join('|')}`;
}

/**
 * The cycle-estimate sentence both dialects carry as a comment: what the figure assumes, and on
 * what numbers. A `;` comment, not a `;@MKR` record, so a header reader ignores it but the
 * operator does not; the rates are the profile's own, so the sentence cannot outlive them
 * (#242/#281).
 */
function cycleEstimateNote(machine: MillProfile): string {
  const rapid = machine.rapidEstimate;
  return (
    `; cycle estimate: cutting + rapids through the trapezoid, timed on ${machine.name}'s rapid model ` +
    `(${rapid.xyMmPerMin} mm/min XY, ${rapid.zMmPerMin} mm/min Z, ${rapid.accelMmPerS2} mm/s² accel, ` +
    `${rapid.source}) — a planning estimate, not a measured cycle time`
  );
}

/**
 * The rotary-frame emitter (#240): the vendor's rotary structure, with A resolved on every move.
 *
 * `ops` is the non-empty operation list `postZ1` filtered, and `errors` carries the refusals the
 * two dialects share; this function adds the rotary frame's own and returns them all. It writes
 * no `;@MKR` header (see the module header) and keeps provenance in `;@CM|` records.
 */
function postRotary(
  ir: ToolpathIR,
  ctx: PostContext,
  machine: MillProfile,
  ops: CamOperation[],
  errors: string[],
): PostResult {
  const radius = ir.rotary?.radius;
  const radiusOk = typeof radius === 'number' && Number.isFinite(radius) && radius > 0;
  if (!radiusOk) {
    errors.push(
      'the toolpath IR is a rotary-frame IR but does not state a usable stock radius (ir.rotary.radius): every Z in a rotary file is a distance above the axis, so the radius those Zs were written for has to be stated',
    );
  }
  if (ctx.zDatum !== 'rotary-axis') {
    errors.push(
      "zDatum 'probed-top-face' needs a flat-frame IR: this toolpath is rotary-frame, whose Zs are measured from the rotary axis, not from a top face",
    );
  }

  const surface = radiusOk ? (radius as number) : null;
  let moveIndex = 0;
  for (const op of ir.operations) {
    for (const move of op.moves) {
      // R5 — `a` is OPTIONAL on the type so every flat IR stays constructible unchanged, and the
      // post is where it becomes required: a rotary move with no A has no angular position, and
      // inventing one would cut a different path from the one CAM planned.
      if (move.a === undefined || !Number.isFinite(move.a)) {
        errors.push(
          `move ${moveIndex}: a rotary-frame IR needs a finite A position (degrees) on every move, and this one has ${move.a === undefined ? 'none' : String(move.a)}`,
        );
      }
      // R1 — the tool axis passes through the rotary axis, so work Y is 0 for the whole file.
      // The vendor's own files command Y three times at most and always 0.
      if (Math.abs(move.y) > 1e-9) {
        errors.push(
          `move ${moveIndex}: Y=${move.y} is not 0; a rotary job holds the tool over the axis, so every Y is 0`,
        );
      }
      // The rotary frame's version of the flat air-cut check: the stock's top is the RADIUS, so a
      // feed between the surface and the hop height above it cuts nothing (R6).
      if (move.kind === 'feed' && surface !== null && move.z > surface + 1e-9 && move.z < surface + ir.hopZ) {
        errors.push(
          `move ${moveIndex}: a cutting move at Z=${move.z} is above the stock's surface (Z > ${surface}) yet below the hop height above it: a cut in the air`,
        );
      }
      moveIndex++;
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const r = radius as number;
  const axis = (v: number): string => formatFixed(v, machine.dialect.axisPrecision);
  const feed = (v: number): string => formatFixed(v, machine.dialect.feedPrecision);
  /** Safe height in the AXIS frame: `safeZ` stays what the IR says — mm above the stock's top. */
  const safe = r + ir.safeZ;
  const safeWord = axis(safe);

  // The vendor's rotary file opens with a fed move to its safe height, and that move states a
  // rate. Use the program's own first feed, so the line names a rate this file is already known
  // to run at; a rapid-only program states the machine's ceiling.
  const firstFeed = ops.flatMap((op) => op.moves).find((move) => move.kind === 'feed');
  const preambleFeed = firstFeed !== undefined && firstFeed.kind === 'feed' ? firstFeed.f : machine.maxCutFeed;

  const lines: string[] = [
    '%',
    'G17 G21 G54 G90',
    'M5',
    `T${ir.toolNumber}M6`,
    // A FED move to a known height BEFORE the spindle starts (and before any XY travel), as the
    // vendor does: after the manual tool change the head's height is unknown, and the feed
    // establishes it without a rapid. The spindle comes on AFTER this move — the verifier's
    // `spindle-at-unknown-z` rule (#396) is right that `M3` before any Z is established spins the
    // cutter up wherever the last job left it, and a feed at the safe height cuts nothing.
    `G01 Z${safeWord} F${feed(preambleFeed)}`,
    // Y is stated here ONCE and is never a word again in this file (see `emit`).
    `G01 Y0 Z${safeWord}`,
    `M3 S${axis(ir.spindleRpm)}`,
    // Provenance, as `;@CM|` records the machine's reader ignores. There is deliberately no
    // `;@MKR` header: see the module header for the round-stock candidate and why it is not
    // written until the bench reads a Studio-generated rotary file.
    `;@CM|TOOL|key=${sanitizeMkrValue(ctx.toolKey)}`,
    `;@CM|ROTARY|radius=${axis(r)}`,
    cycleEstimateNote(machine),
  ];

  // Sticky modal state, exactly as the flat emitter keeps it, plus A.
  let lastX: string | null = null;
  let lastZ: string | null = null;
  let lastA: string | null = null;
  let lastF: string | null = null;

  // Y IS NEVER A WORD AFTER THE PREAMBLE, and that is a fact about the frame rather than an
  // omission: Studio's 4-axis mode forces the work Y to 0 and centres the origin on the rotary
  // axis, which is EXACTLY R6's frame (origin on the axis, Z = radius, Y ≡ 0, X along the axis).
  // `postRotary` refuses a move whose Y is not 0 rather than writing it, so leaving Y out cannot
  // hide a tool taken off the axis — the Y a reader sees is the one the preamble stated.
  const emit = (move: CamMove): void => {
    const fx = axis(move.x);
    const fz = axis(move.z);
    const fa = axis(move.a as number); // every move's `a` was validated above
    const code = move.kind === 'rapid' ? 'G0' : 'G1';
    const words: string[] = [];
    if (fx !== lastX) words.push(`X${fx}`);
    if (fz !== lastZ) words.push(`Z${fz}`);
    if (fa !== lastA) words.push(`A${fa}`);
    if (move.kind === 'feed') {
      const f = feed(move.f);
      // A rapid never carries an F — the rate is the controller's own seek rate (#184), and the
      // vendor's rotary rapids carry none either.
      if (f !== lastF) words.push(`F${f}`);
    }
    if (words.length === 0) return;
    lines.push(`${code} ${words.join(' ')}`);
    lastX = fx;
    lastZ = fz;
    lastA = fa;
    if (move.kind === 'feed') lastF = feed(move.f);
  };

  for (const op of ops) {
    // Every operation is readable on its own: its first move re-states X, Z and A in full.
    lastX = null;
    lastZ = null;
    lastA = null;
    for (const move of op.moves) emit(move);
  }

  // The vendor retracts to its safe height before the unwind, so the unwind is not the last thing
  // holding the tool at cutting depth.
  if (lastZ !== safeWord) {
    const words: string[] = [];
    if (lastX !== null) words.push(`X${lastX}`);
    words.push(`Z${safeWord}`);
    if (lastA !== null) words.push(`A${lastA}`);
    lines.push(`G0 ${words.join(' ')}`);
  }

  lines.push(
    // The firmware's rotary unwind, written EXACTLY as the vendor writes it, with no spaces: `S`
    // drops whole turns and keeps A modulo 360 (`R` would RESET it to that value). It is the
    // file's LAST motion word, and it leaves the axis at a known angle after a program whose A
    // ran unwound — the vendor's files end on it too.
    'G92.4A0S0',
    'M9',
    'M5',
    'M30',
  );

  return { ok: true, text: lines.join('\n') + '\n' };
}

/**
 * Turn a toolpath IR into a `.nc` program, or refuse with the reasons (never a silent
 * assumption).
 *
 * The frame picks the dialect, and each dialect refuses the other's context (#240): the flat
 * emitter refuses the `'rotary-axis'` datum and any move carrying an `a`, the rotary emitter
 * refuses the `'probed-top-face'` datum, a move with no `a`, a non-zero Y and an IR with no
 * stock radius. Both refuse an IR with no non-empty operation, a move with a non-finite
 * coordinate, a feed outside `(0, machine.maxCutFeed]`, the spindle speed above
 * `machine.maxRpm`, a cutting move above the stock but below `hopZ` (a cut in the air is a CAM
 * bug), and a machine with an automatic tool changer (this post writes the manual-change
 * dialect only).
 */
export function postZ1(
  ir: ToolpathIR,
  ctx: PostContext,
  machine: MillProfile,
  opts: PostOptions = {},
): PostResult {
  const errors: string[] = [];

  // An operation with no moves is SKIPPED, not refused: `generateEngrave` emits one for a
  // label whose region is empty, so operation numbers track label order (#173 comment).
  // Only when EVERY operation is empty is there nothing to post.
  const ops = ir.operations.filter((op) => op.moves.length > 0);
  if (ops.length === 0) {
    errors.push('the toolpath IR has no operation with any moves: nothing to post');
  }

  if (machine.hasATC) {
    errors.push(
      `the ${machine.name} has an automatic tool changer (hasATC = true); this post writes the manual-change dialect only`,
    );
  }

  if (!Number.isFinite(ir.spindleRpm) || ir.spindleRpm > machine.maxRpm) {
    errors.push(`spindle speed ${ir.spindleRpm} RPM exceeds the ${machine.name}'s ${machine.maxRpm} RPM ceiling`);
  }

  // The checks BOTH dialects owe: a finite position, and a feed the machine can run. Whether a
  // move's `a` is required or forbidden, and where the stock's top is, are the frame's own
  // questions — asked here for the flat frame, in `postRotary` for the rotary one.
  let moveIndex = 0;
  for (const op of ir.operations) {
    for (const move of op.moves) {
      if (!Number.isFinite(move.x) || !Number.isFinite(move.y) || !Number.isFinite(move.z)) {
        errors.push(`move ${moveIndex} has a non-finite coordinate (x=${move.x}, y=${move.y}, z=${move.z})`);
      }
      if (ir.frame === 'flat' && move.a !== undefined) {
        // #240 — the A word belongs to the rotary dialect; silently dropping it would post a
        // different path from the one CAM planned, so a flat IR carrying one is refused.
        errors.push(
          `move ${moveIndex}: the toolpath IR is flat-frame but this move carries A=${move.a}; the flat dialect has no A axis`,
        );
      }
      if (move.kind === 'feed') {
        if (!(move.f > 0) || move.f > machine.maxCutFeed) {
          errors.push(`move ${moveIndex}: feed ${move.f} mm/min is not in (0, ${machine.maxCutFeed}]`);
        }
        // A "cut" above the stock top but below the hop height is cutting air: the CAM or the
        // depth intent is wrong, and the machine would do it without complaint. #624 — after
        // #608's `applySurfaceLift` the local top is the plane's lift at this XY, not work Z0,
        // so a feed that only climbs by the plane's lift is a correct cut, not air; a flat post
        // (`surface` absent, or a flat plane) keeps the old `Z > 1e-9` refusal. The rotary
        // frame's equivalent is in `postRotary`, where the stock top is the radius.
        if (ir.frame === 'flat') {
          const top = ctx.surface ? surfaceLift(ctx.surface.plane, ctx.surface.z0, move.x, move.y) : 0;
          if (move.z > top + 1e-9 && move.z < ir.hopZ) {
            errors.push(
              `move ${moveIndex}: a cutting move at Z=${move.z} is above the stock top (Z > ${top}) yet below hopZ=${ir.hopZ}: a cut in the air`,
            );
          }
        }
      }
      moveIndex++;
    }
  }

  if (ir.frame === 'rotary') return postRotary(ir, ctx, machine, ops, errors);

  // ---- The flat frame only, from here on.
  if (ctx.zDatum === 'rotary-axis') {
    errors.push(
      "zDatum 'rotary-axis' needs a rotary-frame IR: this toolpath's Zs are measured from the probed top face, so posting it against the rotary axis would put every cut in the wrong place",
    );
  }

  if (errors.length > 0) return { ok: false, errors };

  // #419 decision 4 — this file's share of the run's vacuum words, decided ONCE here so the
  // preamble and the ending cannot disagree about which program they are in.
  const span = opts.vacuum ?? 'whole';
  const vacuumOn = ir.air && (span === 'whole' || span === 'first');
  const vacuumOff = ir.air && (span === 'whole' || span === 'last');

  const axis = (v: number): string => formatFixed(v, machine.dialect.axisPrecision);
  const feed = (v: number): string => formatFixed(v, machine.dialect.feedPrecision);
  const numberOrZero = (v: number | null): string => axis(v ?? 0);

  const { length: L, width: W, thickness: T } = ctx.stock;
  /** The profile's own rapid model, the one number set the cycle estimate is timed with (#281). */
  const rapid = machine.rapidEstimate;

  // ---- The `;@MKR|` header. Field for field, as Studio writes it (issue implementation spec).
  const header: string[] = [
    ';@MKR|BEGIN',
    ';@MKR|SCHEMA|v=1.0.0',
    mkr('MACHINE', `id=${machine.id}`, `name=${machine.name}`),
    mkr('MATERIAL', 'id=0', `name=${sanitizeMkrValue(ctx.materialName)}`),
    mkr('STOCK', 'id=cuboid', `length=${axis(L)}`, `width=${axis(W)}`, `height=${axis(T)}`, 'diameter=1'),
    // #208 D2: `length` = X, `width` = Y rests on ONE square sample (/Makera-Parity.md §6.1);
    // a non-square blank in Studio's own preview is what settles it. The x/y/z are the origin
    // relative to the stock's CENTRE, which is what the sample shows for topFrontLeft.
    mkr('ORIGIN', 'id=0', 'type_name=topFrontLeft', `x=${axis(-L / 2)}`, `y=${axis(-W / 2)}`, `z=${axis(T / 2)}`),
    mkr('CAM', `id=${CAM_ID}`, `name=${CAM_NAME}`, `v=${ctx.camVersion}`),
    ';@MKR|UNIT|value=MM',
    mkr(
      'TOOL',
      `number=${ir.toolNumber}`,
      `id=${ir.tool.id ?? 0}`,
      `name=${sanitizeMkrValue(ir.tool.name)}`,
      // #268/#187 — `type=` is written VERBATIM from the tool's own `typeText`, and only the FLAT
      // end mill's word (`Flat End`) was read out of a Studio sample: for a non-flat tool (a V-bit
      // whose `typeText` is `Engraving`) this is OUR word, not Studio's, because Studio's own value
      // for a non-flat tool has never been read. #268 is that read; until it is made, a file this
      // post writes for a V-bit states a type the machine's reader has not been shown to expect.
      `type=${sanitizeMkrValue(ir.tool.typeText)}`,
      `handlediameter=${numberOrZero(ir.tool.handleDiameter)}`,
      `sticklength=${numberOrZero(ir.tool.stickout)}`,
      `shoulderlength=${numberOrZero(ir.tool.shoulderLength)}`,
      `flutelength=${numberOrZero(ir.tool.fluteLength)}`,
      `diameter=${numberOrZero(ir.tool.diameter)}`,
      `tipdiameter=${numberOrZero(ir.tool.tipDiameter)}`,
      `cornerradius=${numberOrZero(ir.tool.cornerRadius)}`,
      `angle=${numberOrZero(ir.tool.angle)}`,
      `halfAngle=${numberOrZero(ir.tool.halfAngle)}`,
    ),
    // #268 — the mark that travels WITH the file, not just a note in this source. `type=` above is
    // written from the tool's own `typeText`, and a flat end mill's word (`Flat End`) is the only
    // one ever read out of a Studio sample; for a V-bit it is `Engraving`, OUR word. A reader of
    // the `.nc` (a person, a diff, the machine's own log) cannot tell a checked field from a
    // guessed one, so say so where the guess is. Emitted only for a non-flat cutter, and as a bare
    // `;` comment so Studio's own reader, which ignores what it does not know, is unaffected.
    ...(ir.tool.shape === 'flat'
      ? []
      : [
          `; type=${sanitizeMkrValue(ir.tool.typeText)} is UNVERIFIED against Makera Studio:` +
            ` a non-flat cutter's own word for this field, not one read out of a Studio sample`,
        ]),
    // #332: our own record, right after the one it qualifies, naming the cutter by OUR key — the
    // only way a file can say WHICH cutter it was written for when the cutter has no vendor `g_ID`
    // (a clone, a hand-typed definition: #212 keeps the id off them, so the MKR line says id=0).
    // Studio ignores a comment it does not know, so this cannot break the machine's own reader;
    // the `MKR` line above is left exactly as Studio writes it and the key never goes into it.
    `;@CM|TOOL|key=${sanitizeMkrValue(ctx.toolKey)}`,
    mkr('TIME', `seconds=${Math.round(estimateIRCycleSeconds(ir, rapid))}`),
    // #242/#281: the machine's screen shows the figure above as the job time, so say what it assumes
    // AND on what numbers. A `;` comment (not a `;@MKR` record), so the header reader ignores it but
    // the operator does not.
    cycleEstimateNote(machine),
    ...ops.map((op, i) => mkr('TOOLPATH', `number=${i + 1}`, `tool_number=${ir.toolNumber}`, `name=${sanitizeMkrValue(op.name)}`)),
    ';@MKR|END',
  ];

  // ---- The body.
  const body: string[] = ['G90 G21'];

  // Sticky modal state: the FORMATTED last-emitted axis words and feed. `null` means "not
  // established in this operation", which forces the next move to re-state the axis.
  let lastX: string | null = null;
  let lastY: string | null = null;
  let lastZ: string | null = null;
  let lastF: string | null = null;

  const emit = (move: CamMove): void => {
    const fx = axis(move.x);
    const fy = axis(move.y);
    const fz = axis(move.z);
    const code = move.kind === 'rapid' ? 'G0' : 'G1';
    const words: string[] = [];
    if (fx !== lastX) words.push(`X${fx}`);
    if (fy !== lastY) words.push(`Y${fy}`);
    if (fz !== lastZ) words.push(`Z${fz}`);
    if (move.kind === 'feed') {
      const f = feed(move.f);
      // A rapid NEVER carries an F: the rapid rate is the controller's own seek rate (#184),
      // and Studio's 25 rapids carry none.
      if (f !== lastF) words.push(`F${f}`);
    }
    if (words.length === 0) return; // a move that changes nothing emits no line
    body.push(`${code} ${words.join(' ')}`);
    lastX = fx;
    lastY = fy;
    lastZ = fz;
    if (move.kind === 'feed') lastF = feed(move.f);
  };

  ops.forEach((op, index) => {
    body.push(`;@MKR|TOOLPATH_START|toolpath_number=${index + 1}`);
    if (index === 0) {
      // The head's Z is unknown after a manual `M6`. The first line therefore lifts it in the
      // MACHINE frame (below), then Studio's own order follows: XY, the spindle, THEN Z stated
      // at the safe height — so no work-frame move ever runs from an unknown height. Seed the
      // sticky state with what these lines established.
      const first = op.moves[0]!;
      const x0 = axis(first.x);
      const y0 = axis(first.y);
      const safe = axis(ir.safeZ);
      body.push(
        '',
        `; T${ir.toolNumber}-${sanitizeMkrValue(ir.tool.name)}`,
        '',
        `T${ir.toolNumber} M6`,
      );
      // #283 — THE PROGRAM'S ACCESSORY IS THE VACUUM, AND THE FILE TURNS IT ON ITSELF. `M7` is
      // answered `ok` by this controller and blows nothing (never mind that no `M7`/`M9` appeared
      // in the 2026-10-07 traffic read at all): air via `M7` is a no-op on a Z1. What clears chips
      // is bare `M331`, "turning extend out mode on" — the code Studio's own Vacuum switch sends,
      // which the bench drove from our console around both 2026-10-12 first-chips runs
      // (`docs/bench/traces/2026-10-12-cut-rowA.log`) and which the maintainer runs for every real
      // cut. The switches are off at power-up and a file cannot assume where the last job left
      // them, so the program states this itself — which is why it belongs in the file. WHICH file
      // says it is the run's first (#419 decision 4): `vacuumOn` is false in a middle or last
      // program, because the mode is already on, and switching it off and back on across a bit
      // change is exactly what that decision avoids.
      if (vacuumOn) body.push('M331');
      // #384 — THE FILE LIFTS THE HEAD ITSELF, IN THE MACHINE FRAME. After a manual `M6` the
      // head's Z is wherever the last job left it, so an XY rapid at "whatever Z the head is
      // at" is the move that drives a tool through the work. `G53` is absolute in MACHINE
      // coordinates, which is the frame the clearance is known in: the controller can execute
      // this from an unknown work position, where a work-frame Z could not be trusted.
      // Studio covers this OUTSIDE the file (its "Goto path origin first" buffer runs
      // `G53 G0 Z-3` then `G90 G0 X Y`, #302 item 5); our app starts a job with `play` alone,
      // so the program has to be safe on its own. The verifier refuses a file that is not.
      body.push(`G53 G0 Z${axis(machine.toolChange.clearanceZ)}`);
      body.push(`G0 X${x0} Y${y0}`, `S${axis(ir.spindleRpm)} M3`, `G0 Z${safe}`);
      lastX = x0;
      lastY = y0;
      lastZ = safe;
      lastF = null;
    } else {
      // Every operation is readable on its own: the first move re-states X, Y and Z in full.
      lastX = null;
      lastY = null;
      lastZ = null;
    }
    for (const move of op.moves) emit(move);
  });

  // ---- Studio's own ending, verbatim.
  body.push(`G0 Z${axis(FINAL_RETRACT_Z)}`);
  // The other end of #283's `M331`: an explicit off. A mode left on would keep running after the
  // job — the bench rule is vacuum on for the cut, off when it is finished. Only the RUN's last
  // program writes it (#419 decision 4); a `'none'` frame file never does.
  if (vacuumOff) body.push('M332');
  body.push('M05', 'G28', 'M02');

  return { ok: true, text: [...header, '', ...body].join('\n') + '\n' };
}
