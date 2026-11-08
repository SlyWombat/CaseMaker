/**
 * #1093 R2 — THE ARCHIVE'S BYTES: every file of the run, under its own name, unchanged.
 *
 * `programFilesZip` is what Save all downloads when there is no directory picker. Read back with
 * fflate's own reader, the entries are exactly the names `runSaveFiles` lists and their bytes are
 * the bytes the machine plays — the same check the e2e makes on the real job, at the unit
 * boundary.
 *
 * (Node environment: fflate's reader does not round-trip inside the jsdom realm the component
 * specs use; the archive itself is realm-independent.)
 */
import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';

import { programFilesZip } from '@/engine/exportTrigger';

const FILES = [
  { name: 'm1trayB-bottom-p1.nc', bytes: 'G21 G90\nT1 M6\nM2\n' },
  { name: 'm1trayB-bottom-p1-frame.nc', bytes: 'G21 G90\nG1 Z20\nM2\n' },
  { name: 'm1trayB-bottom-run.json', bytes: '{"kind":"casemaker-run"}' },
];

describe('#1093 R2 — the Save all archive', () => {
  it('files every name into the archive with its exact bytes', () => {
    const zip = unzipSync(programFilesZip(FILES));
    expect(Object.keys(zip).sort()).toEqual(['m1trayB-bottom-p1-frame.nc', 'm1trayB-bottom-p1.nc', 'm1trayB-bottom-run.json']);
    for (const file of FILES) expect(strFromU8(zip[file.name]!), file.name).toBe(file.bytes);
  });
});
