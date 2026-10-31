/**
 * #743 P-4b — the command line's Gerber door: the files become a JOB DOCUMENT.
 *
 * What the door adds over the planner (pinned in `pcbImport.spec.ts`): the blank it was told, PCB
 * stock with copper's cap, the design's taped-to-the-bed holding, no demo lines, one
 * content-addressed source per file, §3.4's drill/bore modes, and a document that round-trips
 * through the app's own schema.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';

import { tl } from './helpers/manifoldExec';
import { flatEndMill } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import { PCB_COPPER_MM } from '@/engine/cnc/stockStart';
import { boardNameOf, buildPcbJob, jobDocumentProblem, type PcbJobFile } from '../../scripts/lib/casemaker/pcbJob';
import { engraveJobMain } from '../../scripts/lib/casemaker/engrave';
import { engraveGenerate } from '@/workers/sim/engraveGenerate';
import type { FeedCatalogueRow } from '@/engine/cnc/feeds';

const FIXTURES = join(process.cwd(), 'tests/unit/fixtures/pcb');
const bytes = (name: string): Uint8Array<ArrayBuffer> => Uint8Array.from(readFileSync(join(FIXTURES, name)));
const file = (name: string, b: Uint8Array = bytes(name)): PcbJobFile => ({ name, bytes: b });

const BLANK = { length: 60, width: 40, thickness: 1.6 };
const TABS = { count: 3, width: 3, height: 1 };

const tool = (key: string, shape: 'flat' | 'drill', d: number): ToolLibraryEntry => ({
  key,
  provenance: 'test',
  tool: flatEndMill(d, { shape, tipDiameter: d, diameter: d }),
});

/** The tiny board's own drills: 0.8 mm ×6 and 1.0 mm ×2. */
const DRILLS = [tool('user:d08', 'drill', 0.8), tool('user:d10', 'drill', 1.0)];

describe('the CLI Gerber door (#743 P-4b)', () => {
  it('builds a PCB job from the files, with the board holding and no demo lines', async () => {
    const out = await buildPcbJob(tl, [file('tiny-F_Cu.gbr'), file('tiny-Edge_Cuts.gbr'), file('tiny.drl')], {
      blank: BLANK,
      tabs: TABS,
      tools: DRILLS,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const job = out.job;

    expect(job.name).toBe('tiny');
    expect(job.stock).toMatchObject({ ...BLANK, material: 'pcb' });
    expect(job.stock.colour).toEqual({ kind: 'laminate', capMm: PCB_COPPER_MM });
    expect(job.sources?.stock?.material).toBe('user');
    expect(job.sources?.stock?.colour).toBe('assumed');
    // The demo lines are for a 100 × 60 plank; the board carries none of them.
    expect(job.labels).toEqual([]);
    // The design's PCB holding: taped to the bed, over a board under it (Q8).
    expect(job.workholding.kind).toBe('tape');
    expect(job.sacrificial.under?.attach).toBe('tape');

    expect(job.vectors).toHaveLength(2);
    expect(job.combined).toHaveLength(1);
    expect(job.drills).toHaveLength(8);
    expect(job.cutouts).toHaveLength(1);
    // Each drill carries its HOLE's size, and the exact owned cutters mean a plunge.
    expect(new Set(job.drills?.map((d) => d.diameter))).toEqual(new Set([0.8, 1.0]));
    expect(job.drills?.every((d) => d.mode === 'drill')).toBe(true);
    expect(out.notes.join(' ')).not.toMatch(/bored/);

    // One content-addressed record per file, kinds from the reader.
    expect(job.sourceFiles).toHaveLength(3);
    expect(job.sourceFiles?.map((s) => s.kind).sort()).toEqual(['excellon', 'gerber', 'gerber']);
    for (const s of job.sourceFiles ?? []) expect(s.sha256).toMatch(/^[0-9a-f]{64}$/);

    // The app's own schema reads it back without losing a field.
    expect(jobDocumentProblem(job)).toBeNull();
  });

  it('bores a hole size no owned cutter is, and says which sizes that is', async () => {
    const out = await buildPcbJob(tl, [file('tiny-F_Cu.gbr'), file('tiny-Edge_Cuts.gbr'), file('tiny.drl')], {
      blank: BLANK,
      tabs: TABS,
      tools: [tool('user:f05', 'flat', 0.5)],
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.job.drills?.every((d) => d.mode === 'bore')).toBe(true);
    expect(out.notes.join(' ')).toContain('bored to size');
  });

  it('takes one .zip and names what it skipped', async () => {
    const zip = zipSync({
      'tiny-F_Cu.gbr': bytes('tiny-F_Cu.gbr'),
      'tiny-Edge_Cuts.gbr': bytes('tiny-Edge_Cuts.gbr'),
      'tiny.drl': bytes('tiny.drl'),
      'README.md': strToU8('# tiny\n'),
    });
    const out = await buildPcbJob(tl, [file('tiny.zip', new Uint8Array(zip))], { blank: BLANK, tabs: TABS, tools: DRILLS });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.job.drills).toHaveLength(8);
    expect(out.job.sourceFiles).toHaveLength(3);
    expect(out.notes.join(' ')).toContain('README.md is not a Gerber or drill file');
  });

  it('cannot be run without the blank it is cut from, and says so', async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
    try {
      await expect(
        engraveJobMain(['--from-gerber', join(FIXTURES, 'tiny-F_Cu.gbr')], { json: true }),
      ).resolves.toBe(1);
    } finally {
      spy.mockRestore();
    }
    expect(errors.join(' ')).toContain('--blank <length>x<width>x<thickness>');
  });

  it('names the board from its outline file', () => {
    expect(boardNameOf(['blinky-F_Cu.gbr', 'blinky-Edge_Cuts.gbr', 'blinky.drl'])).toBe('blinky');
    expect(boardNameOf(['board.gtl', 'board.gko'])).toBe('board');
    expect(boardNameOf([])).toBe('board');
  });
});

/**
 * §3.4 — THE BOARD'S CUTTERS, WRITTEN AT IMPORT (P-5 prerequisite).
 *
 * A board arrives with an engraver for the isolation, a drill (or borer) per hole size, and a flat
 * that reaches through it for the cut-out, written as ordinary `setups[].tools`/`toolItems`. The
 * generator then posts one program per cutter — the check that matters, because a board that names
 * its cutters but posts one file has not been assigned at all.
 */
describe('the board’s cutters are assigned at import (#743 §3.4)', () => {
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
  const bits = [tool('inv:d08', 'drill', 0.8), tool('inv:d10', 'drill', 1.0)].map((t, i) => ({
    ...t,
    tool: { ...t.tool, id: i === 0 ? 'pcb-drill-0-8' : 'pcb-drill-1-0', fluteLength: 12 },
  }));
  const tools = [engraver, ...bits, corn];
  const rows: FeedCatalogueRow[] = [
    { cutterId: 'pcb-engrave-0-1-60', material: 'PCB', rpm: 12000, feed: 500, plungeFeed: 200, stepDown: 0.1 },
    { cutterId: 'pcb-corn-0-8', material: 'PCB', rpm: 12000, feed: 500, plungeFeed: 200, stepDown: 0.2 },
    { cutterId: 'pcb-drill-0-8', material: 'PCB', rpm: 12000, feed: 300, plungeFeed: 100, stepDown: 1.6 },
    { cutterId: 'pcb-drill-1-0', material: 'PCB', rpm: 12000, feed: 300, plungeFeed: 100, stepDown: 1.6 },
  ];

  it('writes the engraver, each drill and the outline cutter into the setup', async () => {
    const out = await buildPcbJob(tl, [file('tiny-F_Cu.gbr'), file('tiny-Edge_Cuts.gbr'), file('tiny.drl')], {
      blank: BLANK,
      tabs: TABS,
      tools,
      catalogue: rows,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const setup = out.job.setups?.[0];
    expect(setup?.tools).toEqual(['inv:engrave-60', 'inv:d08', 'inv:d10', 'inv:corn-0-8']);
    // The isolation frame belongs to the engraver; each drill to the bit of its own size; the
    // cut-out to the flat that reaches through the board.
    expect(setup?.toolItems?.['inv:engrave-60']).toEqual([out.plan.items.frames[0]!.id]);
    expect(setup?.toolItems?.['inv:d08']).toEqual(
      out.plan.items.drills.filter((d) => d.diameter === 0.8).map((d) => d.id),
    );
    expect(setup?.toolItems?.['inv:d10']).toEqual(
      out.plan.items.drills.filter((d) => d.diameter === 1.0).map((d) => d.id),
    );
    expect(setup?.toolItems?.['inv:corn-0-8']).toEqual([out.plan.items.cutouts[0]!.id]);
  });

  it('posts one program per cutter, including both drill sizes', async () => {
    const out = await buildPcbJob(tl, [file('tiny-F_Cu.gbr'), file('tiny-Edge_Cuts.gbr'), file('tiny.drl')], {
      blank: BLANK,
      tabs: TABS,
      tools,
      catalogue: rows,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const job = out.job;
    job.toolKey = 'inv:engrave-60';
    const gen = engraveGenerate(tl, job, engraver.tool, rows, null, undefined, { tools });
    expect(gen.errors).toEqual([]);
    expect(gen.ok).toBe(true);
    expect(gen.programs.map((p) => p.toolKey)).toEqual([
      'inv:engrave-60',
      'inv:d08',
      'inv:d10',
      'inv:corn-0-8',
    ]);
  });
});
