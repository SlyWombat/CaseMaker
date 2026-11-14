/**
 * #1237 — A LOCATION FILE WITH NO SETTINGS SECTION IS SAID, NOT ASSUMED.
 *
 * A pre-#412 house file (tools and inventory only) states no shop settings; the CLI plans it on the
 * recommendations and names no location to the planner (so the planner's guard does not refuse it).
 * That must not be silent: one progress line AND a run-level info diagnostic in the receipt say
 * "this location file has no settings section; planned on the recommendations." A location document
 * (always a settings map, `{}` when it states none) says nothing.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import type { Receipt } from '@/platform/headless/receipt';
import { NO_SETTINGS_SECTION, engraveJobMain } from '../../scripts/lib/casemaker/engrave';
import { HUMAN, type CommandOptions } from '../../scripts/lib/casemaker/output';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE_LOCATION = join(APP, 'tests', 'unit', 'fixtures', 'location-doc.json');
const SCRATCH = mkdtempSync(join(tmpdir(), 'casemaker-no-settings-1237-'));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

async function run(locationPath: string, tag: string): Promise<{ lines: string[]; receipt: Receipt }> {
  const job = defaultEngraveJob();
  job.toolKey = 'flat-1.0';
  const jobPath = join(SCRATCH, `${tag}.job.json`);
  writeFileSync(jobPath, JSON.stringify(job));
  const out = join(SCRATCH, `${tag}-out`);
  mkdirSync(out, { recursive: true });
  const lines: string[] = [];
  let receipt: Receipt | null = null;
  const options: CommandOptions = {
    ...HUMAN,
    now: new Date('2026-11-14T12:00:00.000Z'),
    sink: { progress: (l) => lines.push(l), receipt: (r) => { receipt = r; } },
  };
  const code = await engraveJobMain([jobPath, '--out', out, '--location', locationPath], options);
  expect(code, lines.join('\n')).toBe(0);
  return { lines, receipt: receipt! };
}

describe('#1237 the location file with no settings section is said', () => {
  it('a house file: one progress line and one info diagnostic in the receipt', async () => {
    const house = join(SCRATCH, 'house.json');
    writeFileSync(house, JSON.stringify({ tools: [], inventory: [] }));
    const { lines, receipt } = await run(house, 'house');
    expect(lines.filter((l) => l.includes(NO_SETTINGS_SECTION))).toHaveLength(1);
    const hits = receipt.diagnostics.filter((d) => d.code === 'location-no-settings');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ severity: 'info', message: NO_SETTINGS_SECTION, program: null });
  }, 240_000);

  it('a location document says nothing, even one that states no overrides', async () => {
    const doc = JSON.parse(readFileSync(FIXTURE_LOCATION, 'utf8')) as { defaults: unknown };
    doc.defaults = {};
    const path = join(SCRATCH, 'empty-settings-location.json');
    writeFileSync(path, JSON.stringify(doc));
    const { lines, receipt } = await run(path, 'empty');
    expect(lines.some((l) => l.includes(NO_SETTINGS_SECTION))).toBe(false);
    expect(receipt.diagnostics.some((d) => d.code === 'location-no-settings')).toBe(false);
  }, 240_000);
});
