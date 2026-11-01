/**
 * #814 — CHANGING A PCB JOB'S HOLDING REBUILDS THE TURNED-OVER SIDE.
 *
 * A two-sided board's setups were derived at import from the HOLDING the board was imported with
 * (#743 P-8): setup 2's mount, its orientation, and every item it cuts were built through
 * `orient('bottom', mount)`, whose flip axis follows the mount — a half turn about machine X for
 * the vise, about Y for the tape and the bracket. Changing the holding afterwards used to change
 * `workholding` alone, so the job said "taped" while setup 2 still said "vise" and its bottom
 * copper was still mirrored about the OTHER axis: two answers to "how is it held", and a bottom
 * side that no longer lands on the holes when the board is turned the way the new mount turns it.
 *
 * THE RE-DERIVE. For each setup whose mount is the OLD holding's kind — i.e. one the import
 * derived, not one a person set — the setup is rebuilt to the new mount: its face-up turn is
 * `orient(up, newMount)`, and every item it owns is moved from the old work frame into the new
 * one through the two rigid maps the engine already owns (`toMachine` for each turn). Frames and
 * cut-outs follow their referenced item by id, so they are not transformed twice.
 *
 * WHAT IS KEPT, AND SAID. A setup whose mount is NOT the old holding's kind was set by hand, and
 * it keeps its mount and its turn; a setup standing on a face the new mount cannot hold (a side
 * face on tape) is kept for the same reason. Both are returned in `kept` so the caller can state
 * the difference once — never silently.
 *
 * The alignment holes (#743 P-8) are the caller's: they were offered on the OLD flip's fixed line,
 * and the caller re-offers them for the new mount (`pcbAlignmentOffer`) and passes the two lists
 * in; matching setup-1 drills are moved to the new line, or removed when the new mount has no
 * line to offer.
 */

import { apply, orient, toMachine, type Mat } from '@/engine/cnc/setups/orient';
import type { Box, Face, MountSpec } from '@/engine/cnc/setups/types';
import type { EngraveJob, EngraveVectorShape, JobSetup } from '@/types/engraveJob';

type Point = [number, number];

export interface ReHoldResult {
  job: EngraveJob;
  /** Setups re-derived to the new mount. */
  moved: number;
  /** Setups kept as they were, each with the sentence the caller shows. */
  kept: { setupId: string; reason: string }[];
  /** What happened to the import's alignment holes. */
  alignment: 'none' | 'moved' | 'removed';
}

/** The stock's box in its own frame, from a job's stock. */
function stockBox(job: EngraveJob): Box {
  return { min: [0, 0, 0], max: [job.stock.length, job.stock.width, job.stock.thickness] };
}

/** The `min` corner `toMachine` subtracts for this matrix (the box's rotated minimum). */
function frameMin(m: Mat, bounds: Box): [number, number, number] {
  const corners: [number, number, number][] = [];
  for (const x of [bounds.min[0], bounds.max[0]])
    for (const y of [bounds.min[1], bounds.max[1]])
      for (const z of [bounds.min[2], bounds.max[2]]) corners.push(apply(m, [x, y, z]));
  return [0, 1, 2].map((i) => Math.min(...corners.map((c) => c[i]!))) as [number, number, number];
}

/** A point in a setup's work frame, carried into the other setup's work frame by their two turns. */
function carry(oldM: Mat, newM: Mat, bounds: Box, p: Point): Point {
  // work → stock: the inverse of `toMachine` (M is a proper rotation, so its inverse is Mᵀ).
  const oldMin = frameMin(oldM, bounds);
  const q: [number, number, number] = [p[0] + oldMin[0], p[1] + oldMin[1], 0];
  const stock: [number, number, number] = [
    oldM[0][0] * q[0] + oldM[1][0] * q[1] + oldM[2][0] * q[2],
    oldM[0][1] * q[0] + oldM[1][1] * q[1] + oldM[2][1] * q[2],
    oldM[0][2] * q[0] + oldM[1][2] * q[1] + oldM[2][2] * q[2],
  ];
  const moved = toMachine(newM, bounds, stock);
  return [moved[0], moved[1]];
}

/** Apply a point map to a vector item, keeping `position + contour` the sum it was (the bbox centre). */
function moveVector(item: EngraveVectorShape, map: (p: Point) => Point): EngraveVectorShape {
  const moved = item.contours.map((ring) => ring.map(([x, y]) => map([x + item.position.x, y + item.position.y])));
  const flat = moved.flat();
  if (flat.length === 0) return { ...item };
  const xs = flat.map((p) => p[0]);
  const ys = flat.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return {
    ...item,
    contours: moved.map((ring) => ring.map(([x, y]): Point => [x - cx, y - cy])),
    position: { x: cx, y: cy },
    width: maxX - minX,
    height: maxY - minY,
  };
}

/** The mount spec the job's current holding stands for (only the kind matters to `orient`). */
export function mountSpecOf(job: EngraveJob): MountSpec {
  const kind = job.workholding.kind;
  if (kind === 'tape') return { kind: 'tape' };
  if (kind === 'bracket') return { kind: 'bracket' };
  return { kind: 'vise' };
}

/** The board's box on the blank, read off the imported outline item (its absolute contours). */
export function pcbBoardBox(job: EngraveJob): { left: number; top: number; width: number; height: number } | null {
  const outline = (job.vectors ?? []).find((v) => /^Board outline/.test(v.name ?? ''));
  if (outline === undefined) return null;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const ring of outline.contours) {
    for (const [x, y] of ring) {
      xs.push(x + outline.position.x);
      ys.push(y + outline.position.y);
    }
  }
  if (xs.length === 0) return null;
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return { left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
}

/**
 * The alignment holes the import's offer added: setup-1 drills the offer itself names. Their
 * positions are in setup 1's frame; a re-hold matches these exact points.
 */
export function alignmentHolesOf(job: EngraveJob): Point[] {
  return (job.drills ?? []).filter((d) => /alignment hole$/.test(d.name ?? '')).map((d) => [d.position.x, d.position.y]);
}

/**
 * #814 — WHAT THE RE-HOLD DID, in the one sentence the panel shows after the press. Null when the
 * board had no setups (the plain one-click), so a single-sided board's message is unchanged.
 */
export function pcbReHoldNote(result: {
  moved: number;
  kept: readonly { setupId: string; reason: string }[];
  alignment: 'none' | 'moved' | 'removed';
  twoSided: boolean;
}): string | null {
  if (!result.twoSided) return null;
  const parts: string[] = [];
  if (result.moved > 0) parts.push('the turned-over side is taped and turns the way a taped board turns');
  for (const keep of result.kept) parts.push(`a setup is left as it was: ${keep.reason}`);
  if (result.alignment === 'moved') parts.push('the alignment holes moved onto the tape flip’s line');
  if (result.alignment === 'removed') parts.push('the alignment holes were removed — the tape flip has no line to offer');
  return parts.length === 0 ? null : `${parts.join('; ')}.`;
}

export interface AlignmentCarry {
  /** The holes the old mount's offer placed, in setup 1's frame. */
  old: readonly Point[];
  /** The holes the new mount's offer places, in setup 1's frame (empty: none is possible). */
  next: readonly Point[];
}

/**
 * Re-derive every setup the import made for the OLD holding. Pure: the caller writes
 * `workholding` itself and shows the sentences this returns.
 */
export function reHoldPcbJob(
  job: EngraveJob,
  newMount: MountSpec,
  alignment: AlignmentCarry | null,
): ReHoldResult {
  const setups = job.setups;
  if (setups === undefined || setups.length === 0) return { job, moved: 0, kept: [], alignment: 'none' };
  const oldMount = mountSpecOf(job);
  const size = { x: job.stock.length, y: job.stock.width, z: job.stock.thickness };
  const bounds = stockBox(job);
  const kept: { setupId: string; reason: string }[] = [];
  let moved = 0;
  const itemMoves = new Map<string, (p: Point) => Point>();

  const nextSetups = setups.map((setup) => {
    if (setup.mount.kind !== oldMount.kind) {
      kept.push({
        setupId: setup.id,
        reason: 'it is held your own way — its mount is not the holding the board was imported with, so it is left as you set it; change it in Setups',
      });
      return setup;
    }
    const up: Face = setup.orientation.top;
    const old = orient(up, oldMount, size);
    const next = orient(up, newMount, size);
    if (!old.ok || !next.ok) {
      kept.push({
        setupId: setup.id,
        reason: next.ok ? 'its turn could not be re-derived' : `the ${newMount.kind === 'tape' ? 'tape' : newMount.kind} cannot hold the stock ${up} face up, so this setup is left as it was`,
      });
      return setup;
    }
    const mount: JobSetup['mount'] = { ...newMount };
    if (JSON.stringify(old.orientation) === JSON.stringify(next.orientation)) {
      // Same turn (setup 1, or a flip whose axis the two mounts share): the mount word changes.
      moved += 1;
      return { ...setup, mount };
    }
    // The setup's OWN items are its frames and cut-outs; the shapes they follow are the
    // referenced vectors (`frame.around`, `cutout.of`, a cutaway's outer and islands), which must
    // move too — the frame and the cut-out then follow their target by id, un-moved themselves.
    const referenced = new Set<string>(setup.itemIds);
    for (const id of setup.itemIds) {
      const frame = (job.combined ?? []).find((c) => c.id === id) as Record<string, unknown> | undefined;
      if (frame !== undefined) {
        for (const key of ['around', 'outer'] as const) if (typeof frame[key] === 'string') referenced.add(frame[key] as string);
        const islands = frame.islands;
        if (Array.isArray(islands)) for (const island of islands) if (typeof island === 'string') referenced.add(island);
      }
      const cutout = (job.cutouts ?? []).find((c) => c.id === id) as Record<string, unknown> | undefined;
      if (cutout !== undefined && typeof cutout.of === 'string') referenced.add(cutout.of);
    }
    for (const id of referenced) {
      itemMoves.set(id, (p) => carry(old.matrix, next.matrix, bounds, p));
    }
    moved += 1;
    return { ...setup, mount, orientation: { ...next.orientation } };
  });

  if (moved === 0) return { job, moved, kept, alignment: 'none' };

  // The items: vectors are carried into their setup's new frame. A moved setup that owns anything
  // else (a shape, a drill, a label) keeps its OLD mount rather than half-move what it cuts — the
  // board's own sides are vectors, frames and cut-outs, so this is a hand edit speaking.
  const unmovable =
    moved > 0 &&
    nextSetups.some((setup) =>
      setup.itemIds.some((id) => {
        const isVector = (job.vectors ?? []).some((v) => v.id === id);
        const isFollows = [...(job.combined ?? []), ...(job.cutouts ?? [])].some((c) => c.id === id);
        return itemMoves.has(id) && !isVector && !isFollows;
      }),
    );
  if (unmovable) {
    return {
      job,
      moved: 0,
      kept: [{ setupId: setups[0]!.id, reason: 'a setup on this board also owns an item that is not a mirrored outline, so the whole re-derive is left alone; change the setups by hand' }],
      alignment: 'none',
    };
  }

  const mapOf = (id: string): ((p: Point) => Point) | undefined => itemMoves.get(id);
  const vectors = (job.vectors ?? []).map((v) => {
    const map = mapOf(v.id);
    return map === undefined ? v : moveVector(v, map);
  });

  // The alignment holes: drills of setup 1 that sit on the OLD offer's line are moved to the new
  // one — or dropped when the new mount offers none, with the caller's sentence.
  let alignmentOutcome: ReHoldResult['alignment'] = 'none';
  let drills = job.drills ?? [];
  if (alignment !== null && alignment.old.length > 0) {
    const onOld = (d: { position: { x: number; y: number } }): boolean =>
      alignment.old.some(([x, y]) => Math.abs(d.position.x - x) < 1e-6 && Math.abs(d.position.y - y) < 1e-6);
    const matches = drills.filter((d) => onOld(d));
    if (matches.length > 0) {
      if (alignment.next.length === 0) {
        const drop = new Set(matches.map((d) => d.id));
        drills = drills.filter((d) => !drop.has(d.id));
        alignmentOutcome = 'removed';
      } else {
        let index = 0;
        drills = drills.map((d) => {
          if (!onOld(d)) return d;
          const at = alignment.next[Math.min(index, alignment.next.length - 1)]!;
          index += 1;
          return { ...d, position: { x: at[0], y: at[1] } };
        });
        alignmentOutcome = 'moved';
      }
    }
  }

  return {
    job: {
      ...job,
      setups: nextSetups,
      vectors,
      ...(alignmentOutcome === 'none' ? {} : { drills }),
    },
    moved,
    kept,
    alignment: alignmentOutcome,
  };
}
