/**
 * #822 — THE PREVIEW DRAWS THE CONE/SPHERE CAVITY.
 *
 * The cavity is the same analytic field the surface program cuts, revolved into a solid and
 * subtracted from the blank. The acceptance reads the preview's own stock mesh: its lowest point
 * is the cut's depth, and the ring where the top face opens is the cavity's rim (R for a cone,
 * ρmax for a sphere). A job without these primitives keeps its picture: no surface entries, and
 * its stock reaches only as deep as its own cuts.
 */
import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { createEngravePreviewer, type EngravePreview } from '@/workers/sim/engravePreview';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { effectiveMargins, MARGIN_DEFAULTS } from '@/engine/cnc/engrave/depthBounds';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { NodeMeshOutput } from '@/workers/geometry/meshOutput';
import type { EngraveJob } from '@/types/engraveJob';

const KEY = 'inv:flat-1x20';
const TOOL: Tool = flatEndMill(1, { name: '1 mm flat end', fluteLength: 20, centreCutting: true });
const ENTRIES: ToolLibraryEntry[] = [{ key: KEY, tool: TOOL, provenance: 'test' }];

const CONE = {
  id: 'funnel',
  name: 'funnel',
  kind: 'cone' as const,
  position: { x: 50, y: 30 },
  rotation: 0,
  enabled: true,
  depth: 2,
  diameter: 10,
  tipDiameter: 2,
};
const SPHERE = { ...CONE, id: 'dimple', name: 'dimple', kind: 'sphere' as const };

const pv = createEngravePreviewer(tl);
let gen = 0;

function build(job: EngraveJob): EngravePreview {
  const p = pv.engravePreview(job, ENTRIES, [], ++gen, effectiveMargins(job, MARGIN_DEFAULTS), new Map());
  if (!p) throw new Error('the previewer refused a fresh generation');
  return p;
}

function job(primitives: (typeof CONE | typeof SPHERE)[]): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    labels: [],
    shapes: [],
    traces: [],
    drills: [],
    threads: [],
    primitives,
    toolKey: KEY,
    tool: TOOL,
  };
}

/** The lowest point of a mesh, and the widest ring where it meets the top face near `cx, cy`. */
function cavity(mesh: NodeMeshOutput, cx: number, cy: number): { minZ: number; rimR: number } {
  let minZ = Infinity;
  let rimR = 0;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const x = mesh.positions[i]!;
    const y = mesh.positions[i + 1]!;
    const z = mesh.positions[i + 2]!;
    const rho = Math.hypot(x - cx, y - cy);
    // The stock is a solid with a bottom face at −thickness: only the material inside the
    // cavity's own neighbourhood says anything about the cavity's depth and rim.
    if (rho > 6) continue;
    minZ = Math.min(minZ, z);
    // The top-face opening: a vertex at the top face within the cavity's own neighbourhood.
    if (Math.abs(z) < 0.02) rimR = Math.max(rimR, rho);
  }
  return { minZ, rimR };
}

describe('#822 the preview draws the cavity', () => {
  it('a cone shows its floor at −depth and its rim at R', () => {
    const p = build(job([CONE]));
    expect(p.surfaces.map((s) => [s.id, s.kind, s.depthMm])).toEqual([['funnel', 'cone', 2]]);
    const { minZ, rimR } = cavity(p.stock, CONE.position.x, CONE.position.y);
    expect(minZ).toBeCloseTo(-2, 1);
    expect(rimR).toBeCloseTo(5, 0);
  });

  it('a sphere shows its floor at −depth and its rim at ρmax', () => {
    const p = build(job([SPHERE]));
    expect(p.surfaces).toHaveLength(1);
    const { minZ, rimR } = cavity(p.stock, SPHERE.position.x, SPHERE.position.y);
    expect(minZ).toBeCloseTo(-2, 1);
    expect(rimR).toBeCloseTo(Math.sqrt(25 - 9), 0);
  });

  it('a job without these primitives keeps its picture', () => {
    const plainJob: EngraveJob = {
      ...job([]),
      shapes: [
        { id: 'pocket', name: 'pocket', kind: 'circle', position: { x: 20, y: 20 }, rotation: 0, depth: 2, enabled: true, diameter: 8 },
      ],
    };
    const p = build(plainJob);
    expect(p.surfaces).toEqual([]);
    // Its picture is exactly the pocket: floor at −2, opening at the pocket's own radius.
    const { minZ, rimR } = cavity(p.stock, 20, 20);
    expect(minZ).toBeCloseTo(-2, 1);
    expect(rimR).toBeCloseTo(4, 0);
  });
});
