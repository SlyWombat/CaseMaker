/**
 * #672 — A PURE PNG READER, for the image relief's heightfield.
 *
 * The relief is sampled in the generate/preview WORKERS, which have no DOM and no canvas — the
 * trace path's `createImageBitmap` decode can never run there (`imageDecode.ts` refuses in
 * headless for the same reason), and baking the heightfield into the document is forbidden (the
 * document stores the image reference and the relief's two numbers, never the sampled field). So
 * the relief carries its own reader: the PNG container, fflate's zlib inflate, and the five
 * scanline unfilters — ~150 lines of pure data work, testable in Node.
 *
 * WHAT IT READS: 8 bits per channel, non-interlaced, greyscale (type 0), grey+alpha (4), RGB (2)
 * and RGBA (6). Everything else — 16-bit channels, palette images, Adam7 interlacing — is refused
 * BY NAME with the way out, because each needs a different expansion (bit unpacking, a palette
 * lookup, seven passes) and none is in this slice.
 *
 * OUT: one luminance byte per pixel, Rec.601 (`0.299R + 0.587G + 0.114B`). Grey images are their
 * own sample. Alpha is IGNORED — a relief is the picture's tone, and compositing onto a colour
 * would be a second convention the sheet would have to state.
 */

import { unzlibSync } from 'fflate';

/** One decoded picture: its size and one luminance byte per pixel, row-major from the top row. */
export interface DecodedImage {
  width: number;
  height: number;
  /** Rec.601 luminance 0–255, `width * height` bytes. */
  grey: Uint8Array;
}

export type PngDecode = { ok: true; image: DecodedImage } | { ok: false; error: string };

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** Channel count for the colour types this reader takes (types 0, 2, 4, 6 at 8 bits). */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

/**
 * Decode a PNG (or say why not). `bytes` is the file's whole content; the signature is checked,
 * so a JPEG or a truncated download is a sentence rather than a mysterious picture.
 */
export function decodePng(bytes: Uint8Array): PngDecode {
  if (bytes.length < 8 || SIGNATURE.some((b, i) => bytes[i] !== b)) {
    return { ok: false, error: 'this is not a PNG file' };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colourType = -1;
  let interlace = 0;
  let sawHeader = false;
  const idat: Uint8Array[] = [];

  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(bytes[offset + 4]!, bytes[offset + 5]!, bytes[offset + 6]!, bytes[offset + 7]!);
    const dataStart = offset + 8;
    if (dataStart + length + 4 > bytes.length) {
      return { ok: false, error: 'the PNG is truncated — re-save or re-export the picture' };
    }
    if (type === 'IHDR') {
      if (length < 13) return { ok: false, error: 'the PNG header is short' };
      width = view.getUint32(dataStart);
      height = view.getUint32(dataStart + 4);
      bitDepth = bytes[dataStart + 8]!;
      colourType = bytes[dataStart + 9]!;
      interlace = bytes[dataStart + 12]!;
      sawHeader = true;
    } else if (type === 'IDAT') {
      idat.push(bytes.subarray(dataStart, dataStart + length));
    } else if (type === 'IEND') {
      break;
    }
    offset = dataStart + length + 4;
  }

  if (!sawHeader) return { ok: false, error: 'the PNG has no header' };
  if (!(width > 0 && height > 0)) return { ok: false, error: 'the PNG states no pixels' };
  if (bitDepth !== 8) {
    return {
      ok: false,
      error: `this PNG is ${bitDepth} bits per channel; the relief reads 8 — export it at 8 bits`,
    };
  }
  const channels = CHANNELS[colourType];
  if (channels === undefined) {
    return {
      ok: false,
      error:
        colourType === 3
          ? 'this is a palette PNG; the relief reads greyscale or true-colour — export it as RGB'
          : `this PNG's colour type (${colourType}) is not one the relief reads — export it as greyscale or RGB`,
    };
  }
  if (interlace !== 0) {
    return { ok: false, error: 'this PNG is interlaced (Adam7); re-export it non-interlaced' };
  }
  if (idat.length === 0) return { ok: false, error: 'the PNG carries no image data' };

  let raw: Uint8Array;
  try {
    raw = unzlibSync(concat(idat));
  } catch {
    return { ok: false, error: 'the PNG’s image data could not be unpacked — re-export the picture' };
  }
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) {
    return { ok: false, error: 'the PNG’s image data is shorter than its size states' };
  }

  // Unfilter in place into a pixel buffer: each scanline starts with one filter-type byte.
  const pixels = new Uint8Array(height * stride);
  const bpp = channels;
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const prev = dst - stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[src + x]!;
      const a = x >= bpp ? pixels[dst + x - bpp]! : 0;
      const b = y > 0 ? pixels[prev + x]! : 0;
      const c = x >= bpp && y > 0 ? pixels[prev + x - bpp]! : 0;
      let out: number;
      switch (filter) {
        case 0:
          out = value;
          break;
        case 1:
          out = value + a;
          break;
        case 2:
          out = value + b;
          break;
        case 3:
          out = value + ((a + b) >> 1);
          break;
        case 4: {
          // Paeth: the neighbour closest to a + b − c.
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          out = value + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          return { ok: false, error: `the PNG uses scanline filter ${filter}, which is not a PNG filter` };
      }
      pixels[dst + x] = out & 0xff;
    }
  }

  // Luminance: grey is its own sample; colour is Rec.601. Alpha (if any) is dropped.
  const grey = new Uint8Array(width * height);
  for (let p = 0; p < grey.length; p++) {
    const base = p * channels;
    grey[p] =
      channels === 1 || channels === 2
        ? pixels[base]!
        : Math.round(0.299 * pixels[base]! + 0.587 * pixels[base + 1]! + 0.114 * pixels[base + 2]!);
  }
  return { ok: true, image: { width, height, grey } };
}

/** The PNG's pixel size without decoding the image data — the import's size check. */
export function pngPixelSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24 || SIGNATURE.some((b, i) => bytes[i] !== b)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!) !== 'IHDR') return null;
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
