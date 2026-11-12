/**
 * #1244 — EACH REALM'S EDGE, TESTED ONCE: THE CLI.
 *
 * The engine no longer reads the ambient shop-settings source; settings enter at a realm's edge.
 * The worker's edge is tested by `settingsReaders1241` (the preview's registration band moves with
 * `probeResiduals(shop)`), and this spec tests the CLI's: `engraveJobMain` with three copies of one
 * location —
 *
 *   - the fixture as it is (every value at its recommendation),
 *   - the same fixture with the key REMOVED (the labelled fallback, which is the recommendation),
 *   - the fixture with one value chosen differently (`registration.viseJawResidualMm` = 0.3).
 *
 * The run sheet prints the registration's datum uncertainty, so the first two arms' sheets must be
 * byte-identical (the recommended value gives today's result from either source) and the third
 * must differ and state the chosen number. A shop value that did not reach the engine would leave
 * all three sheets identical.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { resetLiveShopDefaults } from '@/platform/defaultsClient';
import type { Receipt } from '@/platform/headless/receipt';
import { engraveJobMain } from '../../scripts/lib/casemaker/engrave';
import { HUMAN, type CommandOptions } from '../../scripts/lib/casemaker/output';
import type { EngraveJob } from '@/types/engraveJob';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE_LOCATION = join(APP, 'tests/unit/fixtures/location-doc.json');
const SCRATCH = mkdtempSync(join(tmpdir(), 'casemaker-engine-edge-1244-'));
afterAll(() => {
  resetLiveShopDefaults();
  rmSync(SCRATCH, { recursive: true, force: true });
});

/** A small vise-held pocket: seconds of CAM, and a sheet with the fixed jaw's datum line. */
function pocketJob(): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    name: 'edge-1244',
    stock: { length: 40, width: 30, thickness: 10, material: 'softwood' },
    labels: [],
    shapes: [
      {
        id: 'shp-1',
        kind: 'rect',
        position: { x: 20, y: 15 },
        rotation: 0,
        depth: 0.5,
        enabled: true,
        width: 10,
        height: 5,
        cornerRadius: 0,
      },
    ],
    toolKey: 'flat-1.0',
  } as EngraveJob;
}

/** A copy of the fixture location, optionally with one key removed or one value chosen. */
function locationCopy(name: string, edit?: { remove?: string; choose?: { key: string; value: number } }): string {
  const location = JSON.parse(readFileSync(FIXTURE_LOCATION, 'utf8')) as {
    tools?: { tool: Record<string, unknown> }[];
    inventory?: { tool: Record<string, unknown> }[];
    defaults: Record<string, { value: unknown; source: string; setAt: string | null; unit: string | null; note: string | null }>;
  };
  if (edit?.remove !== undefined) delete location.defaults[edit.remove];
  if (edit?.choose !== undefined) {
    location.defaults[edit.choose.key] = {
      value: edit.choose.value,
      source: 'chosen',
      setAt: '2026-11-12T00:00:00.000Z',
      unit: 'mm',
      note: null,
    };
  }
  const path = join(SCRATCH, `location-${name}.json`);
  writeFileSync(path, JSON.stringify(location, null, 1));
  return path;
}

/** Run the CLI for a job and a location; return its run sheet's text. */
async function sheetText(jobPath: string, locationPath: string): Promise<string> {
  const outDir = join(SCRATCH, `out-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(outDir, { recursive: true });
  let receipt: Receipt | null = null;
  const options: CommandOptions = { ...HUMAN, sink: { receipt: (r) => { receipt = r; } } };
  const code = await engraveJobMain([jobPath, '--out', outDir, '--location', locationPath], options);
  expect(code, 'the command must succeed').toBe(0);
  expect(receipt, 'the command must emit a receipt').not.toBeNull();
  const sheet = readdirSync(outDir).find((f) => f.endsWith('-run-sheet.md'));
  expect(sheet, 'the run must write its sheet').toBeDefined();
  return readFileSync(join(outDir, sheet!), 'utf8');
}

describe('#1244 the CLI’s edge carries a chosen setting into the engine', () => {
  it('the recommended value gives today’s sheet from either source; a chosen value changes it', async () => {
    const jobPath = join(SCRATCH, 'edge-1244.job.json');
    writeFileSync(jobPath, JSON.stringify(pocketJob(), null, 1));
    const base = locationCopy('base');
    const absent = locationCopy('absent', { remove: 'registration.viseJawResidualMm' });
    const chosen = locationCopy('chosen', { choose: { key: 'registration.viseJawResidualMm', value: 0.3 } });

    const baseSheet = await sheetText(jobPath, base);
    const absentSheet = await sheetText(jobPath, absent);
    const chosenSheet = await sheetText(jobPath, chosen);

    // The recommendation, from a seeded value or from the labelled fallback: the same sheet.
    expect(absentSheet).toBe(baseSheet);
    // A chosen value reaches the registration plan the sheet prints.
    expect(chosenSheet).not.toBe(baseSheet);
    expect(chosenSheet).toContain('±0.3 mm');
    expect(baseSheet).not.toContain('±0.3 mm');
  }, 600_000);
});
