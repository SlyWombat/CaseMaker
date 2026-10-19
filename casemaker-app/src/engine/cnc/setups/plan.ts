/**
 * The setups planner (#428 phase 1, §5.4 "planning from the geometry"). Pure.
 *
 *   1. Each removal says which faces it opens to (the CAM split a target object's regions already).
 *   2. Directions are chosen GREEDILY: the one reaching the most volume first (a tie goes to the face
 *      the operator chose up), then the next for what is left. A removal joins the first chosen
 *      direction it opens to.
 *   3. Each direction becomes a mount the location can hold (`orient.ts`); one it cannot is reported
 *      `unholdable`, with its items, and the rotary offered when the stock fits it.
 *   4. ORDER: the chosen face first, then the rest by the volume they remove, ascending — removing less
 *      first leaves the most for the next setup to grip.
 *
 * The stock state is CARRIED: setup N+1's `stockBefore` is setup N's `stockAfter`, and the checks
 * (`checks.ts`) read it. The operator's edits ({@link editSetups}) re-run the same validation.
 */

import { checkSetup } from './checks';
import { faceAxis, orient } from './orient';
import { remountStep } from './remount';
import type { SetupsSettings } from './settings';
import type { Box, Face, MountSpec, Removal, Setup, SetupsInput, SetupsPlan, StockState } from './types';

/**
 * How the plan holds a setup whose up face is `face`: its own mount when `mounts` names one, else the
 * input's default. Exported because the section renders a setup's mount from the same reading the
 * planner used, and two answers to "which fixture is this?" would be one too many.
 */
export function mountFor(input: SetupsInput, face: Face): MountSpec {
  return input.mounts?.[face] ?? input.mount;
}

const SIDES: readonly Face[] = ['left', 'right', 'front', 'back'];

function rotaryFits(
  stock: { x: number; y: number; z: number },
  envelope: { diameter: number; length: number },
): boolean {
  const dims = [stock.x, stock.y, stock.z].sort((a, b) => a - b);
  return Math.hypot(dims[0]!, dims[1]!) <= envelope.diameter && dims[2]! <= envelope.length;
}

/** Group the removals into directions, greedily by volume. */
export function groupByDirection(removals: Removal[], firstUp: Face): Map<Face, Removal[]> {
  const left = removals.filter((r) => r.opensTo.length > 0);
  const groups = new Map<Face, Removal[]>();
  while (left.length > 0) {
    const weight = new Map<Face, number>();
    for (const r of left) for (const f of r.opensTo) weight.set(f, (weight.get(f) ?? 0) + r.volume);
    let best: Face | null = null;
    for (const [f, w] of weight) {
      const bw = best === null ? -1 : weight.get(best)!;
      if (w > bw || (w === bw && f === firstUp)) best = f;
    }
    if (best === null) break;
    const taken = left.filter((r) => r.opensTo.includes(best!));
    groups.set(best, taken);
    for (const r of taken) left.splice(left.indexOf(r), 1);
  }
  return groups;
}

/** The bounds after a setup: a facing pass takes its depth off the face it opens to (#428 review). */
function boundsAfter(bounds: Box, items: Removal[]): Box {
  const b: Box = { min: [...bounds.min], max: [...bounds.max] };
  for (const r of items) {
    if (!r.facing || r.opensTo.length !== 1) continue;
    const { axis, high } = faceAxis(r.opensTo[0]!);
    if (high) b.max[axis] = Math.min(b.max[axis], r.box.min[axis]);
    else b.min[axis] = Math.max(b.min[axis], r.box.max[axis]);
  }
  return b;
}

/** Build the setups for an ordered list of (face, items), carrying the stock and checking each. */
export function buildSetups(
  input: SetupsInput,
  ordered: { face: Face; items: Removal[] }[],
  settings: SetupsSettings,
): SetupsPlan {
  const setups: Setup[] = [];
  const unholdable: SetupsPlan['unholdable'] = [];
  const lost = input.removals
    .filter((r) => r.opensTo.length === 0)
    .map((r) => ({ itemId: r.id, reason: `${r.name} opens to no face, so no setup can reach it` }));
  let stock: StockState = { bounds: { min: [0, 0, 0], max: [input.stock.x, input.stock.y, input.stock.z] }, cuts: [] };
  for (const { face, items } of ordered) {
    const size = { x: stock.bounds.max[0] - stock.bounds.min[0], y: stock.bounds.max[1] - stock.bounds.min[1], z: stock.bounds.max[2] - stock.bounds.min[2] };
    const mount = mountFor(input, face);
    const o = orient(face, mount, size);
    if (!o.ok) {
      unholdable.push({ face, reason: o.reason, itemIds: items.map((i) => i.id) });
      continue;
    }
    const after: StockState = { bounds: boundsAfter(stock.bounds, items), cuts: [...stock.cuts, ...items] };
    const prev = setups[setups.length - 1];
    setups.push({
      index: setups.length + 1,
      faceUp: face,
      mount,
      rotation: o.matrix,
      orientation: o.orientation,
      itemIds: items.map((i) => i.id),
      stockBefore: stock,
      stockAfter: after,
      remount: remountStep(setups.length + 1, prev ? prev.rotation : null, o.matrix, face, mount, stock, prev ? prev.mount : null),
      findings: checkSetup(o.matrix, o.orientation, mount, stock, items, settings),
    });
    stock = after;
  }
  // The rotary only when it saves remounts: two or more SIDE directions (a flip is not a rotary job),
  // and only when the machine has one and the stock fits ITS envelope (#448, read from the record).
  const sides = new Set([...setups.map((s) => s.faceUp), ...unholdable.map((u) => u.face)].filter((f) => SIDES.includes(f)));
  const envelope = input.rotaryEnvelope;
  const rotaryOffer =
    envelope !== undefined && sides.size >= 2 && rotaryFits(input.stock, envelope)
      ? `the rotary would reach the ${[...sides].join(', ')} faces in one mount (the stock fits ⌀${envelope.diameter} × ${envelope.length}) — once it is characterised (CNC-5)`
      : null;
  return { setups, unholdable, lost, rotaryOffer };
}

export function planSetups(input: SetupsInput, settings: SetupsSettings): SetupsPlan {
  const firstUp = input.firstUp ?? 'top';
  const groups = groupByDirection(input.removals, firstUp);
  const vol = (items: Removal[]) => items.reduce((a, r) => a + r.volume, 0);
  const ordered = [...groups.entries()]
    .map(([face, items]) => ({ face, items }))
    .sort((a, b) => (a.face === firstUp ? -1 : b.face === firstUp ? 1 : vol(a.items) - vol(b.items)));
  return buildSetups(input, ordered, settings);
}

/** The operator's edits to a plan (§5.4 "manual override"). */
export type SetupEdit =
  | { kind: 'move'; itemId: string; toFace: Face }
  | { kind: 'add'; face: Face }
  | { kind: 'reorder'; faces: Face[] }
  | { kind: 'merge'; from: Face; into: Face }
  /**
   * Change the fixture for one setup (maintainer decision, 2026-10-17). The face must already be a
   * setup, because a mount belongs to a held position — adding the position and changing its mount
   * are two statements, and the first one has to exist before the second means anything.
   */
  | { kind: 'mount'; face: Face; mount: MountSpec };

export type EditResult = { ok: true; plan: SetupsPlan } | { ok: false; reason: string };

/**
 * Apply edits to the current grouping and re-plan. An item may only move to (or be merged into) a
 * setup facing a face it OPENS to — anything else is refused with the reason, and nothing changes.
 */
export function editSetups(input: SetupsInput, plan: SetupsPlan, edits: SetupEdit[], settings: SetupsSettings): EditResult {
  const byId = new Map(input.removals.map((r) => [r.id, r]));
  let order: { face: Face; items: Removal[] }[] = [
    ...plan.setups.map((s) => ({ face: s.faceUp, items: s.itemIds.map((id) => byId.get(id)!) })),
    ...plan.unholdable.map((u) => ({ face: u.face, items: u.itemIds.map((id) => byId.get(id)!) })),
  ];
  const find = (f: Face) => order.find((g) => g.face === f);
  // A mount edit changes the input the plan is rebuilt from, so later edits in the same call read
  // the new fixture too instead of a stale one.
  let mounts: Partial<Record<Face, MountSpec>> = { ...(input.mounts ?? {}) };
  for (const e of edits) {
    if (e.kind === 'add') {
      if (!find(e.face)) order.push({ face: e.face, items: [] });
    } else if (e.kind === 'move') {
      const item = byId.get(e.itemId);
      if (!item) return { ok: false, reason: `${e.itemId} is not one of the job's items` };
      if (!item.opensTo.includes(e.toFace)) {
        return { ok: false, reason: `${item.name} cannot be cut from the ${e.toFace} face — it opens to ${item.opensTo.join(' and ')}` };
      }
      for (const g of order) g.items = g.items.filter((i) => i.id !== item.id);
      const target = find(e.toFace) ?? (order.push({ face: e.toFace, items: [] }), find(e.toFace)!);
      target.items.push(item);
    } else if (e.kind === 'merge') {
      if (e.from === e.into) return { ok: false, reason: `the ${e.from} setup cannot be merged into itself` };
      const from = find(e.from);
      if (!from) return { ok: false, reason: `there is no ${e.from} setup to merge` };
      const stuck = from.items.filter((i) => !i.opensTo.includes(e.into));
      if (stuck.length > 0) {
        return { ok: false, reason: `${stuck.map((i) => i.name).join(', ')} cannot be cut from the ${e.into} face` };
      }
      const into = find(e.into) ?? (order.push({ face: e.into, items: [] }), find(e.into)!);
      into.items.push(...from.items);
      order = order.filter((g) => g !== from);
    } else if (e.kind === 'reorder') {
      const known = new Set(order.map((g) => g.face));
      if (e.faces.length !== known.size || e.faces.some((f) => !known.has(f))) {
        return { ok: false, reason: 'a reorder must name every setup once' };
      }
      order = e.faces.map((f) => find(f)!);
    } else {
      if (!find(e.face)) return { ok: false, reason: `there is no ${e.face} setup whose mount to change` };
      mounts = { ...mounts, [e.face]: e.mount };
    }
  }
  return { ok: true, plan: buildSetups({ ...input, mounts }, order.filter((g) => g.items.length > 0), settings) };
}
