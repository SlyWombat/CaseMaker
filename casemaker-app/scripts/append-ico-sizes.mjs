#!/usr/bin/env node
/**
 * Give `src-tauri/icons/icon.ico` every Windows icon size (#403 gap 5).
 *
 * `tauri icon` writes six sizes — 16, 24, 32, 48, 64, 256 — and re-running it reproduces exactly
 * those six, so it cannot close the gap by itself. 20 and 40 are the sizes the shell asks for at
 * 125% and 150% display scaling; without them Windows falls back to a neighbouring size and those
 * are the two the maintainer asked for.
 *
 *     npm run icons
 *
 * It keeps every entry already in `icon.ico` and only *adds* the sizes that are missing, resampling
 * them from the master PNG with a box filter. That order matters: the six sizes Tauri made stay
 * byte-identical, so this cannot quietly restyle them, and a second run is a no-op.
 *
 * IT DELIBERATELY DOES NOT RUN `tauri icon` FIRST, which is how it was first written. Re-running
 * `tauri icon` in this repo is NOT a no-op: measured on 2026-10-13, Tauri 2.7.1 regenerated all
 * seventeen checked-in PNGs with different pixels (the uncompressed sizes match, so it is the
 * resample that differs) and dropped 35 android/ios files into a Windows desktop app's icon
 * directory. Chained here it would turn a two-size fix into a repo-wide icon redraw — so it is not
 * chained. If the ARTWORK ever changes, run `tauri icon src-tauri/icons/icon.png -o
 * src-tauri/icons` yourself on Windows first and expect to review the whole set; that is a redesign
 * and deserves its own diff. Why the output differs is not settled: either the CLI's resampler
 * changed, or the checked-in 512 `icon.png` is a copy of a larger original master that is no longer
 * in the repo. The maintainer has the artwork and can say which.
 *
 * No image library: the PNG decode, the box filter and the PNG encode are in `scripts/lib/raster.mjs`,
 * shared with the installer artwork. Only the ICO container is here.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodePng, encodePng, resample } from './lib/raster.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MASTER = join(ROOT, 'src-tauri', 'icons', 'icon.png');
const TARGET = join(ROOT, 'src-tauri', 'icons', 'icon.ico');

/** Every size a Windows shell can ask for. 0 in the ICO directory means 256. */
const WANTED = [16, 20, 24, 32, 40, 48, 64, 256];

// ---------------------------------------------------------------- ICO container

/** Each entry's payload is a PNG — which is what Tauri writes and what Windows has accepted since
 *  Vista. `width`/`height` of 0 in the directory means 256. */
function readIco(buf) {
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) throw new Error('not an ICO');
  const count = buf.readUInt16LE(4);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 16;
    const width = buf[at] === 0 ? 256 : buf[at];
    const height = buf[at + 1] === 0 ? 256 : buf[at + 1];
    if (width !== height) throw new Error(`ICO entry ${i} is ${width}x${height}; expected square`);
    const size = buf.readUInt32LE(at + 8);
    const offset = buf.readUInt32LE(at + 12);
    entries.set(width, buf.subarray(offset, offset + size));
  }
  return entries;
}

function writeIco(sizes, entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);

  const directory = Buffer.alloc(sizes.length * 16);
  let offset = 6 + sizes.length * 16;
  const bodies = [];
  sizes.forEach((size, i) => {
    const png = entries.get(size);
    const at = i * 16;
    directory[at] = size === 256 ? 0 : size;
    directory[at + 1] = size === 256 ? 0 : size;
    directory[at + 2] = 0; // palette size (0 = no palette)
    directory[at + 3] = 0; // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += png.length;
    bodies.push(png);
  });

  return Buffer.concat([header, directory, ...bodies]);
}

// ---------------------------------------------------------------- main

const existing = readIco(readFileSync(TARGET));
const master = decodePng(readFileSync(MASTER));
const show = (sizes) => [...sizes].sort((a, b) => a - b).join(', ');
console.log(`icon.ico currently carries: ${show(existing.keys())}`);
console.log(`master ${MASTER.replace(`${ROOT}/`, '')} is ${master.width}x${master.height}`);

const strays = [...existing.keys()].filter((size) => !WANTED.includes(size));
if (strays.length) console.log(`  dropping ${show(strays)} (not a size a Windows shell asks for)`);

const missing = WANTED.filter((size) => !existing.has(size));
if (missing.length === 0) {
  console.log(`nothing to do: icon.ico already carries all of ${WANTED.join(', ')}`);
  process.exit(0);
}

for (const size of missing) {
  if (size > master.width) throw new Error(`cannot make ${size}px from a ${master.width}px master`);
  const rgba = resample(master, size);
  existing.set(size, encodePng(size, size, rgba));
  console.log(`  added ${size}x${size} (resampled from the master)`);
}

const ordered = WANTED.filter((size) => existing.has(size));
writeFileSync(TARGET, writeIco(ordered, existing));

// Re-read rather than trust the write: the point of the script is the file on disk.
const written = readIco(readFileSync(TARGET));
const got = [...written.keys()].sort((a, b) => a - b);
if (got.join(',') !== WANTED.join(',')) {
  throw new Error(`icon.ico now carries ${got.join(', ')}; expected ${WANTED.join(', ')}`);
}
console.log(`icon.ico now carries: ${got.join(', ')}`);
