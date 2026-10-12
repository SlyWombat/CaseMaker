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
 * **The format is CONFIRMED, 2026-10-12: 28 real codes, every one decoded.** #208 A7 had a single
 * label — the 1 mm ball nose the bench cuts with — and the reading below was a guess fitted to it.
 * The house's whole Makera inventory has since been photographed from the boxes, and it settled the
 * three things one label could not: a code's numbers mean different things for different types
 * (#378, #380), a type word may carry Makera's `-M-` metal marker (#379), and a type word this app
 * has no shape for still leaves its numbers readable (#377).
 *
 * What has NOT changed is the SHAPE of the answer, which is why the callers are written the way they
 * are: a word nobody knows is `'unknown'` rather than an error, and a length that is not a number
 * only costs that length. The parts still worth doubting are the ones a box does not state at all —
 * the shank, and a corn bit's chip-breaker teeth.
 */
export interface BoxCode {
  shape: ToolShape;
  tipDiameter: number | null;
  fluteLength: number | null;
  /**
   * The INCLUDED angle in degrees, when the code states one — an engraving code's first number
   * (`C1-BIT-ENGRAVE-30-0.3`) and a chamfer code's only one (#378, #380).
   *
   * It is the angle the LABEL prints, and both of Makera's own rows record a printed angle as the
   * included one: `catalogue.rs` stores a chamfer's straight into `angle` and an engraver's HALVED
   * into `halfAngle` ("30º in the name is the INCLUDED angle"). So a consumer writing this into a
   * `Tool` must halve it for an engraver and must not for a chamfer — which is why it is named for
   * what the label says rather than after either field.
   */
  includedAngle: number | null;
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
  /** Nothing matched. `prefill` is non-null when the code was read but nothing fit: the panel shows
   *  the reading back so it can be checked against the box, and the numbers are the user's to correct
   *  in the Type door, which opens blank. `null` when nothing was read. */
  | { kind: 'unknown'; prefill: BoxCode | null };

/** A printed length, or null. A label cannot state a length of 0 mm, so 0 is "not stated". */
function boxLength(raw: string): number | null {
  if (!/^\d+(\.\d+)?$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Makera's "for Metal" line marker: a bare `M` token sitting between the type word and the numbers
 * — `O-FLUTE-M-2-8`, `ENGRAVE-M-30-0.3`, `BALL-NOSE-M-2-6` (#379). It names the product line, not
 * the shape, and it is not a number, so it is dropped before either is read rather than being left
 * to be read as one.
 *
 * Nothing keeps it. Whether a metal bit should be a note or a material hint on the row is open on
 * #379; today it only has to stop being in the way. A thread's size — `M5` in `THREAD-M5-15` — is a
 * different token and is NOT this: the match is exact.
 */
const METAL_MARKER = 'M';

/** What a code's tail can say. Whatever a type's tail does not state is `null`, never 0. */
interface TailReading {
  tipDiameter: number | null;
  fluteLength: number | null;
  includedAngle: number | null;
}

/**
 * The tail most types use: the last two tokens are the tip diameter and then the flute length —
 * `C1-BIT-FLAT-3.175-12`, `C1-BIT-BALL-NOSE-1-4`, `C1-BIT-O-FLUTE-M-2-8`, `C1-BIT-CORN-2.0-10.5`.
 */
function tipThenFlute(tail: readonly string[]): TailReading | null {
  if (tail.length < 2) return null;
  return {
    tipDiameter: boxLength(tail[tail.length - 2]!),
    fluteLength: boxLength(tail[tail.length - 1]!),
    includedAngle: null,
  };
}

/**
 * A type whose tail does NOT mean `<tip>-<flute>`.
 *
 * The number of numbers, and what they mean, depends on the type word (#378, #380) — the whole
 * inventory was photographed from the boxes on 2026-10-12 and every one of the 28 codes was decoded,
 * which is what turned this from a guess into a table. Only the exceptions live here; everything
 * else is {@link tipThenFlute}, so a type added later reads sensibly by default rather than needing
 * a row of its own.
 *
 * An ENGRAVING code is `<angle>-<tip>` and states no flute: `C1-BIT-ENGRAVE-30-0.3` is a 30° cutter
 * with a 0.3 mm tip, and `C1-BIT-ENGRAVE-M-60-0.1` a 60° with a 0.1 mm one. The angle is the one the
 * LABEL prints — see {@link BoxCode.includedAngle} for what that means to a `Tool`.
 */
const TAIL_READINGS: Partial<Record<ToolShape, (tail: readonly string[]) => TailReading | null>> = {
  engraving: (tail) =>
    tail.length === 2
      ? { tipDiameter: boxLength(tail[1]!), fluteLength: null, includedAngle: boxLength(tail[0]!) }
      : null,
};

/**
 * Read a Makera box code — `C1-BIT-<TYPE>-<numbers>` — into the shape and the numbers it names.
 *
 * The type word may itself contain dashes (`BALL-NOSE`) and may carry the `-M-` metal marker, which
 * {@link METAL_MARKER} has already dropped; what is left is read through the SAME vocabulary
 * Studio's `type=` field uses ({@link shapeFromType}), so a label and a `.nc` header describing one
 * cutter agree once the dashes are spelled as spaces — a second, competing vocabulary would be one
 * more thing to get wrong.
 *
 * Where the type word ENDS is not fixed by the dashes alone, since the type can be one token or two,
 * so each split of the tokens is offered to the vocabulary and the first one it recognises wins —
 * shortest word first, because `BALL NOSE 1` is still a ball and would otherwise swallow a number.
 * What the rest of the tail then means is the type's business ({@link TAIL_READINGS}), not a fixed
 * `-<tip>-<flute>` position.
 *
 * Nothing recognised as a type word is not nothing read: the numbers are still taken by the default
 * reading and the shape is `'unknown'`, which is what makes a code from a type this app has never
 * seen useful (#377) instead of a dead label.
 *
 * Anything that is not that shape at all — no prefix, fewer than three tokens, no type word — is
 * `null`: the code is then still matchable against the inventory as text, but it says nothing about
 * the cutter. A number that is not a number only costs that number.
 */
export function parseBoxCode(value: string): BoxCode | null {
  const text = value.trim().toUpperCase();
  const PREFIX = 'C1-BIT-';
  if (!text.startsWith(PREFIX)) return null;
  const tokens = text
    .slice(PREFIX.length)
    .split('-')
    .filter((t) => t.length > 0 && t !== METAL_MARKER);
  if (tokens.length < 3) return null;
  for (let cut = 1; cut < tokens.length; cut++) {
    const shape = shapeFromType(tokens.slice(0, cut).join(' '));
    if (shape === 'unknown') continue;
    const tail = tokens.slice(cut);
    const reading = (TAIL_READINGS[shape] ?? tipThenFlute)(tail);
    if (reading !== null) return { shape, ...reading };
  }
  // No split is a type word this app knows. Keep the numbers, call the shape what it is.
  const typeWords = tokens.slice(0, -2).join(' ');
  const reading = tipThenFlute(tokens);
  if (typeWords.length === 0 || reading === null) return null;
  return { shape: shapeFromType(typeWords), ...reading };
}

/**
 * Whether a code the user typed names a code the inventory already holds.
 *
 * EXACT, trimmed, and that is a choice (#311 review): the service's one-code-one-item rule compares
 * the stored value byte for byte, so this has to answer the same question or the two disagree about
 * whether a code is taken — a lowercase retype that matched here but not there would be offered as
 * "one you have" and then refused as a second item, or the reverse. The label is the source of the
 * code, and a scanner types it as printed; a case difference is a different code. The stored value
 * is never rewritten by this: {@link itemFromEntry} keeps whatever was first scanned, symbology and
 * all.
 */
function ownerOfCode(value: string, items: readonly InventoryItem[]): InventoryItem | null {
  const wanted = value.trim();
  if (wanted.length === 0) return null;
  for (const item of items) {
    for (const coded of item.codes) {
      if (coded.value.trim() === wanted) return item;
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
 * the flute.** The label's two numbers are not the same kind of statement as a catalogue row's: the
 * tip is the cutter's identity, where the flute is what the BOX says the bit reaches — the bench
 * cutter's own box reads `…-1-4` and the row it names states a `fluteLength` of 4, but one agreeing
 * pair does not make the box's number the catalogue's field. Matching on it would let a single
 * disagreement hide the right row behind an empty list, where the user has no way back. Matching on
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

/**
 * A count from a text field: blank is ONE, and a count the service would refuse is left for the
 * form to catch — never silently rewritten to 1.
 *
 * BLANK IS ONE AT EVERY SURFACE THAT ASKS (#331): a registration and an edit are the same question
 * to the same `InventoryItemSchema`, and a blank the form itself produced must not be refused. The
 * rule lives here, not beside any one of those surfaces, so all of them answer alike.
 */
export function quantityOrOne(value: string): number {
  const t = value.trim();
  if (t.length === 0) return 1;
  const n = Number(t);
  return Number.isInteger(n) ? n : 0;
}

/**
 * Why a form cannot be sent yet, or null. The rule and the words for it live together here rather
 * than beside one of the surfaces that ask it: the three register doors and the inventory editor
 * (`ToolDetail.tsx`) all collect a quantity, all are refused by the same `InventoryItemSchema`, and
 * four copies of the same sentence would be four chances to drift.
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

/**
 * The DEFINITION half of a typed-in cutter, as typed — every number a string, because a blank one
 * is not a zero. Shared by the Type door and the Yours-row editor (#335): the two ask the same six
 * questions of the same `Tool`, and a second form would be a second set of rules to drift.
 */
export interface CutterSpec {
  name: string;
  shape: ToolShape;
  /** Cutting diameter at the tip, mm. */
  tipDiameter: string;
  /** Shank diameter, mm — the form calls it the shank, the `Tool` calls it the handle. */
  handleDiameter: string;
  fluteLength: string;
  shoulderLength: string;
}

/** The Type door's fields: the definition, plus the two the inventory row needs. */
export interface CutterForm extends CutterSpec {
  /** Blank means one; see {@link quantityOrOne}. */
  quantity: string;
  notes: string;
}

/** A form field, in mm, or null — NEVER 0. A blank field is "not stated", and 0 mm is a cutter
 *  nobody makes; writing 0 would put a real number in a `Tool` where the truth is "unknown", and
 *  the cut planner treats the two differently (a 0 shank would collide with everything). A typed
 *  0 or a negative is REFUSED before this is reached ({@link lengthProblem}); the null here is the
 *  last line, not the rule. */
function lengthOrNull(value: string): number | null {
  const t = value.trim();
  if (t.length === 0) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Why a length field cannot be sent, or null. Blank is fine — it is the honest answer for a
 * measurement nobody took — but a typed `0` or `-3` is a typo, not an unknown, and turning it into
 * null silently would read a slip of the finger as "not stated" (#334). The same shape of rule as
 * {@link quantityProblem}, for the same reason: the form disables the submit with the sentence.
 */
export function lengthProblem(value: string): string | null {
  const t = value.trim();
  if (t.length === 0) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0
    ? null
    : 'a length is millimetres above 0 — leave the box blank when it is not known';
}

/** The length fields of a spec, with the label each one is refused under. */
const LENGTH_FIELDS: ReadonlyArray<{ key: keyof CutterSpec; label: string }> = [
  { key: 'tipDiameter', label: 'tip ⌀' },
  { key: 'handleDiameter', label: 'shank ⌀' },
  { key: 'fluteLength', label: 'flute' },
  { key: 'shoulderLength', label: 'shoulder' },
];

/**
 * Why a definition cannot be sent yet, or null: it needs a name, and every length it states has to
 * be one. First problem wins, named by its field, so the tooltip says which box to fix.
 */
export function specProblem(spec: CutterSpec): string | null {
  if (spec.name.trim().length === 0) return 'a cutter needs a name';
  for (const f of LENGTH_FIELDS) {
    const why = lengthProblem(spec[f.key]);
    if (why !== null) return `${f.label}: ${why}`;
  }
  return null;
}

/** A `Tool` as the form shows it: numbers as text, a null as the blank it came from. */
export function specOfTool(tool: Tool): CutterSpec {
  const text = (n: number | null) => (n === null ? '' : String(n));
  return {
    name: tool.name,
    shape: tool.shape,
    tipDiameter: text(tool.tipDiameter),
    handleDiameter: text(tool.handleDiameter),
    fluteLength: text(tool.fluteLength),
    shoulderLength: text(tool.shoulderLength),
  };
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

/** A `Tool` with nothing stated: what a typed-in cutter starts from. */
const BLANK_TOOL: Tool = {
  number: null,
  id: null,
  name: '',
  typeText: '',
  shape: 'unknown',
  handleDiameter: null,
  tipDiameter: null,
  diameter: null,
  cornerRadius: null,
  angle: null,
  halfAngle: null,
  fluteLength: null,
  shoulderLength: null,
  stickout: null,
  centreCutting: null,
};

/**
 * The spec's six fields written over `base`, with the two derived fields that follow from them.
 *
 * Everything the spec does not ask about — stick-out, centre-cutting, the angles — is `base`'s,
 * untouched: the Yours-row editor (#335) must not blank a measured stick-out because its form has no
 * box for one. The derived fields are the ones the physical cutter answers for itself: a flat end
 * mill's `diameter` IS its cutting diameter and its corner radius is 0, where for every other shape
 * `diameter` is the SHANK (Makera's own convention, `Tool.diameter`) — and the shank alone (#334):
 * a ball nose typed with a tip and no shank has a `diameter` of null, not the tip, because the tip
 * is a different measurement and a shank the user never typed is a guess the sweep would then read
 * as a fact. `typeText` is rewritten in the vocabulary {@link shapeFromType} reads back, so the
 * shape survives a round trip through a header.
 */
export function toolFromSpec(spec: CutterSpec, base: Tool): Tool {
  const tip = lengthOrNull(spec.tipDiameter);
  const shank = lengthOrNull(spec.handleDiameter);
  const shape = spec.shape;
  return {
    ...base,
    name: spec.name.trim(),
    typeText: SHAPE_TYPE_TEXT[shape],
    shape,
    handleDiameter: shank,
    tipDiameter: tip,
    diameter: shape === 'flat' ? (tip ?? shank) : shank,
    cornerRadius: shape === 'flat' ? 0 : null,
    fluteLength: lengthOrNull(spec.fluteLength),
    shoulderLength: lengthOrNull(spec.shoulderLength),
  };
}

/**
 * A cutter the user typed in (#309 Type door).
 *
 * Nothing is invented: every field the form did not state is `null`, `id` and `number` are null
 * because this cutter came from no Makera table, and `origin` is null because it came from no
 * catalogue row. The derived fields are {@link toolFromSpec}'s.
 */
export function itemFromForm(form: CutterForm, now: string): InventoryItem {
  return {
    id: newId(),
    tool: toolFromSpec(form, BLANK_TOOL),
    origin: null,
    quantity: quantityOrOne(form.quantity),
    codes: [],
    addedAt: now,
    notes: textOrNull(form.notes),
  };
}
