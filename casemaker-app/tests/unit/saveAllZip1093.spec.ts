// @vitest-environment jsdom
/**
 * #1093 R2 — SAVE ALL'S DOWNLOAD, WHERE THERE IS NO DIRECTORY PICKER.
 *
 * The archive's contents are checked in `programFilesZip1093.spec.ts` (node environment: fflate's
 * reader does not round-trip inside jsdom). This file checks the browser half: with no
 * `showDirectoryPicker` the operator gets ONE `<stem>-programs.zip` download and nothing else.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { saveFilesFolderOrZip } from '@/engine/exportTrigger';

const realCreate = URL.createObjectURL;
const realRevoke = URL.revokeObjectURL;
const realClick = HTMLAnchorElement.prototype.click;
const realPicker = (window as Window & { showDirectoryPicker?: unknown }).showDirectoryPicker;

afterEach(() => {
  URL.createObjectURL = realCreate;
  URL.revokeObjectURL = realRevoke;
  HTMLAnchorElement.prototype.click = realClick;
  if (realPicker === undefined) delete (window as Window & { showDirectoryPicker?: unknown }).showDirectoryPicker;
  else (window as Window & { showDirectoryPicker?: unknown }).showDirectoryPicker = realPicker;
});

const FILES = [
  { name: 'm1trayB-bottom-p1.nc', bytes: 'G21 G90\nT1 M6\nM2\n' },
  { name: 'm1trayB-bottom-run.json', bytes: '{"kind":"casemaker-run"}' },
];

describe('#1093 R2 — Save all without a directory picker', () => {
  it('downloads one <stem>-programs.zip and writes no loose files', async () => {
    const clicked: string[] = [];
    URL.createObjectURL = (() => 'blob:1093') as typeof URL.createObjectURL;
    URL.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      clicked.push(this.download);
    };
    delete (window as Window & { showDirectoryPicker?: unknown }).showDirectoryPicker;
    const outcome = await saveFilesFolderOrZip(FILES, 'm1trayB-bottom-programs.zip');
    expect(outcome).toBe('zip');
    expect(clicked).toEqual(['m1trayB-bottom-programs.zip']);
  });
});
