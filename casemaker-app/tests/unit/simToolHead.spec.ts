// #527 §6 — the machine layer's two bodies: the cutter's head with the collet nut, and the wired
// probe's. The opacity is the issue's 40 %, and the transparency rule is the #162 one: a
// transparent mesh that writes depth hides everything inside it, so `depthWrite` must be false.
// No renderer is needed — the groups are plain three objects built in Node.

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  disposeToolHeadGroup,
  PROBE_TIP_LENGTH_MM,
  probeHeadGroup,
  TOOL_HEAD_OPACITY,
  toolHeadGroup,
} from '@/components/viewport/simGeometry';
import { flatEndMill } from '@/engine/cnc/tool';
import type { HolderProfile } from '@/engine/cnc/machine';

const meshes = (group: THREE.Group): THREE.Mesh[] => {
  const out: THREE.Mesh[] = [];
  group.traverse((o) => {
    if (o instanceof THREE.Mesh) out.push(o);
  });
  return out;
};

const cylinders = (group: THREE.Group): THREE.CylinderGeometry[] =>
  meshes(group)
    .map((m) => m.geometry)
    .filter((g): g is THREE.CylinderGeometry => g instanceof THREE.CylinderGeometry);

/** A cylinder's own parameters, which is where the drawn diameter and height are stated. */
const params = (g: THREE.CylinderGeometry): { rTop: number; height: number; zMin: number; zMax: number } => {
  const p = g.parameters as { radiusTop: number; height: number };
  g.computeBoundingBox();
  const box = g.boundingBox!;
  return { rTop: p.radiusTop, height: p.height, zMin: box.min.z, zMax: box.max.z };
};

const HOLDER: HolderProfile = { nutDiameter: 16, nutLength: 5, source: 'measured test fixture' };

describe('#527 — the cutter head is translucent at 40 % and never writes depth', () => {
  it('every mesh carries the shared translucent material', () => {
    const group = toolHeadGroup(flatEndMill(1))!;
    expect(meshes(group).length).toBeGreaterThan(0);
    for (const m of meshes(group)) {
      const material = m.material as THREE.MeshStandardMaterial;
      expect(material.transparent).toBe(true);
      expect(material.opacity).toBe(TOOL_HEAD_OPACITY);
      expect(material.depthWrite).toBe(false);
    }
    disposeToolHeadGroup(group);
  });

  it('40 % is the issue’s number, not a local constant', () => {
    expect(TOOL_HEAD_OPACITY).toBe(0.4);
  });
});

describe('#527 — the collet nut comes from the machine profile when it is measured', () => {
  it('draws the measured nut above the shank', () => {
    const group = toolHeadGroup(flatEndMill(1, { fluteLength: 12, stickout: 20 }), { holder: HOLDER })!;
    const nut = cylinders(group).filter((g) => {
      const p = params(g);
      return p.rTop === HOLDER.nutDiameter / 2 && p.height === HOLDER.nutLength;
    });
    expect(nut).toHaveLength(1);
    // It sits ABOVE the tool: the nut's bottom is no lower than the shank it caps.
    expect(params(nut[0]!).zMin).toBeGreaterThanOrEqual(18);
    disposeToolHeadGroup(group);
  });

  it('keeps the generic stub when the profile has no measurement (null is NOT MEASURED)', () => {
    const group = toolHeadGroup(flatEndMill(1), { holder: null })!;
    const hasNut = cylinders(group).some((g) => params(g).rTop === HOLDER.nutDiameter / 2);
    expect(hasNut).toBe(false);
    disposeToolHeadGroup(group);
  });
});

describe('#527 — the probe body', () => {
  it('has the measured tip at the origin and the body above it', () => {
    const group = probeHeadGroup(2);
    const tip = cylinders(group)[0]!;
    const p = params(tip);
    expect(p.rTop).toBe(1); // 2.0 mm across, the measured wired probe (#208 A8)
    expect(p.height).toBe(PROBE_TIP_LENGTH_MM);
    expect(p.zMin).toBeCloseTo(0, 6);
    expect(p.zMax).toBeCloseTo(PROBE_TIP_LENGTH_MM, 6);
    disposeToolHeadGroup(group);
  });

  it('is translucent and takes the measured nut like the cutter', () => {
    const group = probeHeadGroup(2, { holder: HOLDER });
    for (const m of meshes(group)) {
      const material = m.material as THREE.MeshStandardMaterial;
      expect(material.transparent).toBe(true);
      expect(material.opacity).toBe(TOOL_HEAD_OPACITY);
      expect(material.depthWrite).toBe(false);
    }
    expect(cylinders(group).some((g) => params(g).rTop === HOLDER.nutDiameter / 2)).toBe(true);
    disposeToolHeadGroup(group);
  });

  it('a different instrument changes the tip: the tip radius is the diameter it is given', () => {
    const group = probeHeadGroup(6);
    expect(params(cylinders(group)[0]!).rTop).toBe(3);
    disposeToolHeadGroup(group);
  });
});
