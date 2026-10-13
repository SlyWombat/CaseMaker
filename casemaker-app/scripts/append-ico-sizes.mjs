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
 * No image library. `sharp` is in `node_modules` but only as a transitive dependency four levels
 * down (`manifold-3d` → `@gltf-transform/functions` → `ndarray-pixels`), which is not something to
 * build a release artefact on, and the master is a plain 8-bit non-interlaced PNG — so the decode,
 * the box filter and the encode are all here, in about the length of the alternative's imports.
 * The resample is premultiplied by alpha, or transparent edges pick up a dark fringe.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MASTER = join(ROOT, 'src-tauri', 'icons', 'icon.png');
const TARGET = join(ROOT, 'src-tauri', 'icons', 'icon.ico');

/** Every size a Windows shell can ask for. 0 in the ICO directory means 256. */
const WANTED = [16, 20, 24, 32, 40, 48, 64, 256];

// ---------------------------------------------------------------- PNG decoding

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Decode an 8-bit, non-interlaced PNG into RGBA.
 *
 * Deliberately narrow: it accepts the colour types a flat artwork master uses (grey, RGB, RGBA)
 * and throws on anything else rather than guessing, because silently mis-decoding an icon is worse
 * than being told the master needs re-exporting.
 */
function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG');

  let width = 0;
  let height = 0;
  let channels = 0;
  const idat = [];
  let palette = null;
  let transparency = null;

  let at = 8;
  while (at < buf.length) {
    const length = buf.readUInt32BE(at);
    const type = buf.toString('ascii', at + 4, at + 8);
    const body = buf.subarray(at + 8, at + 8 + length);

    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      const colour = body[9];
      const interlace = body[12];
      if (depth !== 8) throw new Error(`master PNG has bit depth ${depth}; expected 8`);
      if (interlace !== 0) throw new Error('master PNG is interlaced; expected non-interlaced');
      const byColour = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
      channels = byColour[colour];
      if (!channels) throw new Error(`master PNG has unsupported colour type ${colour}`);
      if (colour === 3) throw new Error('master PNG is palettised; re-export it as RGB or RGBA');
      if (colour === 0 || colour === 4) throw new Error('master PNG is greyscale; re-export it as RGB or RGBA');
    } else if (type === 'PLTE') {
      palette = body;
    } else if (type === 'tRNS') {
      transparency = body;
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    at += 12 + length;
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const flat = Buffer.alloc(height * stride);

  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const row = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = flat.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? flat.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let value = row[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) value += paeth(a, b, c);
      else if (filter !== 0) throw new Error(`unsupported PNG filter ${filter}`);
      cur[x] = value & 0xff;
    }
  }

  // Normalise to RGBA so the resampler has one shape to handle.
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    if (channels === 4) {
      rgba.set(flat.subarray(i * 4, i * 4 + 4), i * 4);
    } else if (channels === 3) {
      rgba[i * 4] = flat[i * 3];
      rgba[i * 4 + 1] = flat[i * 3 + 1];
      rgba[i * 4 + 2] = flat[i * 3 + 2];
      rgba[i * 4 + 3] = 255;
    } else {
      const grey = flat[i * 2];
      rgba[i * 4] = grey;
      rgba[i * 4 + 1] = grey;
      rgba[i * 4 + 2] = grey;
      rgba[i * 4 + 3] = channels === 2 ? flat[i * 2 + 1] : 255;
    }
  }

  if (palette && transparency) throw new Error('master PNG has a palette with transparency');
  return { width, height, data: rgba };
}

// ---------------------------------------------------------------- PNG encoding

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'ascii');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, tail]);
}

/** Encode RGBA as an 8-bit PNG with filter 0 on every row — the ICO only needs it readable. */
function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- resampling

/**
 * Per destination pixel, the source pixels it covers and how much of each — exact fractional
 * overlap, so a 512→20 or 512→40 reduction (ratios of 25.6 and 12.8) is the true area average
 * rather than a nearest-neighbour approximation.
 */
function axisSpans(srcLen, dstLen) {
  const spans = [];
  for (let d = 0; d < dstLen; d++) {
    const s0 = (d * srcLen) / dstLen;
    const s1 = ((d + 1) * srcLen) / dstLen;
    const weights = [];
    let total = 0;
    for (let i = Math.floor(s0); i < Math.ceil(s1); i++) {
      const overlap = Math.min(s1, i + 1) - Math.max(s0, i);
      if (overlap > 0) {
        weights.push([i, overlap]);
        total += overlap;
      }
    }
    spans.push(weights.map(([i, w]) => [i, w / total]));
  }
  return spans;
}

/** Area-average down to `size`×`size`, premultiplied by alpha so edges do not darken. */
function resample(src, size) {
  const xSpans = axisSpans(src.width, size);
  const ySpans = axisSpans(src.height, size);
  const out = new Uint8Array(size * size * 4);

  for (let dy = 0; dy < size; dy++) {
    for (let dx = 0; dx < size; dx++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (const [sy, wy] of ySpans[dy]) {
        for (const [sx, wx] of xSpans[dx]) {
          const w = wx * wy;
          const at = (sy * src.width + sx) * 4;
          const alpha = src.data[at + 3] / 255;
          r += src.data[at] * alpha * w;
          g += src.data[at + 1] * alpha * w;
          b += src.data[at + 2] * alpha * w;
          a += alpha * w;
        }
      }
      const at = (dy * size + dx) * 4;
      if (a > 0) {
        out[at] = Math.round(r / a);
        out[at + 1] = Math.round(g / a);
        out[at + 2] = Math.round(b / a);
      }
      out[at + 3] = Math.round(a * 255);
    }
  }
  return out;
}

// ---------------------------------------------------------------- ICO container

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
