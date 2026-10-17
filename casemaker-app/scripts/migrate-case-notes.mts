/**
 * One-off migration of `Case: yellow.` notes into per-copy case records (#491).
 *
 * The label import has always written the physical case into an item's NOTES. #491 stores the
 * colour on the copy's box whereabouts, where every presentation reads it. This script reads the
 * inventory from a running house service, runs the pure migration (`caseNoteMigration.ts`) over
 * every item, and PATCHes back only the items that changed. THE NOTES ARE LEFT INTACT — the note is
 * the operator's record, not a field to consume.
 *
 * The rules, restated: one colour in the note → every copy of the item gets it, and the copy entries
 * the inventory did not have are created (condition null, never guessed). Several colours → only a
 * variant sentence that says how many of each ("2× yellow; 2× orange") is followed; otherwise the
 * item is left uncoloured and reported. Machine copies take no case. Re-running is safe: copies that
 * already state a case keep it.
 *
 * Run from casemaker-app on Windows, against the desktop app's house service:
 *
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/migrate-case-notes.mts \
 *     --url http://127.0.0.1:8123 [--dry-run] [--item <inventory id>]
 *
 * `--dry-run` prints what would change and writes nothing. No token is involved: the house API is
 * the app's own loopback service, and this script never touches the LAN.
 */

import { migrateCaseNotes } from '../src/engine/cnc/caseNoteMigration';
import { InventorySchema, type InventoryItem } from '../src/platform/houseClient';

interface Args {
  url: string;
  dryRun: boolean;
  item: string | null;
}

function parseArgs(argv: string[]): Args {
  let url: string | null = null;
  let dryRun = false;
  let item: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') url = argv[++i] ?? null;
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--item') item = argv[++i] ?? null;
    else if (a === '--') continue;
    else if (a !== undefined && a.startsWith('--')) throw new Error(`unknown flag "${a}"`);
    else if (a !== undefined) throw new Error(`unexpected argument "${a}"`);
  }
  if (url === null || url.trim() === '') {
    throw new Error('--url is required (e.g. --url http://127.0.0.1:8123)');
  }
  return { url: url.replace(/\/+$/, ''), dryRun, item };
}

function keyPath(id: string): string {
  return id.split('/').map(encodeURIComponent).join('/');
}

async function readInventory(url: string): Promise<{ items: InventoryItem[]; etag: string | null }> {
  const res = await fetch(`${url}/api/v1/inventory`, { headers: { Accept: 'application/json' } });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET inventory answered ${res.status}: ${text}`);
  const parsed: unknown = JSON.parse(text);
  const items = InventorySchema.parse(parsed);
  return { items: [...items], etag: res.headers.get('etag') };
}

async function patchItem(url: string, item: InventoryItem, etag: string | null): Promise<void> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (etag !== null) headers['If-Match'] = etag;
  const res = await fetch(`${url}/api/v1/inventory/${keyPath(item.id)}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(item),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PATCH ${item.id} answered ${res.status}: ${text}`);
  }
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`migrate-case-notes: ${e instanceof Error ? e.message : String(e)}`);
    console.error(
      'usage: npx tsx --tsconfig tsconfig.scripts.json scripts/migrate-case-notes.mts --url <house url> [--dry-run] [--item <id>]',
    );
    process.exitCode = 2;
    return;
  }

  const { items, etag } = await readInventory(args.url);
  const chosen = args.item === null ? items : items.filter((i) => i.id === args.item);
  if (args.item !== null && chosen.length === 0) {
    throw new Error(`no inventory item has id "${args.item}"`);
  }
  const results = migrateCaseNotes(chosen);
  const changed = results.filter((r) => r.changed);

  for (const r of results) {
    if (r.reason !== null) console.log(`${r.item.id}: ${r.reason}`);
  }
  console.log(
    `${items.length} item${items.length === 1 ? '' : 's'} read, ${changed.length} to change` +
      (args.dryRun ? ' (dry run — nothing written)' : ''),
  );
  if (args.dryRun || changed.length === 0) return;

  // Each PATCH changes the inventory's validator, so the next write asks for a fresh one. The
  // service's ETag is a whole-document version, not a per-item one (#321).
  let current = etag;
  let written = 0;
  for (const r of changed) {
    await patchItem(args.url, r.item, current);
    written += 1;
    const fresh = await readInventory(args.url);
    current = fresh.etag;
  }
  console.log(`wrote ${written} item${written === 1 ? '' : 's'}`);
}

main().catch((e: unknown) => {
  console.error(`migrate-case-notes: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
