/**
 * #1093 R1 — ONE NAME FOR A PROGRAM FILE, PADDED SO THE FOLDER SORTS IN CUT ORDER.
 *
 * `releaseFileName` is the only function that names a program file (Save, the run sheet, the
 * release store, the run record and the CLI). One program keeps `<stem>.nc`; more than one gets
 * `<stem>-p<index>.nc` with the index zero-padded to the width of `total`, program 1 included: a
 * machine's file list and every OS folder sort by name, and `p10` before `p2` is how an operator
 * runs the tab release before the cuts. RED before the change: `(2, 19)` was `tray-p2.nc` and
 * `(1, 5)` was `tray-p1.nc` with no padding.
 */
import { describe, expect, it } from 'vitest';

import { releaseFaceFileName, releaseFileName, releasePrograms, type ReleaseSource } from '@/engine/cnc/engrave/release';
import { runSheetFaceFileName } from '@/engine/cnc/engrave/runSheet';

function source(kind: 'facing' | undefined, i: number, dryRun = false): ReleaseSource {
  return {
    setupIndex: 1,
    setupId: `setup-${i}`,
    toolKey: 'inv:flat',
    ...(kind === undefined ? {} : { kind }),
    nc: `G1 X${i}\nM2`,
    hash: `h${i}`,
    verify: null,
    ...(dryRun ? { dryRun: true } : {}),
  };
}

describe('#1093 R1 — releaseFileName, the one naming function', () => {
  it('one program keeps the job name', () => {
    expect(releaseFileName('tray', 1, 1)).toBe('tray.nc');
    expect(releaseFileName('My job', 1, 1)).toBe('My-job.nc');
  });

  it('more than one numbers EVERY program, including the first', () => {
    expect(releaseFileName('tray', 1, 5)).toBe('tray-p1.nc');
    expect(releaseFileName('tray', 5, 5)).toBe('tray-p5.nc');
  });

  it('pads the index to the width of the total', () => {
    expect(releaseFileName('tray', 2, 19)).toBe('tray-p02.nc');
    expect(releaseFileName('tray', 10, 19)).toBe('tray-p10.nc');
    expect(releaseFileName('tray', 19, 19)).toBe('tray-p19.nc');
    // A 100-program run pads to three.
    expect(releaseFileName('tray', 7, 100)).toBe('tray-p007.nc');
  });

  it('a dry-run variant inserts -dry and keeps the same numbering', () => {
    expect(releaseFileName('My job', 1, 1, true)).toBe('My-job-dry.nc');
    expect(releaseFileName('tray', 2, 19, true)).toBe('tray-dry-p02.nc');
  });

  it('a 19-program list sorts lexically in cut order — the reason for the padding', () => {
    const names = Array.from({ length: 19 }, (_, i) => releaseFileName('m1trayF-banded2', i + 1, 19));
    expect([...names].sort()).toEqual(names);
    // Unpadded, the sort would put p10..p19 before p2 — the machine's list would play out of order.
    const unpadded = Array.from({ length: 19 }, (_, i) => `m1trayF-banded2-p${i + 1}.nc`);
    expect([...unpadded].sort().slice(0, 3)).toEqual(['m1trayF-banded2-p1.nc', 'm1trayF-banded2-p10.nc', 'm1trayF-banded2-p11.nc']);
  });
});

/**
 * #1093 — THE FACED RUN USES THE SAME NAMES AS EVERYTHING ELSE.
 *
 * 0f's ruling: ONE naming function for Save, sheet, release, record and CLI. The release store
 * used to name by CUT-ORDER position, so a faced run uploaded the skim as `<stem>-p1.nc` and every
 * engraving one place higher — while Save all, the sheet and the CLI wrote `<stem>-face.nc` and
 * numbered the engravings p1… (the sheet's own "program N", the skim excluded). The operator
 * uploaded "-p1" for a file Save calls "-face", and the machine's list did not match the sheet.
 *
 * RED at 96becd1fd: the three cases below were `badge-p1/p2/p3`, `badge-p1/p2` and
 * `badge-dry-p1/dry-p2`.
 */
describe('#1093 — a faced run names the skim and numbers the engravings', () => {
  it('two engravings: the skim is -face, the engravings are p1..p2', () => {
    const files = releasePrograms('badge', [source('facing', 1), source(undefined, 2), source(undefined, 3)], []);
    expect(files.map((f) => f.filename)).toEqual(['badge-face.nc', 'badge-p1.nc', 'badge-p2.nc']);
    // The cut-order index and total stay the machine's program numbering (the skim is program 1).
    expect(files.map((f) => [f.index, f.total])).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it('one engraving beside the skim keeps the one-program name', () => {
    const files = releasePrograms('badge', [source('facing', 1), source(undefined, 2)], []);
    expect(files.map((f) => f.filename)).toEqual(['badge-face.nc', 'badge.nc']);
  });

  it('the sheet’s face helper and the release’s are the same rule', () => {
    expect(runSheetFaceFileName('My job')).toBe(releaseFaceFileName('My job'));
    expect(runSheetFaceFileName('My job')).toBe('My-job-face.nc');
  });

  it('a lifted dry run keeps names of its own, for the skim and the program', () => {
    const files = releasePrograms(
      'badge',
      [source('facing', 1, true), source(undefined, 2, true), source(undefined, 3)],
      [],
    );
    expect(files.map((f) => f.filename)).toEqual(['badge-dry-face.nc', 'badge-dry-p1.nc', 'badge-p2.nc']);
  });
});
