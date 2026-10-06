import { openBinaryFile } from '@/utils/openTextFile';
import { MAX_TRACE_EDGE, traceRaster, type RasterImage, type TraceOptions } from './rasterOutline';
import type { OutlineImport } from './outlineTypes';

/**
 * The browser half of raster tracing (#252): pick a bitmap, decode it to pixels, trace it. This
 * is the only module in the trace path that touches a browser API — `rasterOutline.ts` stays pure
 * and testable in Node.
 *
 * The decode is a seam (`setRasterDecodeLoader`) for the same reason the sim and preview clients
 * are: `createImageBitmap` does not exist in jsdom, and a component test should exercise the real
 * trace against real pixels rather than mock the thing under test.
 */

export const RASTER_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'];

export type RasterDecoder = (file: Blob) => Promise<RasterImage>;

let decodeLoader: () => Promise<RasterDecoder> = async () => decodeImageFile;

/** Swap the decoder. Vitest uses this; the app never calls it. */
export function setRasterDecodeLoader(fn: () => Promise<RasterDecoder>): void {
  decodeLoader = fn;
}

/**
 * Decode a bitmap to RGBA pixels. Downscales to `MAX_TRACE_EDGE` on the long edge — a 6000 px
 * photo traces to the same cut region as its 1024 px reduction, for a fraction of the work.
 *
 * The canvas is painted WHITE first: a transparent PNG would otherwise decode its dead pixels as
 * black, and the tracer would fill the whole sheet. White matches how the tracer reads a
 * transparent pixel (background), so both agree that "nothing here" means "no cut".
 */
export async function decodeImageFile(file: Blob): Promise<RasterImage> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, MAX_TRACE_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Could not read the image: the browser gave no 2D canvas context.');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    const data = ctx.getImageData(0, 0, width, height).data;
    return { width, height, data };
  } finally {
    bitmap.close();
  }
}

/** `ok` with the pixels kept so the dialog's controls can re-trace without a second pick. */
export type RasterImportResult =
  | { ok: true; image: RasterImage; outline: OutlineImport }
  | { ok: false; error: string };

/**
 * Pick an image and trace it. Resolves `null` on cancel. The pixels ride along in the result
 * because every control in the dialog re-traces from them — re-decoding a file the user already
 * chose would be both slower and, for a multi-frame format, not even the same picture.
 */
export async function importRasterFromDisk(options?: TraceOptions): Promise<RasterImportResult | null> {
  const file = await openBinaryFile({
    description: 'Image to trace',
    extensions: RASTER_EXTENSIONS,
    mime: 'image/*',
  });
  if (!file) return null;
  try {
    const decode = await decodeLoader();
    const image = await decode(file);
    const parsed = traceRaster(image, options, file.name);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    return { ok: true, image, outline: parsed.outline };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
