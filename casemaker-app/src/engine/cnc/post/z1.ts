/**
 * The Z1 post-processor (#173): toolpath IR → `.nc`.
 *
 * The IR (#172) is fully resolved and machine-independent: every axis is on every move, Z is
 * a work coordinate (0 = stock top, cuts negative), and the feeds are already on the moves.
 * This module is the ONLY place any of that becomes the Z1's dialect:
 *
 *  - the `;@MKR|` header the machine's UI reads (field for field, as Studio writes it),
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
 * PROVENANCE. Every machine number comes from the `MachineProfile` (#184); nothing about the
 * machine is typed here. The STRUCTURE — the header field list, the body order, the ending —
 * is written from `/Fabrication.md` §2 and the issue's implementation spec, which read it off
 * Studio's one Z1-generated sample. No vendor line is copied into this file.
 */

import type { CamMove, ToolpathIR } from '../cam/ir';
import { estimateIRCycleSeconds, ASSUMED_RAPID_MM_MIN } from '../cam/ir';
import type { MachineProfile } from '../machine';
import { formatFixed, sanitizeMkrValue } from './format';

/**
 * The context the post cannot get from the IR alone (#173).
 *
 * `zDatum` is deliberately a literal type: posting requires stating the datum every Z is
 * measured from, so the old failure mode — silently assuming the face is at Z0 — is a type
 * error, not a runtime accident. There are exactly two legal values (#237, `/Rotary.md` §3.3):
 * `'probed-top-face'` for the flat frame, and `'rotary-axis'` for the rotary frame (Z = radius
 * from the axis). The second exists so "Z is radius" is expressible rather than smuggled; the
 * flat post still refuses to write it (R-3 adds rotary posting).
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
}

export type PostResult = { ok: true; text: string } | { ok: false; errors: string[] };

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
 * Turn a toolpath IR into a `.nc` program, or refuse with the reasons (never a silent
 * assumption).
 *
 * `zDatum` must be the probed top face. Refuses when the IR has no non-empty operation, a
 * move has a non-finite coordinate, a feed is outside `(0, machine.maxCutFeed]`, the spindle
 * speed is above `machine.maxRpm`, a cutting move sits above the stock but below `hopZ` (a
 * cut in the air is a CAM bug), the machine has an automatic tool changer (this post writes
 * the manual-change dialect only), or the IR is not the flat frame (#237: a rotary-frame IR,
 * or the `'rotary-axis'` datum, cannot be posted by the flat dialect).
 */
export function postZ1(ir: ToolpathIR, ctx: PostContext, machine: MachineProfile): PostResult {
  const errors: string[] = [];

  // An operation with no moves is SKIPPED, not refused: `generateEngrave` emits one for a
  // label whose region is empty, so operation numbers track label order (#173 comment).
  // Only when EVERY operation is empty is there nothing to post.
  const ops = ir.operations.filter((op) => op.moves.length > 0);
  if (ops.length === 0) {
    errors.push('the toolpath IR has no operation with any moves: nothing to post');
  }

  // A rotary-frame IR must not flow through this post unnoticed (#237): every Z in the flat
  // dialect is measured from the probed top face, but a rotary IR's Z is the radius from the
  // axis, so the two Zs are different quantities. There is no rotary posting until R-3.
  if (ir.frame === 'rotary') {
    errors.push(
      'the toolpath IR is a ROTARY-frame IR (work Z = radius from the axis); this post writes the flat 3-axis dialect only (#237 R-0; R-3 adds rotary posting)',
    );
  }
  if (ctx.zDatum === 'rotary-axis') {
    errors.push(
      "zDatum 'rotary-axis' is not postable: this post measures every Z from the probed top face (#237 R-0; R-3 adds rotary posting)",
    );
  }

  if (machine.hasATC) {
    errors.push(
      `the ${machine.name} has an automatic tool changer (hasATC = true); this post writes the manual-change dialect only`,
    );
  }

  if (!Number.isFinite(ir.spindleRpm) || ir.spindleRpm > machine.maxRpm) {
    errors.push(`spindle speed ${ir.spindleRpm} RPM exceeds the ${machine.name}'s ${machine.maxRpm} RPM ceiling`);
  }

  let moveIndex = 0;
  for (const op of ir.operations) {
    for (const move of op.moves) {
      if (!Number.isFinite(move.x) || !Number.isFinite(move.y) || !Number.isFinite(move.z)) {
        errors.push(`move ${moveIndex} has a non-finite coordinate (x=${move.x}, y=${move.y}, z=${move.z})`);
      }
      if (move.kind === 'feed') {
        if (!(move.f > 0) || move.f > machine.maxCutFeed) {
          errors.push(`move ${moveIndex}: feed ${move.f} mm/min is not in (0, ${machine.maxCutFeed}]`);
        }
        // A "cut" above the stock top but below the hop height is cutting air: the CAM or the
        // depth intent is wrong, and the machine would do it without complaint.
        if (move.z > 1e-9 && move.z < ir.hopZ) {
          errors.push(
            `move ${moveIndex}: a cutting move at Z=${move.z} is above the stock (Z > 0) yet below hopZ=${ir.hopZ}: a cut in the air`,
          );
        }
      }
      moveIndex++;
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const axis = (v: number): string => formatFixed(v, machine.dialect.axisPrecision);
  const feed = (v: number): string => formatFixed(v, machine.dialect.feedPrecision);
  const numberOrZero = (v: number | null): string => axis(v ?? 0);

  const { length: L, width: W, thickness: T } = ctx.stock;

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
    mkr('TIME', `seconds=${Math.round(estimateIRCycleSeconds(ir))}`),
    // #242: the machine's screen shows the figure above as the job time, so say what it assumes.
    // A `;` comment (not a `;@MKR` record), so the header reader ignores it but the operator does not.
    `; cycle estimate: cutting + rapids at an assumed ${ASSUMED_RAPID_MM_MIN} mm/min (PROVISIONAL, #208 D3 calibrates)`,
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
      // The head's Z is unknown after a manual `M6`. Studio positions XY first, starts the
      // spindle, THEN states Z at the safe height — so the first move never rapids in Z from
      // an unknown height. Seed the sticky state with what these lines established.
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
      if (ir.air) body.push('M7');
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
  if (ir.air) body.push('M9');
  body.push('M05', 'G28', 'M02');

  return { ok: true, text: [...header, '', ...body].join('\n') + '\n' };
}
