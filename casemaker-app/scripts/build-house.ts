/**
 * Build a `casemaker-house` document from labels.json, ready for POST /api/v1/import or the app's
 * Import. The build itself — the app's own box-code reader (`parseBoxCode`, after #377–#380) against
 * every label, and the inventory rows it produces (#654 scope 4) — is `src/engine/cnc/houseDocument.ts`;
 * this script owns only the paths, the JSON and the exit code.
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
import { InventorySchema } from '../src/platform/houseClient';
import { buildHouseInventory, type LabelRecord } from '../src/engine/cnc/houseDocument';

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

const args = parseArgs(process.argv.slice(2));
const labels = JSON.parse(readFileSync(args.labels, 'utf8')) as { records: LabelRecord[] };
const { inventory, problems } = buildHouseInventory({ records: labels.records });

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
