/**
 * The house document's INVENTORY, built from the printed label corpus (#309, #491).
 *
 * `scripts/build-house.ts` turns `tool-labels/labels.json` into `kazoo-house.json`, ready for
 * POST /api/v1/import or the app's Import. Two things in that build are logic rather than file
 * handling: reading each box's code with the app's own reader (`parseBoxCode`, after #377–#380) and
 * checking that reading against what the label corpus recorded, and turning the reading into the
 * materialised `Tool` the house serves. Both live here, in a pure function, so the script keeps the
 * paths and the exit codes and a unit test can drive the same builder with real label records.
 *
 * #654 scope 4 — A V-BIT'S FLUTE LENGTH IS DERIVED, NOT COPIED. Makera prints a V-bit's included
 * angle and, for an engraver, its tip; it never prints the flute length, and `labels.json` carries
 * the printed fields only. Copying that empty field wrote `fluteLength: null` onto all six house
 * V-bits on every rebuild. But the length is geometry the record DOES state — the cone reaches the
 * shank at `(diameter − tip) / (2 · tan(halfAngle))` — and `vProfile.vFluteLength` is its one
 * owner (shared with the register, the profile drawing and the V-carve depth limit). The build
 * applies it only where the label states none: a stated flute wins, because it is the vendor's
 * measurement and not ours to overwrite.
 *
 * The build never guesses: a record the reader cannot read, or one whose reading disagrees with
 * what the corpus recorded, is reported in `problems` and the script refuses to write a document.
 */
import { caseColourOnly } from './caseColour';
import { parseBoxCode } from './registerCutter';
import { ToolSchema } from './toolLibrary';
import { vFluteLength } from './vProfile';
import type { Tool } from './tool';
import type { ToolCopy } from './toolCondition';
import type { Coded, Origin } from '@/platform/houseClient';

/** The printed fields a label's reading records; `labels.json` is vendor data and stays local. */
export interface LabelReading {
  shape: 'flat' | 'ball' | 'engraving' | 'chamfer' | 'drill' | 'thread';
  threadSpec?: string;
  tipDiameter?: number | null;
  fluteLength?: number | null;
  angleDeg?: number | null;
  cutterDiameter?: number | null;
}

export interface LabelVariant {
  quantity: number;
  case: string;
  collar?: boolean;
  overallLength: { mm: number };
  tipToCollarMm?: { mm: number };
}

export interface LabelRecord {
  code: string;
  label: string;
  chinese: string;
  makeraSku: string;
  quantity: number;
  codes: Coded[];
  caseColours: string[];
  reading: LabelReading;
  variants?: LabelVariant[];
  inService?: { where: string };
}

/** One inventory row, as the document serves it (`InventorySchema` validates the whole list). */
export interface HouseInventoryItem {
  id: string;
  tool: Tool;
  origin: Origin | null;
  quantity: number;
  codes: Coded[];
  addedAt: string;
  notes: string;
  copies: ToolCopy[];
}

export interface HouseBuild {
  /** One row per label record, in the corpus's order. */
  inventory: HouseInventoryItem[];
  /** Why the corpus and the app's reader disagree, one sentence per record; empty is a clean build. */
  problems: string[];
}

const SHANK = 3.175; // every label says 1/8" shank
const TYPE_TEXT: Record<string, string> = {
  flat: 'Flat End', ball: 'Ball Nose', engraving: 'Engraving', chamfer: 'Chamfer', drill: 'Drill', thread: 'Thread',
};
const near = (a: number | null | undefined, b: number | null | undefined) =>
  a == null || b == null ? a === b : Math.abs(a - b) < 1e-6;

/**
 * One case descriptor per physical box, or null where the corpus does not say. The variant
 * sentence is the exact split ("2× yellow with collar; 2× orange"); a single `caseColours` entry
 * covers the whole quantity. Several descriptors with no variant split is UNKNOWN, not a guess.
 */
function casePerBox(r: LabelRecord, problems: string[]): (string | null)[] {
  if (r.variants !== undefined && r.variants.length > 0) {
    const out: string[] = [];
    for (const v of r.variants) for (let i = 0; i < v.quantity; i++) out.push(v.case);
    if (out.length !== r.quantity) {
      problems.push(`${r.code}: variants describe ${out.length} boxes but quantity is ${r.quantity}`);
      return Array<string | null>(r.quantity).fill(null);
    }
    return out;
  }
  if (r.caseColours.length === 1) {
    return Array<string | null>(r.quantity).fill(r.caseColours[0]!);
  }
  return Array<string | null>(r.quantity).fill(null);
}

/** One boxed copy per physical bit, with the case when the corpus knows it. */
function copiesFor(r: LabelRecord, problems: string[]): ToolCopy[] {
  return casePerBox(r, problems).map((descriptor, i) => ({
    id: `c-${i + 1}`,
    condition: null,
    whereabouts: {
      kind: 'box',
      case:
        descriptor === null
          ? null
          : { colour: caseColourOnly(descriptor), label: descriptor },
    },
    runtimeWarnMinutes: null,
    notes: null,
    runtimeMinutes: null,
  }));
}

/**
 * The document's inventory, built from the labels and checked against the app's own reader.
 *
 * A record becomes one row: its id from the printed code, its `Tool` from the reader's reading
 * (the label's text is the name — the only statement of the metal line an `inv:` tool carries), its
 * case on each physical copy (#491), and the corpus's own notes. A reading that disagrees with the
 * corpus is collected in `problems` rather than thrown, so a run reports every bad box at once.
 */
export function buildHouseInventory({ records }: { records: readonly LabelRecord[] }): HouseBuild {
  const problems: string[] = [];

  const inventory = records.map((r): HouseInventoryItem | null => {
    const read = parseBoxCode(r.code);
    const want = r.reading;
    if (read === null) { problems.push(`${r.code}: reader returned null`); return null; }
    if (read.shape !== want.shape) problems.push(`${r.code}: shape ${read.shape}, recorded ${want.shape}`);
    if (want.shape === 'thread') {
      if (read.threadSpec !== want.threadSpec) problems.push(`${r.code}: threadSpec ${read.threadSpec}, recorded ${want.threadSpec}`);
    } else if (!near(read.tipDiameter, want.tipDiameter ?? null)) {
      problems.push(`${r.code}: tip ${read.tipDiameter}, recorded ${want.tipDiameter}`);
    }
    if (!near(read.fluteLength, want.fluteLength ?? null)) problems.push(`${r.code}: flute ${read.fluteLength}, recorded ${want.fluteLength}`);
    if (!near(read.includedAngle, want.angleDeg ?? null)) problems.push(`${r.code}: angle ${read.includedAngle}, recorded ${want.angleDeg}`);

    const shape = read.shape;
    // A thread mill's cutting diameter is not in its code (#380); the label prints it (d4, d2.4).
    const tip = shape === 'thread' ? (want.cutterDiameter ?? null) : read.tipDiameter;
    const stated: Tool = ToolSchema.parse({
      number: null,
      id: null,
      name: r.label,
      typeText: TYPE_TEXT[shape] ?? '',
      shape,
      handleDiameter: SHANK,
      tipDiameter: tip,
      // Makera's convention (`Tool.diameter`, catalogue.rs): a flat's diameter is its cut, others' the shank.
      diameter: shape === 'flat' ? tip : SHANK,
      // As catalogue.rs states them: a flat's corner is 0, a ball's is the ball radius.
      cornerRadius: shape === 'flat' ? 0 : shape === 'ball' && tip !== null ? tip / 2 : null,
      // The label prints the INCLUDED angle: a chamfer keeps it in `angle`, an engraver halves it into `halfAngle`.
      angle: shape === 'chamfer' ? read.includedAngle : null,
      halfAngle: shape === 'engraving' && read.includedAngle !== null ? read.includedAngle / 2 : null,
      fluteLength: read.fluteLength,
      shoulderLength: null,
      stickout: null,
      centreCutting: null,
    });
    // #654 scope 4 — a label states no flute length for a V-bit because Makera does not print one;
    // `vFluteLength` reads it off the cone the printed angle and diameter define, and answers null
    // for every shape that is not a cone. A STATED length is the vendor's measurement: never touched.
    const tool: Tool = stated.fluteLength === null
      ? { ...stated, fluteLength: vFluteLength(stated) }
      : stated;

    const notes: string[] = [];
    notes.push(`Case: ${r.caseColours.map((c: string) => c.split(' ')[0]).join(' + ')}. Makera ${r.makeraSku}. Label CN: ${r.chinese}.`);
    if (/-M-/.test(r.code)) notes.push('Metal line (-M-).');
    if (r.variants) {
      notes.push('Two physical variants under one code (#381): ' + r.variants.map((v) =>
        `${v.quantity}× ${v.case}${v.collar ? ' with collar' : ''}, ≈${v.overallLength.mm} mm overall` +
        (v.tipToCollarMm ? `, tip→collar ≈${v.tipToCollarMm.mm} mm` : '')).join('; ') + ' (ruler photo, ±2 mm).');
    }
    if (r.inService) notes.push(`In service: ${r.inService.where}.`); // live notes may be newer: re-export before rebuilding
    if (shape === 'thread') notes.push(`Thread ${read.threadSpec}; cutter ⌀ from the label (d${tip}), not the code.`);

    return {
      id: 'kz-' + r.code.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^c1-bit-/, ''),
      tool,
      origin: null,
      quantity: r.quantity,
      codes: r.codes,
      addedAt: '2026-10-12T00:00:00.000Z',
      notes: notes.join(' '),
      copies: copiesFor(r, problems),
    };
  }).filter((i): i is HouseInventoryItem => i !== null);

  return { inventory, problems };
}
