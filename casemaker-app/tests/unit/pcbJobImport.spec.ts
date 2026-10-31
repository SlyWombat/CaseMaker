/**
 * The browser door's glue (#743 P-4b): picked files (or one `.zip`) → the planner's items and the
 * document's source records.
 *
 * The geometry is the planner's and is pinned in `pcbImport.spec.ts`; this pins what the DOOR adds
 * — reading File bytes, the archive's skipped entries, the per-file source records (kind and
 * SHA-256), and the ids each item kind gets.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';

import { tl } from './helpers/manifoldExec';
import { planPcbJobImport } from '@/engine/import/pcbJobImport';

const FIXTURES = join(process.cwd(), 'tests/unit/fixtures/pcb');
const bytes = (name: string): Uint8Array => new Uint8Array(readFileSync(join(FIXTURES, name)));
const file = (name: string): File => new File([bytes(name)], name);

const OPTS = {
  blank: { length: 60, width: 40, thickness: 1.6 },
  tabs: { count: 3, width: 3, height: 1 },
};

describe('the PCB import door (#743 P-4b)', () => {
  it('reads picked files into the board items, with a source record per file', async () => {
    const out = await planPcbJobImport(tl, [file('tiny-F_Cu.gbr'), file('tiny-Edge_Cuts.gbr'), file('tiny.drl')], OPTS);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.plan.board).toEqual({ left: 14, top: 15, width: 32, height: 10 });
    expect(out.plan.items.vectors).toHaveLength(2);
    expect(out.plan.items.frames).toHaveLength(1);
    expect(out.plan.items.drills).toHaveLength(8);
    expect(out.plan.items.cutouts).toHaveLength(1);
    // The ids are the document's own prefixes (vec / shp / drl / cut).
    expect(out.plan.items.vectors.every((v) => v.id.startsWith('vec'))).toBe(true);
    expect(out.plan.items.frames[0]?.id.startsWith('shp')).toBe(true);
    expect(out.plan.items.drills.every((d) => d.id.startsWith('drl'))).toBe(true);
    expect(out.plan.items.cutouts[0]?.id.startsWith('cut')).toBe(true);
    // One record per file, content-addressed, kinds from the reader.
    expect(out.sources).toHaveLength(3);
    expect(out.sources.map((s) => s.source.kind).sort()).toEqual(['excellon', 'gerber', 'gerber']);
    for (const s of out.sources) {
      expect(s.source.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(s.skipped).toBeNull();
    }
    expect(out.skipped).toEqual([]);
  });

  it('takes one .zip, names what it skipped, and plans the same board', async () => {
    const zip = zipSync({
      'F_Cu.gbr': bytes('tiny-F_Cu.gbr'),
      'Edge_Cuts.gbr': bytes('tiny-Edge_Cuts.gbr'),
      'board.drl': bytes('tiny.drl'),
      'README.md': strToU8('# board\n'),
    });
    const out = await planPcbJobImport(tl, [new File([zip], 'board.zip')], OPTS);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.skipped).toEqual(['README.md']);
    expect(out.plan.board).toEqual({ left: 14, top: 15, width: 32, height: 10 });
    expect(out.plan.items.drills).toHaveLength(8);
    expect(out.sources).toHaveLength(3);
  });

  it('refuses a set with no copper, and an archive with no layers', async () => {
    const noCopper = await planPcbJobImport(tl, [file('tiny-Edge_Cuts.gbr'), file('tiny.drl')], OPTS);
    expect(noCopper.ok).toBe(false);
    if (!noCopper.ok) expect(noCopper.error).toMatch(/No copper file/);

    const emptyZip = await planPcbJobImport(tl, [new File([zipSync({ 'README.md': strToU8('x') })], 'x.zip')], OPTS);
    expect(emptyZip.ok).toBe(false);
    if (!emptyZip.ok) expect(emptyZip.error).toMatch(/holds no Gerber or drill files/);
  });
});
