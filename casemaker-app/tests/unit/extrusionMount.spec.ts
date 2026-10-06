// Issue #151 (first half) — the 20-series extrusion / M5 T-nut interface.
//
// The claims worth testing here are physical ones, so most of them are made
// against a mesh: "an M5 clearance hole through the wall", "the head seat is on
// the INNER face", "the bolts are on the slot pitch and centred". An op-tree
// assertion would pass on a feature that emitted the cutters at the wrong end
// of the wall, which is exactly the mistake this design invites — the extrusion
// is outside the case, so the head has to be inside, and nothing but a probe
// says which face got the counterbore.

import { describe, it, expect, beforeEach } from 'vitest';

import {
  buildMountingFeatureOps,
  extrusionMountPreset,
} from '@/engine/compiler/mountingFeatures';
import { computeShellDims } from '@/engine/compiler/caseShell';
import { faceFrame } from '@/engine/coords';
import { clearanceDiameter } from '@/engine/compiler/fasteners';
import { cube, difference, intersection, translate, union, type BuildOp } from '@/engine/compiler/buildPlan';
import { compileProject } from '@/engine/compiler/ProjectCompiler';
import { createDefaultProject, useProjectStore } from '@/store/projectStore';
import { serializeProject, parseProject } from '@/store/persistence';
import { exec } from './helpers/manifoldExec';

function volume(op: BuildOp): number {
  const m = exec(op);
  try {
    return m.volume();
  } finally {
    m.delete();
  }
}

const project = createDefaultProject('rpi-4b');
const dims = computeShellDims(project.board, project.case, [], () => undefined);
const frame = faceFrame('+y', dims.outerX, dims.outerY, dims.outerZ);
const WALL = project.case.wallThickness;
const R = clearanceDiameter('M5') / 2;

/** The `+y` wall as a slab of real material, in world coords. */
const wallSlab = translate([0, dims.outerY - WALL, 0], cube([dims.outerX, WALL, dims.outerZ]));

/** A slab spanning the wall's full thickness, `halfW` either side of `u`. */
function uSlab(u: number, halfW: number): BuildOp {
  const cx = frame.origin[0] + frame.uAxis[0] * u;
  return translate([cx - halfW, dims.outerY - WALL, 0], cube([2 * halfW, WALL, dims.outerZ]));
}

function mountsOf(feature?: Partial<ReturnType<typeof extrusionMountPreset>[number]>) {
  const base = extrusionMountPreset(dims.outerX, dims.outerZ)[0]!;
  const f = { ...base, ...feature } as typeof base;
  const groups = buildMountingFeatureOps([f], project.board, project.case);
  return { feature: f, ...groups, cutters: union(groups.subtractive) };
}

/** Material the cutters take out of a slab of real wall. */
function removedFrom(cutters: BuildOp, zone: BuildOp): number {
  return volume(zone) - volume(difference([zone, cutters]));
}

describe('#151 — extrusion mount preset (pure)', () => {
  it('is two M5 bolts on the 20 mm slot pitch, centred on the back face', () => {
    const [f] = extrusionMountPreset(120, 60);
    expect(f!.type).toBe('extrusion-mount');
    expect(f!.mountClass).toBe('external');
    expect(f!.face).toBe('+y');
    expect(f!.position).toEqual({ u: 60, v: 30 });
    expect(f!.params).toEqual({ count: 2, pitch: 20, along: 'u', flush: 0 });
    expect(f!.enabled).toBe(true);
  });

  it('gives each application its own id, so two mounts do not collide', () => {
    const [a] = extrusionMountPreset(120, 60);
    const [b] = extrusionMountPreset(120, 60);
    expect(a!.id).not.toBe(b!.id);
  });

  it('cuts material only — no additive geometry, so no printed part changes', () => {
    expect(mountsOf().additive).toEqual([]);
  });

  it('keeps its type and params through the Zod schema', () => {
    const p = createDefaultProject('rpi-4b');
    p.mountingFeatures = extrusionMountPreset(120, 60);
    const parsed = parseProject(serializeProject(p));
    expect(parsed.mountingFeatures?.[0]?.type).toBe('extrusion-mount');
    expect(parsed.mountingFeatures?.[0]?.params.pitch).toBe(20);
  });

  it('is reachable from the panel preset', () => {
    useProjectStore.getState().setProject(createDefaultProject('rpi-4b'));
    useProjectStore.getState().applyMountingPreset('extrusion-mount-2020');
    const features = useProjectStore.getState().project.mountingFeatures;
    expect(features).toHaveLength(1);
    expect(features[0]!.type).toBe('extrusion-mount');
  });

  it('emits one hole per bolt, and none when disabled', () => {
    expect(mountsOf().subtractive).toHaveLength(2);
    expect(mountsOf({ params: { count: 3, pitch: 20, along: 'u', flush: 0 } }).subtractive)
      .toHaveLength(3);
    expect(mountsOf({ enabled: false }).subtractive).toHaveLength(0);
  });
});

describe('#151 — extrusion mount geometry (evaluated)', () => {
  it('drills an M5 clearance bore clean through the wall', () => {
    const removed = removedFrom(mountsOf().cutters, wallSlab);
    const expected = 2 * Math.PI * R * R * WALL;
    // A 32-sided cylinder is ~0.5% under the circle it stands in for, and
    // separate features; anything else means the bore did not reach a face.
    expect(removed / expected).toBeGreaterThan(0.98);
    expect(removed / expected).toBeLessThan(1.01);
  });

  it('reaches the bore on both faces of the wall', () => {
    const { cutters } = mountsOf();
    const bore = Math.PI * R * R;
    // 1 mm slabs straddling each face: a bore that stops short shows up as a
    // face with no hole in it.
    const outer = translate([0, dims.outerY - 1, 0], cube([dims.outerX, 1.2, dims.outerZ]));
    const inner = translate([0, dims.outerY - WALL - 0.2, 0], cube([dims.outerX, 1.2, dims.outerZ]));
    expect(volume(intersection([cutters, outer])) / (2 * bore * 1)).toBeGreaterThan(0.9);
    expect(volume(intersection([cutters, inner])) / (2 * bore * 1)).toBeGreaterThan(0.9);
  });

  it('leaves the head seat on the inner face, not the outer', () => {
    // Split the wall at 3/4 of its thickness: the seat (clamped to
    // wall − floor) lives in the inner part, so asking for flush must add
    // material to the inner share and nothing at all to the outer one.
    const innerShare = translate(
      [0, dims.outerY - WALL, 0],
      cube([dims.outerX, WALL * 0.75, dims.outerZ]),
    );
    const outerShare = translate(
      [0, dims.outerY - WALL * 0.25, 0],
      cube([dims.outerX, WALL * 0.25, dims.outerZ]),
    );
    const plain = mountsOf();
    const flushed = mountsOf({
      params: { count: 2, pitch: 20, along: 'u', flush: 1 },
    });
    const addedInner = removedFrom(flushed.cutters, innerShare) - removedFrom(plain.cutters, innerShare);
    const addedOuter = removedFrom(flushed.cutters, outerShare) - removedFrom(plain.cutters, outerShare);
    expect(addedInner).toBeGreaterThan(0);
    expect(Math.abs(addedOuter)).toBeLessThan(0.5);
  });

  it('clamps the seat to the wall it has, never through it', () => {
    const flushed = mountsOf({ params: { count: 1, pitch: 0, along: 'u', flush: 1 } });
    // wall − floor is the deepest `screwHole` will go, so the whole bore is
    // still a flat-sided clearance hole: a seat cut THROUGH the wall would
    // remove more than the bore plus that clamp, ring and all.
    const removed = removedFrom(flushed.cutters, wallSlab);
    const bore = Math.PI * R * R * WALL;
    const maxSeat = Math.PI * ((clearanceDiameter('M5') + 4) / 2) ** 2 * WALL;
    expect(removed).toBeGreaterThan(bore);
    expect(removed).toBeLessThan(bore + maxSeat);
  });

  it('spaces the bolts on the pitch, centred on the face', () => {
    const { feature, cutters } = mountsOf({
      params: { count: 3, pitch: 20, along: 'u', flush: 0 },
    });
    const cu = feature.position.u;
    const oneBore = Math.PI * R * R * WALL;
    // The middle bolt sits on the face centre; the outer two, 20 mm either
    // side; nothing at all halfway between them.
    // The probes are 6 mm wide, wider than the 5.2 mm bore, so a hit is the
    // WHOLE bore rather than a chord of it.
    expect(removedFrom(cutters, uSlab(cu, 3)) / oneBore).toBeGreaterThan(0.9);
    expect(removedFrom(cutters, uSlab(cu - 20, 3)) / oneBore).toBeGreaterThan(0.9);
    expect(removedFrom(cutters, uSlab(cu + 20, 3)) / oneBore).toBeGreaterThan(0.9);
    expect(removedFrom(cutters, uSlab(cu - 10, 3))).toBeLessThan(0.1);
  });

  it('runs the bolt line down v when asked', () => {
    const { feature, cutters } = mountsOf({
      params: { count: 2, pitch: 20, along: 'v', flush: 0 },
    });
    const oneBore = Math.PI * R * R * WALL;
    const cv = feature.position.v;
    const vSlab = (v: number) =>
      translate([0, dims.outerY - WALL, cv + v - 3], cube([dims.outerX, WALL, 6]));
    expect(removedFrom(cutters, vSlab(10)) / oneBore).toBeGreaterThan(0.9);
    expect(removedFrom(cutters, vSlab(-10)) / oneBore).toBeGreaterThan(0.9);
    expect(removedFrom(cutters, vSlab(0))).toBeLessThan(0.1);
  });
});

describe('#151 — extrusion mounts compose with the shell', () => {
  beforeEach(() => {
    useProjectStore.getState().setProject(createDefaultProject('rpi-4b'));
  });

  it('reaches the compiled shell as subtractions', () => {
    useProjectStore.getState().applyMountingPreset('extrusion-mount-2020');
    const p = useProjectStore.getState().project;
    const groups = buildMountingFeatureOps(p.mountingFeatures, p.board, p.case);
    expect(groups.additive).toHaveLength(0);
    expect(groups.subtractive).toHaveLength(2);
  });

  it('leaves the shell one piece, with material gone', () => {
    const bare = compileProject(useProjectStore.getState().project);
    const bareVol = volume(bare.nodes.find((n) => n.id === 'shell')!.op);

    useProjectStore.getState().applyMountingPreset('extrusion-mount-2020');
    const shellOp = compileProject(useProjectStore.getState().project).nodes.find(
      (n) => n.id === 'shell',
    )!.op;
    const m = exec(shellOp);
    const vol = m.volume();
    const parts = m.decompose();
    const shellCount = parts.length;
    parts.forEach((p) => p.delete());
    m.delete();

    // Two bores through a wall are through-holes, not sealed voids, so this
    // must stay a single connected piece — a decomposition that split here
    // would mean a bore landed where the wall had no material to lose.
    expect(shellCount).toBe(1);
    expect(vol).toBeLessThan(bareVol);
  });
});
