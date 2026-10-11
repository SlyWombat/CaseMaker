import type { MeshNode, NodeMaterial } from '@/types';
import { PRINT_FLIP_NODE_IDS } from '@/engine/exporters/parts';

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
 */
export { PRINT_FLIP_NODE_IDS };

export interface PartTransform {
  /** rotate by 180° about this local axis before translating; null = no rotation */
  flipAxis: 'x' | 'y' | null;
  translate: [number, number, number];
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

/**
 * Compute, for each node, the transform that should be baked into its position
 * buffer to lay parts out flat on the bed and side-by-side along +X.
 *
 * Lid-style nodes (anything in opts.flipNodeIds) are flipped 180° about X so
 * their flat top surface ends up on the bed.
 */
export function computePartTransforms(
  nodes: ReadonlyArray<MeshNode>,
  opts: Partial<LayoutOptions> = {},
): Map<string, PartTransform> {
  const cfg = { ...DEFAULTS, ...opts };
  const flipSet = new Set(cfg.flipNodeIds);
  const out = new Map<string, PartTransform>();

  // Compute post-flip bboxes (effective footprint for layout).
  const items: { id: string; flipAxis: 'x' | null; postFlipBBox: NodeBBox }[] = [];
  for (const n of nodes) {
    const raw = bboxOf(n.buffer.positions);
    const flipAxis: 'x' | null = flipSet.has(n.id) ? 'x' : null;
    let postFlip: Omit<NodeBBox, 'id'>;
    if (flipAxis === 'x') {
      // Rotate 180° about X about the node's bbox-X-center: y -> -y, z -> -z.
      // After flipping, the node's Y range is mirrored and Z range is mirrored.
      postFlip = {
        minX: raw.minX,
        maxX: raw.maxX,
        minY: -raw.maxY,
        maxY: -raw.minY,
        minZ: -raw.maxZ,
        maxZ: -raw.minZ,
      };
    } else {
      postFlip = raw;
    }
    items.push({ id: n.id, flipAxis, postFlipBBox: { id: n.id, ...postFlip } });
  }

  // Pack along +X with one-row-then-wrap behavior.
  let cursorX = 0;
  let rowMaxY = 0;
  let rowOriginY = 0;
  for (const item of items) {
    const w = item.postFlipBBox.maxX - item.postFlipBBox.minX;
    const d = item.postFlipBBox.maxY - item.postFlipBBox.minY;
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
    const tx = cursorX - item.postFlipBBox.minX;
    const ty = rowOriginY - item.postFlipBBox.minY;
    const tz = -item.postFlipBBox.minZ;
    out.set(item.id, { flipAxis: item.flipAxis, translate: [tx, ty, tz] });
    cursorX += w + cfg.gap;
    if (d > rowMaxY) rowMaxY = d;
  }
  return out;
}

/**
 * Apply a transform to a position buffer. Returns a fresh Float32Array
 * (does not mutate the input). Indices are unchanged.
 */
export function applyPartTransform(
  positions: Float32Array,
  transform: PartTransform,
): Float32Array {
  const out = new Float32Array(positions.length);
  const [tx, ty, tz] = transform.translate;
  if (transform.flipAxis === 'x') {
    for (let i = 0; i < positions.length; i += 3) {
      out[i] = positions[i]! + tx;
      out[i + 1] = -positions[i + 1]! + ty;
      out[i + 2] = -positions[i + 2]! + tz;
    }
  } else if (transform.flipAxis === 'y') {
    for (let i = 0; i < positions.length; i += 3) {
      out[i] = -positions[i]! + tx;
      out[i + 1] = positions[i + 1]! + ty;
      out[i + 2] = -positions[i + 2]! + tz;
    }
  } else {
    for (let i = 0; i < positions.length; i += 3) {
      out[i] = positions[i]! + tx;
      out[i + 1] = positions[i + 1]! + ty;
      out[i + 2] = positions[i + 2]! + tz;
    }
  }
  // #357 — every branch above negates exactly TWO axes, which is a half turn about the third: a
  // rotation, determinant +1. Only a transform with a NEGATIVE determinant (a mirror — an odd
  // number of negated axes) inverts triangle winding; this one does not. So the indices are
  // correct as they are, and it is `applyLayoutToMeshes`' old unconditional reversal that wrote
  // every pre-flipped part inside-out. `exportLayout.spec.ts` measures the signed volume, so the
  // day someone adds a mirror flip axis the sign goes negative and the suite says so.
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
