/**
 * Registering a physical cutter (#309, milestone #212) — the pure half.
 *
 * The app has three tiers of tool DEFINITION (built-ins, a synced Makera catalogue, the house's own
 * `user:` tools) and, below them, the cutters the user actually OWNS (#319). An owned cutter is not
 * a fourth definition: it is one row of inventory, a materialised `Tool` plus how many there are and
 * the printed codes that identify one. This module turns what the user did — scanned a box code,
 * picked a catalogue row, or typed numbers in — into that row, and nothing here touches React, the
 * service, or the store.
 *
 * Two rules from the platform layer shape everything below, and both are enforced again on the
 * service's side (`house.rs`), so a payload that breaks them is a document this build should not be
 * reading:
 *
 *   - a CODE identifies exactly one possession, so a code may not appear on two items
 *     (`InventorySchema`) — hence a scan of a code the inventory already holds is a QUANTITY, not a
 *     second item;
 *   - `quantity` is never 0 — "none left" is a removal, not a zero.
 */

import type { Coded, HouseHealth, InventoryItem, Origin } from '@/platform/houseClient';
import { newId } from '@/utils/id';
import { shapeFromType, type Tool, type ToolShape } from './tool';
import type { ToolLibraryEntry } from './toolLibrary';
import { catalogueIdOf, tierOf } from './toolTiers';

/**
 * What a printed box code says about the cutter inside.
 *
 * **PROVISIONAL (#208 A7: one label known).** The only label anyone here has held is the 1 mm ball
 * nose (`3.175*1*4mm Ball Nose`, g_ID `131012103804`) the bench is cutting with, so the reading below
 * is a guess fitted to ONE example and marked as such rather than presented as Makera's format. The
 * parts that would go wrong first if the guess is wrong are the type words — hence {@link shapeOf}
 * maps a word it does not know to `'unknown'` and still returns the two numbers, and the caller is
 * told the reading is provisional so it can show it as a reading rather than a fact.
 */
export interface BoxCode {
  shape: ToolShape;
  tipDiameter: number | null;
  fluteLength: number | null;
}

/**
 * What a code typed or scanned into the Scan door turned out to name.
 *
 * `owned` is the common case by design: the user scans the box in their hand, and if that cutter is
 * already registered the honest answer is "this is one of the ones you have", not a second row.
 */
export type ResolvedCode =
  /** A cutter the inventory already holds — a copy of the SAME cutter, so the quantity goes up. */
  | { kind: 'owned'; item: InventoryItem }
  /**
   * Nothing owns the code, but catalogue rows fit the reading: the user picks the one on the label.
   * `prefill` is the provisional reading, so the panel can say WHY these rows and not others.
   */
  | { kind: 'candidates'; rows: readonly ToolLibraryEntry[]; prefill: BoxCode }
  /** Nothing matched. `prefill` is non-null when the code was read but nothing fit — the seed for
   *  the Type door, where the numbers are the user's to correct. `null` when nothing was read. */
  | { kind: 'unknown'; prefill: BoxCode | null };

/** A printed length, or null. A label cannot state a length of 0 mm, so 0 is "not stated". */
function boxLength(raw: string): number | null {
  if (!/^\d+(\.\d+)?$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Read a Makera box code — `C1-BIT-<TYPE>-<tip>-<flute>` — into the shape and the two lengths it
 * names. **PROVISIONAL** (see {@link BoxCode}).
 *
 * The type word may itself contain dashes (`BALL-NOSE`), so the last two dash-separated tokens are
 * the lengths and everything between the prefix and them is the type. The word is read through the
 * SAME vocabulary Studio's `type=` field uses ({@link shapeFromType}), so a label and a `.nc` header
 * describing one cutter agree once the dashes are spelled as spaces — a second, competing vocabulary
 * would be one more thing to get wrong, and an unrecognised word is `'unknown'` rather than an error,
 * because the two numbers below it are still read.
 *
 * Anything that is not that shape — no prefix, fewer than three tokens, an empty type word — is
 * `null`: the code is then still matchable against the inventory as text, but it says nothing about
 * the cutter. A length that is not a number only costs that length.
 */
export function parseBoxCode(value: string): BoxCode | null {
  const text = value.trim().toUpperCase();
  const PREFIX = 'C1-BIT-';
  if (!text.startsWith(PREFIX)) return null;
  const tokens = text.slice(PREFIX.length).split('-').filter((t) => t.length > 0);
  if (tokens.length < 3) return null;
  const flute = boxLength(tokens[tokens.length - 1]!);
  const tip = boxLength(tokens[tokens.length - 2]!);
  const typeWords = tokens.slice(0, -2).join(' ');
  if (typeWords.length === 0) return null;
  return { shape: shapeFromType(typeWords), tipDiameter: tip, fluteLength: flute };
}

/**
 * Whether a code the user typed names a code the inventory already holds.
 *
 * Case-insensitive, because a case difference is not something a printed code can mean — the user
 * retyping `c1-bit-flat-2-0` in lowercase is naming the same box, and letting that mint a second
 * item would break the one-code-one-cutter rule on the service. The stored value is never rewritten
 * by this: {@link itemFromEntry} keeps whatever was first scanned, symbology and all.
 */
function ownerOfCode(value: string, items: readonly InventoryItem[]): InventoryItem | null {
  const wanted = value.trim().toUpperCase();
  if (wanted.length === 0) return null;
  for (const item of items) {
    for (const coded of item.codes) {
      if (coded.value.trim().toUpperCase() === wanted) return item;
    }
  }
  return null;
}

/** Two lengths read off one label that name the same cutter. Microns, not float equality. */
function sameLength(a: number | null, b: number | null): boolean {
  return a !== null && b !== null && Math.abs(a - b) < 0.01;
}

/**
 * What the user's code names: a cutter they already have, catalogue rows that fit it, or nothing.
 *
 * **The candidate rule, decided (#309 "ask first"): match on the tip and let the user pick; ignore
 * the flute.** The slug reading is PROVISIONAL (#208 A7 — one label known), and the one label that
 * is known proves why: the bench cutter's own box says `…-1-4`, which fits a 1 mm BALL row whose
 * catalogue `fluteLength` is 4.0 — but the flute on the label is what the BOX says the bit reaches,
 * not a field Makera fills differently in general. Matching on a provisional field would let one
 * wrong guess hide the right row behind an empty list, where the user has no way back. Matching on
 * the tip over-suggests instead, and the mockup (G2) already draws that outcome: two rows fit, pick
 * the one on the label. `shape` is matched when the label named one — a word we could not read
 * leaves the shape free rather than excluding every row.
 */
export function resolveCode(
  value: string,
  items: readonly InventoryItem[],
  entries: readonly ToolLibraryEntry[],
): ResolvedCode {
  const owned = ownerOfCode(value, items);
  if (owned) return { kind: 'owned', item: owned };

  const prefill = parseBoxCode(value);
  if (!prefill) return { kind: 'unknown', prefill: null };

  const rows = entries.filter((entry) => {
    if (tierOf(entry.key) !== 'catalogue') return false;
    if (prefill.shape !== 'unknown' && entry.tool.shape !== prefill.shape) return false;
    // A label that stated no tip cannot be narrowed by it; the user picks.
    return prefill.tipDiameter === null || sameLength(entry.tool.tipDiameter, prefill.tipDiameter);
  });

  return rows.length > 0 ? { kind: 'candidates', rows, prefill } : { kind: 'unknown', prefill };
}

/** What the Scan door knows about a cutter it is about to register. */
export interface EntryChoice {
  /** A count the user typed; blank has already become 1 by the time this is called. */
  quantity: number;
  /** The code the cutter was identified by, if any: the box one, or nothing for a Type-door entry. */
  code?: Coded | null;
  notes?: string | null;
  /** The client's clock, injected so a test is not reading the wall. */
  now: string;
  /** The catalogue sync the row came from, so a clone can name where it came from (#212). */
  health?: HouseHealth | null;
}

/** Trimmed text, or null — the same rule every optional field on this form uses. */
function textOrNull(value: string | null | undefined): string | null {
  const t = (value ?? '').trim();
  return t.length === 0 ? null : t;
}

/** A count from a text field: blank is ONE (a user with the box in hand has at least one), and a
 *  count the service would refuse is left for the form to catch — never silently rewritten to 1. */
export function quantityOrOne(value: string): number {
  const t = value.trim();
  if (t.length === 0) return 1;
  const n = Number(t);
  return Number.isInteger(n) ? n : 0;
}

/**
 * Why a door cannot be sent yet, or null. The rule and the words for it live together here rather
 * than beside one of the three forms that ask it: all three collect a quantity, all three are
 * refused by the same `InventoryItemSchema`, and three copies of the same sentence would be three
 * chances to drift.
 */
export function quantityProblem(value: string): string | null {
  return quantityOrOne(value) > 0 ? null : 'a quantity is a whole number of cutters, one or more';
}

/**
 * A catalogue row, registered as an owned cutter.
 *
 * The `Tool` is COPIED, not referenced — the user physically owns the cutter whether or not the
 * catalogue still lists it (#308) — but Makera's `id` stays on the copy: it is the definition's own
 * identity and the house's is `Origin.id`. The clone does not inherit the `g_ID`; the definition is
 * Makera's and only the row and its codes are ours, which is what `origin` records.
 */
export function itemFromEntry(entry: ToolLibraryEntry, choice: EntryChoice): InventoryItem {
  const catalogueId = catalogueIdOf(entry.key);
  const origin: Origin | null = catalogueId
    ? { id: catalogueId, syncedAt: choice.health?.catalogueSyncedAt ?? null }
    : null;
  return {
    id: newId(),
    tool: { ...entry.tool },
    origin,
    quantity: choice.quantity,
    codes: choice.code ? [choice.code] : [],
    addedAt: choice.now,
    notes: textOrNull(choice.notes),
  };
}

/** The Type door's fields, as typed — every number a string, because a blank one is not a zero. */
export interface CutterForm {
  name: string;
  shape: ToolShape;
  /** Cutting diameter at the tip, mm. */
  tipDiameter: string;
  /** Shank diameter, mm — the form calls it the shank, the `Tool` calls it the handle. */
  handleDiameter: string;
  fluteLength: string;
  shoulderLength: string;
  /** Blank means one; see {@link quantityOrOne}. */
  quantity: string;
  notes: string;
}

/** A form field, in mm, or null — NEVER 0. A blank field is "not stated", and 0 mm is a cutter
 *  nobody makes; writing 0 would put a real number in a `Tool` where the truth is "unknown", and
 *  the cut planner treats the two differently (a 0 shank would collide with everything). */
function lengthOrNull(value: string): number | null {
  const t = value.trim();
  if (t.length === 0) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The `type=` text a typed-in cutter records. It is not from a `.nc` header — there is none — so it
 * is written in the SAME vocabulary {@link shapeFromType} reads back, which a round-trip test pins:
 * the panel shows it and the parser must land on the shape the user picked.
 */
const SHAPE_TYPE_TEXT: Record<ToolShape, string> = {
  flat: 'Flat End',
  ball: 'Ball Nose',
  'tapered-ball': 'Tapered Ball Nose',
  engraving: 'Engraving',
  chamfer: 'Chamfer',
  drill: 'Drill',
  thread: 'Thread',
  bull: 'Bull Nose',
  unknown: '',
};

/**
 * A cutter the user typed in (#309 Type door).
 *
 * Nothing is invented: every field the form did not state is `null`, `id` and `number` are null
 * because this cutter came from no Makera table, and `origin` is null because it came from no
 * catalogue row. The two derived fields are the ones the physical cutter answers for itself: a flat
 * end mill's `diameter` IS its cutting diameter and its corner radius is 0, where for every other
 * shape `diameter` is the shank (Makera's own convention, `Tool.diameter`).
 */
export function itemFromForm(form: CutterForm, now: string): InventoryItem {
  const tip = lengthOrNull(form.tipDiameter);
  const shank = lengthOrNull(form.handleDiameter);
  const shape = form.shape;
  const tool: Tool = {
    number: null,
    id: null,
    name: form.name.trim(),
    typeText: SHAPE_TYPE_TEXT[shape],
    shape,
    handleDiameter: shank,
    tipDiameter: tip,
    diameter: shape === 'flat' ? (tip ?? shank) : (shank ?? tip),
    cornerRadius: shape === 'flat' ? 0 : null,
    angle: null,
    halfAngle: null,
    fluteLength: lengthOrNull(form.fluteLength),
    shoulderLength: lengthOrNull(form.shoulderLength),
    stickout: null,
    centreCutting: null,
  };
  return {
    id: newId(),
    tool,
    origin: null,
    quantity: quantityOrOne(form.quantity),
    codes: [],
    addedAt: now,
    notes: textOrNull(form.notes),
  };
}
