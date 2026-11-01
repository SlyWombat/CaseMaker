/**
 * #743 P-6 — the board's Cut-side facts and its run sheet.
 *
 * The budget is pure arithmetic (design §3.6): depth − copper − the job's Z budget. The sheet's
 * board section is design §3.7: the blank, what each file made (role and SHA-256 prefix), the
 * program order, and the meter check after the run.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { tl } from './helpers/manifoldExec';
import { flatEndMill } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { FeedCatalogueRow } from '@/engine/cnc/feeds';
import { pcbSurfaceBudget, pcbSurfaceSentence } from '@/engine/cnc/engrave/pcbBudget';
import { buildRunSheet } from '@/engine/cnc/engrave/runSheet';
import { engraveGenerate } from '@/workers/sim/engraveGenerate';
import { buildPcbJob, type PcbJobFile } from '../../scripts/lib/casemaker/pcbJob';
import type { EngraveJob } from '@/types/engraveJob';

const FIXTURES = join(process.cwd(), 'tests/unit/fixtures/pcb');
const bytes = (name: string): Uint8Array<ArrayBuffer> => Uint8Array.from(readFileSync(join(FIXTURES, name)));
const file = (name: string): PcbJobFile => ({ name, bytes: bytes(name) });
const BLANK = { length: 60, width: 40, thickness: 1.6 };
const TABS = { count: 3, width: 3, height: 1 };

const engraver: ToolLibraryEntry = {
  key: 'inv:engrave-60',
  provenance: 'test',
  tool: flatEndMill(3.175, {
    id: 'pcb-engrave-0-1-60',
    name: '60° 0.1 mm engraving bit',
    typeText: 'Engraving',
    shape: 'engraving',
    tipDiameter: 0.1,
    diameter: 3.175,
    halfAngle: 30,
    angle: 60,
    fluteLength: 12,
  }),
};
const corn: ToolLibraryEntry = {
  key: 'inv:corn-0-8',
  provenance: 'test',
  tool: flatEndMill(0.8, { id: 'pcb-corn-0-8', name: '0.8 mm corn bit', fluteLength: 12 }),
};
const bit = (key: string, id: string, d: number): ToolLibraryEntry => ({
  key,
  provenance: 'test',
  tool: flatEndMill(d, { id, shape: 'drill', tipDiameter: d, diameter: d, fluteLength: 12 }),
});
const TOOLS = [engraver, bit('inv:d08', 'pcb-drill-0-8', 0.8), bit('inv:d10', 'pcb-drill-1-0', 1.0), corn];
const ROWS: FeedCatalogueRow[] = [
  { cutterId: 'pcb-engrave-0-1-60', material: 'PCB', rpm: 12000, feed: 500, plungeFeed: 200, stepDown: 0.1 },
  { cutterId: 'pcb-corn-0-8', material: 'PCB', rpm: 12000, feed: 500, plungeFeed: 200, stepDown: 0.2 },
  { cutterId: 'pcb-drill-0-8', material: 'PCB', rpm: 12000, feed: 300, plungeFeed: 100, stepDown: 1.6 },
  { cutterId: 'pcb-drill-1-0', material: 'PCB', rpm: 12000, feed: 300, plungeFeed: 100, stepDown: 1.6 },
];

/** A job that only has the two fields the budget reads. */
function boardJob(depth = 0.1, capMm: number | null = 0.035): EngraveJob {
  const job = {
    stock: {
      length: 60,
      width: 40,
      thickness: 1.6,
      material: 'pcb',
      ...(capMm === null ? {} : { colour: { kind: 'laminate', capMm } }),
    },
    combined: [{ id: 'iso', kind: 'frame', isolation: true, enabled: true, depth }],
  } as unknown as EngraveJob;
  return job;
}

describe('the surface budget (§3.6)', () => {
  it('is depth − copper − the Z budget, with the design’s arithmetic', () => {
    const budget = pcbSurfaceBudget(boardJob(), 0.02);
    expect(budget).not.toBeNull();
    expect(budget?.depthMm).toBe(0.1);
    expect(budget?.capMm).toBe(0.035);
    expect(budget?.budgetMm).toBe(0.045);
  });

  it('states the miss with the measured residual and the physical fix', () => {
    const budget = pcbSurfaceBudget(boardJob(), 0.02)!;
    const sentence = pcbSurfaceSentence(budget, 0.06);
    expect(sentence).toContain('uneven by 0.06 mm after its tilt is taken out');
    expect(sentence).toContain('within 0.045 mm');
    expect(sentence).toContain('It is 0.015 mm over');
    expect(sentence).toContain('tape the board flat');
  });

  it('is null for a job that is not a board', () => {
    expect(pcbSurfaceBudget(boardJob(0.1, null), 0.02)).toBeNull();
  });
});

describe('the board’s run sheet (§3.7)', () => {
  it('states the board, what each file made, the program order and the meter check', async () => {
    const built = await buildPcbJob(
      tl,
      [file('tiny-F_Cu.gbr'), file('tiny-Edge_Cuts.gbr'), file('tiny-inside.drl')],
      { blank: BLANK, tabs: TABS, tools: TOOLS, catalogue: ROWS },
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const job = built.job;
    job.toolKey = engraver.key;
    // The app resolves the job's cutter from its registry; a test carries it on the job instead.
    job.tool = engraver.tool;
    // The roles ride the sources (and survive the schema), which is what the sheet reads.
    expect(job.sourceFiles?.map((s) => s.role)).toEqual(['top-copper', 'outline', 'drills']);
    const gen = await engraveGenerate(tl, job, engraver.tool, ROWS, null, undefined, { tools: TOOLS });
    expect(gen.ok).toBe(true);
    const sheet = buildRunSheet(job, gen, null, new Date('2026-10-31T00:00:00Z'));

    const board = sheet.sections.find((s) => s.title.endsWith('· The board'));
    expect(board).toBeDefined();
    const text = board!.steps.map((s) => `${s.text} ${s.value ?? ''}`).join('\n');
    expect(text).toContain('PCB 60 × 40 × 1.6 mm, copper 0.035 mm on the top face, copper side up.');
    expect(text).toContain('taped flat to the bed over a 12 mm board');
    // One line per file, with its role and its digest's prefix.
    expect(text).toMatch(/What the files made — tiny-F_Cu\.gbr\s+top copper · [0-9a-f]{8}/);
    expect(text).toMatch(/What the files made — tiny-Edge_Cuts\.gbr\s+outline · [0-9a-f]{8}/);
    expect(text).toMatch(/What the files made — tiny-inside\.drl\s+drills · [0-9a-f]{8}/);
    // The program order, with the holes' sizes and the cut-out's tabs.
    expect(text).toContain('1 Isolate the copper · 0.215 mm wide · 0.1 mm deep');
    expect(text).toContain('2 8 holes (⌀0.8 mm, ⌀1 mm)');
    expect(text).toContain('3 Cut out the board · 3 tabs');

    // #743 P-6 — the run sheet NAMES THE COPPER'S SHORTS: the coverage carries the same sentence
    // the Cut confirm prints, built from the report.
    const withCopper = buildRunSheet(
      job,
      gen,
      {
        diagnostics: [],
        copper: { ok: false, designPieces: 2, pieces: 1, matched: 2, shorts: 1, bandLeftMm2: 0.452 },
      },
      new Date('2026-10-31T00:00:00Z'),
    );
    const warnings = withCopper.sections.find((s) => s.title.endsWith('· Warnings carried from the app'));
    const warningsText = warnings!.steps.map((s) => s.text).join('\n');
    expect(warningsText).toContain('The copper does not match the design: 1 piece, 2 of 2 still there, 1 short');
    expect(warningsText).toContain('0.452 mm² of copper left in the isolation');

    const record = sheet.sections.find((s) => s.title.endsWith('· Record afterwards'));
    const recordText = record!.steps.map((s) => s.text).join('\n');
    expect(recordText).toContain('Break the tabs and sand the edge.');
    expect(recordText).toContain('Check for shorts with a meter between neighbouring pads before soldering.');
  });
});
