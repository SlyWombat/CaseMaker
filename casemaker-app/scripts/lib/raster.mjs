/**
 * The image primitives the build scripts share (#403): decode a PNG, resample it, write a PNG or a
 * BMP, and composite one image onto another.
 *
 * There is no image library in this project and none is wanted. `sharp` is present in
 * `node_modules` but only four levels down (`manifold-3d` → `@gltf-transform/functions` →
 * `ndarray-pixels`), which is not something to build release artefacts on, and everything needed
 * here is small: our masters are plain 8-bit non-interlaced PNGs and the outputs are flat artwork.
 *
 * The PNG side is deliberately narrow — it takes the colour types flat artwork uses and throws
 * anything else rather than guessing, because silently mis-decoding an icon is worse than being told
 * the master needs re-exporting. Resampling is premultiplied by alpha, or transparent edges pick up
 * a dark fringe.
 *
 * `append-ico-sizes.mjs` and `gen-installer-art.mjs` both use this; a second copy of a PNG decoder
 * in this repo would be a second thing to keep right.
 */

import { deflateSync, inflateSync } from 'node:zlib';

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ------------------------------------------------------------------ PNG decoding

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** `#rrggbb` → `[r,g,b]`. The palette is written as hex in the scripts, so parse it once here. */
export function hex(colour) {
  const m = /^#?([0-9a-f]{6})$/i.exec(colour);
  if (!m) throw new Error(`not a hex colour: ${colour}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/**
 * Decode an 8-bit, non-interlaced PNG into RGBA.
 *
 * Deliberately narrow: it accepts the colour types a flat artwork master uses (grey, RGB, RGBA)
 * and throws on anything else rather than guessing, because silently mis-decoding an icon is worse
 * than being told the master needs re-exporting.
 */
export function decodePng(buf) {
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

  // Normalise to RGBA so every consumer has one shape to handle.
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

// ------------------------------------------------------------------ PNG encoding

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

/** Encode RGBA as an 8-bit PNG with filter 0 on every row — these files only need to be readable. */
export function encodePng(width, height, rgba) {
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

/**
 * Encode RGBA as a 24-bit bottom-up BMP, which is the only bitmap form MUI's header and welcome
 * bitmaps accept.
 *
 * BMP has no alpha channel, so the image must already be flat — `flatten` does that, and this
 * asserts it did rather than writing a bitmap whose transparency silently became black.
 */
export function encodeBmp(width, height, rgba) {
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 255) throw new Error('encodeBmp needs a flattened image (found a non-opaque pixel)');
  }
  const rowSize = Math.ceil((width * 3) / 4) * 4; // rows are padded to a 4-byte boundary
  const pixelBytes = rowSize * height;
  const header = Buffer.alloc(54);
  header.write('BM', 0, 'ascii');
  header.writeUInt32LE(54 + pixelBytes, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14); // BITMAPINFOHEADER
  header.writeInt32LE(width, 18);
  header.writeInt32LE(height, 22); // positive height = bottom-up
  header.writeUInt16LE(1, 26); // planes
  header.writeUInt16LE(24, 28); // bits per pixel
  header.writeUInt32LE(0, 30); // BI_RGB
  header.writeUInt32LE(pixelBytes, 34);
  header.writeInt32LE(2835, 38); // 72 dpi
  header.writeInt32LE(2835, 42);

  const pixels = Buffer.alloc(pixelBytes); // zero-filled, so row padding is already black
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * width * 4;
    const dst = y * rowSize;
    for (let x = 0; x < width; x++) {
      pixels[dst + x * 3] = rgba[src + x * 4 + 2]; // B
      pixels[dst + x * 3 + 1] = rgba[src + x * 4 + 1]; // G
      pixels[dst + x * 3 + 2] = rgba[src + x * 4]; // R
    }
  }
  return Buffer.concat([header, pixels]);
}

// ------------------------------------------------------------------ resampling

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
export function resample(src, size) {
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

// ------------------------------------------------------------------ composition

/**
 * A fresh opaque canvas. `top` and `bottom` differ → a vertical gradient, which is what gives the
 * installer art some depth without an asset to hand-draw.
 */
export function canvas(width, height, top, bottom = top) {
  const [r0, g0, b0] = hex(top);
  const [r1, g1, b1] = hex(bottom);
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const t = height === 1 ? 0 : y / (height - 1);
    const r = Math.round(r0 + (r1 - r0) * t);
    const g = Math.round(g0 + (g1 - g0) * t);
    const b = Math.round(b0 + (b1 - b0) * t);
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      out[at] = r;
      out[at + 1] = g;
      out[at + 2] = b;
      out[at + 3] = 255;
    }
  }
  return { width, height, data: out };
}

/** Fill an axis-aligned rectangle. Coordinates are clamped, so a caller cannot write out of bounds. */
export function fillRect(img, x, y, w, h, colour) {
  const [r, g, b] = hex(colour);
  for (let yy = Math.max(0, y); yy < Math.min(img.height, y + h); yy++) {
    for (let xx = Math.max(0, x); xx < Math.min(img.width, x + w); xx++) {
      const at = (yy * img.width + xx) * 4;
      img.data[at] = r;
      img.data[at + 1] = g;
      img.data[at + 2] = b;
      img.data[at + 3] = 255;
    }
  }
}

/** `resample` in the shape `blit` and `encodeBmp` take. `resample` itself returns bare pixels,
 *  because the ICO path already knows the size it asked for and does not need it handed back. */
export function scaled(img, size) {
  return { width: size, height: size, data: resample(img, size) };
}

/**
 * Alpha-composite `src` onto `dst` with its top-left at (x, y).
 *
 * The source must be smaller than the destination and offset inside it; a blit that hung off the
 * edge would be a placement mistake, and clipping it silently is how an image ends up half-drawn.
 */
export function blit(dst, src, x, y) {
  // Handed bare pixels (what `resample` returns) rather than an image, every loop bound below is
  // `undefined` and this draws nothing at all, quietly. That is not hypothetical: it is how the
  // first run of gen-installer-art.mjs produced two blank panels.
  if (typeof src?.width !== 'number' || typeof src?.height !== 'number' || !src.data) {
    throw new Error('blit needs { width, height, data }; use scaled() around a resample()');
  }
  if (x < 0 || y < 0 || x + src.width > dst.width || y + src.height > dst.height) {
    throw new Error(
      `blit of ${src.width}x${src.height} at ${x},${y} does not fit inside ${dst.width}x${dst.height}`,
    );
  }
  for (let sy = 0; sy < src.height; sy++) {
    for (let sx = 0; sx < src.width; sx++) {
      const s = (sy * src.width + sx) * 4;
      const d = ((y + sy) * dst.width + (x + sx)) * 4;
      const a = src.data[s + 3] / 255;
      if (a === 0) continue;
      dst.data[d] = Math.round(src.data[s] * a + dst.data[d] * (1 - a));
      dst.data[d + 1] = Math.round(src.data[s + 1] * a + dst.data[d + 1] * (1 - a));
      dst.data[d + 2] = Math.round(src.data[s + 2] * a + dst.data[d + 2] * (1 - a));
      dst.data[d + 3] = 255;
    }
  }
}
