/**
 * The whole-job PCB import (#743 P-4): the tiny-* Gerber set on a 60 × 40 × 1.6 mm blank.
 *
 * `tiny-F_Cu.gbr` (copper, 27.375 × 5.65 mm), `tiny-Edge_Cuts.gbr` (outline, 32 × 10 mm at
 * (2,2)–(34,12)) and `tiny.drl` (eight holes) are the board the P-2 and P-3 specs read. The board
 * is centred on the blank, so its box's front-left corner is (14, 15) and every item is in the
 * blank's frame.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { tl } from './helpers/manifoldExec';
import { planPcbImport, type PcbSourceFile } from '@/engine/import/pcbImport';

const FIXTURES = join(process.cwd(), 'tests/unit/fixtures/pcb');
const bytes = (name: string): Uint8Array => new Uint8Array(readFileSync(join(FIXTURES, name)));
const text = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

function source(name: string, content?: string): PcbSourceFile {
  return { name, bytes: content === undefined ? bytes(name) : new TextEncoder().encode(content) };
}

let ids = 0;
const opts = {
  blank: { length: 60, width: 40, thickness: 1.6 },
  tabs: { count: 3, width: 3, height: 1 },
  idFor: (what: string): string => `id-${what}-${++ids}`,
};

const TINY_SET = (): PcbSourceFile[] => [source('tiny-F_Cu.gbr'), source('tiny-Edge_Cuts.gbr'), source('tiny.drl')];

describe('the PCB import (#743 P-4)', () => {
  it('tells each file what it is, and lays the board centred on the blank', () => {
    const plan = planPcbImport(tl, TINY_SET(), opts);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.files.map((f) => f.role)).toEqual(['top-copper', 'outline', 'drills']);
    expect(plan.files[0]?.summary).toMatch(/top copper/);
    expect(plan.files[2]?.summary).toMatch(/8 holes/);
    // The board is the outline's 32 × 10, centred: left (60 − 32)/2 = 14, top (40 − 10)/2 = 15.
    expect(plan.board).toEqual({ left: 14, top: 15, width: 32, height: 10 });
    expect(plan.mirrored).toBe(false);
  });

  it('makes the items of §3.3: copper, isolation, drills, outline and cut-out', () => {
    const plan = planPcbImport(tl, TINY_SET(), opts);
    if (!plan.ok) throw new Error(plan.error);

    const copper = plan.items.vectors.find((v) => v.id === plan.copperId);
    expect(copper).toBeDefined();
    expect(copper?.construction).toBe(true);
    expect(copper?.fillRule).toBe('NonZero');
    expect(copper?.importedFrom?.name).toBe('tiny-F_Cu.gbr');
    // The copper's own bbox (27.375 × 5.65) sits at the board's centre.
    expect(copper?.width).toBeCloseTo(27.375, 6);
    expect(copper?.height).toBeCloseTo(5.65, 6);
    expect(copper?.position.x).toBeCloseTo(14 + (4.75 + 32.125) / 2 - 2, 6);
    expect(copper?.position.y).toBeCloseTo(15 + (4.75 + 10.4) / 2 - 2, 6);

    const outline = plan.items.vectors.find((v) => v.id === plan.outlineId);
    expect(outline?.construction).toBe(true);
    expect(outline?.width).toBeCloseTo(32, 6);
    expect(outline?.importedFrom?.name).toBe('tiny-Edge_Cuts.gbr');

    const frame = plan.items.frames[0];
    expect(frame).toMatchObject({
      kind: 'frame',
      around: plan.copperId,
      gap: 0,
      width: 0.4,
      depth: 0.1,
      isolation: true,
    });

    expect(plan.items.drills).toHaveLength(8);
    const first = plan.items.drills[0];
    expect(first).toMatchObject({ kind: 'drill', through: true, mode: 'drill' });
    // File (5,5) → board (3,3) → blank (17,18).
    expect(first?.position.x).toBeCloseTo(17, 6);
    expect(first?.position.y).toBeCloseTo(18, 6);

    const cutout = plan.items.cutouts[0];
    expect(cutout).toMatchObject({ kind: 'cutout', of: plan.outlineId, side: 'outside', inset: 0, tabs: { count: 3 } });
  });

  it('states the sha-256 of every source, so a re-import can replace by hash', () => {
    const plan = planPcbImport(tl, TINY_SET(), opts);
    if (!plan.ok) throw new Error(plan.error);
    for (const file of plan.files) expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.files.map((f) => f.kind)).toEqual(['gerber', 'gerber', 'excellon']);
  });

  it('mirrors a bottom-only set about the board\'s X centre, and says so', () => {
    const bottom = text('tiny-F_Cu.gbr').replace('Copper,L1,Top', 'Copper,L2,Bot');
    const plan = planPcbImport(tl, [source('tiny-F_Cu.gbr', bottom), source('tiny-Edge_Cuts.gbr'), source('tiny.drl')], opts);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.mirrored).toBe(true);
    expect(plan.notes.join(' ')).toMatch(/mirrored/i);
    // The board centre is x = 18 in the file's frame; the first hole (5,5) mirrors to (31,5) →
    // blank x = 14 + 31 − 2 = 43.
    expect(plan.items.drills[0]?.position.x).toBeCloseTo(43, 6);
    // The copper's own centre mirrors about the board: 36 − 18.4375 = 17.5625 → 29.5625 on the blank.
    const copper = plan.items.vectors.find((v) => v.id === plan.copperId);
    expect(copper?.position.x).toBeCloseTo(14 + (36 - 18.4375) - 2, 6);
  });

  it('refuses a two-sided set, no copper, and a board bigger than the blank, by name', () => {
    const bottom = text('tiny-F_Cu.gbr').replace('Copper,L1,Top', 'Copper,L2,Bot');
    const twoSided = planPcbImport(
      tl,
      [source('tiny-F_Cu.gbr'), source('tiny-F_Cu_B.gbr', bottom), source('tiny-Edge_Cuts.gbr')],
      opts,
    );
    expect(twoSided.ok).toBe(false);
    if (!twoSided.ok) expect(twoSided.code).toBe('pcb-two-sided');

    const noCopper = planPcbImport(tl, [source('tiny-Edge_Cuts.gbr'), source('tiny.drl')], opts);
    expect(noCopper.ok).toBe(false);
    if (!noCopper.ok) expect(noCopper.code).toBe('pcb-no-copper');

    const tinyBlank = planPcbImport(tl, TINY_SET(), { ...opts, blank: { length: 20, width: 20, thickness: 1.6 } });
    expect(tinyBlank.ok).toBe(false);
    if (!tinyBlank.ok) {
      expect(tinyBlank.code).toBe('pcb-off-blank');
      expect(tinyBlank.error).toMatch(/32 × 10 mm/);
      expect(tinyBlank.error).toMatch(/20 × 20 mm/);
    }
  });

  it('lists a file whose role it cannot tell instead of guessing, and still imports the board', () => {
    const unnamed = text('tiny-Edge_Cuts.gbr').replace('%TF.FileFunction,Profile,NP*%\n', '');
    const plan = planPcbImport(
      tl,
      [source('tiny-F_Cu.gbr'), source('board.gbr', unnamed), source('tiny.drl')],
      opts,
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const unknown = plan.files.find((f) => f.name === 'board.gbr');
    expect(unknown?.role).toBe('unknown');
    expect(plan.notes.join(' ')).toMatch(/not guessed/);
    // With no outline file the board is the copper plus the stated margin.
    expect(plan.board.width).toBeCloseTo(27.375 + 2, 6);
    expect(plan.board.height).toBeCloseTo(5.65 + 2, 6);
  });

  it('keeps a slot rather than losing the file: the rest imports and the slot is named', () => {
    const plan = planPcbImport(tl, [source('tiny-F_Cu.gbr'), source('tiny-Edge_Cuts.gbr'), source('slot.drl')], opts);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.items.drills).toHaveLength(1); // the round hit; the slot is not an item yet
    expect(plan.notes.join(' ')).toMatch(/slot/);
    expect(plan.notes.join(' ')).toMatch(/rest of the board imported/);
  });
});
