import { openTextFile } from '@/utils/openTextFile';
import type { Mm } from '@/types';
import { MAX_LINE_POINTS, type EngraveLineItem, type EngraveVectorShape } from '@/types/engraveJob';
import { parseSvgOutline } from './svgOutline';
import { parseDxfOutline } from './dxfOutline';
import type { OutlineImport, OutlineParseResult } from './outlineTypes';
import { shopDefault } from '@/store/shopDefaultsStore';

/**
 * The front door to vector import (#217): pick a file, dispatch to the pure parser for its
 * format, and hand the panel either an `OutlineImport` (rings in mm + the size to show) or an
 * error. `svgOutline.ts` and `dxfOutline.ts` stay pure; this is the only module here that
 * touches the browser's file picker.
 *
 * The panel split is deliberate (#213–#215): this is engine work, and the "Import outline…" menu
 * entry, the preview and the size control belong to the engrave panel.
 */

export const OUTLINE_EXTENSIONS = ['.svg', '.dxf'];

export type { OutlineImport, OutlineParseResult, OutlineFormat, OutlineFillRule } from './outlineTypes';
export { MAX_OUTLINE_FILE_BYTES, MAX_OUTLINE_CONTOURS, MAX_OUTLINE_PATHS, MAX_OUTLINE_POINTS, scaleOutlineToWidth } from './outlineTypes';
export { parseSvgOutline } from './svgOutline';
export { parseDxfOutline } from './dxfOutline';
// Raster tracing (#252) is the third format, and by the time an `OutlineImport` exists the
// caller cannot tell which of the three it came from. Its door and its options re-export here so
// the panel has one import site, exactly as it does for the two vector parsers.
export type { RasterImage, TraceOptions } from './rasterOutline';
export { TRACE_DEFAULTS, MM_PER_PX, traceRaster } from './rasterOutline';
export { importRasterFromDisk, RASTER_EXTENSIONS, setRasterDecodeLoader } from './imageDecode';
export type { RasterImportResult, RasterDecoder } from './imageDecode';

/** Dispatch by extension: `.svg` and `.dxf` only. The name is stamped onto the result. */
export function parseOutlineFile(
  text: string,
  fileName: string,
  opts: { dxfChordToleranceMm?: number } = {},
): OutlineParseResult {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  if (ext === 'svg') return parseSvgOutline(text, fileName);
  if (ext === 'dxf') return parseDxfOutline(text, fileName, { chordToleranceMm: opts.dxfChordToleranceMm });
  return {
    ok: false,
    error: `Unsupported outline format ".${ext}": import an SVG or a DXF file.`,
  };
}

/**
 * Open the picker, read the chosen file and parse it. Resolves `null` when the user cancels, so
 * the panel can do nothing rather than show an error. The picker's own size guard
 * (`MAX_TEXT_FILE_BYTES`) is the outer limit; each parser refuses its format's oversized file.
 */
export async function importOutlineFromDisk(): Promise<OutlineParseResult | null> {
  const file = await openTextFile({ description: 'Vector outline', extensions: OUTLINE_EXTENSIONS });
  if (!file) return null;
  // #451 — the arc chord error is a shop default, read from the location at the import.
  return parseOutlineFile(file.text, file.name, { dxfChordToleranceMm: shopDefault('import.dxfChordToleranceMm').value });
}

/** The placement fields the panel supplies when it turns an import into a job item. */
export interface VectorShapeFields {
  id: string;
  position: { x: Mm; y: Mm };
  depth: Mm;
  /** Degrees, default 0. */
  rotation?: number;
  /** Default true. */
  enabled?: boolean;
  /** Optional human name, shown in operations/findings. */
  name?: string;
}

/**
 * An accepted `OutlineImport` as a job item (#217). The contours are already mm and centred on
 * the origin, so the item's `position`/`rotation` place them exactly as a polygon's `points`.
 */
export interface LineTraceFields {
  position: { x: Mm; y: Mm };
  depth: Mm;
  /** Degrees, default 0. */
  rotation?: number;
  /** Default true. */
  enabled?: boolean;
  /** The import's name; several lines are suffixed `— line N`. */
  name?: string;
  /**
   * One id per ITEM, in order — a long path splits into several items, so the caller mints an id
   * per item rather than per path.
   */
  idFor: (index: number) => string;
}

/**
 * #664 — an accepted `OutlineImport`'s paths as `line` items: one per path, each an Engrave
 * operation cut by the trace rules. The paths share the import's centred frame with the contours,
 * so giving every item the same position/rotation keeps the strokes on the drawing they were
 * drawn with. A file with no paths yields an empty list (a fills-only import is unchanged).
 *
 * #678 — a CLOSED path (a stroke-only shape's ring) becomes a `closed: true` line, so the cut is
 * the ring rather than a pocket. A RING LONGER THAN THE CAP is still a ring: its chunks are OPEN
 * items sharing their seam vertex, and the LAST chunk gets the ring's first point appended, so the
 * union of the items is exactly the closed path. No chunk is `closed: true` — a closed item feeds
 * from its own last point back to its own first, which for a chunk would cut a chord across the
 * ring.
 */
export function toLineTraces(outline: OutlineImport, fields: LineTraceFields): EngraveLineItem[] {
  const paths = outline.paths ?? [];
  // #664 — A DOCUMENT LINE HOLDS AT MOST `MAX_LINE_POINTS`. A freehand stroke flattens to
  // thousands of points, and the schema (and the row's editor) refuse more than the cap — so a
  // long path is split into CONSECUTIVE items that share their seam vertex: the cut geometry is
  // unchanged, every item is loadable, and the file is never a refusal Makera's own importer would
  // not make. One number (`MAX_LINE_POINTS`) keeps the writer and the reader in step.
  type Point = [Mm, Mm];
  const chunksOf = (points: readonly Point[]): Point[][] => {
    const mapped = points.map(([x, y]): Point => [x, y]);
    if (mapped.length <= MAX_LINE_POINTS) return mapped.length >= 2 ? [mapped] : [];
    const chunks: Point[][] = [];
    let start = 0;
    while (start < mapped.length - 1) {
      const end = Math.min(mapped.length, start + MAX_LINE_POINTS);
      chunks.push(mapped.slice(start, end));
      start = end - 1; // the seam vertex is the last point of one item and the first of the next
    }
    return chunks;
  };
  const lines: { points: Point[]; closed: boolean }[] = [];
  for (const path of paths) {
    const points = path.points.map(([x, y]): Point => [x, y]);
    if (path.closed && points.length >= 3 && points.length <= MAX_LINE_POINTS) {
      lines.push({ points, closed: true });
      continue;
    }
    const chunks = chunksOf(points);
    if (path.closed && chunks.length > 1) {
      // A ring past the cap: open chunks, the last returning to the ring's first point.
      const first = points[0]!;
      const lastChunk = chunks[chunks.length - 1]!;
      const last = lastChunk[lastChunk.length - 1]!;
      if (last[0] !== first[0] || last[1] !== first[1]) lastChunk.push([first[0], first[1]]);
    }
    for (const chunk of chunks) lines.push({ points: chunk, closed: false });
  }
  const many = lines.length > 1;
  return lines.map(({ points, closed }, i) => ({
    kind: 'line' as const,
    id: fields.idFor(i),
    position: { x: fields.position.x, y: fields.position.y },
    rotation: fields.rotation ?? 0,
    points,
    closed,
    depth: fields.depth,
    enabled: fields.enabled ?? true,
    ...(fields.name === undefined || fields.name.trim() === ''
      ? {}
      : { name: many ? `${fields.name} — line ${i + 1}` : fields.name }),
  }));
}

export function toVectorShape(outline: OutlineImport, fields: VectorShapeFields): EngraveVectorShape {
  return {
    kind: 'vector',
    id: fields.id,
    name: fields.name,
    sourceName: outline.sourceName,
    contours: outline.contours,
    fillRule: outline.fillRule,
    width: outline.width,
    height: outline.height,
    position: { x: fields.position.x, y: fields.position.y },
    rotation: fields.rotation ?? 0,
    depth: fields.depth,
    enabled: fields.enabled ?? true,
  };
}
