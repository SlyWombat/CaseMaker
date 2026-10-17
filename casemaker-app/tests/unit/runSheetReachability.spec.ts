// The run sheet's reachability report (#410).
//
// The report exists because of the one fact a single "what did it lose" number cannot carry: a
// region no cutter on the bench reaches at all. The table it prints is measured, so these cases
// build the `Reachability` the way the bench does — through `reachabilityFor` with an injected
// `measure` — and then assert only what the SHEET adds: the framing, the grouping, and the two
// sentences that are the whole reason the section is on the paper.

import { describe, it, expect } from 'vitest';

import { buildRunSheet, type RunSheet, type RunSheetGenerated } from '@/engine/cnc/engrave/runSheet';
import { reachabilityFor, type Reachability } from '@/engine/cnc/engrave/reachability';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { LabelEngravability } from '@/workers/sim/engraveGeometry';
import type { EngraveJob } from '@/types/engraveJob';

const NOW = new Date('2026-10-15T00:00:00Z');

/**
 * The three items, with the area each one's profile holds. A measurement row names an item by its
 * ID, so the fixture keeps ids and display text apart the way a real job does — `"TITLE"` is what
 * `itemName` prints, `title` is what the plan and the table key on.
 */
const ITEMS = [
  { id: 'title', text: 'TITLE', area: 900 },
  { id: 'sub', text: 'SUB', area: 100 },
  { id: 'lost', text: 'LOST', area: 50 },
];

function tool(key: string, diameter: number, opts: Partial<Tool> = {}): ToolLibraryEntry {
  return { key, tool: flatEndMill(diameter, { shoulderLength: 12, ...opts }), provenance: 'runSheetReachability test' };
}

function jobWith(): EngraveJob {
  const job = defaultEngraveJob();
  job.labels = ITEMS.map((item, i) => ({
    id: item.id,
    text: item.text,
    font: 'sans-default',
    weight: 'bold' as const,
    size: 8,
    position: { x: 15 + i * 20, y: 30 },
    rotation: 0,
    depth: 1,
    enabled: true,
  }));
  return job;
}

/** A measured row in `measureLabels`'s shape. */
function row(labelId: string, opened: number): LabelEngravability {
  const area = ITEMS.find((i) => i.id === labelId)!.area;
  return { labelId, glyphArea: area, openedArea: opened, ratio: opened / area, emptyChars: [], outsideArea: 0, polygons: [] };
}

const TOOLS = [tool('ball', 1.0, { shape: 'ball', typeText: 'Ball End' }), tool('wide', 3.175), tool('fine', 1.0)];

/** The design the section is written for: the wide bit reaches nothing, the fine one reaches two of
 * the three regions, and `LOST` is beyond both — the case a single number would hide. */
function reachFor(): Reachability {
  const opened = (key: string, id: string): number =>
    key === 'fine' ? { title: 900, sub: 80, lost: 0 }[id]! : 0;
  return reachabilityFor(jobWith(), TOOLS, [], (key) => ITEMS.map((i) => row(i.id, opened(key, i.id))));
}

function generated(): RunSheetGenerated {
  return {
    findings: [],
    feeds: null,
    cam: { operations: 1, cuttingMoves: 10, estimatedSeconds: 30, passes: 1 },
    nc: 'G21 G90\nM2',
    verify: null,
    frameNc: null,
  };
}

function sheetFor(reach?: Reachability, unreachable?: { row: ReturnType<typeof reachFor>['cutters'][0]['rows'][0]; cutters: number }[]): RunSheet {
  const job = jobWith();
  return buildRunSheet(job, generated(), null, NOW, undefined, {
    ...(reach ? { reachability: reach } : null),
    ...(unreachable ? { unreachable } : null),
  });
}

const section = (sheet: RunSheet, id: string) => {
  const s = sheet.sections.find((x) => x.id === id);
  expect(s, `section ${id}`).toBeTruthy();
  return s!;
};

const textOf = (s: { steps: { text: string; value?: string }[] }) =>
  s.steps.map((x) => `${x.text} ${x.value ?? ''}`).join('\n');

describe('the run sheet’s reachability report (#410)', () => {
  it('adds no section and renumbers nothing when the caller measured no table', () => {
    const plain = sheetFor();
    expect(plain.sections.map((s) => s.id)).toEqual([
      'need',
      'mount',
      'load',
      'cutter',
      'origin',
      'dry-run',
      'cut',
      'warnings',
      'record',
    ]);
    // The numbering is computed from position, so a sheet that never gained the section is numbered
    // exactly as the hand-numbered one was — the byte-identical promise the option makes.
    expect(plain.sections.map((s) => s.title)).toEqual([
      '1 · What you need',
      '2 · Mount the vise',
      '3 · Load the blank',
      '4 · Fit the cutter and measure its length',
      '5 · Set the work origin',
      '6 · Dry run',
      '7 · Cut',
      '8 · Warnings carried from the app',
      '9 · Record afterwards',
    ]);
  });

  it('puts the table directly after the section that names the cutter, and renumbers the rest', () => {
    const s = sheetFor(reachFor());
    expect(s.sections.map((x) => x.id)).toEqual([
      'need',
      'reach',
      'mount',
      'load',
      'cutter',
      'origin',
      'dry-run',
      'cut',
      'warnings',
      'record',
    ]);
    expect(section(s, 'reach').title).toBe('2 · What each cutter reaches');
    expect(section(s, 'mount').title).toBe('3 · Mount the vise');
    expect(section(s, 'record').title).toBe('10 · Record afterwards');
  });

  it('groups the cutters by OUTCOME, naming every cutter that shares a row', () => {
    const reach = reachFor();
    const text = textOf(section(sheetFor(reach), 'reach'));
    // One row for the 3.175 mm bit, one for the 1.0 mm flat. Two cutters, two rows — not a row per
    // cutter, and not a summary that drops a key the operator cannot look up.
    expect(text).toContain('⌀ 3.175 mm — wide');
    expect(text).toContain('⌀ 1.0 mm — fine');
    // The shares are per item, in the job's own order, with the item named as #211 names it.
    expect(text).toContain('"TITLE" 100 % · "SUB" 80 % · "LOST" 0 %');
    expect(text).toContain('"TITLE" 0 % · "SUB" 0 % · "LOST" 0 %');
    // …and the design-wide share, which is an AREA share (980 mm² of 1050 mm²), not the mean of the
    // three ratios — and not a share of a total read off the ball nose, which was never measured.
    expect(text).toContain('93 % of the whole design');
  });

  it('says why the cutters it never measured are absent, rather than only leaving them out', () => {
    const text = textOf(section(sheetFor(reachFor()), 'reach'));
    expect(text).toContain('1 of your 3 cutters were not measured: not a flat end mill');
  });

  it('answers a V-bit on a region job with the V-carve sentence, not the generic not-flat phrase (#486)', () => {
    const vbit = tool('vbit', 0.3, {
      name: '30° engraving bit',
      shape: 'engraving',
      typeText: 'Engraving',
      tipDiameter: 0.3,
      diameter: 3.175,
      halfAngle: 15,
      angle: 30,
    });
    const reach = reachabilityFor(jobWith(), [...TOOLS, vbit], [], (key) =>
      ITEMS.map((i) => row(i.id, key === 'fine' ? { title: 900, sub: 80, lost: 0 }[i.id]! : 0)),
    );
    const text = textOf(section(sheetFor(reach), 'reach'));
    expect(text).toContain('a V-bit is not a rest cutter here; the second program would be a V-carve (#221)');
    // The ball nose keeps the generic phrase — the #221 sentence is about a V-bit, not every
    // cutter that is not flat.
    expect(text).toContain('not a flat end mill (or a V-bit on a job with regions)');
  });

  it('names the region NO cutter reaches, with its area, and that it is turned off', () => {
    const text = textOf(section(sheetFor(reachFor()), 'reach'));
    expect(text).toContain('"LOST" is cut by none of the 2 cutters measured above');
    expect(text).toContain('50 mm²');
    expect(text).toContain('the program does not cut it');
  });

  it('derives the unreachable list from the table when the caller edited nothing', () => {
    const reach = reachFor();
    // No `unreachable` handed over: the sheet asks the table itself, and gets the same answer.
    const text = textOf(section(sheetFor(reach), 'reach'));
    expect(text).toContain('"LOST" is cut by none of the 2 cutters measured above');
    // The caller that DID edit the job says so, and its list is what is printed.
    const dropped = reach.cutters.find((c) => c.key === 'wide')!.rows.filter((r) => r.itemId === 'lost');
    const withList = textOf(
      section(
        sheetFor(reach, dropped.map((r) => ({ row: r, cutters: 2 }))),
        'reach',
      ),
    );
    expect(withList).toContain('"LOST" is cut by none of the 2 cutters measured above');
  });

  it('separates a region no cutter reaches from one the CHOSEN cutter misses', () => {
    const reach = reachFor();
    const job = jobWith();
    job.toolKey = 'wide';
    const s = buildRunSheet(job, generated(), null, NOW, undefined, { reachability: reach });
    const text = textOf(section(s, 'reach'));
    // `wide` misses all three, so two notes and one "nothing reaches it" line — and the notes name
    // the cutter that WOULD take the region, because that is a decision the operator can make.
    expect(text).toContain('wide reaches none of "TITLE"; fine reaches 100 % of it');
    expect(text).toContain('wide reaches none of "SUB"; fine reaches 80 % of it');
    expect(text).toContain('"LOST" is cut by none of the 2 cutters measured above');
    expect(text).not.toContain('wide reaches none of "LOST"');
    // `wide` reaches nothing, so a second program is worth having and the pair is named.
    expect(text).toContain('A second, finer bit reaches more: fine');
  });
});
