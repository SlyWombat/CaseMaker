/**
 * The work-holding checks for one setup (#428, §5.4 "consequences, checked per setup"), on the stock
 * as it enters the setup (`stockBefore`: its bounds after any facing, and the earlier setups' cuts) and
 * the setup's own cuts. Faces are found through the setup's ROTATION, so a check reads the face that
 * is really at the jaw, the ledge or the bed.
 *
 *   - `clamp-on-cut` (error): an EARLIER setup cut into a clamped face's grip band.
 *   - `cuts-clamped-face` (error): THIS setup cuts into a clamped face's grip band.
 *   - `rests-on-cut` (error): the face going DOWN is cut where it rests — the vise's ledge strips, or
 *     the whole seat on tape or the bracket unless a board carries it.
 *   - `cannot-seat` (error): the vise — stock no taller than the ledge step sits below the jaw tops.
 *   - `thin-grip` (warning): less than the shop's `setups.minGripMm` to grip. On the vise the jaws grip
 *     the ledge step (3.1 mm) of a seated stock, so this fires there only when the shop asks for more.
 *
 * The vise's ledge is a product constant (`fixture.ts`): its step is the grip band's height, and its
 * width the strips the stock rests on, along the jaws.
 */

import { LEDGE_STEP, LEDGE_WIDTH } from '../fixture';
import { faceAxis, machineSize, type Mat } from './orient';
import type { Box, Face, MountSpec, Orientation, Removal, SetupFinding, StockState } from './types';
import type { SetupsSettings } from './settings';

const EPS = 1e-6;

/** Whether a cut's box reaches a face of the stock's current bounds. */
function touches(box: Box, face: Face, bounds: Box): boolean {
  const { axis, high } = faceAxis(face);
  return high ? box.max[axis] >= bounds.max[axis] - EPS : box.min[axis] <= bounds.min[axis] + EPS;
}

function overlaps(box: Box, axis: 0 | 1 | 2, lo: number, hi: number): boolean {
  return box.min[axis] < hi - EPS && box.max[axis] > lo + EPS;
}

const names = (cs: Removal[]) => cs.map((c) => c.name).join(', ');

export function checkSetup(
  m: Mat,
  o: Orientation,
  mount: MountSpec,
  before: StockState,
  own: Removal[],
  settings: SetupsSettings,
): SetupFinding[] {
  const out: SetupFinding[] = [];
  const b = before.bounds;
  const height = machineSize(m, b).z;
  const down = o.bottom;
  const { axis: upAxis, high: downHigh } = faceAxis(down);
  /** The band `depth` mm up from the down face, along the stock's up axis. */
  const band = (depth: number): [number, number] => (downHigh ? [b.max[upAxis] - depth, b.max[upAxis]] : [b.min[upAxis], b.min[upAxis] + depth]);

  if (mount.kind === 'vise') {
    if (height <= LEDGE_STEP) {
      out.push({
        code: 'cannot-seat',
        severity: 'error',
        text: `the stock stands ${height} mm tall this way up — no taller than the vise's ${LEDGE_STEP} mm ledge step, so seated on the ledges its top would sit below the jaw tops`,
      });
    }
    const grip = Math.min(height, LEDGE_STEP);
    const [lo, hi] = band(grip);
    for (const [jawFace, jaw] of [
      [o.left, 'fixed'],
      [o.right, 'moving'],
    ] as const) {
      const prev = before.cuts.filter((c) => touches(c.box, jawFace, b) && overlaps(c.box, upAxis, lo, hi));
      if (prev.length > 0) {
        out.push({ code: 'clamp-on-cut', severity: 'error', text: `the ${jaw} jaw closes where an earlier setup cut the stock (${names(prev)})`, itemIds: prev.map((c) => c.id) });
      }
      const mine = own.filter((c) => touches(c.box, jawFace, b) && overlaps(c.box, upAxis, lo, hi));
      if (mine.length > 0) {
        out.push({ code: 'cuts-clamped-face', severity: 'error', text: `this setup cuts into the face on the ${jaw} jaw, inside its grip (${names(mine)})`, itemIds: mine.map((c) => c.id) });
      }
    }
    if (grip < settings.minGripMm) {
      out.push({ code: 'thin-grip', severity: 'warning', text: `the jaws grip ${grip} mm of the stock — less than the ${settings.minGripMm} mm the shop asks for` });
    }
    const jawAxis = faceAxis(o.left).axis;
    const strips: [number, number][] = [
      [b.min[jawAxis], b.min[jawAxis] + LEDGE_WIDTH],
      [b.max[jawAxis] - LEDGE_WIDTH, b.max[jawAxis]],
    ];
    const onLedge = before.cuts.filter((c) => touches(c.box, down, b) && strips.some(([a, z]) => overlaps(c.box, jawAxis, a, z)));
    if (onLedge.length > 0) {
      out.push({ code: 'rests-on-cut', severity: 'error', text: `the face going down sits on the ledges where an earlier setup cut it (${names(onLedge)})`, itemIds: onLedge.map((c) => c.id) });
    }
  } else {
    const seat = before.cuts.filter((c) => touches(c.box, down, b));
    if (seat.length > 0 && !mount.board) {
      out.push({
        code: 'rests-on-cut',
        severity: 'error',
        text: `the face going down sits ${mount.kind === 'tape' ? 'on the tape' : 'on the bed'} where an earlier setup cut it (${names(seat)}) — a board under it would carry it`,
        itemIds: seat.map((c) => c.id),
      });
    }
    if (height < settings.minGripMm) {
      out.push({ code: 'thin-grip', severity: 'warning', text: `the stock is only ${height} mm tall this way up — less than the ${settings.minGripMm} mm the shop asks for` });
    }
  }
  return out;
}
