// Fetch Makera's reference G-code corpus into a GIT-IGNORED directory (#186).
//
//   npm run reference-gcode:fetch
//
// WHY A SCRIPT AND NOT A CHECKED-IN FOLDER
//
//   MakeraInc/CarveraController is GPL-3.0. Case Maker is Apache-2.0. GPL-3.0 files
//   cannot be copied into this repo. So the repo gains a reproducible way to
//   OBTAIN the corpus and none of its content. Hand-write any fixture that has to
//   be committed — a 20-line one that exercises the same syntax is both legally
//   clean and a better test than a 2.8 MB file nobody reads.
//
//   Format and protocol FACTS (what `T1M6` means, that `G53` exists) are
//   interoperability information and fine to encode in our own tests. The vendor's
//   files are not ours to redistribute.
//
// WHAT IT PROVES
//
//   Every file is verified against the git blob SHA-1 the GitHub tree reported, at a
//   PINNED commit, so a changed or truncated download fails loudly rather than
//   quietly shifting what the parser is tested against.
//
// PROVENANCE
//
//   All of these are CARVERA-generated. They are evidence about the shared Smoothieware
//   G-code dialect, not about Z1 behaviour (/Fabrication.md §1).

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'MakeraInc/CarveraController';
/** Pinned so the corpus is the same bytes every time. Bump deliberately. */
const COMMIT = '3914c912452f83fbd5b5d90c730cb78795198438';
const ROOT_IN_REPO = 'src/gcodes/Examples/';

/**
 * A SECOND source, and the only Z1-generated file in the corpus: Studio's own `TopClamp.nc`,
 * the machine's first-job example, as published in the `1.4.6_sample` release of
 * MakeraInc/CarveraProfiles (NO licence: all rights reserved). It is the only sample with a
 * `;@MKR|` header, so without it the header path is outside the automated gate.
 *
 * Pinned by RELEASE TAG, size and git blob SHA. Note this is NOT byte-identical to the copy
 * Studio installs locally: they differ by exactly one byte, `;@MKR|UNIT|value=mm` there and
 * `value=MM` here. The header's unit CASE is inconsistent between Studio builds, so anything
 * reading it must not compare case-sensitively.
 */
const RELEASE_REPO = 'MakeraInc/CarveraProfiles';
const RELEASE_TAG = '1.4.6_sample';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CORPUS_DIR = join(HERE, '..', 'reference-gcode');

/**
 * [path, bytes, git blob sha1 prefix, source]. Sizes are the cheap first check. `source` is
 * omitted for CarveraController's Examples/ and is `'release'` for the CarveraProfiles asset.
 */
export const MANIFEST = [
  ['LED/ABS-Base.nc', 52124, '46b4245238'],
  ['LED/ACRYLIC-Balloon.nc', 47854, 'c7001a7299'],
  ['LED/ACRYLIC-Carvera.nc', 283719, '2561a63bf8'],
  ['LED/ACRYLIC-Face.nc', 168819, '8efc553730'],
  ['LED/ACRYLIC-R2D2.nc', 146642, '108501872c'],
  ['LED/ACRYLIC-SpiderMan.nc', 68652, 'fd762be67e'],
  ['LED/ALUMINUM-Button.nc', 16743, 'ee90fa700f'],
  ['LED/PCB-NO-UV-MASK.nc', 92807, '64837ff659'],
  ['LED/PCB-UV-MASK(PART1).nc', 59273, '164df6f007'],
  ['LED/PCB-UV-MASK(PART2).nc', 486409, '28a306c816'],
  ['Laser/AudreyHepburn.nc', 2824166, '9820417f42'],
  ['Laser/AudreyHepburnSmall.nc', 331837, 'f3d944c565'],
  ['Relief/PirateShip.nc', 2803177, 'f300988e5f'],
  ['Rotation/NefertitiFinish.nc', 2616552, '46d746e61e'],
  ['Rotation/NefertitiRough.nc', 135990, '70cc51609b'],
  ['Tests/4th-test-air.nc', 135990, 'fd4155826f'],
  ['Tests/atc-fatigue-test.nc', 678, 'bc9316d8b6'],
  ['Tests/atc-test.nc', 75, 'b828eee1b2'],
  ['Tests/board-test.nc', 1651, '61cfcd24c8'],
  ['Tests/fatigue-test-air.nc', 135237, '144c1ab07f'],
  ['Tests/fatigue-test.nc', 2086961, '105f3a4250'],
  ['Tests/flatness-test-air.nc', 215, '7926cb940f'],
  ['Tests/goto-pack-pos.nc', 53, 'e13b36431e'],
  ['Tests/laser-test-air.nc', 14772, 'da73dbfeee'],
  ['Tests/pcb-test-air.nc', 286571, '3e2de409e1'],
  // Z1-generated, from the CarveraProfiles release (see RELEASE_REPO above).
  ['Z1/TopClamp.nc', 214495, '1f96d8a6fe', 'release'],
];

/** Git's blob hash: sha1("blob <size>\0" + content). What the GitHub tree reports. */
export function gitBlobSha1(buf) {
  return createHash('sha1')
    .update(`blob ${buf.length}\0`)
    .update(buf)
    .digest('hex');
}

const WARNING = `
  Reference G-code corpus -- READ THIS
  ------------------------------------
  These files are Makera's: from ${REPO} (GPL-3.0) and, for Z1/TopClamp.nc, from
  ${RELEASE_REPO} (NO licence: all rights reserved). Case Maker is Apache-2.0.
  They are downloaded into a git-ignored directory and MUST NOT be committed,
  copied into src/, or embedded in a test as a literal. Hand-write fixtures.
  Only Z1/TopClamp.nc is Z1-generated; the rest are Carvera-generated: evidence about the
  shared dialect, not about the Z1.
`;

async function main() {
  console.log(WARNING);
  console.log(`  commit ${COMMIT.slice(0, 12)}  ->  ${CORPUS_DIR}\n`);
  let fetched = 0;
  let kept = 0;
  const failures = [];

  for (const [rel, size, shaPrefix, source] of MANIFEST) {
    const dest = join(CORPUS_DIR, rel);
    if (existsSync(dest)) {
      const have = readFileSync(dest);
      if (have.length === size && gitBlobSha1(have).startsWith(shaPrefix)) {
        kept++;
        continue;
      }
      console.log(`  ! ${rel}: present but does not match the manifest, refetching`);
    }
    const url =
      source === 'release'
        ? `https://github.com/${RELEASE_REPO}/releases/download/${RELEASE_TAG}/${encodeURIComponent(rel.split('/').pop())}`
        : `https://raw.githubusercontent.com/${REPO}/${COMMIT}/${ROOT_IN_REPO}${rel
            .split('/')
            .map(encodeURIComponent)
            .join('/')}`;
    let buf;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      buf = Buffer.from(await res.arrayBuffer());
    } catch (e) {
      failures.push(`${rel}: ${e.message}`);
      continue;
    }
    if (buf.length !== size) {
      failures.push(`${rel}: expected ${size} bytes, got ${buf.length}`);
      continue;
    }
    const sha = gitBlobSha1(buf);
    if (!sha.startsWith(shaPrefix)) {
      failures.push(`${rel}: blob sha ${sha.slice(0, 10)} != manifest ${shaPrefix}`);
      continue;
    }
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, buf);
    fetched++;
    console.log(`  + ${rel}  (${size} bytes)`);
  }

  console.log(`\n  ${fetched} fetched, ${kept} already present and verified, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.error(`  FAILED ${f}`);
    process.exit(1);
  }
}

// Importable for a test that wants the manifest without running a download.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
