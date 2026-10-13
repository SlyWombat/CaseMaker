#!/usr/bin/env node
/**
 * Build the text the Windows installer shows on its licence page (#403 gap 5).
 *
 *     npm run installer:license
 *
 * The page is fed by `bundle.licenseFile` in `tauri.conf.json`, which is a *plain text file*: Tauri
 * pastes the path into the NSIS template's `!define LICENSE`, and MUI's licence page hands it to
 * NSIS's `LicenseData`, which renders `.rtf` as rich text and everything else as plain text. So it
 * cannot point at the repository's `LICENSE` directly — and the page also must not show the licence
 * alone.
 *
 * WHY THE NOTICE FILE IS IN HERE. Apache-2.0 section 4(d) says that if the work ships a NOTICE file,
 * anything distributing it must reproduce the attribution notices that file contains. A Windows
 * installer that puts a binary on someone's machine is a distribution, and this repository's NOTICE
 * carries the bundled-font attributions — Barlow and the two IBM Plex families under the SIL Open
 * Font License, the Hershey Roman Simplex public-domain acknowledgement, and opentype.js under MIT.
 * A licence page showing `LICENSE` and stopping there would omit all of it. Including it costs one
 * page of scrolling; omitting it is the gap.
 *
 * Both halves are copied verbatim from the repository files, so this is a build step and not a
 * second copy to keep in step: change `LICENSE` or `NOTICE` and re-run.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LICENSE = join(ROOT, '..', 'LICENSE');
const NOTICE = join(ROOT, '..', 'NOTICE');
const OUT = join(ROOT, 'src-tauri', 'windows', 'license.txt');

// Plain \n throughout; the whole document is converted to CRLF in one place at the end, or the
// lines written as \r\n here would come out \r\r\n.
const LEAD = [
  'Case Maker is licensed under the Apache License, Version 2.0, reproduced in',
  'full below. It is followed by the project NOTICE file, whose attribution',
  'notices are distributed with the licence as section 4(d) requires.',
].join('\n');

const RULE = '='.repeat(78);

const license = readFileSync(LICENSE, 'utf8').replace(/\r\n/g, '\n').trimEnd();
const notice = readFileSync(NOTICE, 'utf8').replace(/\r\n/g, '\n').trimEnd();

const text = `${LEAD}\n\n${RULE}\n\n${license}\n\n${RULE}\nNOTICE\n\n${notice}\n`;

// NSIS's LicenseData has a size limit and makensis warns when it is passed; staying well under the
// classic 32767-character control limit is one thing this can check on its own, so a future NOTICE
// that grows past it fails here rather than silently truncating the page.
if (text.length > 32000) {
  throw new Error(`licence page text is ${text.length} characters; NSIS truncates the page past ~32k`);
}
for (const [name, source] of [['LICENSE', license], ['NOTICE', notice]]) {
  if (!text.includes(source)) throw new Error(`${name} did not survive into the licence page text`);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, text.split('\n').join('\r\n'));

console.log(
  `${OUT.replace(`${ROOT}/`, '')}: ${text.length} characters ` +
    `(LICENSE ${license.length} + NOTICE ${notice.length} + ${text.length - license.length - notice.length} of preamble and rules)`,
);
