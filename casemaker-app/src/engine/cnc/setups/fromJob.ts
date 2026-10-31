/**
 * The job document's cuts as the setups planner's `Removal[]` (#471, #419 J4).
 *
 * The planner (#428) knows geometry: a removal's box in the stock frame, the faces it opens to and
 * the volume the greedy grouping weighs. The document knows items: a position, a depth, a cutter and
 * a `through` flag. This is the one translation between them, so the section, the planner and the
 * tests read the same boxes — and the boxes come from `sweptCuts`, the #488 reading the jaw check
 * and the run sheet already use, rather than a second walk of the profiles.
 *
 * WHAT IS A CUT. `sweptCuts` already excludes a disabled item, a `construction` item and every
 * keep-out (a void is a fact about the blank, not work), which is exactly `jobSetups`' item set. The
 * facing pass is added here because it is a real removal — it takes a layer off the top before the
 * engraving — but it is NOT a job item, so its id is synthetic and `isSyntheticRemovalId` is what
 * keeps it out of `setups[].itemIds`.
 *
 * FACES. Every item the document can state is cut from the top (`opensTo: ['top']`). A through
 * drill or thread opens to the bottom too — the document may state `through` even though generation
 * refuses it until #218, and the planner should read what the document says, not silently pretend
 * the hole is blind. Nothing else can reach a side face: there is no item field for one, which is
 * why a real job plans one setup today and multi-setup is exercised on planner fixtures.
 *
 * `connected` is #429's reference-registration requirement: one opening whose box is its footprint.
 * A single drill, a thread or one shape pocket is one; a label's glyphs, a vector outline with
 * holes, a combined region and a trace are not, and are left unmarked rather than guessed.
 */

import type { EngraveJob } from '@/types/engraveJob';
import { drillHoles, sweptCuts } from '@/engine/cnc/engrave/partPlan';
import type { Removal } from './types';

/**
 * The facing pass's removal id. It starts with `@`, which no item id minted by `newId` does, so a
 * job item can never collide with it and `isSyntheticRemovalId` is a one-character test.
 */
export const FACING_REMOVAL_ID = '@facing';

/** Whether a removal id names work done on the stock rather than a job item. */
export function isSyntheticRemovalId(id: string): boolean {
  return id.startsWith('@');
}

/** One drill's `through` flag, read from the document by id. A thread's is read the same way. */
function throughById(job: EngraveJob): Map<string, boolean> {
  const through = new Map<string, boolean>();
  for (const drill of job.drills ?? []) through.set(drill.id, drill.through);
  for (const thread of job.threads ?? []) through.set(thread.id, thread.through);
  return through;
}

/**
 * Whether this cut is one connected opening, as #429 defines it for reference registration. The
 * document's own kinds are the evidence: a single hole, a thread or one shape is one region; a
 * drill array is one only when its lattice is one hole; labels, vectors, combined regions and
 * traces are not.
 */
function connectedById(job: EngraveJob): Set<string> {
  const connected = new Set<string>();
  for (const shape of job.shapes) connected.add(shape.id);
  for (const drill of job.drills ?? []) {
    if (drill.kind === 'drill' || drill.count.x * drill.count.y === 1) connected.add(drill.id);
  }
  for (const thread of job.threads ?? []) connected.add(thread.id);
  return connected;
}

/**
 * Every cut the planner may assign to a setup, in the document's own order (region items first,
 * then traces, drills and threads — `sweptCuts`' order, which is `toPartPlan`'s), with the facing
 * pass last.
 *
 * The box is in the STOCK frame: origin at the stock's min corner, Z bottom → top, the cut rising
 * from its floor to the top face. `volume` is the swept footprint times the depth — a relative
 * weight for the greedy direction grouping, not a claim about the material actually removed.
 */
/**
 * A drill's OWN footprint, when the item states its hole's size (#743 P-4b's imported drills).
 *
 * `sweptCuts` sizes a drill by the job's own cutter. That is right for a one-tool job — whose tool
 * IS the drill — and wrong once a setup has several cutters: a 0.8 mm hole cut in setup 1 while
 * the job's first tool is a 0.1 mm engraver reads as a 0.1 mm opening, so the registration on the
 * drilled holes (#429) sees a slot too small to probe. The item's stated diameter IS the hole, so
 * that is the footprint the planner, the reference openings and the probe plan read.
 */
function holeFootprints(job: EngraveJob): Map<string, { minX: number; maxX: number; minY: number; maxY: number }> {
  const out = new Map<string, { minX: number; maxX: number; minY: number; maxY: number }>();
  for (const drill of job.drills ?? []) {
    const d = drill.diameter;
    if (d === undefined || !(d > 0)) continue;
    const r = d / 2;
    const points = drillHoles(drill);
    if (points.length === 0) continue;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [x, y] of points) {
      minX = Math.min(minX, x - r);
      maxX = Math.max(maxX, x + r);
      minY = Math.min(minY, y - r);
      maxY = Math.max(maxY, y + r);
    }
    out.set(drill.id, { minX, maxX, minY, maxY });
  }
  return out;
}

export function removalsFrom(job: EngraveJob): Removal[] {
  const { length, width, thickness } = job.stock;
  const through = throughById(job);
  const connected = connectedById(job);
  const holes = holeFootprints(job);
  const removals: Removal[] = [];

  for (const cut of sweptCuts(job)) {
    const isThrough = through.get(cut.id) === true;
    const depth = Math.max(0, isThrough ? thickness : cut.depth);
    const floor = Math.max(0, thickness - depth);
    const box = holes.get(cut.id) ?? cut.box;
    const area = Math.max(0, box.maxX - box.minX) * Math.max(0, box.maxY - box.minY);
    removals.push({
      id: cut.id,
      name: cut.name.trim() === '' ? cut.id : cut.name,
      volume: area * (thickness - floor),
      box: {
        min: [box.minX, box.minY, isThrough ? 0 : floor],
        max: [box.maxX, box.maxY, thickness],
      },
      opensTo: isThrough ? ['top', 'bottom'] : ['top'],
      ...(connected.has(cut.id) ? { connected: true } : {}),
      ...(cut.roundDiameterMm === undefined ? {} : { roundDiameterMm: cut.roundDiameterMm }),
    });
  }

  // The facing pass takes the whole top layer. It opens to the top, is carried as a `facing`
  // removal so the next setup's stock height is the faced one, and never enters a stored item list.
  if (job.facing !== undefined && job.facing.enabled && job.facing.depth > 0) {
    const depth = Math.min(job.facing.depth, thickness);
    removals.push({
      id: FACING_REMOVAL_ID,
      name: 'facing',
      volume: length * width * depth,
      box: { min: [0, 0, thickness - depth], max: [length, width, thickness] },
      opensTo: ['top'],
      facing: true,
    });
  }

  return removals;
}
