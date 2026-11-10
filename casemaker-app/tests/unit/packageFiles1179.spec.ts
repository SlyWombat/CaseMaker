// #1179 slice C — THE FILES ON THE CARD BELONG TO THE PACKAGE.
//
// A program's name carries the package key, so a different plan's file can never be played by
// name; and the cleanup can name exactly what belongs to this job in another package, including
// yesterday's keyless names, without ever touching another job's files.

import { describe, expect, it } from 'vitest';

import { releaseFaceFileName, releaseFileName, releasePrograms, type ReleaseSource } from '@/engine/cnc/engrave/release';
import { otherPackageFilesFor, packageKeyOf } from '@/engine/cnc/engrave/packageFiles';

const KEY = 'deadbeef';

describe('#1179 C — keyed names', () => {
  it('one program: <stem>-<key>.nc; many: <stem>-<key>-pNN.nc', () => {
    expect(releaseFileName('My job', 1, 1, false, KEY)).toBe('My-job-deadbeef.nc');
    expect(releaseFileName('tray', 1, 5, false, KEY)).toBe('tray-deadbeef-p1.nc');
    expect(releaseFileName('tray', 2, 19, false, KEY)).toBe('tray-deadbeef-p02.nc');
  });

  it('a dry-run variant keeps its own name and the key', () => {
    expect(releaseFileName('tray', 2, 19, true, KEY)).toBe('tray-deadbeef-dry-p02.nc');
    expect(releaseFaceFileName('tray', true, KEY)).toBe('tray-deadbeef-dry-face.nc');
  });

  it('no key keeps the legacy name, so a pre-change package still round-trips', () => {
    expect(releaseFileName('tray', 2, 19)).toBe('tray-p02.nc');
    expect(releaseFaceFileName('tray')).toBe('tray-face.nc');
  });

  it('releasePrograms stamps the key on every program it lists', () => {
    const programs: ReleaseSource[] = [
      { index: 1, total: 2, setupIndex: 0, setupId: 's0', toolKey: 't1', filename: '', hash: 'a', nc: 'G1', verify: null },
      { index: 2, total: 2, setupIndex: 0, setupId: 's0', toolKey: 't1', filename: '', hash: 'b', nc: 'G2', verify: null },
    ] as unknown as ReleaseSource[];
    expect(releasePrograms('tray', programs, [], KEY).map((p) => p.filename)).toEqual([
      'tray-deadbeef-p1.nc',
      'tray-deadbeef-p2.nc',
    ]);
  });
});

describe('#1179 C — which files are this job in another package', () => {
  const stem = 'm1trayF-banded2';

  it('selects old keys and legacy keyless names of THIS job only', () => {
    const names = [
      `${stem}-p01.nc`, // yesterday's keyless program → another package
      `${stem}-airwalk.nc`, // yesterday's keyless walk → another package
      `${stem}-${KEY}-p01.nc`, // this package → keeps
      `${stem}-feedface-p01.nc`, // another package's key → removed
      'other-job-p01.nc', // another job → keeps
      `${stem}-notes.txt`, // not a program → keeps
      `${stem}.nc`, // legacy one-program name → another package
    ];
    expect(otherPackageFilesFor(names, stem, KEY)).toEqual([
      `${stem}-p01.nc`,
      `${stem}-airwalk.nc`,
      `${stem}-feedface-p01.nc`,
      `${stem}.nc`,
    ]);
  });

  it('a keyless package still selects the legacy names AND another package\'s keyed files', () => {
    // The current package has no key, so no file of it can carry one: anything keyed with this
    // stem belongs to a different package and is stale too.
    expect(otherPackageFilesFor([`${stem}-p01.nc`, `${stem}-${KEY}-p01.nc`], stem, null)).toEqual([
      `${stem}-p01.nc`,
      `${stem}-${KEY}-p01.nc`,
    ]);
  });

  it('packageKeyOf reads the frozen package hash, and only an 8-hex key', () => {
    expect(packageKeyOf({ package: { hash: 'DEADBEEF' } } as never)).toBe('deadbeef');
    expect(packageKeyOf({ package: { hash: 'old' } } as never)).toBeNull();
    expect(packageKeyOf({} as never)).toBeNull();
  });
});
