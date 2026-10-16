/**
 * A cutter's condition, copy by copy (#415, decision Q4), and the pure rules tool choice uses.
 *
 * THE OPERATOR SETS THE CONDITION — new / used / worn / broken — and nothing else does: runtime (#381)
 * only WARNS past a threshold ({@link runtimeWarning}), it never retires a cutter. An inventory item
 * lists at most `quantity` described copies; a copy with no entry has NO condition set and is in its
 * box (`tool_copy.rs`), so nothing here guesses "new" for a bit that has been in a spindle.
 *
 * FOR TOOL CHOICE (`recommendTool.ts`, which is not this file's to change): {@link conditionRank}
 * orders candidates — new and used first, unset next, worn last, broken never — and
 * {@link conditionForKey} answers, for a registry key (`inv:<id>`), the best usable copy and the note
 * a worn pick should carry. `toolRegistryStore` fills the lookup whenever the inventory loads, so the
 * wiring there is one call.
 */

import { z } from 'zod';

export const CONDITIONS = ['new', 'used', 'worn', 'broken'] as const;
export type Condition = (typeof CONDITIONS)[number];

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** Not blank, no control character — `tool_copy.rs`'s rule for a machine id. */
export const machineIdText = z.string().refine((v) => v.trim().length > 0 && !CONTROL.test(v), 'is blank or has a control character');

/** The most copies an item may describe, and the largest per-copy override — `tool_copy.rs`'s caps. */
export const MAX_COPIES = 500;
export const MAX_WARN_MINUTES = 100_000;

export const WhereaboutsSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('box') }).strict(),
  z.object({ kind: z.literal('machine'), machineId: machineIdText }).strict(),
]);

export const ToolCopySchema = z
  .object({
    id: z.string().refine((v) => v.trim().length > 0 && v === v.trim() && !CONTROL.test(v), 'is not a usable id'),
    condition: z.enum(CONDITIONS),
    whereabouts: WhereaboutsSchema,
    /** This cutter's own runtime-warning threshold, minutes; overrides `tools.runtimeWarnMinutes`. */
    runtimeWarnMinutes: z.number().finite().positive().max(MAX_WARN_MINUTES).nullable().default(null),
    notes: z.string().nullable().default(null),
  })
  .strict();

export type ToolCopy = z.infer<typeof ToolCopySchema>;
export type Whereabouts = z.infer<typeof WhereaboutsSchema>;

/** The checks `tool_copy.rs` makes on an item's copies, restated: run from the item schema. */
export function copiesProblem(quantity: number, copies: readonly ToolCopy[], colletFits: readonly string[] | null): string | null {
  if (copies.length > quantity || copies.length > MAX_COPIES) {
    return `${copies.length} copies are described but only ${Math.min(quantity, MAX_COPIES)} are owned`;
  }
  const ids = new Set<string>();
  const machines = new Set<string>();
  for (const c of copies) {
    if (ids.has(c.id)) return `copy ${c.id} is described twice`;
    ids.add(c.id);
    if (c.whereabouts.kind === 'machine') {
      if (machines.has(c.whereabouts.machineId)) {
        return `two copies are in machine ${c.whereabouts.machineId} at once — a spindle holds one cutter`;
      }
      machines.add(c.whereabouts.machineId);
    }
  }
  if (colletFits !== null && new Set(colletFits).size !== colletFits.length) return 'the collet-fit list names a machine twice';
  return null;
}

/** A copy's condition, or `null` for a copy nobody described. */
export type CopyCondition = Condition | null;

/**
 * The order tool choice prefers copies in: lower is better. New and used are equally good (Q4:
 * "prefers new or used over worn"); a copy with no condition set comes next; worn last; broken is
 * never chosen (`Infinity`).
 */
export function conditionRank(c: CopyCondition): number {
  switch (c) {
    case 'new':
    case 'used':
      return 0;
    case null:
      return 1;
    case 'worn':
      return 2;
    case 'broken':
      return Number.POSITIVE_INFINITY;
  }
}

/** The shape of an inventory item this needs (the full one is `houseClient`'s). */
export interface ItemWithCopies {
  id: string;
  quantity: number;
  copies: readonly ToolCopy[];
}

export interface ConditionSummary {
  /** The best usable copy's condition (`null` = not set), or `'broken'` when none is usable. */
  best: CopyCondition;
  /** Copies that may be chosen: everything but the broken ones. */
  usable: number;
  /** The note a pick of this cutter should carry — a worn one, or none usable — or null. */
  note: string | null;
}

/** Every copy's condition: the described ones, then `null` for each undescribed one. */
export function copyConditions(item: ItemWithCopies): CopyCondition[] {
  const described = item.copies.map((c) => c.condition);
  return [...described, ...Array<CopyCondition>(Math.max(0, item.quantity - described.length)).fill(null)];
}

export function itemConditionSummary(item: ItemWithCopies): ConditionSummary {
  const all = copyConditions(item);
  const usable = all.filter((c) => c !== 'broken');
  if (usable.length === 0) {
    return { best: 'broken', usable: 0, note: 'every copy of this cutter is marked broken — it is not chosen' };
  }
  const best = usable.reduce((a, b) => (conditionRank(b) < conditionRank(a) ? b : a));
  return {
    best,
    usable: usable.length,
    note:
      best === 'worn'
        ? usable.length === 1
          ? 'the only usable copy of this cutter is marked worn — check it before the cut'
          : `every usable copy of this cutter (${usable.length}) is marked worn — check the one you fit`
        : null,
  };
}

/**
 * Runtime only warns (Q4): past the threshold, "check this bit"; never a change of condition. The
 * threshold is the copy's own override, else the shop's `tools.runtimeWarnMinutes` — passed in,
 * never a constant here. `runtimeMinutes` is #381's to count.
 */
export function runtimeWarning(
  runtimeMinutes: number | null,
  copyOverride: number | null,
  shopThreshold: number,
): string | null {
  if (runtimeMinutes === null) return null;
  const limit = copyOverride ?? shopThreshold;
  if (!(runtimeMinutes > limit)) return null;
  return `check this bit — ${Math.round(runtimeMinutes)} min of cutting, past the ${Math.round(limit)} min mark${copyOverride !== null ? ' set for it' : ''}`;
}

// — the lookup tool choice reads -------------------------------------------------------------------

let summaries = new Map<string, ConditionSummary>();

/** Replace the summaries, keyed by registry key (`inv:<id>`). `toolRegistryStore` calls it. */
export function setInventoryConditions(items: readonly ItemWithCopies[], keyOf: (id: string) => string): void {
  summaries = new Map(items.map((i) => [keyOf(i.id), itemConditionSummary(i)]));
}

/** The condition summary for a registry key, or null for a cutter with no possession (`cat:`, builtin). */
export function conditionForKey(key: string): ConditionSummary | null {
  return summaries.get(key) ?? null;
}

/** Test seam. */
export function resetInventoryConditions(): void {
  summaries = new Map();
}

/**
 * The machine a copy on `item` is in that a copy on ANOTHER item is in too (#415 review: a spindle
 * holds one cutter, whichever item it belongs to) — `tool_copy.rs`'s `machine_clash`.
 */
export function machineClash(
  items: readonly { id: string; copies: readonly ToolCopy[] }[],
): string | null {
  const seen = new Map<string, string>();
  for (const item of items) {
    for (const c of item.copies) {
      if (c.whereabouts.kind !== 'machine') continue;
      const holder = seen.get(c.whereabouts.machineId);
      if (holder !== undefined && holder !== item.id) return c.whereabouts.machineId;
      seen.set(c.whereabouts.machineId, item.id);
    }
  }
  return null;
}
