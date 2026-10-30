/**
 * The reference object a job's 3D primitives are positioned against (#435).
 *
 * The file is read ONCE at import: it is parsed for its bounding size and returned as base64. The
 * SHA-256 is the object's identity and the mesh cache key; re-importing the same bytes therefore
 * decodes once.
 *
 * #720 — NO SIZE CAP. The bytes do not ride in the persisted job any more: the store keeps them in
 * an IndexedDB blob keyed by the SHA-256 and the localStorage copy carries only the hash, the size
 * and the name (the .cutjob file still embeds them, so a saved document stays self-contained). A
 * 12 MB model is an ordinary goal now; nothing is decimated, because the heightfield is sampled at
 * the job's grid pitch whatever the mesh's triangle count.
 *
 * Pure parsing lives in `stlParser.ts` / `threeMfParser.ts`; the STEP kernel (#774) is a lazy
 * import of `stepMesh.ts`. Only `readTargetObjectFile` touches the browser's `File` and
 * `crypto.subtle`, and it never throws — every failure is a sentence the person who picked the
 * file is told.
 */

import type { EngraveTargetObject } from '@/types/engraveJob';
import { arrayBufferToBase64 } from './base64';
import { parseStl, type ParsedMesh } from './stlParser';
import { parse3MF } from './threeMfParser';
import { decodePng } from './png';
import { DEFAULT_RELIEF_DEPTH_MM } from '@/engine/cnc/cam/relief';

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

/**
 * The file's SOURCE kind. `step` is not a stored format: a STEP is tessellated at the door
 * (#774) and stored as the binary STL `formatOf` maps everything mesh-shaped to, so the rest of
 * the app keeps reading one mesh format.
 */
type SourceFormat = TargetObjectFormat | 'step';

function formatOf(name: string): SourceFormat | null {
  const lower = name.toLowerCase();
  if (lower.endsWith('.stl')) return 'stl';
  if (lower.endsWith('.3mf')) return '3mf';
  // #774 — a STEP/STP is a B-rep; the CAD kernel turns it into a mesh before anything else sees it.
  if (lower.endsWith('.step') || lower.endsWith('.stp')) return 'step';
  // #672 — a picture is a goal: its luminance is the heightfield the goal pipeline surfaces.
  if (lower.endsWith('.png')) return 'png';
  return null;
}

/**
 * #672 — a picture carries no physical size, so the import FITS it onto the blank: the natural
 * size is the pixel count at the SVG fallback (25.4/96 mm per pixel, the same assumption the trace
 * dialog states), scaled to fit `fit` with the aspect kept. The row's width field rescales it
 * later; the relief depth is the labelled CAM default until the operator states one.
 */
export interface ImageFit {
  maxWidth: number;
  maxHeight: number;
}

const NATURAL_MM_PER_PX = 25.4 / 96;

/**
 * Read a picked `.stl` / `.3mf` / `.step` as a reference object. `id` is supplied by the caller
 * (the store's `newTargetObjectId`), so this module stays free of the store and the id convention
 * lives in one place.
 */
export async function readTargetObjectFile(
  file: File,
  id: string,
  opts: { fit?: ImageFit } = {},
): Promise<TargetObjectRead> {
  const format = formatOf(file.name);
  if (format === null) {
    return { ok: false, error: `${file.name} is not an STL, 3MF, STEP or PNG file.` };
  }
  if (file.size === 0) return { ok: false, error: `${file.name} is empty.` };

  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch {
    return { ok: false, error: `${file.name} could not be read.` };
  }

  if (format === 'png') {
    // #672 — the relief's picture: validated by the same decoder the worker samples with, so a
    // 16-bit or interlaced file is refused HERE with its sentence rather than at Generate.
    const decoded = decodePng(new Uint8Array(bytes));
    if (!decoded.ok) {
      return { ok: false, error: `${file.name} cannot be a relief: ${decoded.error}.` };
    }
    const { width, height } = decoded.image;
    const natural = { x: width * NATURAL_MM_PER_PX, y: height * NATURAL_MM_PER_PX };
    const scale =
      opts.fit === undefined ? 1 : Math.min(opts.fit.maxWidth / natural.x, opts.fit.maxHeight / natural.y);
    let sha256: string;
    try {
      const { sha256Hex } = await import('./meshStock');
      sha256 = await sha256Hex(bytes);
    } catch {
      return { ok: false, error: `${file.name} could not be hashed.` };
    }
    return {
      ok: true,
      id,
      name: file.name,
      format: 'png',
      sha256,
      data: arrayBufferToBase64(bytes),
      size: { x: natural.x * scale, y: natural.y * scale, z: DEFAULT_RELIEF_DEPTH_MM },
    };
  }

  // #774 — a STEP is converted ONCE, here: the kernel tessellates the B-rep and the job stores
  // the binary STL, so the id/hash/embed contract below is the one every mesh already has. The
  // file's own name is kept, so the row still says which file was picked.
  let stored: ArrayBuffer = bytes;
  let mesh: ParsedMesh;
  try {
    if (format === 'step') {
      const { stepToStl } = await import('./stepMesh');
      const converted = await stepToStl(bytes);
      stored = converted.stl;
      mesh = converted.mesh;
    } else {
      mesh = format === '3mf' ? parse3MF(bytes) : parseStl(bytes);
    }
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: format === 'step' ? `${file.name} could not be read as STEP: ${why}` : `${file.name} could not be parsed: ${why}`,
    };
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
    sha256 = await sha256Hex(stored);
  } catch {
    return { ok: false, error: `${file.name} could not be hashed.` };
  }

  return {
    ok: true,
    id,
    name: file.name,
    // A STEP was converted to the mesh above; what is EMBEDDED — and what the hash identifies — is
    // that mesh's binary STL, so the document says so.
    format: format === 'step' ? 'stl' : format,
    sha256,
    data: arrayBufferToBase64(stored),
    size,
  };
}

/**
 * #685 — the whole TARGET OBJECT a picked goal file makes: the reader above, then the placement
 * every goal import uses (centred in X/Y with its top flush on the stock's top face), marked as
 * the shape to MAKE.
 *
 * The wizard's Surface a mesh pick asks for this file, and a wizard portal cannot own the panel's
 * file input, so the step reads the file the same way the panel's goal door does. The panel keeps
 * its own copy for now (#685 leaves the panel swap to the picker alone).
 */
export async function readGoalObjectFile(
  file: File,
  id: string,
  stock: { length: number; width: number },
): Promise<{ ok: true; target: EngraveTargetObject } | { ok: false; error: string }> {
  // A PICTURE has no physical size: fit it onto the blank, aspect kept — the same door as the
  // panel's goal import (#672).
  const isPng = /\.png$/i.test(file.name);
  const result = await readTargetObjectFile(
    file,
    id,
    isPng
      ? { fit: { maxWidth: Math.max(1, stock.length - 4), maxHeight: Math.max(1, stock.width - 4) } }
      : {},
  );
  if (!result.ok) return result;
  return {
    ok: true,
    target: {
      id: result.id,
      name: result.name,
      format: result.format,
      sha256: result.sha256,
      data: result.data,
      size: result.size,
      position: { x: stock.length / 2, y: stock.width / 2, z: 0 },
      rotation: 0,
      enabled: true,
      role: 'goal',
    },
  };
}

const meshCache = new Map<string, ParsedMesh>();

/**
 * The parsed mesh for an embedded target object, cached by its SHA-256. A decode failure is a
 * malformed document rather than a user error; the viewport treats it as "draw nothing".
 */
export function targetObjectMesh(target: Pick<EngraveTargetObject, 'sha256' | 'format'> & { data?: string }): ParsedMesh {
  // #672 — a picture has no mesh: its heights are sampled from the pixels (surface3d's image
  // branch). The viewport's draw catches this and draws nothing, which is the honest picture of a
  // relief that has not been cut yet.
  if (target.format === 'png') {
    throw new Error('a picture relief has no mesh to draw — its heights come from the pixels');
  }
  const cached = meshCache.get(target.sha256);
  if (cached) return cached;
  // #720 — the bytes may be missing (the blob store lost them, or they have not been re-attached
  // yet): the call sites draw nothing, and Generate refuses with the sentence that says so.
  if (target.data === undefined) throw new Error('the mesh bytes are not loaded');
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
