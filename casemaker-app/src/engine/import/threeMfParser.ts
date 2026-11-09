import { unzipSync } from 'fflate';
import type { ParsedMesh } from './stlParser';

/**
 * #1130 — A 3MF'S TRIANGLES MAY CARRY MATERIAL ATTRIBUTES. The reader used to demand
 * `<triangle v1="…" v2="…" v3="…" />` with nothing after `v3`, so a file whose triangles name a
 * material (`pid="5" p1="0"` — what the 3MF material extension writes, and what
 * `Escutcheon.3mf` does) matched NO triangles and failed as "3MF: no triangles found in model".
 * The attribute tail is now allowed; the core geometry attributes are still read in their
 * schema order, which is how every producer writes them.
 *
 * UNITS ARE DECLARED, NOT ASSUMED. A 3MF states its scale ONCE, on `<model unit="…">` — one of
 * `micron`, `millimeter` (the default when the attribute is absent), `centimeter`, `inch`, `foot`
 * or `meter`. The numbers are converted to the app's millimetres here, ONCE, and the unit rides
 * on the result so the doors can state which reading the file got ({@link threeMfUnitSentence}).
 * Reading a centimetre model's raw numbers as millimetres would import it ten times too small.
 *
 * TRANSFORMS ARE APPLIED (#1131). A model places its geometry with a 4×3 affine on each
 * `<component>` and on each `<build><item>`: twelve numbers, `m00 m01 m02 m10 m11 m12 m20 m21 m22
 * m30 m31 m32`, row-major, applied with the point on the LEFT — x' = x·m00 + y·m10 + z·m20 + m30.
 * A build item's transform is applied after its component's, and nested component chains compose
 * the same way. The unit is the unit of ALL the model's coordinates, so a transform's translation
 * is scaled by it too. Ignoring a transform imports a rotated part at the wrong orientation and
 * cuts it that way.
 *
 * THE SCENE IS THE BUILD. Objects are resolved through their build items, and an object may be a
 * mesh or a `<components>` holder that references other objects (a holder of its own has no
 * vertices). An object the build does not place is still included at its own place: the reader has
 * always taken every mesh object in the file, and a document that forgets its build item must not
 * lose its geometry. Geometry is appended in build-item order, then unreferenced objects in
 * document order.
 */

/** The unit a 3MF model declares, and the factor its numbers are multiplied by to give mm. */
export interface ThreeMfUnit {
  /** The token the model's `unit` attribute states, lowercased, or null when it states none. */
  stated: string | null;
  /** Millimetres per file unit. Exactly 1 when the model states none (the format's default). */
  mmPerUnit: number;
}

export interface ThreeMfMesh extends ParsedMesh {
  unit: ThreeMfUnit;
}

/** The core spec's unit tokens and their millimetres. */
const UNIT_MM: Readonly<Record<string, number>> = {
  micron: 0.001,
  millimeter: 1,
  centimeter: 10,
  inch: 25.4,
  foot: 304.8,
  meter: 1000,
};

/** The words {@link threeMfUnitSentence} prints for a stated token. */
const UNIT_WORD: Readonly<Record<string, string>> = {
  micron: 'micrometres',
  millimeter: 'millimetres',
  centimeter: 'centimetres',
  inch: 'inches',
  foot: 'feet',
  meter: 'metres',
};

/** The model's declared unit, or the format's millimetre default when it declares none. */
function modelUnit(xml: string): ThreeMfUnit {
  const modelTag = /<model\b[^>]*>/.exec(xml)?.[0];
  const raw = modelTag === undefined ? undefined : /\bunit\s*=\s*"([^"]*)"/.exec(modelTag)?.[1];
  if (raw === undefined) return { stated: null, mmPerUnit: 1 };
  const stated = raw.trim().toLowerCase();
  const mmPerUnit = UNIT_MM[stated];
  if (mmPerUnit === undefined) {
    throw new Error(
      `3MF: the model's unit "${raw}" is not one of micron, millimeter, centimeter, inch, foot or meter`,
    );
  }
  return { stated, mmPerUnit };
}

/** A 4×3 affine: the twelve numbers of a 3MF transform, row-major, last row the translation. */
type Affine = readonly number[];

const IDENTITY: Affine = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

/** One transform attribute, or null when the element states none (the identity). */
function parseTransform(raw: string | undefined): Affine | null {
  if (raw === undefined) return null;
  const m = raw.trim().split(/\s+/).map(Number);
  if (m.length !== 12 || m.some((v) => !Number.isFinite(v))) {
    throw new Error(`3MF: the transform "${raw}" is not 12 finite numbers`);
  }
  return m;
}

/**
 * `a` then `b`: the 3MF point-on-the-left convention means the composed matrix is the ordinary
 * 4×4 product a·b, restricted to the affine twelve (the last column is always 0 0 0 1).
 */
function compose(a: Affine, b: Affine): Affine {
  const out = new Array<number>(12);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!;
    }
    out[9 + r] =
      a[9]! * b[r]! + a[10]! * b[3 + r]! + a[11]! * b[6 + r]! + b[9 + r]!;
  }
  return out;
}

interface ComponentRef {
  objectId: string;
  /** Null for the identity. */
  transform: Affine | null;
}

interface ThreeMfObject {
  id: string;
  /** The object's own vertices, in the model's units (not yet scaled). */
  vertices: number[];
  triangles: number[];
  components: ComponentRef[];
}

/** Every `<object>` in the document, keyed by id. */
function parseObjects(xml: string): Map<string, ThreeMfObject> {
  const objects = new Map<string, ThreeMfObject>();
  const objectRe = /<object\b([^>]*?)(?:\/>|>([\s\S]*?)<\/object>)/g;
  let objectMatch: RegExpExecArray | null;
  while ((objectMatch = objectRe.exec(xml)) !== null) {
    const attrs = objectMatch[1] ?? '';
    const id = /\bid\s*=\s*"([^"]*)"/.exec(attrs)?.[1];
    if (id === undefined) continue; // a nameless object cannot be referenced; skip it as before
    const body = objectMatch[2] ?? '';
    const vertices: number[] = [];
    const vertexRe = /<vertex\s+x="([^"]+)"\s+y="([^"]+)"\s+z="([^"]+)"\s*\/>/g;
    let vm: RegExpExecArray | null;
    while ((vm = vertexRe.exec(body)) !== null) {
      vertices.push(parseFloat(vm[1]!), parseFloat(vm[2]!), parseFloat(vm[3]!));
    }
    // #1130 — the tail after v3 is the triangle's MATERIAL reference (`pid p1 p2 p3`), not part
    // of its geometry; `[^>]*` stops at the tag's own `>`, so it cannot run into the next element.
    const triRe = /<triangle\s+v1="(\d+)"\s+v2="(\d+)"\s+v3="(\d+)"[^>]*>/g;
    let tm: RegExpExecArray | null;
    const triangles: number[] = [];
    while ((tm = triRe.exec(body)) !== null) {
      triangles.push(parseInt(tm[1]!, 10), parseInt(tm[2]!, 10), parseInt(tm[3]!, 10));
    }
    const components: ComponentRef[] = [];
    const componentRe = /<component\b([^>]*)\/?>/g;
    let cm: RegExpExecArray | null;
    while ((cm = componentRe.exec(body)) !== null) {
      const cattrs = cm[1] ?? '';
      const objectId = /\bobjectid\s*=\s*"([^"]*)"/.exec(cattrs)?.[1];
      if (objectId === undefined) continue;
      const transform = parseTransform(/\btransform\s*=\s*"([^"]*)"/.exec(cattrs)?.[1]);
      components.push({ objectId, transform });
    }
    objects.set(id, { id, vertices, triangles, components });
  }
  return objects;
}

interface BuildItem {
  objectId: string;
  /** Null for the identity. */
  transform: Affine | null;
}

/** The `<build>`'s items, in document order; empty when the document has no build. */
function parseBuildItems(xml: string): BuildItem[] {
  const buildBlock = /<build\b[^>]*>([\s\S]*?)<\/build>/.exec(xml)?.[1];
  if (buildBlock === undefined) return [];
  const items: BuildItem[] = [];
  const itemRe = /<item\b([^>]*)\/?>/g;
  let im: RegExpExecArray | null;
  while ((im = itemRe.exec(buildBlock)) !== null) {
    const attrs = im[1] ?? '';
    const objectId = /\bobjectid\s*=\s*"([^"]*)"/.exec(attrs)?.[1];
    if (objectId === undefined) continue;
    const transform = parseTransform(/\btransform\s*=\s*"([^"]*)"/.exec(attrs)?.[1]);
    items.push({ objectId, transform });
  }
  return items;
}

export function parse3MF(buf: ArrayBuffer): ThreeMfMesh {
  const zip = unzipSync(new Uint8Array(buf));
  const modelEntry = zip['3D/3dmodel.model'] ?? zip['3d/3dmodel.model'];
  if (!modelEntry) throw new Error('3MF: missing 3D/3dmodel.model entry');
  const xml = new TextDecoder('utf-8').decode(modelEntry);
  const unit = modelUnit(xml);
  const objects = parseObjects(xml);

  const positions: number[] = [];
  const indices: number[] = [];
  /** The objects a build item (directly or through components) placed. */
  const placed = new Set<string>();

  /**
   * Append one object's geometry, transformed by `transform` (the accumulated item/parent chain)
   * and converted to millimetres. Components recurse with their own transform applied first.
   */
  function appendObject(id: string, transform: Affine, path: ReadonlySet<string>): void {
    if (path.has(id)) {
      throw new Error(`3MF: the model's components form a cycle at object "${id}"`);
    }
    const object = objects.get(id);
    if (object === undefined) {
      throw new Error(`3MF: the model references object "${id}", which it does not define`);
    }
    placed.add(id);
    if (object.components.length > 0) {
      const next = new Set(path);
      next.add(id);
      for (const component of object.components) {
        // The component's transform applies first, then the item/parent transform.
        const combined = compose(component.transform ?? IDENTITY, transform);
        appendObject(component.objectId, combined, next);
      }
    }
    if (object.vertices.length === 0 || object.triangles.length === 0) return;
    const vertexBase = positions.length / 3;
    // #720 — APPEND, do not spread: a real model's vertex/triangle arrays run to hundreds of
    // thousands of entries, and `push(...array)` overflows the call stack at that size (observed on
    // a 318k-triangle terrain: "Maximum call stack size exceeded").
    for (let i = 0; i < object.vertices.length; i += 3) {
      const x = object.vertices[i]!;
      const y = object.vertices[i + 1]!;
      const z = object.vertices[i + 2]!;
      // Apply the affine in the model's own units, then convert once: the unit governs the
      // transform's translation too, so this is the spec's reading for a non-mm model.
      positions.push(
        (x * transform[0]! + y * transform[3]! + z * transform[6]! + transform[9]!) * unit.mmPerUnit,
        (x * transform[1]! + y * transform[4]! + z * transform[7]! + transform[10]!) * unit.mmPerUnit,
        (x * transform[2]! + y * transform[5]! + z * transform[8]! + transform[11]!) * unit.mmPerUnit,
      );
    }
    for (const index of object.triangles) indices.push(vertexBase + index);
  }

  const buildItems = parseBuildItems(xml);
  for (const item of buildItems) {
    appendObject(item.objectId, item.transform ?? IDENTITY, new Set());
  }
  // The reader has always taken every mesh object, including one the build does not place; keep
  // that, at the object's own place, so a document that forgets its build item loses nothing.
  for (const object of objects.values()) {
    if (
      !placed.has(object.id) &&
      object.vertices.length > 0 &&
      object.triangles.length > 0
    ) {
      appendObject(object.id, IDENTITY, new Set());
    }
  }

  if (indices.length === 0) throw new Error('3MF: no triangles found in model');

  const positionsTyped = new Float32Array(positions);
  const indicesTyped = new Uint32Array(indices);
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity,
    maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  const vertCount = positionsTyped.length / 3;
  for (let i = 0; i < vertCount; i++) {
    const x = positionsTyped[i * 3]!;
    const y = positionsTyped[i * 3 + 1]!;
    const z = positionsTyped[i * 3 + 2]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return {
    positions: positionsTyped,
    indices: indicesTyped,
    triangleCount: indicesTyped.length / 3,
    bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
    unit,
  };
}

/**
 * What the file's numbers were read as, in ONE sentence for the person who picked it — the same
 * job {@link objUnitSentence} does for an OBJ. Exported beside the parser so the goal door and any
 * other 3MF door cannot word the same fact twice.
 */
export function threeMfUnitSentence(name: string, unit: ThreeMfUnit): string {
  if (unit.stated === null) {
    return `${name} states no unit; a 3MF without one is read as millimetres (the format's default).`;
  }
  const word = UNIT_WORD[unit.stated] ?? unit.stated;
  return `${name} states its unit as “${unit.stated}”; its numbers are read as ${word} (${unit.mmPerUnit} mm per unit).`;
}
