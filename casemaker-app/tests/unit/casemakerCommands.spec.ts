// #477 — the command functions behind `casemaker export` and `casemaker location`, exercised
// directly. The export case is a real compile of a tiny project (the sample script's own
// calibration shape) through the shared Manifold path; the location cases read the committed
// fixture, never the machine's real document.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetRegistry } from '@/engine/cnc/toolRegistry';
import { exportMain } from '../../scripts/lib/casemaker/exportCommand';
import { locationMain, locationSectionLines } from '../../scripts/lib/casemaker/locationCommand';
import { type CommandOptions } from '../../scripts/lib/casemaker/output';
import { loadCatalogue, loadLocation } from '../../src/platform/headless/bootstrap';
import { parseReceipt, receiptJson, type Receipt } from '../../src/platform/headless/receipt';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'location-doc.json');
const CATALOGUE = join(HERE, 'fixtures', 'catalogue-doc.json');
const scratch = mkdtempSync(join(tmpdir(), 'casemaker-cli-'));
const absent = join(scratch, 'no-such-location.json');

afterAll(() => rmSync(scratch, { recursive: true, force: true }));
beforeEach(() => resetRegistry());
afterEach(() => {
  vi.restoreAllMocks();
  resetRegistry();
});

function capture(): { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  });
  return { lines, errors };
}

describe('#477 casemaker location', () => {
  it('renders the resolved document’s tools, stock and machines', () => {
    const loaded = loadLocation(FIXTURE)!;
    expect(loaded.kind).toBe('location');

    const tools = locationSectionLines(loaded, 'tools').join('\n');
    expect(tools).toContain('location "Test bench"');
    expect(tools).toContain('user:1a2b3c4d5e');
    expect(tools).toContain('owned      inv:inv-1a2b3c');
    expect(tools).toContain('2 tools from the user\'s own list, 1 owned cutter');

    const stock = locationSectionLines(loaded, 'stock').join('\n');
    expect(stock).toContain('stock-plate1');
    expect(stock).toContain('aluminium-6061');
    expect(stock).toContain('100 × 100 × 5 mm');

    const machines = locationSectionLines(loaded, 'machines').join('\n');
    expect(machines).toContain('machine-1a2b3c');
    expect(machines).toContain('192.0.2.10:2222');

    const accessories = locationSectionLines(loaded, 'accessories').join('\n');
    expect(accessories).toContain('fx-vise-1');
    expect(accessories).toContain('makera-z1-low-profile-vise');
    expect(accessories).toContain('on machine-1a2b3c');
  });

  it('runs each section and names the document it read', async () => {
    for (const section of ['tools', 'stock', 'machines', 'accessories'] as const) {
      const out = capture();
      expect(await locationMain([section, '--location', FIXTURE])).toBe(0);
      expect(out.lines[0]).toContain('location "Test bench"');
      expect(out.lines.length).toBeGreaterThan(1);
    }
  });

  it('says there is no document when the named file does not exist', async () => {
    const out = capture();
    expect(await locationMain(['tools', '--location', absent])).toBe(0);
    expect(out.lines.join('\n')).toContain('no location document');
  });

  it('refuses a missing or unknown section and a bad document by exit code, not process.exit', async () => {
    const missing = capture();
    expect(await locationMain([])).toBe(1);
    expect(missing.errors.join('\n')).toContain('usage: casemaker location');

    const unknown = capture();
    expect(await locationMain(['cutters', '--location', FIXTURE])).toBe(1);
    expect(unknown.errors.join('\n')).toContain('is not a location section');

    const badPath = join(scratch, 'bad.json');
    writeFileSync(badPath, '{ "kind": "casemaker-location" }');
    const bad = capture();
    expect(await locationMain(['tools', '--location', badPath])).toBe(1);
    expect(bad.errors.join('\n')).toContain('does not match this build');
  });
});

// #560 — a headless house has no Makera Studio to sync from. `import-catalogue` takes the
// `catalogue.json` a Studio machine synced, holds it to the app's own reader and writes it beside
// the house document, stating the date the file says it was synced.
describe('#560 casemaker location import-catalogue', () => {
  function houseDir(name: string): { dir: string; document: string; destination: string } {
    const dir = join(scratch, name);
    return { dir, document: join(dir, 'location.json'), destination: join(dir, 'catalogue.json') };
  }

  it('writes the catalogue beside the named house document and states its synced-at date', async () => {
    const house = houseDir('import-house');
    const out = capture();
    expect(await locationMain(['import-catalogue', CATALOGUE, '--location', house.document])).toBe(0);

    // The bytes written ARE the bytes read: the file is the sync's own, not a re-serialisation.
    expect(readFileSync(house.destination, 'utf8')).toBe(readFileSync(CATALOGUE, 'utf8'));
    // And the app's own reader reads what landed, date included.
    const loaded = loadCatalogue(house.destination)!;
    expect(loaded.syncedOn).toBe('2026-10-20T08:00:00.000Z');
    expect(loaded.tools).toHaveLength(2);
    expect(loaded.rows).toHaveLength(3);
    const text = out.lines.join('\n');
    expect(text).toContain(`catalogue ${CATALOGUE} -> ${house.destination}`);
    expect(text).toContain('2 cutters, 3 feed rows');
    expect(text).toContain('synced 2026-10-20T08:00:00.000Z');
    expect(text).not.toContain('replaced');
  });

  it('replaces a catalogue that was already there, and says so', async () => {
    const house = houseDir('import-replace');
    mkdirSync(house.dir, { recursive: true });
    writeFileSync(house.destination, readFileSync(CATALOGUE, 'utf8'));

    const out = capture();
    expect(await locationMain(['import-catalogue', CATALOGUE, '--location', house.document])).toBe(0);
    expect(out.lines.join('\n')).toContain('replaced the catalogue that was there');
  });

  it('imports a valid catalogue with no syncedAt date, and says the date is absent', async () => {
    const house = houseDir('import-no-date');
    const doc = JSON.parse(readFileSync(CATALOGUE, 'utf8')) as Record<string, unknown>;
    delete doc.syncedAt;
    const undated = join(scratch, 'catalogue-undated.json');
    writeFileSync(undated, JSON.stringify(doc));

    const out = capture();
    expect(await locationMain(['import-catalogue', undated, '--location', house.document])).toBe(0);
    expect(out.lines.join('\n')).toContain('the file states no synced-at date');
    expect(existsSync(house.destination)).toBe(true);
  });

  it('refuses a malformed catalogue by name and writes nothing', async () => {
    const house = houseDir('import-refused');
    const wrongVersion = join(scratch, 'catalogue-wrong-version.json');
    writeFileSync(wrongVersion, JSON.stringify({ kind: 'casemaker-catalogue', schemaVersion: 99 }));

    const out = capture();
    expect(await locationMain(['import-catalogue', wrongVersion, '--location', house.document])).toBe(1);
    expect(out.errors.join('\n')).toContain(`${wrongVersion} is version 99`);
    expect(existsSync(house.destination)).toBe(false);

    const wrongKind = join(scratch, 'catalogue-wrong-kind.json');
    writeFileSync(
      wrongKind,
      JSON.stringify({ kind: 'casemaker-location', schemaVersion: 1, tools: [], feeds: [] }),
    );
    const kind = capture();
    expect(await locationMain(['import-catalogue', wrongKind, '--location', house.document])).toBe(1);
    expect(kind.errors.join('\n')).toContain('this file must be "casemaker-catalogue"');
    expect(existsSync(house.destination)).toBe(false);
  });

  it('names a missing file and a missing argument instead of writing anything', async () => {
    const house = houseDir('import-missing');
    const missing = capture();
    expect(await locationMain(['import-catalogue', join(scratch, 'absent-catalogue.json'), '--location', house.document])).toBe(1);
    expect(missing.errors.join('\n')).toContain('could not read the catalogue at');
    expect(existsSync(house.destination)).toBe(false);

    const noArg = capture();
    expect(await locationMain(['import-catalogue'])).toBe(1);
    expect(noArg.errors.join('\n')).toContain('import-catalogue needs the synced catalogue file');
  });

  it('emits the group’s receipt under --json, with the counts and the synced-at date', async () => {
    const house = houseDir('import-receipt');
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array): boolean => {
      written.push(String(chunk));
      return true;
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const options: CommandOptions = { json: true };
    expect(await locationMain(['import-catalogue', CATALOGUE, '--location', house.document], options)).toBe(0);

    const text = written.join('');
    const receipt: Receipt = parseReceipt(JSON.parse(text));
    // One canonical form: what the command printed is what `receiptJson` renders.
    expect(receiptJson(receipt)).toBe(text);
    expect(receipt.command).toBe('location');
    expect(receipt.stage).toBe('import-catalogue');
    if (receipt.command !== 'location') throw new Error('expected a location receipt');
    expect(receipt.details.section).toBe('import-catalogue');
    expect(receipt.details.catalogue).toEqual({
      source: CATALOGUE,
      destination: house.destination,
      tools: 2,
      feeds: 3,
      syncedAt: '2026-10-20T08:00:00.000Z',
      replaced: false,
    });
    expect(receipt.inputs.map((f) => f.path)).toEqual([CATALOGUE]);
    expect(receipt.outputs.map((f) => f.path)).toEqual([house.destination]);
  });
});

describe('#477 casemaker export', () => {
  function calibrationProject(): Record<string, unknown> {
    const now = new Date(0).toISOString();
    return {
      schemaVersion: 1,
      id: 'cli-export-calibration',
      name: 'CLI export test',
      createdAt: now,
      modifiedAt: now,
      board: {
        id: 'cli-export-board',
        name: 'Export calibration',
        manufacturer: 'Case Maker tests',
        pcb: { size: { x: 30, y: 30, z: 1.6 } },
        mountingHoles: [],
        components: [],
        defaultStandoffHeight: 3,
        recommendedZClearance: 4,
        builtin: false,
      },
      case: {
        wallThickness: 2,
        floorThickness: 2,
        lidThickness: 2,
        cornerRadius: 2,
        internalClearance: 0.5,
        zClearance: 4,
        joint: 'snap-fit',
        ventilation: { enabled: false, pattern: 'none', coverage: 0 },
        bosses: { enabled: false, insertType: 'self-tap', outerDiameter: 5, holeDiameter: 2.5 },
      },
      ports: [],
      externalAssets: [],
    };
  }

  it('reads a saved project and writes its laid-out STL and PRINT-NOTES beside it', async () => {
    const projectPath = join(scratch, 'calibration.caseproj.json');
    writeFileSync(projectPath, JSON.stringify(calibrationProject(), null, 2));
    const out = capture();

    expect(await exportMain([projectPath, '--location', absent])).toBe(0);
    expect(out.lines.join('\n')).toContain('CLI_export_test.stl');
    expect(out.lines.join('\n')).toContain('triangles');

    const stl = join(scratch, 'CLI_export_test.stl');
    const notes = join(scratch, 'CLI_export_test-PRINT-NOTES.txt');
    expect(existsSync(stl)).toBe(true);
    expect(statSync(stl).size).toBeGreaterThan(84); // a non-empty binary STL
    expect(readFileSync(notes, 'utf8').length).toBeGreaterThan(0);
  }, 120_000);

  it('refuses a missing argument or an unreadable file by exit code', async () => {
    const missing = capture();
    expect(await exportMain([])).toBe(1);
    expect(missing.errors.join('\n')).toContain('usage: casemaker export');

    const unreadable = capture();
    expect(await exportMain([join(scratch, 'absent.caseproj.json')])).toBe(1);
    expect(unreadable.errors.join('\n')).toContain('cannot read');
  });
});
