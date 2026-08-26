import { aabbOfOp, type BuildOp, type BuildPlan } from './buildPlan';

interface BBox {
  min: [number, number, number];
  max: [number, number, number];
}

/**
 * Compute the world-space bounding box of a BuildOp tree analytically. This is
 * conservative: rotations/extrusions are captured via a coarse over-estimation.
 * Used only by the JS-side connectivity walk to detect obvious disjoint
 * additive volumes; the authoritative count comes from Manifold's decompose()
 * after the boolean ops finish (see ManifoldRuntime.ts).
 */
export function bboxOfOp(op: BuildOp): BBox | null {
  switch (op.kind) {
    case 'cube':
      return {
        min: op.center
          ? [-op.size[0] / 2, -op.size[1] / 2, -op.size[2] / 2]
          : [0, 0, 0],
        max: op.center
          ? [op.size[0] / 2, op.size[1] / 2, op.size[2] / 2]
          : [op.size[0], op.size[1], op.size[2]],
      };
    case 'cylinder': {
      const r = Math.max(op.radiusLow, op.radiusHigh ?? op.radiusLow);
      return {
        min: op.center ? [-r, -r, -op.height / 2] : [-r, -r, 0],
        max: op.center ? [r, r, op.height / 2] : [r, r, op.height],
      };
    }
    case 'translate': {
      const inner = bboxOfOp(op.child);
      if (!inner) return null;
      return {
        min: [
          inner.min[0] + op.offset[0],
          inner.min[1] + op.offset[1],
          inner.min[2] + op.offset[2],
        ],
        max: [
          inner.max[0] + op.offset[0],
          inner.max[1] + op.offset[1],
          inner.max[2] + op.offset[2],
        ],
      };
    }
    case 'rotate': {
      const inner = bboxOfOp(op.child);
      if (!inner) return null;
      // Conservative envelope: take the L∞ extent and project as a cube.
      const ext = Math.max(
        Math.abs(inner.min[0]),
        Math.abs(inner.min[1]),
        Math.abs(inner.min[2]),
        Math.abs(inner.max[0]),
        Math.abs(inner.max[1]),
        Math.abs(inner.max[2]),
      );
      return { min: [-ext, -ext, -ext], max: [ext, ext, ext] };
    }
    case 'scale': {
      const inner = bboxOfOp(op.child);
      if (!inner) return null;
      return {
        min: [inner.min[0] * op.factor, inner.min[1] * op.factor, inner.min[2] * op.factor],
        max: [inner.max[0] * op.factor, inner.max[1] * op.factor, inner.max[2] * op.factor],
      };
    }
    case 'extrude':
    case 'revolve':
      // Profile-driven solids: reuse the analytic profile bounds from
      // buildPlan rather than duplicating the 2D walk here.
      return aabbOfOp(op);
    case 'hull':
    case 'union': {
      let result: BBox | null = null;
      for (const c of op.children) {
        const b = bboxOfOp(c);
        if (!b) continue;
        result = result ? mergeBBox(result, b) : b;
      }
      return result;
    }
    case 'difference': {
      // Difference uses only the first child's bbox.
      return op.children[0] ? bboxOfOp(op.children[0]) : null;
    }
    case 'intersection': {
      let result: BBox | null = null;
      for (const c of op.children) {
        const b = bboxOfOp(c);
        if (!b) continue;
        result = result ? intersectBBox(result, b) : b;
      }
      return result;
    }
    case 'mesh': {
      const positions = op.positions;
      if (positions.length === 0) return null;
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
      return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
    }
  }
}

function mergeBBox(a: BBox, b: BBox): BBox {
  return {
    min: [
      Math.min(a.min[0], b.min[0]),
      Math.min(a.min[1], b.min[1]),
      Math.min(a.min[2], b.min[2]),
    ],
    max: [
      Math.max(a.max[0], b.max[0]),
      Math.max(a.max[1], b.max[1]),
      Math.max(a.max[2], b.max[2]),
    ],
  };
}

function intersectBBox(a: BBox, b: BBox): BBox {
  return {
    min: [
      Math.max(a.min[0], b.min[0]),
      Math.max(a.min[1], b.min[1]),
      Math.max(a.min[2], b.min[2]),
    ],
    max: [
      Math.min(a.max[0], b.max[0]),
      Math.min(a.max[1], b.max[1]),
      Math.min(a.max[2], b.max[2]),
    ],
  };
}

/**
 * Predicate: BuildPlan has the canonical 2 nodes (shell + lid). Returns the
 * issue list when not. Used as a sanity check before sending the plan to the
 * worker.
 */
export function checkBuildPlanShape(plan: BuildPlan): string[] {
  const issues: string[] = [];
  const ids = plan.nodes.map((n) => n.id);
  if (!ids.includes('shell')) issues.push('plan missing shell node');
  if (!ids.includes('lid')) issues.push('plan missing lid node');
  if (plan.nodes.length !== 2) {
    issues.push(`plan has ${plan.nodes.length} nodes; expected exactly 2 (shell + lid)`);
  }
  return issues;
}
