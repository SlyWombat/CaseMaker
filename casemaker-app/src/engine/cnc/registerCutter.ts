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
import { isMetalCutterName, shapeFromType, statedCuttingSize, vendorId, type Tool, type ToolShape } from './tool';
import type { ToolLibraryEntry } from './toolLibrary';
import { catalogueIdOf, tierOf } from './toolTiers';
import { vFluteLength } from './vProfile';

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
  /**
   * Whether the code carries Makera's `-M-` "for Metal" marker (#379 review) — the one thing a
   * printed code says that is NOT a type word, a number or a measurement.
   *
   * It is kept because the two lines are different cutters and a job's answer depends on which one
   * is in the spindle: Makera files a single-flute end mill under "Single Flute Non Metal" and its
   * `-M-` twin under the metal group, and the material a bit was ground for is not recoverable from
   * its dimensions. It rides on the reading so {@link resolveCode} can prefer the row on the same
   * line as the box, and the panel can say which line the box named.
   */
  metal: boolean;
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
  /**
   * The thread the code names — `M5` in `C1-BIT-THREAD-M5-15` (#380), `M3` in `C1-BIT-THREAD-M3-9`.
   *
   * A SPECIFICATION, not a measurement, and not the cutter: what diameter a thread mill cuts is not
   * in the code at all — the store prints it beside the spec instead (`M5(d4) * 15mm`) — so the
   * diameter has to come from Makera's thread row in the synced catalogue, whose spec and angle live
   * in that row's `extras`. Nothing narrows a candidate by this yet; it is kept so that a step which
   * can is not asking for a value the reading threw away.
   */
  threadSpec: string | null;
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
 * It is not thrown away, though: it is taken out of the tokens and kept where a reader can see it,
 * as {@link BoxCode.metal}. A thread's size — `M5` in `THREAD-M5-15` — is a different token and is
 * NOT this: the match is exact.
 */
const METAL_MARKER = 'M';

/**
 * A store SKU's pack size. The printed code on the box does not carry one — a store variant code is
 * the box code plus this suffix (#377) — so a scanned QR value never has it, but a typed SKU does,
 * and left in the tail it was read as one of the cutter's numbers: `C1-BIT-DRILL-2.5-12-10PCS` came
 * out a 12 mm drill and `C1-BIT-ENGRAVE-30-0.3-10PCS` a 0.3° engraver, both naming the pack count
 * and neither the cutter (#379 review).
 *
 * The `S` is optional (#465): the short form `C1-BIT-O-FLUTE-M-3.175-12-5PC` is the same store
 * suffix with one letter fewer, and left in the tail it makes a fixed-length tail the wrong length,
 * so the reader falls through to a split that loses a field. Dropping it cannot lose information,
 * because a pack count is never a fact about the cutter — it says how many came in the box, which
 * the inventory's own `quantity` records, not what the bit is — so both forms read the same cutter.
 */
const PACK_SUFFIX = /^\d+PCS?$/;

/**
 * A type word is a WORD: it starts with a letter, never a number. Once a split of the tokens would
 * put a number inside the type word, every later split would leave it there, so the search stops
 * rather than offering the vocabulary `DRILL 2.5` and `DRILL 2.5 12` — two strings no type is
 * called, and a tail read from the wrong side of a number (#379 review).
 */
const STARTS_NUMERIC = /^\d/;

/** What a code's tail can say. Whatever a type's tail does not state is `null`, never 0. */
interface TailReading {
  tipDiameter: number | null;
  fluteLength: number | null;
  includedAngle: number | null;
  threadSpec: string | null;
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
    threadSpec: null,
  };
}

/** `M5`, `M2.5`, `M12` — a metric thread size, the whole of what a THREAD code says about the thread. */
const THREAD_SPEC = /^M\d+(\.\d+)?$/;

/**
 * A type whose tail does NOT mean `<tip>-<flute>`.
 *
 * The number of numbers, and what they mean, depends on the type word (#378, #380) — the whole
 * inventory was photographed from the boxes on 2026-10-12 and every one of the 28 codes was decoded,
 * which is what turned this from a guess into a table. Only the exceptions live here; everything
 * else is {@link tipThenFlute}, so a type added later reads sensibly by default rather than needing
 * a row of its own.
 *
 * Each reader also returns `null` for a tail it does not recognise, which sends the code on to the
 * next split of its tokens rather than freezing it: a shape's format is a claim about the tails that
 * TYPE carries, and a tail matching none of them says this reading is wrong.
 *
 *   - **ENGRAVE** is `<angle>-<tip>` and states no flute: `C1-BIT-ENGRAVE-30-0.3` is a 30° cutter
 *     with a 0.3 mm tip, and `C1-BIT-ENGRAVE-M-60-0.1` a 60° with a 0.1 mm one. The angle is the one
 *     the LABEL prints — see {@link BoxCode.includedAngle} for what that means to a `Tool`.
 *   - **CHAMFER** is `<angle>` alone, one number and nothing else: `C1-BIT-CHAMFER-90` (#380). That
 *     is the whole code, which is why a two-token code is readable at all.
 *   - **THREAD** is `<spec>-<flute>` — `C1-BIT-THREAD-M5-15`, `C1-BIT-THREAD-M3-9` (#380). The spec
 *     is a thread size, so it is not a number and `boxLength` would have made it a null tip.
 */
const TAIL_READINGS: Partial<Record<ToolShape, (tail: readonly string[]) => TailReading | null>> = {
  engraving: (tail) =>
    tail.length === 2
      ? {
          tipDiameter: boxLength(tail[1]!),
          fluteLength: null,
          includedAngle: boxLength(tail[0]!),
          threadSpec: null,
        }
      : null,
  chamfer: (tail) =>
    tail.length === 1
      ? {
          tipDiameter: null,
          fluteLength: null,
          includedAngle: boxLength(tail[0]!),
          threadSpec: null,
        }
      : null,
  thread: (tail) =>
    tail.length === 2
      ? {
          tipDiameter: null,
          fluteLength: boxLength(tail[1]!),
          includedAngle: null,
          threadSpec: THREAD_SPEC.test(tail[0]!) ? tail[0]! : null,
        }
      : null,
};

/**
 * Read a Makera box code — `C1-BIT-<TYPE>-<numbers>` — into the shape and the numbers it names.
 *
 * The type word may itself contain dashes (`BALL-NOSE`) and may carry the `-M-` metal marker, which
 * {@link METAL_MARKER} has already taken out and recorded as {@link BoxCode.metal}; what is left is
 * read through the SAME vocabulary Studio's `type=` field uses ({@link shapeFromType}), so a label
 * and a `.nc` header describing one cutter agree once the dashes are spelled as spaces — a second,
 * competing vocabulary would be one more thing to get wrong. A trailing pack size
 * ({@link PACK_SUFFIX}) is dropped for the same reason: it is the store's token, not the cutter's.
 *
 * Where the type word ENDS is not fixed by the dashes alone, since the type can be one token or two,
 * so each split of the tokens is offered to the vocabulary and the first one it recognises wins —
 * shortest word first, because `BALL NOSE 1` is still a ball and would otherwise swallow a number,
 * and no further than the first numeric token, because past that a split is not a word
 * ({@link STARTS_NUMERIC}). What the rest of the tail then means is the type's business
 * ({@link TAIL_READINGS}), not a fixed `-<tip>-<flute>` position.
 *
 * Nothing recognised as a type word is not nothing read: the numbers are still taken by the default
 * reading and the shape is `'unknown'`, which is what makes a code from a type this app has never
 * seen useful (#377) instead of a dead label.
 *
 * Anything that is not that shape at all — no prefix, fewer than two tokens, no type word — is
 * `null`: the code is then still matchable against the inventory as text, but it says nothing about
 * the cutter. A number that is not a number only costs that number. TWO tokens are enough, because a
 * chamfer code is its type word and one number and nothing else (#380).
 */
export function parseBoxCode(value: string): BoxCode | null {
  const text = value.trim().toUpperCase();
  const PREFIX = 'C1-BIT-';
  if (!text.startsWith(PREFIX)) return null;
  const parts = text
    .slice(PREFIX.length)
    .split('-')
    .filter((t) => t.length > 0);
  const metal = parts.includes(METAL_MARKER);
  const tokens = parts.filter((t) => t !== METAL_MARKER);
  if (PACK_SUFFIX.test(tokens[tokens.length - 1] ?? '')) tokens.pop();
  if (tokens.length < 2) return null;
  for (let cut = 1; cut < tokens.length; cut++) {
    if (STARTS_NUMERIC.test(tokens[cut - 1]!)) break;
    const shape = shapeFromType(tokens.slice(0, cut).join(' '));
    if (shape === 'unknown') continue;
    const tail = tokens.slice(cut);
    const reading = (TAIL_READINGS[shape] ?? tipThenFlute)(tail);
    if (reading !== null) return { shape, metal, ...reading };
  }
  // No split is a type word this app knows. Keep the numbers, call the shape what it is.
  const typeWords = tokens.slice(0, -2).join(' ');
  const reading = tipThenFlute(tokens);
  if (typeWords.length === 0 || reading === null) return null;
  return { shape: shapeFromType(typeWords), metal, ...reading };
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
 * Whether a catalogue row is on Makera's "for Metal" line.
 *
 * Two sources, and neither alone is the line (#398):
 *
 *   - the vendor's own `metalDuty` column, served beside the row's `tool`. Read off the real install
 *     before it was wired, it holds `0` on exactly the Non Metal groups — so a `0` is the vendor
 *     saying "not the metal line", and it wins over a name that says otherwise. But `1` is on the
 *     `(Metal)` line AND on every corn, drill, thread and chamfer row: "rated for metal", not "on the
 *     metal line". A corn bit is `1`, shape `flat`, and its box (`BIT-CORN-2.0-10.5`) carries no
 *     `-M-`; reading `1` as the line would rank a same-tip plain flat ahead of the corn row the box
 *     names. So a `1` says nothing this function can use, and is left to
 *   - the row's NAME: `3.175*12mm Flat End(Metal)` is the row the built-in was copied from, and
 *     `catalogue.rs` records the same `(Metal)` convention (#379 review). The reading itself is
 *     `tool.isMetalCutterName`, the one copy of it. It is also the whole answer for a row with no
 *     column — a built-in, or a `cat:` row from a service older than the field.
 */
function isMetalRow(entry: ToolLibraryEntry): boolean {
  if (entry.metalDuty === 0) return false;
  return isMetalCutterName(entry.tool.name);
}

/**
 * Whether a CUTTER — a `Tool` in the spindle, or the snapshot a job carries — is on Makera's "for
 * Metal" line (#405 review).
 *
 * The line is stated three ways in the wild, and ANY one of them is enough:
 *
 *   - the NAME, read by `isMetalCutterName` — the one copy of that reading, shared with
 *     {@link isMetalRow}. A catalogue ROW spells it as the `(Metal)` suffix; a printed LABEL spells
 *     it as the phrase `for Metal` (`Single Flute Engraving Bit for Metal - 1/8" Shank 60° * 0.1mm`);
 *   - the printed BOX CODE's `-M-` segment (`C1-BIT-ENGRAVE-M-60-0.1`, #379) — read by
 *     `parseBoxCode`, the one copy of THAT, so a cutter filed under a code cannot slip past a check
 *     that only ever looked at a name. The code a `Tool` carries is its `id`: our own post writes it
 *     into `;@MKR|TOOL|id=…` and `toolFromMkrRecord` reads it back, which is how a job says which
 *     printed code its cutter is (`docs/bench/single-barrel.nc` files the 30° bit under
 *     `id=C1-BIT-ENGRAVE-30-0.3`).
 *
 * Neither statement is redundant, and the code half is no substitute for the name half: an owned
 * cutter reached through an `inv:` key is the inventory's own snapshot, whose `id` is `null`
 * (`toolRegistry.inventoryEntryFor`), so the label's name is the ONLY statement such a `Tool`
 * carries.
 */
export function isMetalTool(tool: Tool): boolean {
  if (isMetalCutterName(tool.name)) return true;
  return tool.id !== null && (parseBoxCode(tool.id)?.metal ?? false);
}

/**
 * Whether a catalogue row fits a box reading.
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
 *
 * ONE statement of the rule, shared by the Scan door ({@link resolveCode}) and the owned cutter's
 * Makera match ({@link suggestMakeraMatch}): an owned row that was registered from a box must
 * suggest the same rows the box's own scan would have. A second fit rule would be a second answer
 * to "which Makera cutter is this".
 */
function fitsReading(entry: ToolLibraryEntry, reading: BoxCode): boolean {
  if (tierOf(entry.key) !== 'catalogue') return false;
  if (reading.shape !== 'unknown' && entry.tool.shape !== reading.shape) return false;
  // A label that stated no tip cannot be narrowed by it; the user picks.
  return reading.tipDiameter === null || sameLength(entry.tool.tipDiameter, reading.tipDiameter);
}

/**
 * The catalogue rows that fit a reading, the same Makera line AHEAD of the other.
 *
 * The box says which LINE it is, and the two lines are different cutters — a bit ground for
 * aluminium is not the one a PLA job wants, and its dimensions do not tell them apart — so the
 * same line is offered ahead of the other when both fit (#379 review).
 *
 * AHEAD OF, not instead of, and this is now the code rather than the comment: the list was once
 * `sameLine.length > 0 ? sameLine : fits`, which dropped every row on the other line as soon as
 * one row matched — so a metal box hid a plain row, and a metal row whose NAME states no line (a
 * clone under a house name, or a catalogue row that does not use Makera's `(Metal)` convention,
 * #398) was hidden from a metal box. Ranked second is not hidden: `rows.length === fits.length`,
 * so the rule that does not bend still holds — there is always one to pick, which is also why the
 * flute is ignored above.
 */
function rowsForReading(entries: readonly ToolLibraryEntry[], reading: BoxCode): ToolLibraryEntry[] {
  const fits = entries.filter((entry) => fitsReading(entry, reading));
  return [
    ...fits.filter((entry) => isMetalRow(entry) === reading.metal),
    ...fits.filter((entry) => isMetalRow(entry) !== reading.metal),
  ];
}

/**
 * What the user's code names: a cutter they already have, catalogue rows that fit it, or nothing.
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

  const rows = rowsForReading(entries, prefill);
  return rows.length > 0 ? { kind: 'candidates', rows, prefill } : { kind: 'unknown', prefill };
}

/** One catalogue row offered as the Makera cutter an owned row physically is (#732). */
export interface MakeraMatch {
  /** The catalogue row — `cat:<catalogue uuid>`. Its `tool.id` is Makera's own `g_ID`. */
  entry: ToolLibraryEntry;
  /**
   * The `g_ID` an operator's confirmation stores on the inventory row (`item.tool.id`). Never
   * null: a row with no `g_ID` cannot be named by a feed row either (`catalogueCoverageFor`),
   * so offering it would be offering a match that changes nothing.
   */
  cutterId: string;
  /** Whether the row is on the same Makera line as the cutter's evidence. Ranked first, not a filter. */
  sameLine: boolean;
}

/** What an owned cutter's own evidence suggests, and where the evidence came from (#732). */
export interface MakeraSuggestion {
  /** What was read, in the box code's vocabulary — a code's reading, or the record's own fields. */
  reading: BoxCode;
  /**
   * `'code'` when a printed code supplied the reading; `'tool'` when the record's own shape, tip
   * and metal line did. The panel says which, because a code is the box's word and a record is the
   * operator's.
   */
  from: 'code' | 'tool';
  /** The code the reading came from, when `from === 'code'`. */
  code: string | null;
  /** Catalogue rows that fit, the same line first. Possibly empty. */
  matches: readonly MakeraMatch[];
}

/**
 * The Makera cutters an owned row could be (#732, maintainer decision 2026-10-28).
 *
 * **SUGGESTS, NEVER MATCHES.** The answer is drawn and the operator confirms one row; nothing here
 * writes, and no caller may store a match the operator did not choose. A physical cutter's label
 * and its Makera catalogue row are two statements of the same bit, and only the person holding the
 * box can say they are.
 *
 * The evidence is the cutter's OWN, in this order:
 *
 *   1. a PRINTED CODE on the row (`InventoryItem.codes`), read by {@link parseBoxCode} — the same
 *      reader the Scan door uses, never a second parser;
 *   2. failing a readable code, the record itself: its shape, its tip (`statedCuttingSize`) and
 *      its metal line (`isMetalTool`), written into the same {@link BoxCode} so the fit rule above
 *      applies unchanged.
 *
 * The fit is then {@link rowsForReading}'s: shape and tip, same Makera line first. The box's flute
 * and angle are shown in the reading but do not narrow — the rule #309 settled, and the reason a
 * single disagreement cannot hide the right row.
 *
 * `null` when there is nothing to suggest: the row already carries a confirmed id (`vendorId`), or
 * its record states neither a readable shape nor a tip. A catalogue row with no `g_ID` is never
 * offered: storing it could not match a feed row.
 */
export function suggestMakeraMatch(
  item: InventoryItem,
  entries: readonly ToolLibraryEntry[],
): MakeraSuggestion | null {
  // Already confirmed: the rail shows the id and a way to clear it, not a list to pick from again.
  if (vendorId(item.tool) !== null) return null;

  let reading: BoxCode;
  let from: 'code' | 'tool';
  let code: string | null = null;
  const printed = item.codes
    .map((coded) => ({ code: coded.value.trim(), reading: parseBoxCode(coded.value) }))
    .find((candidate): candidate is { code: string; reading: BoxCode } => candidate.reading !== null);
  if (printed) {
    reading = printed.reading;
    from = 'code';
    code = printed.code;
  } else {
    const tool = item.tool;
    const tip = statedCuttingSize(tool);
    // Nothing names a cutter: an unknown shape with no cutting size is not evidence, and every
    // catalogue row would be "a match".
    if (tool.shape === 'unknown' && tip === null) return null;
    reading = {
      shape: tool.shape,
      metal: isMetalTool(tool),
      tipDiameter: tip,
      fluteLength: tool.fluteLength,
      // The label prints the INCLUDED angle; the record keeps an engraver's half angle and a
      // chamfer's straight one (see {@link BoxCode.includedAngle}).
      includedAngle:
        tool.shape === 'engraving' && tool.halfAngle !== null ? tool.halfAngle * 2 : tool.angle,
      threadSpec: null,
    };
    from = 'tool';
  }

  const matches = rowsForReading(entries, reading)
    .filter((entry) => vendorId(entry.tool) !== null)
    .map((entry) => ({
      entry,
      cutterId: vendorId(entry.tool) as string,
      sameLine: isMetalRow(entry) === reading.metal,
    }));
  return { reading, from, code, matches };
}

/**
 * The inventory row with Makera's own cutter id confirmed (or cleared) (#732).
 *
 * THE ID LIVES ON `tool.id`, deliberately — the field `vendorId` reads for every consumer that
 * asks "which Makera cutter is this": `feeds.catalogueCoverageFor`, the `.nc` header
 * (`post/z1.ts`) and the header matcher. A second field on the inventory row would be a second
 * home for one fact, and the service's Zod/Rust schemas already carry this one. `Origin.id` is a
 * different id — Studio's catalogue row UUID — and stays where it is.
 *
 * The whole row is returned so the caller PATCHes it with the rest of the possession untouched;
 * `null` clears a wrong match, and feeds go back to saying the cutter carries no Makera id until
 * the operator confirms another.
 */
export function withMakeraId(item: InventoryItem, cutterId: string | null): InventoryItem {
  return { ...item, tool: { ...item.tool, id: cutterId } };
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
 *
 * A V-bit's `fluteLength` is filled in here when the row leaves it empty (#654): an engraver or
 * chamfer's flute is its cone height, derivable from the diameter and angle the row states, and a
 * registered cutter with a real flute length is what the run sheet, the holder gate and the feeds
 * then read — not a `?` that the operator still has to resolve by hand.
 */
export function itemFromEntry(entry: ToolLibraryEntry, choice: EntryChoice): InventoryItem {
  const catalogueId = catalogueIdOf(entry.key);
  const origin: Origin | null = catalogueId
    ? { id: catalogueId, syncedAt: choice.health?.catalogueSyncedAt ?? null }
    : null;
  return {
    id: newId(),
    tool: { ...entry.tool, fluteLength: entry.tool.fluteLength ?? vFluteLength(entry.tool) },
    origin,
    quantity: choice.quantity,
    codes: choice.code ? [choice.code] : [],
    addedAt: choice.now,
    notes: textOrNull(choice.notes),
    // #415: a newly registered cutter has no copy described and no collet fit stated.
    copies: [],
    colletFits: null,
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
    // #415: a newly registered cutter has no copy described and no collet fit stated.
    copies: [],
    colletFits: null,
  };
}
