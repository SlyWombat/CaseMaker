/**
 * #845 — THE GRBL 1.1 POST: toolpath IR → `.nc` for a machine run from the operator's own sender.
 *
 * The same contract as `post/z1.ts` (the IR is machine-independent; THIS module is the only place
 * it becomes a dialect), for the other half of the desktop-router world: GRBL 1.1 speaks plain
 * G-code — G21 G90, M3/M5 spindle, M8/M9 coolant, work offsets G54…G59 — and has NO tool changer,
 * so a tool change is a PAUSE (`M0`) with the tool named in a comment: the operator changes the
 * bit, re-zeroes Z, and resumes.
 *
 * WHAT THIS POST DELIBERATELY DOES NOT WRITE:
 *   - the `;@MKR|` header (Makera Studio's dialect, not GRBL's) — the header here is a `;` comment
 *     block: job, machine, dialect, stock, origin and the cutter, as text a person reads;
 *   - `M6`/`T` (no changer), `M331`/`M332` (Smoothie accessories), `G28` (its meaning depends on
 *     the sender's homing setup; the file retracts instead), `M7` (the Z1's vacuum no-op);
 *   - `G53` before a tool change: the machine frame of a GRBL router is the operator's, and a
 *     machine-coordinate lift from an unknown position is the move that crashes one. The file
 *     lifts in WORK coordinates after the pause and says, in the pause's own comment, that Z must
 *     be re-zeroed on the new bit.
 *
 * A ROTARY IR is refused by name: a 4th axis is the machine's to state, and a generic profile
 * states three.
 */

import type { CamMove, ToolpathIR } from '../cam/ir';
import { estimateIRCycleSeconds } from '../cam/ir';
import { dialectOf, type Mill } from '../machine';
import { surfaceLift } from '../engrave/surfacePlane';
import { formatFixed } from './format';
import type { PostContext, PostOptions, PostResult } from './z1';

/** The safe height a GRBL file retracts to at its end, mm above the work zero. */
export const GRBL_FINAL_RETRACT_Z = 10;

/**
 * Post an IR in the GRBL 1.1 dialect. The checks are the Z1's own (finite positions, a feed the
 * machine can run, the spindle ceiling, no A in a flat frame) plus this dialect's refusals: a
 * rotary frame, or an automatic changer the machine does not have.
 */
export function postGrbl(ir: ToolpathIR, ctx: PostContext, machine: Mill, opts: PostOptions = {}): PostResult {
  const errors: string[] = [];
  const ops = ir.operations.filter((op) => op.moves.length > 0);
  if (ops.length === 0) errors.push('the toolpath IR has no operation with any moves: nothing to post');
  if (ir.frame === 'rotary') {
    errors.push(
      'a rotary program needs a fourth axis, and this GRBL machine states three: cut the job on a flat blank, or use a machine with an A axis',
    );
  }
  if (ctx.zDatum === 'rotary-axis') {
    errors.push("zDatum 'rotary-axis' needs a rotary-frame IR: these Zs are measured from the probed top face");
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
      if (ir.frame === 'flat' && move.a !== undefined) {
        errors.push(`move ${moveIndex}: a flat-frame program carries A=${move.a}, and this machine has no A axis`);
      }
      if (move.kind === 'feed') {
        if (!(move.f > 0) || move.f > machine.maxCutFeed) {
          errors.push(`move ${moveIndex}: feed ${move.f} mm/min is not in (0, ${machine.maxCutFeed}]`);
        }
        const top = ctx.surface ? surfaceLift(ctx.surface.plane, ctx.surface.z0, move.x, move.y) : 0;
        if (move.z > top + 1e-9 && move.z < ir.hopZ) {
          errors.push(
            `move ${moveIndex}: a cutting move at Z=${move.z} is above the stock top (Z > ${top}) yet below hopZ=${ir.hopZ}: a cut in the air`,
          );
        }
      }
      moveIndex++;
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  // #845 — the formatting is the machine's own table through `dialectOf`: a framed Makera run in
  // GRBL mode and a stated GRBL machine both read one function, so the grid cannot differ.
  const dialect = dialectOf(machine);
  const axis = (v: number): string => formatFixed(v, dialect.axisPrecision);
  const feed = (v: number): string => formatFixed(v, dialect.feedPrecision);
  const span = opts.vacuum ?? 'whole';
  const coolantOn = ir.air && (span === 'whole' || span === 'first');
  const coolantOff = ir.air && (span === 'whole' || span === 'last');
  const { length: L, width: W, thickness: T } = ctx.stock;
  const rapid = machine.rapidEstimate;
  // #845 — THE WORK ORIGIN the file is written against. `topFrontLeft` writes the IR's own work
  // coordinates (X0 Y0 at the stock's front-left corner); `topCentre` writes them about the stock's
  // centre, which is the convention most GRBL senders offer, so every X/Y moves by half the stock.
  // The Zs are untouched: both origins put Z0 on the probed top face.
  const centre = ctx.origin === 'topCentre';
  const dx = centre ? -L / 2 : 0;
  const dy = centre ? -W / 2 : 0;

  // ---- The header: a `;` comment block, the dialect's own words (no `;@MKR`). ----
  const header: string[] = [
    `; Case Maker — ${ctx.jobName}`,
    `; dialect: GRBL 1.1`,
    `; machine: ${machine.name}`,
    `; tool: T${ir.toolNumber} ${ir.tool.name} (${ctx.toolKey})`,
    `; stock: ${axis(L)} x ${axis(W)} x ${axis(T)} mm, ${ctx.materialName}`,
    `; origin: ${ctx.origin} — X0 Y0 at the stock's ${centre ? 'centre' : 'front-left'}, Z0 on the probed top face`,
    `; estimated cycle time: ${Math.round(estimateIRCycleSeconds(ir, rapid))} s`,
    ...ops.map((op, i) => `; toolpath ${i + 1}: ${op.name}`),
  ];

  // ---- The body. ----
  const body: string[] = ['G21 G90', 'G54'];
  let lastX: string | null = null;
  let lastY: string | null = null;
  let lastZ: string | null = null;
  let lastF: string | null = null;
  const emit = (move: CamMove): void => {
    const fx = axis(move.x + dx);
    const fy = axis(move.y + dy);
    const fz = axis(move.z);
    const code = move.kind === 'rapid' ? 'G0' : 'G1';
    const words: string[] = [];
    if (fx !== lastX) words.push(`X${fx}`);
    if (fy !== lastY) words.push(`Y${fy}`);
    if (fz !== lastZ) words.push(`Z${fz}`);
    if (move.kind === 'feed') {
      const f = feed(move.f);
      if (f !== lastF) words.push(`F${f}`);
    }
    if (words.length === 0) return;
    body.push(`${code} ${words.join(' ')}`);
    lastX = fx;
    lastY = fy;
    lastZ = fz;
    if (move.kind === 'feed') lastF = feed(move.f);
  };

  ops.forEach((op, index) => {
    const first = op.moves[0]!;
    if (index === 0) {
      // A MANUAL TOOL CHANGE IS A PAUSE (#845): the machine has no changer, so the operator
      // changes the bit here. The pause's comment names the tool and the one thing that must be
      // done before the next line — re-zero Z on the new bit, or the file's safe height is
      // measured from the old one.
      body.push(
        '',
        `; change to T${ir.toolNumber} ${ir.tool.name} — then re-zero Z on the top face and resume`,
        'M0',
        '',
      );
      if (coolantOn) body.push('M8');
      body.push(`G0 Z${axis(ir.safeZ)}`, `G0 X${axis(first.x + dx)} Y${axis(first.y + dy)}`, `M3 S${axis(ir.spindleRpm)}`);
      lastX = axis(first.x + dx);
      lastY = axis(first.y + dy);
      lastZ = axis(ir.safeZ);
      lastF = null;
    } else {
      lastX = null;
      lastY = null;
      lastZ = null;
    }
    body.push(`; toolpath ${index + 1}: ${op.name}`);
    for (const move of op.moves) emit(move);
    body.push(`G0 Z${axis(ir.safeZ)}`);
    lastZ = axis(ir.safeZ);
  });

  body.push(`G0 Z${axis(GRBL_FINAL_RETRACT_Z)}`);
  if (coolantOff) body.push('M9');
  body.push('M5', 'M30');

  return { ok: true, text: [...header, '', ...body].join('\n') + '\n' };
}
