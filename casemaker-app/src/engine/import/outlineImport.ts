import { openTextFile } from '@/utils/openTextFile';
import type { Mm } from '@/types';
import type { EngraveVectorShape } from '@/types/engraveJob';
import { parseSvgOutline } from './svgOutline';
import { parseDxfOutline } from './dxfOutline';
import type { OutlineImport, OutlineParseResult } from './outlineTypes';

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
export { MAX_OUTLINE_FILE_BYTES, MAX_OUTLINE_CONTOURS, MAX_OUTLINE_POINTS, scaleOutlineToWidth } from './outlineTypes';
export { parseSvgOutline } from './svgOutline';
export { parseDxfOutline } from './dxfOutline';

/** Dispatch by extension: `.svg` and `.dxf` only. The name is stamped onto the result. */
export function parseOutlineFile(text: string, fileName: string): OutlineParseResult {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  if (ext === 'svg') return parseSvgOutline(text, fileName);
  if (ext === 'dxf') return parseDxfOutline(text, fileName);
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
  return parseOutlineFile(file.text, file.name);
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
