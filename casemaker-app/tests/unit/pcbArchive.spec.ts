/**
 * The `.zip` door for a Gerber set (#743 P-4b).
 *
 * The archive is built here with fflate — the same dependency the 3MF readers use — so the test
 * holds no binary fixture it cannot read. The set is the tiny board's copper and its drills plus a
 * README, which must be skipped and said; and the archive flows straight into `planPcbImport` to
 * prove the two doors meet.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';

import { tl } from './helpers/manifoldExec';
import { readPcbArchive } from '@/engine/import/pcbArchive';
import { planPcbImport } from '@/engine/import/pcbImport';

const FIXTURES = join(process.cwd(), 'tests/unit/fixtures/pcb');
const bytes = (name: string): Uint8Array => new Uint8Array(readFileSync(join(FIXTURES, name)));

describe('a PCB set from a zip (#743 P-4b)', () => {
  it('takes the layer files and says what it skipped', () => {
    const zip = zipSync({
      'board/F_Cu.gbr': bytes('tiny-F_Cu.gbr'),
      'board/Edge_Cuts.gbr': bytes('tiny-Edge_Cuts.gbr'),
      'board/board.drl': bytes('tiny.drl'),
      'board/README.md': strToU8('# tiny board\n'),
      'board/board-F_Fab.pdf': strToU8('%PDF-1.4'),
    });
    const read = readPcbArchive(zip);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.files.map((f) => f.name)).toEqual(['F_Cu.gbr', 'Edge_Cuts.gbr', 'board.drl']);
    expect(read.skipped).toEqual(['README.md', 'board-F_Fab.pdf']);
  });

  it('plans the board from the archive alone', () => {
    const zip = zipSync({
      'F_Cu.gbr': bytes('tiny-F_Cu.gbr'),
      'Edge_Cuts.gbr': bytes('tiny-Edge_Cuts.gbr'),
      'board.drl': bytes('tiny.drl'),
    });
    const read = readPcbArchive(zip);
    if (!read.ok) throw new Error(read.error);
    let n = 0;
    const plan = planPcbImport(tl, read.files, {
      blank: { length: 60, width: 40, thickness: 1.6 },
      tabs: { count: 3, width: 3, height: 1 },
      idFor: (what) => `id-${what}-${++n}`,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.board).toEqual({ left: 14, top: 15, width: 32, height: 10 });
    expect(plan.items.drills).toHaveLength(8);
  });

  it('refuses an archive with no layers, naming what it holds', () => {
    const none = readPcbArchive(zipSync({ 'README.md': strToU8('hello') }));
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.error).toMatch(/holds no Gerber or drill files \(it holds README\.md\)/);
    const empty = readPcbArchive(zipSync({}));
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error).toMatch(/empty/);
  });
});
