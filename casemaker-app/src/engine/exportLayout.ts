import type { MeshNode, NodeMaterial } from '@/types';
import { PRINT_FLIP_NODE_IDS, printMetaForId } from '@/engine/exporters/parts';

export type ExportLayoutMode = 'print-ready' | 'assembled';

/**
 * Parts that must be turned over to print cleanly.
 *
 * Issue #154 — this is no longer a hand-kept list. It is re-exported from the
 * single id-keyed print table in `@/engine/exporters/parts`, so the flip the
 * exporter bakes into the buffer and the `flipForPrint` the UI reports come
 * from the same entry. They used to disagree: every `rack-*` id except
 * `rack-bottom` was reported un-flipped while the exporter flipped the fused
 * frames. The rationale for each entry (lid ceiling-down; rack counterbores
 * up; fused frames inverted off their four stacking feet) lives with the table.
 *
 * Issue #358 — the same table's `rotation` is applied here too, so the whole
 * declared orientation of a part now reaches the bed: `computePartTransforms`
 * reads it per node. Before this, `rotation` was declared, surfaced by the UI
 * and the notes, and read by nothing, so the only orientation a part could get
 * was the flip — and a rack side panel, whose note says "Lay FLAT", exported
 * standing on its edge.
 */
export { PRINT_FLIP_NODE_IDS };

export interface PartTransform {
  /**
   * Euler degrees applied FIRST — the print table's declared `rotation`, in the
   * global X-then-Y-then-Z order the compiler's `rotate` op uses (the order
   * `Manifold.rotate` documents). `[0, 0, 0]` means "prints as modelled".
   *
   * Issue #358 — this field is why any part ever came out on its edge: the
   * table declared a rotation, `printMetaForId` reported it, and nothing
   * applied it, so the only orientation a part could get was `flipAxis`.
   */
  rotation: [number, number, number];
  /** rotate by 180° about this local axis AFTER `rotation`; null = no flip */
  flipAxis: 'x' | 'y' | null;
  translate: [number, number, number];
}

/** Row-major 3×3. */
type Mat3 = [number, number, number, number, number, number, number, number, number];

/** Snap a cosine/sine to exactly 0 or ±1 for the right angles — `Math.cos(Math.PI / 2)` is
 *  6.1e-17, and 6e-17 mm of skew on a 250 mm panel is noise a bbox check should not eat. */
function snap(v: number): number {
  if (Math.abs(v) < 1e-12) return 0;
  if (Math.abs(Math.abs(v) - 1) < 1e-12) return Math.sign(v);
  return v;
}

/** Euler degrees → a rotation matrix, global frame: about X, then Y, then Z (R = Rz·Ry·Rx). */
function eulerMat3(deg: readonly [number, number, number]): Mat3 {
  const cx = snap(Math.cos((deg[0] * Math.PI) / 180));
  const sx = snap(Math.sin((deg[0] * Math.PI) / 180));
  const cy = snap(Math.cos((deg[1] * Math.PI) / 180));
  const sy = snap(Math.sin((deg[1] * Math.PI) / 180));
  const cz = snap(Math.cos((deg[2] * Math.PI) / 180));
  const sz = snap(Math.sin((deg[2] * Math.PI) / 180));
  return [
    cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx,
    sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx,
    -sy, cy * sx, cy * cx,
  ];
}

const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** A transform's linear part: the declared rotation, then the flip. */
function linearPart(t: Pick<PartTransform, 'rotation' | 'flipAxis'>): Mat3 {
  const m = t.rotation[0] === 0 && t.rotation[1] === 0 && t.rotation[2] === 0
    ? IDENTITY
    : eulerMat3(t.rotation);
  if (t.flipAxis === 'x') return [m[0], m[1], m[2], -m[3], -m[4], -m[5], -m[6], -m[7], -m[8]];
  if (t.flipAxis === 'y') return [-m[0], -m[1], -m[2], m[3], m[4], m[5], -m[6], -m[7], -m[8]];
  return m;
}

export interface LayoutOptions {
  gap: number;
  bedWidth: number;
  /** Nodes whose assembly orientation is upside-down for printing. */
  flipNodeIds?: ReadonlyArray<string>;
}

const DEFAULTS: Required<LayoutOptions> = {
  gap: 5,
  bedWidth: 220,
  flipNodeIds: PRINT_FLIP_NODE_IDS,
};

interface NodeBBox {
  id: string;
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

function bboxOf(positions: Float32Array): Omit<NodeBBox, 'id'> {
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity,
    maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!;
    const y = positions[i + 1]!;
    const z = positions[i + 2]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

/** Map a point through a transform's linear part. Allocates — for the bbox corners only. */
function transformPoint(
  m: Mat3,
  x: number,
  y: number,
  z: number,
): [number, number, number] {
  return [
    m[0] * x + m[1] * y + m[2] * z,
    m[3] * x + m[4] * y + m[5] * z,
    m[6] * x + m[7] * y + m[8] * z,
  ];
}

/**
 * Compute, for each node, the transform that should be baked into its position
 * buffer to lay parts out flat on the bed and side-by-side along +X.
 *
 * Orientation comes from the print table (`printMetaForId`), the same id-keyed
 * entries the UI's hint, the notes sidecar and `PRINT_FLIP_NODE_IDS` read:
 *
 *  - the declared `rotation` is applied first — issue #358, and the reason a
 *    rack side panel used to export standing on its edge;
 *  - nodes listed in `opts.flipNodeIds` are then turned over 180° about X, the
 *    lid-style flip.
 *
 * The packing footprint is the bbox AFTER both, because that is the footprint
 * the part actually occupies on the bed.
 */
export function computePartTransforms(
  nodes: ReadonlyArray<MeshNode>,
  opts: Partial<LayoutOptions> = {},
): Map<string, PartTransform> {
  const cfg = { ...DEFAULTS, ...opts };
  const flipSet = new Set(cfg.flipNodeIds);
  const out = new Map<string, PartTransform>();

  // Compute post-orientation bboxes (effective footprint for layout).
  const items: { id: string; transform: PartTransform; postBBox: NodeBBox }[] = [];
  for (const n of nodes) {
    const raw = bboxOf(n.buffer.positions);
    const rotation = printMetaForId(n.id).rotation;
    const flipAxis: 'x' | 'y' | null = flipSet.has(n.id) ? 'x' : null;
    const m = linearPart({ rotation, flipAxis });
    // An affine map sends a box's CORNERS to the extremes of its image, so boxing the eight
    // transformed corners is exact — not a conservative over-cover.
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const x of [raw.minX, raw.maxX]) {
      for (const y of [raw.minY, raw.maxY]) {
        for (const z of [raw.minZ, raw.maxZ]) {
          const [px, py, pz] = transformPoint(m, x, y, z);
          if (px < minX) minX = px;
          if (py < minY) minY = py;
          if (pz < minZ) minZ = pz;
          if (px > maxX) maxX = px;
          if (py > maxY) maxY = py;
          if (pz > maxZ) maxZ = pz;
        }
      }
    }
    items.push({
      id: n.id,
      transform: { rotation, flipAxis, translate: [0, 0, 0] },
      postBBox: { id: n.id, minX, minY, minZ, maxX, maxY, maxZ },
    });
  }

  // Pack along +X with one-row-then-wrap behavior.
  let cursorX = 0;
  let rowMaxY = 0;
  let rowOriginY = 0;
  for (const item of items) {
    const w = item.postBBox.maxX - item.postBBox.minX;
    const d = item.postBBox.maxY - item.postBBox.minY;
    if (cursorX > 0 && cursorX + w > cfg.bedWidth) {
      // Wrap to next row.
      rowOriginY += rowMaxY + cfg.gap;
      cursorX = 0;
      rowMaxY = 0;
    }
    // Translate so:
    //   bbox.min.x lands at cursorX
    //   bbox.min.y lands at rowOriginY
    //   bbox.min.z lands at 0
    const tx = cursorX - item.postBBox.minX;
    const ty = rowOriginY - item.postBBox.minY;
    const tz = -item.postBBox.minZ;
    out.set(item.id, { ...item.transform, translate: [tx, ty, tz] });
    cursorX += w + cfg.gap;
    if (d > rowMaxY) rowMaxY = d;
  }
  return out;
}

/**
 * Apply a transform to a position buffer. Returns a fresh Float32Array
 * (does not mutate the input). Indices are unchanged.
 *
 * The order is the print table's own: the declared `rotation` first, then the
 * flip, then the layout translate.
 */
export function applyPartTransform(
  positions: Float32Array,
  transform: PartTransform,
): Float32Array {
  const out = new Float32Array(positions.length);
  const [tx, ty, tz] = transform.translate;
  const m = linearPart(transform);
  const [m0, m1, m2, m3, m4, m5, m6, m7, m8] = m;
  // The maths is inlined per vertex rather than routed through `transformPoint`: this runs over
  // every vertex of the largest exports (the fused racks), and a three-element array per vertex
  // is pure garbage there.
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!;
    const y = positions[i + 1]!;
    const z = positions[i + 2]!;
    out[i] = m0 * x + m1 * y + m2 * z + tx;
    out[i + 1] = m3 * x + m4 * y + m5 * z + ty;
    out[i + 2] = m6 * x + m7 * y + m8 * z + tz;
  }
  // #357 — every transform this module builds is a ROTATION: the Euler rotation has determinant
  // +1, and each flip branch negates two matrix rows, which also leaves the determinant at +1.
  // Only a mirror (an odd number of negated axes) inverts triangle winding; none of these do. So
  // the indices are correct as they are, and it is `applyLayoutToMeshes`' old unconditional
  // reversal that wrote every pre-flipped part inside-out. `exportLayout.spec.ts` measures the
  // signed volume, so the day someone adds a mirror the sign goes negative and the suite says so.
  return out;
}

export interface LaidOutMesh {
  id: string;
  positions: Float32Array;
  indices: Uint32Array;
  /** Issue #168 — carried through untouched: laying a part out flat does not
   *  change which tool prints it. */
  material?: NodeMaterial;
}

export function applyLayoutToMeshes(
  nodes: ReadonlyArray<MeshNode>,
  opts: Partial<LayoutOptions> = {},
): LaidOutMesh[] {
  const transforms = computePartTransforms(nodes, opts);
  return nodes.map((n) => {
    const t = transforms.get(n.id);
    if (!t) {
      return {
        id: n.id,
        positions: n.buffer.positions,
        indices: n.buffer.indices,
        material: n.material,
      };
    }
    const positions = applyPartTransform(n.buffer.positions, t);
    // #357 — the indices are carried through untouched. The flip negates Y and Z, a half turn
    // about X, so the triangle order still faces outward (see `applyPartTransform`). Reversing it
    // here wrote the part inside-out: a Manifold difference() then unions a negative volume.
    return { id: n.id, positions, indices: n.buffer.indices, material: n.material };
  });
}
