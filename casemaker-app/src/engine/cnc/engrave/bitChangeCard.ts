/**
 * #1168 — THE BIT-CHANGE CARD'S FACTS, ONE PLACE, NO JSX.
 *
 * The card is the per-change moment inside step 3 (#1127's checklist is the first-Load gate; this
 * one is between programs). Everything it says is derived here so the component stays a renderer:
 *
 *   - the bit to FIT, named the bench way — case/cap colour first (#491), then the cutter's name;
 *   - the bit to TAKE OUT (the finished program's cutter), named the same way;
 *   - what the collets do (from the two shanks' stated diameters);
 *   - the green row's clauses, each only when true;
 *   - whether a colour is MISSING — the copy's case field is read, never the Notes (#1168's data
 *     rule): a bit without one is named in the hint that links to its row, not guessed at.
 *
 * Chips are omitted, one by one, when the value does not exist. Never a placeholder.
 */
import type { InventoryItem } from '@/platform/houseClient';
import type { ReleaseFile, ReleaseRecord } from '@/store/engraveReleaseStore';
import { caseSwatch } from '@/engine/cnc/caseColour';
import { benchCutterFor } from '@/engine/cnc/toolRegistry';

/** One bit, in the card's words. */
export interface BitCardFact {
  toolKey: string;
  name: string;
  /** `Red` — the case/cap colour's own word; null when no copy states one. */
  colourWord: string | null;
  colourHex: string | null;
  /** What is printed on the tube (the cutter's own type text), when the record has one. */
  printed: string | null;
  /** The facts the operator can check at a glance; each chip only when its value exists. */
  chips: string[];
}

export interface BitChangeCardFacts {
  done: number;
  total: number;
  nextIndex: number;
  fit: BitCardFact;
  takeOut: BitCardFact | null;
  /** `The collet you have in stays.` / `The collet changes: 3.175 mm to 6 mm.` — null when unknown. */
  colletLine: string | null;
  /** The green row: what already happened, each clause only when true. */
  facts: string[];
  /** A bit whose copy states no case colour; the card hints at its row instead of guessing. */
  colourMissing: { toolKey: string; name: string } | null;
  /** True when program k+1 uses the same cutter as program k: there is no change to show. */
  sameCutter: boolean;
}

/** The `inv:` possession behind a registry key, when the key is one. */
function possessionFor(toolKey: string, items: readonly InventoryItem[]): InventoryItem | null {
  if (!toolKey.startsWith('inv:')) return null;
  const id = toolKey.slice('inv:'.length);
  return items.find((item) => item.id === id) ?? null;
}

/**
 * The case/cap colour, straight from the possession's copies (#1168's data rule): the copy's own
 * `case` field is read, and anything else — an empty field, a copy at the machine — means NO
 * colour. Notes are never parsed. Distinct colours read as the operator's own words.
 */
function colourOf(item: InventoryItem | null): { word: string | null; hex: string | null } {
  if (item === null) return { word: null, hex: null };
  const colours: string[] = [];
  for (const copy of item.copies) {
    const kase = copy.whereabouts.kind === 'box' ? (copy.whereabouts.case ?? null) : null;
    if (kase === null) continue;
    if (!colours.some((c) => c.toLowerCase() === kase.colour.toLowerCase())) colours.push(kase.colour);
  }
  if (colours.length === 0) return { word: null, hex: null };
  // The card's headline is the COLOUR word (`Red cap · …`), not the bench phrase (`Red case`):
  // the operator's own capitalisation survives after the first letter.
  const word = (c: string): string => c.charAt(0).toUpperCase() + c.slice(1);
  return {
    word: colours.map(word).join(' or '),
    hex: caseSwatch(colours[0]!),
  };
}

/** How many of the pieces are still usable: stated copies minus broken and lost ones. */
function leftCount(item: InventoryItem): number | null {
  if (item.copies.length === 0) return null; // nothing described: a count would be a guess
  const unusable = item.copies.filter((c) => c.condition === 'broken' || c.condition === 'lost').length;
  const left = item.quantity - unusable;
  return left > 0 ? left : 0;
}

/** One bit's card facts. */
export function bitCardFact(toolKey: string, items: readonly InventoryItem[]): BitCardFact {
  const tool = benchCutterFor(toolKey);
  const item = possessionFor(toolKey, items);
  const colour = colourOf(item);
  const chips: string[] = [];
  if (tool?.fluteLength !== null && tool?.fluteLength !== undefined && tool.fluteLength > 0) {
    chips.push(`cuts ${tool.fluteLength} mm deep`);
  }
  if (tool?.handleDiameter !== null && tool?.handleDiameter !== undefined && tool.handleDiameter > 0) {
    chips.push(`shank ${tool.handleDiameter} mm`);
  }
  // Where it is kept is the operator's own note (`box B · row 2`), never a made-up shelf.
  if (item?.notes !== null && item?.notes !== undefined && item.notes.trim() !== '') chips.push(item.notes);
  const left = item === null ? null : leftCount(item);
  if (left !== null) chips.push(`${left} left`);
  return {
    toolKey,
    name: tool?.name ?? toolKey,
    colourWord: colour.word,
    colourHex: colour.hex,
    printed: tool?.typeText !== null && tool?.typeText !== undefined && tool.typeText.trim() !== '' ? tool.typeText : null,
    chips,
  };
}

function fileAt(record: ReleaseRecord, index: number): ReleaseFile | null {
  return record.files.find((f) => f.index === index) ?? null;
}

/**
 * The card's facts for this moment: the record names the programs and their cutters, and the
 * inventory names the bits. Nothing here reads the job — the record already carries it.
 */
export function bitChangeCardFacts(record: ReleaseRecord, items: readonly InventoryItem[]): BitChangeCardFacts {
  const nextIndex = record.next ?? 0;
  const fitFile = fileAt(record, nextIndex);
  const finishedIndex = record.active ?? nextIndex - 1;
  const takeOutFile = fileAt(record, finishedIndex);
  const fit = bitCardFact(fitFile?.toolKey ?? record.job.toolKey, items);
  const takeOut = takeOutFile === null || takeOutFile.toolKey === fit.toolKey ? null : bitCardFact(takeOutFile.toolKey, items);

  const fitShank = benchCutterFor(fit.toolKey)?.handleDiameter ?? null;
  const outShank = takeOut === null ? null : (benchCutterFor(takeOut.toolKey)?.handleDiameter ?? null);
  const colletLine =
    fitShank === null || outShank === null
      ? null
      : fitShank === outShank
        ? 'The collet you have in stays.'
        : `The collet changes: ${outShank} mm to ${fitShank} mm.`;

  const done = record.files.filter((f) => f.done).length;
  const facts = [
    // The phase is only reached after a program finished (completeProgram), the span closed with a
    // home, and a finished program's post stopped the spindle. Each clause is therefore true.
    finishedIndex > 0 ? `Program ${finishedIndex} finished` : null,
    'head homed',
    'spindle stopped',
  ].filter((f): f is string => f !== null);

  const missing = fit.colourWord === null ? { toolKey: fit.toolKey, name: fit.name } : null;
  return {
    done,
    total: record.files.length,
    nextIndex,
    fit,
    takeOut,
    colletLine,
    facts,
    colourMissing: missing,
    sameCutter: takeOutFile !== null && takeOutFile.toolKey === fit.toolKey,
  };
}
