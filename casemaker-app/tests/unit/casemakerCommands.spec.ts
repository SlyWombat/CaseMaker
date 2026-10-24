// #477 — the command functions behind `casemaker export` and `casemaker location`, exercised
// directly. The export case is a real compile of a tiny project (the sample script's own
// calibration shape) through the shared Manifold path; the location cases read the committed
// fixture, never the machine's real document.

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetRegistry } from '@/engine/cnc/toolRegistry';
import { exportMain } from '../../scripts/lib/casemaker/exportCommand';
import { locationMain, locationSectionLines } from '../../scripts/lib/casemaker/locationCommand';
import { loadLocation } from '../../src/platform/headless/bootstrap';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'location-doc.json');
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
