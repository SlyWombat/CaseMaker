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

import { releaseFileName } from '@/engine/cnc/engrave/release';

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
