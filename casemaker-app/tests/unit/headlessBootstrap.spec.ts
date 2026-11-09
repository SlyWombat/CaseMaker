// #476 — the set-up every headless entry point shares: one wasm instance, the bundled faces
// parsed once, and the machine's own document (location.json, then house.json, then nothing)
// applied to the registry. The scripts' byte-identical outputs are checked against committed bench
// jobs in the commit; this spec holds the module's own contract.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { dedupeCutterEntries } from '@/engine/cnc/toolLibrary';
import { resetRegistry, getTools } from '@/engine/cnc/toolRegistry';
import { BUNDLED_FONTS, labelFontsLoaded } from '@/engine/fonts/registry';
import {
  bootstrap,
  CatalogueDocumentError,
  loadCatalogue,
  loadLocation,
  LocationDocumentError,
} from '@/platform/headless/bootstrap';

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

// #732 — THE CLI'S CATALOGUE READER (#308). `loadCatalogue` turns the house's `catalogue.json`
// into the rows every feeds tier takes. The geometry join is load-bearing: a row alone cannot say
// whether the id it names still describes the cutter in hand, and that comparison is what REFUSES
// a stale match rather than cutting on it.
describe('#732 the house catalogue reader', () => {
  const MILL_ID = '112111313870';

  const catalogue = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    kind: 'casemaker-catalogue',
    schemaVersion: 1,
    syncedAt: '2026-10-20T08:00:00.000Z',
    tools: [
      {
        key: 'cat:fixture-mill',
        provenance: 'fixture',
        contentHash: 'fixture',
        tool: {
          number: 1,
          id: MILL_ID,
          name: 'fixture thread mill',
          typeText: 'Thread',
          shape: 'thread',
          handleDiameter: 3.175,
          tipDiameter: null,
          diameter: 2,
          cornerRadius: null,
          angle: null,
          halfAngle: null,
          fluteLength: 12,
          shoulderLength: null,
          stickout: null,
          centreCutting: null,
        },
      },
    ],
    feeds: [
      { cutterId: MILL_ID, material: '6061 Aluminum', rpm: 15000, feed: 60, plungeFeed: 60, stepDown: 0.5 },
    ],
    ...over,
  });

  it('reads and validates the catalogue, joining each row to its cutter’s geometry', () => {
    const path = write('catalogue.json', catalogue());
    const loaded = loadCatalogue(path)!;
    expect(loaded.path).toBe(path);
    expect(loaded.syncedOn).toBe('2026-10-20T08:00:00.000Z');
    expect(loaded.tools).toHaveLength(1);
    expect(loaded.rows).toHaveLength(1);
    expect(loaded.rows[0]!.cutter).toEqual({ shape: 'thread', diameter: 2, tipDiameter: null });
  });

  it('answers null when the file is not there, and refuses one that is not this build’s', () => {
    // No catalogue on this machine is a normal state — the starting table answers.
    expect(loadCatalogue(join(scratch, 'absent-catalogue.json'))).toBeNull();

    const wrongKind = write('catalogue-wrong-kind.json', catalogue({ kind: 'casemaker-location' }));
    expect(() => loadCatalogue(wrongKind)).toThrow(CatalogueDocumentError);
    expect(() => loadCatalogue(wrongKind)).toThrow(
      `${wrongKind} says it is "casemaker-location"; this file must be "casemaker-catalogue"`,
    );

    const wrongVersion = write('catalogue-wrong-version.json', catalogue({ schemaVersion: 2 }));
    expect(() => loadCatalogue(wrongVersion)).toThrow(
      `${wrongVersion} is version 2; this build reads version 1`,
    );

    // A row no cut can use is refused WITH its section named, not silently dropped.
    const badFeeds = write(
      'catalogue-bad-feeds.json',
      catalogue({
        feeds: [{ cutterId: MILL_ID, material: '6061 Aluminum', rpm: 0, feed: 60, plungeFeed: 60, stepDown: 0.5 }],
      }),
    );
    expect(() => loadCatalogue(badFeeds)).toThrow(
      `${badFeeds} does not match its own schema: "feeds" is not a feed catalogue:`,
    );
  });
});

// #1111 R1 — BOTH DOORS BUILD THE REGISTRY FROM THE SAME THREE TIERS. The app's registry is
// built-ins + the house service's `cat:` rows + the inventory's `inv:` rows; the CLI's bootstrap
// registered only the location's own list, so its candidate set carried no `cat:` entry (its IDEAL
// plan ran without the catalogue) and its arrival order differed. The catalogue beside the
// location is now registered as `cat:` definitions, and `dedupeCutterEntries` puts the result in
// one canonical order whichever way the two lists arrive.
describe('#1111 the bootstrap registers the catalogue beside the location', () => {
  const CATALOGUE = {
    kind: 'casemaker-catalogue',
    schemaVersion: 1,
    syncedAt: '2026-10-20T08:00:00.000Z',
    tools: [
      {
        key: 'cat:fixture-1111-flat',
        provenance: 'fixture',
        contentHash: 'fixture',
        tool: {
          number: 2,
          id: '111011313825',
          name: 'fixture 3.175 flat',
          typeText: 'Flat End',
          shape: 'flat',
          handleDiameter: 3.175,
          tipDiameter: 3.175,
          diameter: 3.175,
          cornerRadius: 0,
          angle: 0,
          halfAngle: 0,
          fluteLength: 25,
          shoulderLength: null,
          stickout: null,
          centreCutting: null,
        },
      },
    ],
    feeds: [],
  };

  const tier = (key: string): number =>
    key.startsWith('inv:') ? 0 : key.startsWith('user:') ? 1 : key.startsWith('cat:') ? 2 : 3;

  it('adds the catalogue’s cat: definitions, in one canonical order', async () => {
    const dir = mkdtempSync(join(scratch, 'cat-loc-'));
    const locationPath = join(dir, 'location.json');
    writeFileSync(locationPath, JSON.stringify(LOCATION));
    writeFileSync(join(dir, 'catalogue.json'), JSON.stringify(CATALOGUE));

    const boot = await bootstrap({ location: locationPath });
    expect(boot.catalogue?.tools.map((t) => t.key)).toEqual(['cat:fixture-1111-flat']);
    expect(getTools().map((t) => t.key)).toContain('cat:fixture-1111-flat');
    // The shop's list — the one every pick reads — is the dedupe's canonical order: owned tiers
    // first, the catalogue's definitions after, the built-ins last, whatever order the documents
    // were concatenated in.
    const keys = dedupeCutterEntries(getTools()).map((t) => t.key);
    expect(keys).toContain('cat:fixture-1111-flat');
    expect(keys.some((k) => k.startsWith('inv:'))).toBe(true);
    expect(keys.map(tier)).toEqual([...keys.map(tier)].sort((a, b) => a - b));
  });

  it('a location with no catalogue beside it is unchanged', async () => {
    const boot = await bootstrap({ location: FIXTURE });
    expect(boot.catalogue).toBeNull();
    expect(getTools().filter((t) => t.key.startsWith('cat:'))).toEqual([]);
  });
});
