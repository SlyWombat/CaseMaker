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
 *
 * A DEFINITION ADOPTS THE PHYSICAL COPIES (#454). The picker also lists the built-in or `cat:` row
 * an owned cutter was registered from, and an entry with no possession is otherwise "not set"
 * however badly the bit in the drawer is worn — a broken owned 1 mm cutter used to leave the
 * identical built-in `flat-1.0` looking fresh, and a worn 3.175 mm lost its tie to the built-in of
 * the same size in silence. So {@link setInventoryConditions} also answers, for a built-in or
 * catalogue key, the copies of the cutter that key corresponds to. Correspondence is cutting
 * diameter, shape and line (metal or not, `registerCutter.isMetalTool` and a `cat:` row's
 * `metalDuty`) and nothing else: not the name, not the id, not the flute. The adoption leaves the
 * possession's own `inv:` key untouched and carries a note saying where the condition came from — a
 * built-in has no condition the operator set, and must not read as though somebody had described it.
 *
 * SEVERAL POSSESSIONS, ONE DEFINITION. The inventory can hold one cutter twice — a row typed in and
 * a clone of the catalogue row, say — and both correspond to the same entry. The entry's summary
 * POOLS their copies rather than taking one row, because the entry stands for the cutter and not for
 * whichever row happened to be listed first: a broken box must not hide a usable copy behind
 * inventory order. The owned `inv:` entries are neither replaced nor ranked down by this — they keep
 * their own keys and summaries, so a house that holds the cutter always has it to choose; the entry
 * gains only the caution its twin would otherwise have lost.
 */

import { z } from 'zod';
import { isMetalTool } from './registerCutter';
import { cuttingDiameter, type Tool } from './tool';
import type { ToolLibraryEntry } from './toolLibrary';

export const CONDITIONS = ['new', 'used', 'worn', 'broken'] as const;
export type Condition = (typeof CONDITIONS)[number];

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** Not blank, no control character — `tool_copy.rs`'s rule for a machine id. */
export const machineIdText = z.string().refine((v) => v.trim().length > 0 && !CONTROL.test(v), 'is blank or has a control character');

/** The most copies an item may describe, and the largest per-copy override — `tool_copy.rs`'s caps. */
export const MAX_COPIES = 500;
export const MAX_WARN_MINUTES = 100_000;
/** `tool_copy.rs`'s MAX_RUNTIME_MINUTES: a sanity bound on counted runtime. */
export const MAX_RUNTIME_MINUTES = 10_000_000;

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
    /**
     * Wear-minutes COUNTED BY CASE MAKER (#414): cutting minutes × the material's wear weight, added when
     * a run the app played finishes, to the copy recorded as in that machine. Runs from Makera Studio are
     * not counted. `tool_copy.rs` leaves it out of the JSON while none is counted; a copy that carries
     * one is refused by a build from before this field.
     */
    runtimeMinutes: z.number().finite().nonnegative().max(MAX_RUNTIME_MINUTES).nullable().default(null),
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
  /**
   * The cutter's own definition (#454). The condition rule needs only `quantity` and `copies`; the
   * definition is what lets a built-in or catalogue key adopt the summary of the copies that ARE
   * that cutter. Optional because a caller asking only "how are this item's copies" has none to
   * give, and an item with no definition corresponds to no entry.
   */
  tool?: Tool;
}

export interface ConditionSummary {
  /** The best usable copy's condition (`null` = not set), or `'broken'` when none is usable. */
  best: CopyCondition;
  /** Copies that may be chosen: everything but the broken ones. */
  usable: number;
  /**
   * The note a pick of this cutter should carry — a worn one, or none usable — or null. A built-in
   * or catalogue key with no possession borrows the copies that correspond to it (#454), and its
   * note names them, so an adopted condition never reads as one the operator set on the definition.
   */
  note: string | null;
}

/** Every copy's condition: the described ones, then `null` for each undescribed one. */
export function copyConditions(item: ItemWithCopies): CopyCondition[] {
  const described = item.copies.map((c) => c.condition);
  return [...described, ...Array<CopyCondition>(Math.max(0, item.quantity - described.length)).fill(null)];
}

/** The summary of a pool of copies, whether they are one item's or several items' (#454). */
function summaryOf(all: readonly CopyCondition[]): ConditionSummary {
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

export function itemConditionSummary(item: ItemWithCopies): ConditionSummary {
  return summaryOf(copyConditions(item));
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

/**
 * Whether a DEFINITION is on Makera's "for Metal" line (#454). The row rule is
 * `registerCutter.isMetalRow`'s: the vendor's own `metalDuty` 0 is the Non Metal groups and wins over
 * a name that says otherwise, while a 1 says only "rated for metal" and is left to the name (a corn
 * bit is 1 and is not the metal line). The name-or-box-code reading itself is `isMetalTool`, the one
 * copy of it.
 */
function entryOnMetalLine(entry: ToolLibraryEntry): boolean {
  return entry.metalDuty !== 0 && isMetalTool(entry.tool);
}

/**
 * Whether an owned cutter's definition is the same cutter as a registry entry's (#454): cutting
 * diameter, shape and line. Nothing else — a name is a label on a box, an id is a table's own
 * identity, and the flute is what the box says the bit reaches, not what the tip is.
 */
function sameCutter(item: ItemWithCopies, entry: ToolLibraryEntry): boolean {
  if (item.tool === undefined) return false;
  const owned = cuttingDiameter(item.tool);
  const stated = cuttingDiameter(entry.tool);
  if (owned === null || stated === null || owned !== stated) return false;
  if (item.tool.shape !== entry.tool.shape) return false;
  return isMetalTool(item.tool) === entryOnMetalLine(entry);
}

/**
 * Replace the summaries, keyed by registry key (`inv:<id>`). `toolRegistryStore` calls it.
 *
 * `entries` are the DEFINITIONS the house also offers — the permanent built-ins and the `cat:`
 * rows, never a possession, and never a `user:` definition (it is a tool the house typed or cloned,
 * not a second way of naming a physical cutter). Every entry that corresponds to one or more items
 * gets their POOLED summary under its own key (#454), so the condition follows the bit on the bench
 * wherever the picker offers it. An entry with no corresponding possession keeps no key: it answers
 * `null`, which is "no condition known", exactly as before.
 */
export function setInventoryConditions(
  items: readonly ItemWithCopies[],
  keyOf: (id: string) => string,
  entries: readonly ToolLibraryEntry[] = [],
): void {
  summaries = new Map(items.map((i) => [keyOf(i.id), itemConditionSummary(i)]));
  for (const entry of entries) {
    // A possession's own summary is never replaced by an adoption; the guard is here because the
    // caller passes a LIST of entries, and a list that accidentally carried an `inv:` row would
    // otherwise pool that item with every other one that corresponds to the entry.
    if (summaries.has(entry.key)) continue;
    const held = items.filter((i) => sameCutter(i, entry));
    if (held.length === 0) continue;
    const summary = summaryOf(held.flatMap((i) => copyConditions(i)));
    summaries.set(entry.key, {
      ...summary,
      // The attribution is the point (#454): the operator set no condition on a shipped assumption
      // or a vendor row, so the caution must say whose copies it is about.
      note:
        summary.note === null
          ? null
          : `the condition comes from the shop’s own copies of it: ${summary.note}`,
    });
  }
}

/** The condition summary for a registry key, or null for a cutter with no copies behind it. */
export function conditionForKey(key: string): ConditionSummary | null {
  return summaries.get(key) ?? null;
}

/**
 * Every summary, keyed by registry key, as plain data (#442) — the table `recommendTool` is HANDED,
 * the way it is handed `tools` and Makera's feed rows (#305/#324). It has to be handed for the same
 * reason: the tool choice runs inside the sim worker, where this module's map is empty, so a lookup
 * made there would quietly answer "no condition known" for every cutter on the bench.
 *
 * Since #454 the table carries the built-in and `cat:` keys an owned cutter corresponds to as well
 * as the `inv:` keys, because those are the keys the worker's candidate list holds.
 */
export function inventoryConditions(): ReadonlyMap<string, ConditionSummary> {
  return new Map(summaries);
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
