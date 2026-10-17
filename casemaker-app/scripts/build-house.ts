/**
 * Build a `casemaker-house` document from labels.json, ready for POST /api/v1/import or the app's
 * Import. The app's own box-code reader (`parseBoxCode`, after #377–#380) decides each cutter's shape
 * and numbers. Any code whose reading disagrees with what labels.json recorded stops the build, so a
 * run doubles as a corpus check of the reader against every box the house owns.
 *
 * #491 — THE CASE IS WRITTEN ON THE COPY. Each physical box gets one `copies` entry with
 * `whereabouts.case = { colour, label }`; `condition` is null because the label corpus says nothing
 * about wear. The note still carries `Case: yellow.` as before — the migration/import is additive.
 * The colour is the first word ("yellow" from "yellow base, clear tube"); the label is the full
 * descriptor. A record whose colours cannot be split across its boxes gets uncoloured copies, never
 * a guessed colour.
 *
 * Run from casemaker-app on Windows:
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/build-house.ts [--labels <labels.json>] [--out <house.json>]
 * Defaults: ../../tool-labels/labels.json and kazoo-house.json beside it. The label text is vendor
 * data and stays out of the repository (`tool-labels/` is ignored); this script is the logic.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBoxCode } from '../src/engine/cnc/registerCutter';
import { ToolSchema } from '../src/engine/cnc/toolLibrary';
import { caseColourOnly } from '../src/engine/cnc/caseColour';
import { InventorySchema, type Coded } from '../src/platform/houseClient';
import type { ToolCopy } from '../src/engine/cnc/toolCondition';

const here = dirname(fileURLToPath(import.meta.url));

interface Args {
  labels: string;
  out: string;
}

function parseArgs(argv: string[]): Args {
  let labels = join(here, '..', '..', 'tool-labels', 'labels.json');
  let out: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--labels') labels = resolve(argv[++i] ?? '');
    else if (a === '--out') out = resolve(argv[++i] ?? '');
    else if (a === '--') continue;
    else if (a !== undefined) throw new Error(`unknown argument "${a}"`);
  }
  return { labels, out: out ?? join(dirname(labels), 'kazoo-house.json') };
}

interface LabelReading {
  shape: 'flat' | 'ball' | 'engraving' | 'chamfer' | 'drill' | 'thread';
  threadSpec?: string;
  tipDiameter?: number | null;
  fluteLength?: number | null;
  angleDeg?: number | null;
  cutterDiameter?: number | null;
}

interface LabelVariant {
  quantity: number;
  case: string;
  collar?: boolean;
  overallLength: { mm: number };
  tipToCollarMm?: { mm: number };
}

interface LabelRecord {
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

const args = parseArgs(process.argv.slice(2));
const labels = JSON.parse(readFileSync(args.labels, 'utf8')) as { records: LabelRecord[] };
const SHANK = 3.175; // every label says 1/8" shank
const TYPE_TEXT: Record<string, string> = {
  flat: 'Flat End', ball: 'Ball Nose', engraving: 'Engraving', chamfer: 'Chamfer', drill: 'Drill', thread: 'Thread',
};
const near = (a: number | null | undefined, b: number | null | undefined) =>
  a == null || b == null ? a === b : Math.abs(a - b) < 1e-6;

const problems: string[] = [];

/**
 * One case descriptor per physical box, or null where the corpus does not say. The variant
 * sentence is the exact split ("2× yellow with collar; 2× orange"); a single `caseColours` entry
 * covers the whole quantity. Several descriptors with no variant split is UNKNOWN, not a guess.
 */
function casePerBox(r: LabelRecord): (string | null)[] {
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
function copiesFor(r: LabelRecord): ToolCopy[] {
  return casePerBox(r).map((descriptor, i) => ({
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

const inventory = labels.records.map((r) => {
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
  const tool = ToolSchema.parse({
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
    copies: copiesFor(r),
  };
}).filter((i): i is NonNullable<typeof i> => i !== null);

if (problems.length > 0) {
  console.error(`BUILD DISAGREES on ${problems.length}:\n  ` + problems.join('\n  '));
  process.exit(1);
}
const checked = InventorySchema.safeParse(inventory);
if (!checked.success) {
  console.error('InventorySchema refuses the document:', JSON.stringify(checked.error.issues, null, 1));
  process.exit(1);
}
const doc = { kind: 'casemaker-house', schemaVersion: 1, tools: [], inventory };
writeFileSync(args.out, JSON.stringify(doc, null, 2) + '\n');
const boxes = inventory.reduce((n, i) => n + i.quantity, 0);
const cased = inventory.reduce((n, i) => n + i.copies.filter((c) => c.whereabouts.kind === 'box' && c.whereabouts.case != null).length, 0);
console.log(`ok: ${inventory.length} items, ${boxes} boxes (${cased} with a case), reader agrees on every code -> ${args.out}`);
