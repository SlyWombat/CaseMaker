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
 *
 * #483 — a headless (Node) run has neither `createImageBitmap` nor `document`, and raster tracing
 * has no Node fallback. It refuses by name instead: `headless-unsupported: raster-import`, with
 * the route that asked for it, so the command prints a reason rather than `document is not
 * defined`. `--from-3mf` does NOT reach this: `design3mf.ts`/`prusa3mf.ts` read geometry
 * (vertices and triangles) only and never a texture, so no pure-JS raster decoder is carried.
 */

export const RASTER_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'];

/** The diagnostic code every headless refusal carries (cnc-guide §8.1). */
export const HEADLESS_UNSUPPORTED = 'headless-unsupported';
/** The one route a headless run refuses today: tracing a raster bitmap (#483). */
export const RASTER_IMPORT = 'raster-import';

/** The refusal text a headless caller sees. `route` is the entry point that attempted it. */
export function headlessUnsupportedMessage(route: string): string {
  return `${HEADLESS_UNSUPPORTED}: ${RASTER_IMPORT} (route: ${route})`;
}

/** A typed refusal for callers that cannot return a result (the decoder itself). */
export class HeadlessUnsupportedError extends Error {
  readonly code = HEADLESS_UNSUPPORTED;
  readonly feature = RASTER_IMPORT;
  readonly route: string;

  constructor(route: string) {
    super(headlessUnsupportedMessage(route));
    this.name = 'HeadlessUnsupportedError';
    this.route = route;
  }
}

/**
 * The browser APIs the default decoder needs, named structurally so this module compiles under
 * the headless config's ES2023 lib (no `DOM`). Node's own `Blob` comes from `@types/node`.
 */
interface BitmapLike {
  readonly width: number;
  readonly height: number;
  close(): void;
}

interface CanvasContextLike {
  fillStyle: string;
  fillRect(x: number, y: number, w: number, h: number): void;
  drawImage(bitmap: BitmapLike, dx: number, dy: number, dw: number, dh: number): void;
  getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
}

interface CanvasLike {
  width: number;
  height: number;
  getContext(
    contextId: '2d',
    options?: { willReadFrequently?: boolean },
  ): CanvasContextLike | null;
}

interface BrowserDecodeGlobals {
  createImageBitmap?: (source: Blob) => Promise<BitmapLike>;
  document?: { createElement(tagName: 'canvas'): CanvasLike };
}

/** True in Node (and in a server/CLI run): there is no document, so there is no picker either. */
export function isHeadless(): boolean {
  return (globalThis as unknown as BrowserDecodeGlobals).document === undefined;
}

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
 *
 * `route` names the caller in a headless refusal (#483). A browser build never sees it.
 */
export async function decodeImageFile(file: Blob, route = 'decodeImageFile'): Promise<RasterImage> {
  const g = globalThis as unknown as BrowserDecodeGlobals;
  if (isHeadless()) throw new HeadlessUnsupportedError(route);
  const createBitmap = g.createImageBitmap;
  const doc = g.document;
  if (typeof createBitmap !== 'function' || doc === undefined) {
    throw new Error('Could not read the image: this browser cannot decode bitmaps (createImageBitmap is unavailable).');
  }
  const bitmap = await createBitmap(file);
  try {
    const scale = Math.min(1, MAX_TRACE_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = doc.createElement('canvas');
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
  | {
      ok: false;
      error: string;
      /** Set only when the refusal is a named headless limitation (#483). */
      code?: typeof HEADLESS_UNSUPPORTED;
      /** The headless route that asked, when `code` is set. */
      route?: string;
    };

/**
 * Pick an image and trace it. Resolves `null` on cancel. The pixels ride along in the result
 * because every control in the dialog re-traces from them — re-decoding a file the user already
 * chose would be both slower and, for a multi-frame format, not even the same picture.
 *
 * A headless run refuses BEFORE the picker (#483): the browser file dialog is the first
 * browser-only thing this path needs, and its failure would not say which capability is missing.
 * `route` names the entry point in that refusal; the app passes the default and never sees it.
 */
export async function importRasterFromDisk(
  options?: TraceOptions,
  route = 'importRasterFromDisk',
): Promise<RasterImportResult | null> {
  if (isHeadless()) {
    return {
      ok: false,
      error: headlessUnsupportedMessage(route),
      code: HEADLESS_UNSUPPORTED,
      route,
    };
  }
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
