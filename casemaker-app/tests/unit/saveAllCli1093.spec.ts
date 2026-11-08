/**
 * #1093 R1 — THE CLI WRITES THE SAME NAMES AS EVERYONE ELSE.
 *
 * `programFileNames` is the command line's copy of the release store's naming; after the ruling it
 * IS `releaseFileName`, for every program including the first. RED before the change: a 5-program
 * job was written as `<job>.nc, <job>-p2.nc, …` — the unnumbered first file the issue is about,
 * and one name the sheet, Save and the release would have to disagree about.
 */
import { describe, expect, it } from 'vitest';

import { programFileNames } from '../../scripts/lib/casemaker/engrave';
import { releaseFileName } from '@/engine/cnc/engrave/release';
import type { EngraveProgram } from '@/workers/sim/engraveGenerate';

const program = (i: number): EngraveProgram =>
  ({ setupIndex: 1, setupId: 's', toolKey: 'k', nc: `G1 X${i}\nM2`, frameNc: null, verify: null, frameVerify: null, cam: null }) as unknown as EngraveProgram;

describe('#1093 R1 — CLI names equal releaseFileName', () => {
  for (const total of [1, 5, 19]) {
    it(`${total} program${total === 1 ? '' : 's'}`, () => {
      const programs = Array.from({ length: total }, (_, i) => program(i + 1));
      const names = programFileNames('m1trayB-top', programs);
      expect(names.map((n) => n.ncFile)).toEqual(
        Array.from({ length: total }, (_, i) => releaseFileName('m1trayB-top', i + 1, total)),
      );
      // The CLI's pair always carries the frame NAME; its writer drops it when the generator
      // produced no frame bytes (`frameNc === null`), so parity is over the .nc names.
      expect(names.map((n) => n.frameFile)).toEqual(
        names.map((n) => `${n.ncFile.slice(0, -'.nc'.length)}-frame.nc`),
      );
    });
  }

  it('a frame is named beside its own program, numbered like it', () => {
    const names = programFileNames('tray', [program(1), program(2), program(3)]);
    expect(names[1]!.ncFile).toBe('tray-p2.nc');
    expect(names[1]!.frameFile).toBe('tray-p2-frame.nc');
  });

  it('a facing program keeps its -face file and no frame', () => {
    const programs = [{ ...program(1), kind: 'facing' as const }, program(2), program(3)];
    const names = programFileNames('tray', programs);
    expect(names[0]).toEqual({ ncFile: 'tray-face.nc', frameFile: null });
    expect(names[1]!.ncFile).toBe('tray-p1.nc');
    expect(names[2]!.ncFile).toBe('tray-p2.nc');
  });
});
