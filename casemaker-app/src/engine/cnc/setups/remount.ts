/**
 * Mounting the stock for a setup (#428, §5.4 "the remount page") — as DATA, and the words for it.
 *
 * A DIRECTED STEP with its own "done" (Q17): the one "I am at the machine" covers the machine moving,
 * never a turn of the stock by hand.
 *
 * THE WORDS LEAD WITH LANDMARKS (#428 review): what STAYS where it is first ("keep the edge on the
 * fixed jaw on the fixed jaw"), then what moves, each named by where it is NOW and where it GOES —
 * never by the stock's own frame, which the operator cannot see. Every turn is a proper rotation
 * (`orient.ts`), so every instruction is one a person can make by hand.
 *
 * THE CONFIRMATION asks about an earlier feature the app can locate in the new mount — is it nearer
 * the fixed jaw or the moving one, nearer you or the back? — chosen so the mirror-image mount would
 * give the OTHER answer. When no earlier feature is lopsided enough to tell the two apart, there is no
 * question: `mirrorCheck` says plainly that a mirrored mount cannot be caught from here.
 */

import { FACE_VEC, apply, machineSize, toMachine, vecToFace, type Mat } from './orient';
import type { Face, MountSpec, RemountStep, Setup, StockState } from './types';

/** How far off-centre a feature must sit, mm, for its side to tell a mount from its mirror image. */
const LOPSIDED_MM = 1;

/** The fixture as a noun, for the step that has to move the stock from one to another. */
function holder(mount: MountSpec): string {
  return mount.kind === 'vise' ? 'vise' : mount.kind === 'bracket' ? 'bracket' : 'tape';
}

/**
 * Where the stock's left edge sits when it is put down unturned in the TARGET fixture. A fixture
 * change is not a turn about a reference that is holding the stock: the old fixture has let go, so
 * the words place the stock first and then turn it from there.
 */
function placedAgainst(mount: MountSpec): string {
  return mount.kind === 'vise'
    ? ', its left edge on the fixed jaw'
    : mount.kind === 'bracket'
      ? ', its left edge against the bracket’s long arm'
      : '';
}

/** A MACHINE face, as the operator names it at the machine. */
function where(f: Face, mount: MountSpec): string {
  switch (f) {
    case 'top':
      return 'up';
    case 'bottom':
      return 'down';
    case 'front':
      return 'nearest you';
    case 'back':
      return 'at the back';
    case 'left':
      return mount.kind === 'vise' ? 'on the fixed jaw' : mount.kind === 'bracket' ? 'against the bracket’s long arm' : 'at the left';
    case 'right':
      return mount.kind === 'vise' ? 'on the moving jaw' : 'at the right';
  }
}

/** Where a face GOES, as a verb phrase: "comes up", "goes onto the moving jaw", "goes to the back". */
function goes(f: Face, mount: MountSpec): string {
  switch (f) {
    case 'top':
      return 'comes UP';
    case 'bottom':
      return 'goes DOWN';
    case 'front':
      return 'comes nearest you';
    case 'back':
      return 'goes to the back';
    case 'left':
      return mount.kind === 'vise' ? 'goes onto the fixed jaw' : mount.kind === 'bracket' ? 'goes against the bracket’s long arm' : 'goes to the left';
    case 'right':
      return mount.kind === 'vise' ? 'goes onto the moving jaw' : 'goes to the right';
  }
}

/** What the face of the stock NOW at machine face `f` is called: "the face now up", "the edge now nearest you". */
function now(f: Face, mount: MountSpec): string {
  return f === 'top' || f === 'bottom' ? `the face now ${where(f, mount)}` : `the edge now ${where(f, mount)}`;
}

/** The turn from `from` to `to`, in landmark words: what stays first, then what moves. */
export function turnWords(from: Mat, to: Mat, mount: MountSpec): string[] {
  // A machine face's stock face before, and where that stock face is after.
  const goesTo = (mf: Face): Face => {
    // stock face s at machine mf under `from`: from·s = mf, so s = fromᵀ·mf.
    const v = FACE_VEC[mf];
    const s: [number, number, number] = [0, 1, 2].map((i) => from[0][i]! * v[0] + from[1][i]! * v[1] + from[2][i]! * v[2]) as [number, number, number];
    return vecToFace(apply(to, s));
  };
  const watched: Face[] = ['left', 'front', 'top'];
  const stays = watched.filter((f) => goesTo(f) === f);
  const moves = watched.filter((f) => goesTo(f) !== f);
  if (moves.length === 0) return [];
  const lines = stays.map((f) => `Keep ${f === 'top' || f === 'bottom' ? 'the face' : 'the edge'} ${where(f, mount)} where it is.`);
  for (const f of moves) lines.push(`Turn it so ${now(f, mount)} ${goes(goesTo(f), mount)}.`);
  return lines;
}

/** The landmark question for the stock as it will sit, or null with the reason none can be asked. */
function landmark(
  setupIndex: number,
  m: Mat,
  stock: StockState,
  visible: Face,
  mount: MountSpec,
): { confirm: RemountStep['confirm']; mirrorCheck: string | null } {
  const b = stock.bounds;
  const ms = machineSize(m, b);
  const size = [ms.x, ms.y, ms.z];
  let best: { name: string; axis: 0 | 1; nearLow: boolean; off: number } | null = null;
  for (const c of stock.cuts.filter((cut) => cut.opensTo.length > 0)) {
    // Only what the operator can SEE once mounted: a feature open to the face going up, or to a side.
    if (!c.opensTo.some((f) => f === visible || (f !== 'top' && f !== 'bottom'))) continue;
    const centre: [number, number, number] = [0, 1, 2].map((i) => (c.box.min[i]! + c.box.max[i]!) / 2) as [number, number, number];
    const p = toMachine(m, b, centre);
    for (const axis of [0, 1] as const) {
      const off = Math.abs(p[axis]! - size[axis]! / 2);
      if (off >= LOPSIDED_MM && (best === null || off > best.off)) best = { name: c.name, axis, nearLow: p[axis]! < size[axis]! / 2, off };
    }
  }
  if (best === null) {
    return {
      confirm: null,
      mirrorCheck:
        'no feature cut so far sits far enough off-centre to tell this mount from its mirror image — check the turn against the steps, edge by edge',
    };
  }
  const [low, high] = best.axis === 0 ? [where('left', mount), where('right', mount)] : [where('front', mount), where('back', mount)];
  const right = `nearer the side ${best.nearLow ? low : high}`;
  const wrong = `nearer the side ${best.nearLow ? high : low}`;
  // The right answer is not always first.
  const options = setupIndex % 2 === 0 ? [right, wrong] : [wrong, right];
  return {
    confirm: { question: `Look at ${best.name}: which side is it nearer?`, options, correct: options.indexOf(right) },
    mirrorCheck: null,
  };
}

/**
 * The step that mounts the stock for a setup, turning it from `from` (null: as supplied, top up).
 *
 * `fromMount` is the fixture the stock is coming OUT of. When it differs from `mount`, the step has
 * to say the stock leaves one fixture for another — "keep the edge on the fixed jaw" is a lie once
 * the vise has let go. The words place it unturned in the new fixture and then turn it there, and
 * the `rotate`/faces still come from the matrices, so a caller that ignores the words is unchanged.
 */
export function remountStep(
  setupIndex: number,
  from: Mat | null,
  to: Mat,
  faceUp: Face,
  mount: MountSpec,
  stock: StockState,
  fromMount: MountSpec | null = null,
): RemountStep | null {
  const I: Mat = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  const start = from ?? I;
  const stockAtFirst = (mf: Face): Face => {
    const v = FACE_VEC[mf];
    return vecToFace([0, 1, 2].map((i) => to[0][i]! * v[0] + to[1][i]! * v[1] + to[2][i]! * v[2]) as [number, number, number]);
  };
  const fixtureChange = from !== null && fromMount !== null && fromMount.kind !== mount.kind;
  // The FIRST mount has no "now" to turn from — the stock is in the operator's hands — so it is named
  // by the design's own faces, the one frame both the operator and the drawing share before any cut.
  // A FIXTURE CHANGE moves the stock between holders: it is placed unturned in the new one, then
  // turned from there, because the old fixture's references are no longer holding anything.
  const words =
    from === null
      ? faceUp === 'top'
        ? []
        : [
            `Mount it with the face the design calls ${faceUp} UP, its ${stockAtFirst('left')} ${where('left', mount)}, and its ${stockAtFirst('front')} ${where('front', mount)}.`,
          ]
      : fixtureChange
        ? [
            `Take the stock out of the ${holder(fromMount)} and put it in the ${holder(mount)} with the face that was up still up and its front edge nearest you${placedAgainst(mount)}.`,
            ...turnWords(I, to, mount),
          ]
        : turnWords(start, to, mount);
  if (from === null && words.length === 0) return null; // setup 1, top up: mounted as supplied
  const stockAt = (mf: Face): Face => {
    const v = FACE_VEC[mf];
    return vecToFace([0, 1, 2].map((i) => to[0][i]! * v[0] + to[1][i]! * v[1] + to[2][i]! * v[2]) as [number, number, number]);
  };
  const lm = landmark(setupIndex, to, stock, faceUp, mount);
  return {
    kind: 'remount',
    needsDone: true,
    rotate: rotationBetween(start, to),
    turnWords: words,
    faceDown: stockAt('bottom'),
    faceAgainstReference: stockAt('left'),
    confirm: lm.confirm,
    mirrorCheck: lm.mirrorCheck,
  };
}

/** The relative turn `to · fromᵀ`, named by its axis and angle when it is one this engine makes. */
function rotationBetween(from: Mat, to: Mat): RemountStep['rotate'] {
  const r = [0, 1, 2].map((i) => [0, 1, 2].map((j) => to[i]![0]! * from[j]![0]! + to[i]![1]! * from[j]![1]! + to[i]![2]! * from[j]![2]!));
  const trace = r[0]![0]! + r[1]![1]! + r[2]![2]!;
  if (trace === 3) return null;
  const about = r[0]![0] === 1 ? 'x' : r[1]![1] === 1 ? 'y' : null;
  if (about === null) return null; // a compound turn; the words carry it
  if (trace === -1) return { about, degrees: 180 };
  // A quarter turn: the sign by the right-hand rule.
  const s = about === 'x' ? r[2]![1]! : r[0]![2]!;
  return { about, degrees: s > 0 ? 90 : -90 };
}

/** Check the operator's answer: the mirror image is refused. With no question, nothing to check. */
export function checkRemountAnswer(step: RemountStep, answer: number): { ok: true } | { ok: false; reason: string } {
  if (step.confirm === null) return { ok: true };
  return answer === step.confirm.correct
    ? { ok: true }
    : { ok: false, reason: 'that is the mirror-image mount — take it out, turn it as the steps say, and answer again' };
}

/** The remount page's words (no picture yet): title, steps and the confirmation. */
export function describeRemount(
  setup: Setup,
  total: number,
  mount: MountSpec,
): { title: string; steps: string[]; confirm: RemountStep['confirm']; mirrorCheck: string | null } | null {
  const r = setup.remount;
  if (!r) return null;
  const holder =
    mount.kind === 'vise'
      ? 'Open the vise. Lift the stock out. Brush the ledges and the jaws.'
      : mount.kind === 'bracket'
        ? 'Loosen the clamps. Lift the stock off. Brush the board and the bracket.'
        : 'Lift the stock off the tape. Clean the bed and lay fresh tape.';
  const seat =
    mount.kind === 'vise'
      ? 'Seat it on the ledges and close the vise.'
      : mount.kind === 'bracket'
        ? 'Push it into the bracket’s corner on both faces. Refit the clamps on the uncut margin.'
        : 'Press it down onto the tape.';
  return {
    title: setup.index === 1 ? `Mount for setup 1 of ${total}` : `Remount for setup ${setup.index} of ${total}`,
    steps: [
      ...(setup.index === 1 ? [] : [holder]),
      ...r.turnWords,
      seat,
      'Check it does not rock. Then answer the question below — and press done only when it is mounted.',
    ],
    confirm: r.confirm,
    mirrorCheck: r.mirrorCheck,
  };
}
