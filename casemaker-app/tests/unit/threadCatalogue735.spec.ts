// #735 item 2 — a thread program runs on the catalogue's numbers when the cutter carries its
// Makera id and the catalogue is handed in.
//
// The bench set (docs/bench/2026-10-27-z1-typical-jobs, run j18) posts the M3 thread mill at
// 10 000 RPM / 300 mm/min, while Makera's catalogue states 15 000 / 60 for this bit. The engine
// already prefers a catalogue row (`threadMill.ts`'s `threadSettings`): what fails on the bench is
// that the owned cutter carries no Makera `g_ID` and the CLI loads no catalogue — #732's work, in
// parallel. These tests pin the engine half at the j18 fixture, and both failure states the issue
// names: no id (no row can name the cutter) and an id with an empty catalogue (nothing to match).
//
// The row's 15 000 RPM is +15.4 % over the Z1's 13 000 RPM ceiling. `clampToMachine` refuses a
// gross overage (50 % above the ceiling) and CLAMPS a modest one, so the honest result of this
// row on this machine is 13 000 RPM with the machine's own warning — not 15 000 silently, and not
// the seeds. The feed is the row's 60 mm/min unchanged.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRunSheet } from '@/engine/cnc/engrave/runSheet';
import type { FeedCatalogueRow } from '@/engine/cnc/feeds';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import type { EngraveJob } from '@/types/engraveJob';
import { generate } from './helpers/engravePipeline';
import { tl } from './helpers/manifoldExec';

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH = resolve(HERE, '../../../docs/bench/2026-10-27-z1-typical-jobs/jobs');

/**
 * Stands in for the owned cutter's Makera `g_ID` — the id `#732` carries onto the inventory entry.
 * The engine treats it opaquely: the catalogue row is matched by exactly this string.
 */
const MAKERA_ID = 'makera-thread-m3-id';

/**
 * Makera's own numbers for this bit (15 000 RPM / 60 mm/min), on the ABS row that answers a PLA
 * blank — the catalogue lists no printed-blank plastic, so ABS is the documented stand-in (#455).
 * The fixture is a PLA proxy, not the 6061 blank the vendor's row was written for.
 */
const ROW: FeedCatalogueRow = {
  cutterId: MAKERA_ID,
  material: 'ABS',
  rpm: 15000,
  feed: 60,
  plungeFeed: 30,
  stepDown: 0.2,
};

function threadMill(id: string | null): Tool {
  return flatEndMill(2.4, {
    id,
    name: 'Thread Milling Bit - 1/8" Shank M3(d2.4mm) * 9mm',
    typeText: 'Thread mill',
    shape: 'thread',
    tipDiameter: 2.4,
    diameter: 3.175,
    fluteLength: 9,
    cornerRadius: null,
  });
}

function benchJob(tool: Tool): EngraveJob {
  const parsed = parseEngraveJob(
    JSON.parse(readFileSync(resolve(BENCH, 'j18-thread-b-mill-proxy.json'), 'utf8')),
  );
  if (!parsed.ok) throw new Error(`the bench fixture no longer parses: ${JSON.stringify(parsed.errors)}`);
  return { ...parsed.job, tool };
}

describe('#735 item 2 — the thread program’s S/F come from the catalogue row', () => {
  it('without a Makera id the program posts the labelled placeholders — the bench set’s j18 failure', () => {
    const job = benchJob(threadMill(null));
    const g = generate(tl, job);
    expect(g.ok, `${g.stage}: ${JSON.stringify(g.errors)}`).toBe(true);
    // No id: `catalogueCoverageFor` answers `no-vendor-id`, no row can name this cutter, and the
    // thread.* placeholders (10000 RPM / 300 mm/min) are the program's own numbers.
    expect(g.threadMachining?.sources.feed).toBe('fallback');
    expect(g.threadMachining?.settings.feed).toBe(300);
    expect(g.threadMachining?.settings.plungeFeed).toBe(100);
    expect(g.threadMachining?.settings.spindleRpm).toBe(10000);
    expect(g.nc).toContain('S10000');
    expect(g.nc).toContain('F300');
  });

  it('a Makera id with no catalogue loaded is still the placeholders — the CLI’s state until #732', () => {
    // The other half of the bench failure: the id is carried, but the CLI loads no catalogue, so
    // there is nothing to answer with. The row is the only fix; a seeded speed is not evidence.
    const g = generate(tl, benchJob(threadMill(MAKERA_ID)));
    expect(g.ok, `${g.stage}: ${JSON.stringify(g.errors)}`).toBe(true);
    expect(g.threadMachining?.sources.feed).toBe('fallback');
    expect(g.threadMachining?.settings.feed).toBe(300);
    expect(g.threadMachining?.settings.spindleRpm).toBe(10000);
    expect(g.nc).toContain('S10000');
  });

  it('id + catalogue row: the row’s 60 mm/min, and its 15 000 RPM clamped to the Z1’s 13 000', () => {
    const job = benchJob(threadMill(MAKERA_ID));
    const g = generate(tl, job, null, [ROW]);
    expect(g.ok, `${g.stage}: ${JSON.stringify(g.errors)}`).toBe(true);
    const s = g.threadMachining!.settings;
    // The feed is the row's, unchanged.
    expect(s.feed).toBe(60);
    expect(s.plungeFeed).toBe(30);
    // 15 000 / 13 000 = 1.154, inside clampToMachine's 50 % refuse band, so it is CLAMPED and
    // adopted: the program runs at the machine's ceiling, and the machine's sentence says so.
    expect(s.spindleRpm).toBe(13000);
    expect(g.threadMachining!.sources.feed).toBe('catalogue: ABS');
    expect(g.threadMachining!.sources.plungeFeed).toBe('catalogue: ABS');
    expect(g.threadMachining!.sources.spindleRpm).toBe('catalogue: ABS');
    const clamped = g.threadMachining!.diagnostics.find((d) => d.code === 'rpm-clamped');
    expect(clamped?.severity).toBe('warning');
    expect(clamped?.message).toContain('15000');
    expect(clamped?.message).toContain('13000');
    // The posted file states the numbers it runs — not the row's raw 15 000, and not the seeds.
    expect(g.nc).toContain('S13000');
    expect(g.nc).toContain('F60');
    expect(g.nc).not.toContain('S15000');
    expect(g.nc).not.toContain('S10000');
    expect(g.nc).not.toContain('F300');
    // The sheet repeats the resolved settings, so the operator reads the clamped spindle and the
    // row's feed rather than the placeholders.
    const sheet = buildRunSheet(job, g, null);
    const cutValue = sheet.sections.find((x) => x.id === 'cut')?.steps[0]?.value ?? '';
    expect(cutValue).toContain('13000 RPM');
    expect(cutValue).toContain('60 mm/min helical feed');
    expect(cutValue).toContain('30 mm/min down the pilot');
    expect(cutValue).not.toContain('10000 RPM');
  });

  it('the missing-pilot warning is STATED, not a block — the shipped #445 decision, kept', () => {
    // The fixture's blank has no pilot cut anywhere, so `thread-pilot-unproven` fires. #445
    // decided this is the operator's precondition, said out loud: a thread mill cannot cut the
    // pilot itself, and the pilot may already exist from an earlier run or another job, which no
    // document in this app can prove either way. The warning names the diameter and depth; the
    // program is written. Blocking would refuse a job whose pilot exists, and could not make one
    // that does not. Nothing in the bench evidence shows a pilot-present program unsafe.
    const g = generate(tl, benchJob(threadMill(MAKERA_ID)), null, [ROW]);
    expect(g.ok, `${g.stage}: ${JSON.stringify(g.errors)}`).toBe(true);
    const pilot = g.findings.find((f) => f.code === 'thread-pilot-unproven');
    expect(pilot?.severity).toBe('warning');
    expect(pilot?.message).toContain('assumes a');
    expect(pilot?.message).toContain('pilot');
    expect(g.nc).not.toBeNull();
  });
});
