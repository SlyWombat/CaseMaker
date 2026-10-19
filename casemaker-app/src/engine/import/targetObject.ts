/**
 * The reference object a job's 3D primitives are positioned against (#435).
 *
 * The file is read ONCE at import: it is parsed for its bounding size and embedded as base64, so
 * the job remains self-contained (the #425 embedded-source rule). The SHA-256 is the object's
 * identity and the mesh cache key; re-importing the same bytes therefore decodes once.
 *
 * Pure parsing lives in `stlParser.ts` / `threeMfParser.ts`; only `readTargetObjectFile` touches
 * the browser's `File` and `crypto.subtle`, and it never throws — every failure is a sentence the
 * person who picked the file is told.
 */

import type { EngraveTargetObject } from '@/types/engraveJob';
import { arrayBufferToBase64 } from './base64';
import { parseStl, type ParsedMesh } from './stlParser';
import { parse3MF } from './threeMfParser';

/** The same 4 MiB cap the #425 embedded source files use. */
export const MAX_TARGET_OBJECT_BYTES = 4 * 1024 * 1024;

export type TargetObjectFormat = EngraveTargetObject['format'];

export type TargetObjectRead =
  | {
      ok: true;
      id: string;
      name: string;
      format: TargetObjectFormat;
      sha256: string;
      data: string;
      size: { x: number; y: number; z: number };
    }
  | { ok: false; error: string };

function formatOf(name: string): TargetObjectFormat | null {
  const lower = name.toLowerCase();
  if (lower.endsWith('.stl')) return 'stl';
  if (lower.endsWith('.3mf')) return '3mf';
  return null;
}

/**
 * Read a picked `.stl` / `.3mf` as a reference object. `id` is supplied by the caller (the store's
 * `newTargetObjectId`), so this module stays free of the store and the id convention lives in one
 * place.
 */
export async function readTargetObjectFile(file: File, id: string): Promise<TargetObjectRead> {
  const format = formatOf(file.name);
  if (format === null) {
    return { ok: false, error: `${file.name} is not an STL or 3MF file.` };
  }
  if (file.size > MAX_TARGET_OBJECT_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(1);
    return {
      ok: false,
      error: `${file.name} is ${mb} MB — larger than the ${MAX_TARGET_OBJECT_BYTES / (1024 * 1024)} MB limit for a target object.`,
    };
  }
  if (file.size === 0) return { ok: false, error: `${file.name} is empty.` };

  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch {
    return { ok: false, error: `${file.name} could not be read.` };
  }

  let mesh: ParsedMesh;
  try {
    mesh = format === '3mf' ? parse3MF(bytes) : parseStl(bytes);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `${file.name} could not be parsed: ${why}` };
  }
  if (mesh.triangleCount === 0 || mesh.indices.length === 0) {
    return { ok: false, error: `${file.name} holds no triangles, so it has no shape to show.` };
  }

  const size = {
    x: mesh.bbox.max[0] - mesh.bbox.min[0],
    y: mesh.bbox.max[1] - mesh.bbox.min[1],
    z: mesh.bbox.max[2] - mesh.bbox.min[2],
  };
  if (!(size.x > 0 && size.y > 0 && size.z > 0)) {
    return { ok: false, error: `${file.name} is flat in at least one direction; a target object needs volume.` };
  }

  let sha256: string;
  try {
    // Lazy import so the headless graph (surface3d → targetObjectMesh, #534) never STATICALLY pulls
    // in meshStock → designImport → platform/features, which is browser-only (__FEATURE_SIM__,
    // window). This reader runs only in the browser file picker, where that chain is fine.
    const { sha256Hex } = await import('./meshStock');
    sha256 = await sha256Hex(bytes);
  } catch {
    return { ok: false, error: `${file.name} could not be hashed.` };
  }

  return {
    ok: true,
    id,
    name: file.name,
    format,
    sha256,
    data: arrayBufferToBase64(bytes),
    size,
  };
}

const meshCache = new Map<string, ParsedMesh>();

/**
 * The parsed mesh for an embedded target object, cached by its SHA-256. A decode failure is a
 * malformed document rather than a user error; the viewport treats it as "draw nothing".
 */
export function targetObjectMesh(target: Pick<EngraveTargetObject, 'sha256' | 'format' | 'data'>): ParsedMesh {
  const cached = meshCache.get(target.sha256);
  if (cached) return cached;
  const bytes = ((): ArrayBuffer => {
    const binary = atob(target.data);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out.buffer;
  })();
  const parsed = target.format === '3mf' ? parse3MF(bytes) : parseStl(bytes);
  meshCache.set(target.sha256, parsed);
  return parsed;
}

/** Test hook: an embedded file replaced under the same hash must not serve a stale mesh. */
export function clearTargetObjectMeshCache(): void {
  meshCache.clear();
}
