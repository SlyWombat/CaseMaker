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
 * THE MESH IS A SOUP OF EVERY OBJECT WITH GEOMETRY. A model may split an assembly across several
 * `<object>`s and reference them from a `<components>` object, and the build item then points at
 * the holder (`Escutcheon.3mf`: object 3 is the mesh, object 4 references it, the build item
 * references 4). Components hold no vertices of their own, so they are skipped and each mesh
 * object's triangles are concatenated in document order — which is the same reading a plain
 * multi-object export already got.
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

export function parse3MF(buf: ArrayBuffer): ThreeMfMesh {
  const zip = unzipSync(new Uint8Array(buf));
  const modelEntry = zip['3D/3dmodel.model'] ?? zip['3d/3dmodel.model'];
  if (!modelEntry) throw new Error('3MF: missing 3D/3dmodel.model entry');
  const xml = new TextDecoder('utf-8').decode(modelEntry);
  const unit = modelUnit(xml);

  const positions: number[] = [];
  const indices: number[] = [];

  let vertexBase = 0;
  const objectRe = /<object\b[^>]*>[\s\S]*?<\/object>/g;
  let objectMatch: RegExpExecArray | null;
  while ((objectMatch = objectRe.exec(xml)) !== null) {
    const objBlock = objectMatch[0];
    const localVerts: number[] = [];
    const vertexRe = /<vertex\s+x="([^"]+)"\s+y="([^"]+)"\s+z="([^"]+)"\s*\/>/g;
    let vm: RegExpExecArray | null;
    while ((vm = vertexRe.exec(objBlock)) !== null) {
      // The model's unit is applied HERE, once: everything downstream (bbox, heightfield, the
      // viewport) reads millimetres, and no caller has to remember the conversion.
      localVerts.push(
        parseFloat(vm[1]!) * unit.mmPerUnit,
        parseFloat(vm[2]!) * unit.mmPerUnit,
        parseFloat(vm[3]!) * unit.mmPerUnit,
      );
    }
    // #1130 — the tail after v3 is the triangle's MATERIAL reference (`pid p1 p2 p3`), not part
    // of its geometry; `[^>]*` stops at the tag's own `>`, so it cannot run into the next element.
    const triRe = /<triangle\s+v1="(\d+)"\s+v2="(\d+)"\s+v3="(\d+)"[^>]*>/g;
    let tm: RegExpExecArray | null;
    const objectTris: number[] = [];
    while ((tm = triRe.exec(objBlock)) !== null) {
      objectTris.push(
        vertexBase + parseInt(tm[1]!, 10),
        vertexBase + parseInt(tm[2]!, 10),
        vertexBase + parseInt(tm[3]!, 10),
      );
    }
    if (localVerts.length === 0 || objectTris.length === 0) continue;
    // #720 — APPEND, do not spread: a real model's vertex/triangle arrays run to hundreds of
    // thousands of entries, and `push(...array)` overflows the call stack at that size (observed on
    // a 318k-triangle terrain: "Maximum call stack size exceeded"). The cap this slice removes was
    // hiding the ceiling; a 12 MB model reaches it immediately.
    for (const value of localVerts) positions.push(value);
    for (const value of objectTris) indices.push(value);
    vertexBase += localVerts.length / 3;
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
