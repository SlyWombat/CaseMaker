// #476 — the set-up every headless entry point shares: one wasm instance, the bundled faces
// parsed once, and the machine's own document (location.json, then house.json, then nothing)
// applied to the registry. The scripts' byte-identical outputs are checked against committed bench
// jobs in the commit; this spec holds the module's own contract.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { resetRegistry, getTools } from '@/engine/cnc/toolRegistry';
import { BUNDLED_FONTS, labelFontsLoaded } from '@/engine/fonts/registry';
import { bootstrap, loadLocation, LocationDocumentError } from '@/platform/headless/bootstrap';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'location-doc.json');
const LOCATION = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
  name: string;
  tools: unknown[];
  inventory: unknown[];
  machines: unknown[];
  stock: unknown[];
  defaults: Record<string, unknown>;
};

/** A scratch directory for documents this spec writes; the repo's fixtures stay untouched. */
const scratch = mkdtempSync(join(tmpdir(), 'casemaker-bootstrap-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function write(name: string, doc: unknown): string {
  const path = join(scratch, name);
  writeFileSync(path, typeof doc === 'string' ? doc : JSON.stringify(doc));
  return path;
}

beforeEach(() => resetRegistry());

describe('#476 the headless bootstrap', () => {
  it('returns one wasm instance per process, the fonts parsed, and the location it read', async () => {
    const first = await bootstrap({ location: FIXTURE });
    const second = await bootstrap({ location: FIXTURE });

    // "Idempotent per process": the second call hands back the very same module, and re-registering
    // the faces is a no-op rather than a second parse.
    expect(second.manifold).toBe(first.manifold);
    expect(first.manifold).toBeDefined();

    // Every bundled face, both weights, is in the parsed cache — what a label typeset needs.
    expect(
      labelFontsLoaded(
        BUNDLED_FONTS.flatMap((f) => [
          { text: 'A', font: f.id, weight: 'regular' as const },
          { text: 'A', font: f.id, weight: 'bold' as const },
        ]),
      ),
    ).toBe(true);

    // The location's own cutters and inventory are in the registry the pipeline resolves through.
    expect(first.location).not.toBeNull();
    expect(first.location!.kind).toBe('location');
    expect(first.location!.name).toBe(LOCATION.name);
    expect(first.location!.path).toBe(FIXTURE);
    expect(first.location!.tools).toHaveLength(LOCATION.tools.length);
    expect(first.location!.inventory).toHaveLength(LOCATION.inventory.length);
    // #477 — the document's other two sections are resolved here too, so `casemaker location`
    // does not parse the file a second time.
    expect(first.location!.machines).toHaveLength(LOCATION.machines.length);
    expect(first.location!.stock).toHaveLength(LOCATION.stock.length);
    expect(first.location!.defaults).not.toBeNull();
    const keys = getTools().map((t) => t.key);
    expect(keys).toEqual(expect.arrayContaining((first.location!.tools as { key: string }[]).map((t) => t.key)));
    expect(keys.some((k) => k.startsWith('inv:'))).toBe(true);
  });

  it('reads a house file as the house, with no name and no defaults', async () => {
    const path = write('house.json', { tools: LOCATION.tools, inventory: LOCATION.inventory });
    const loaded = loadLocation(path);
    expect(loaded).not.toBeNull();
    expect(loaded!.kind).toBe('house');
    expect(loaded!.name).toBeNull();
    expect(loaded!.defaults).toBeNull();
    // A house file has no machine or stock sections: empty, not the location's value.
    expect(loaded!.machines).toEqual([]);
    expect(loaded!.stock).toEqual([]);
    expect(loaded!.path).toBe(path);
    expect(getTools().some((t) => t.key === (LOCATION.tools[0] as { key: string }).key)).toBe(true);
  });

  it('tries the paths it is given in order: location.json wins over house.json', () => {
    const location = write('ordered-location.json', readFileSync(FIXTURE, 'utf8'));
    const house = write('ordered-house.json', { tools: [], inventory: [] });
    expect(loadLocation([location, house])!.path).toBe(location);
    expect(loadLocation([house, location])!.path).toBe(house);
  });

  it('answers null when this machine has no document at all', () => {
    expect(loadLocation([])).toBeNull();
  });

  it('refuses a document that is present but unreadable, naming the file', () => {
    const badJson = write('not-json.json', '{ "tools": ');
    expect(() => loadLocation(badJson)).toThrow(LocationDocumentError);
    expect(() => loadLocation(badJson)).toThrow(`${badJson} is not JSON:`);

    // A location this build cannot read is refused, not half-applied — the import panel's rule.
    const mismatched = write('mismatched.json', { kind: 'casemaker-location' });
    expect(() => loadLocation(mismatched)).toThrow(/does not match this build/);

    const badHouse = write('bad-house.json', { tools: 'not a list', inventory: [] });
    expect(() => loadLocation(badHouse)).toThrow(`${badHouse}: "tools" is not a tool list:`);
    expect(() => loadLocation(badHouse)).toThrow(LocationDocumentError);
  });

  it('answers null for a named document that is not there, and leaves the registry alone', () => {
    const before = getTools();
    expect(loadLocation(join(scratch, 'absent.json'))).toBeNull();
    expect(getTools()).toBe(before);
  });
});
