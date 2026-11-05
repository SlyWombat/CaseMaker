/**
 * #898 — THE UNDERSIDE CHOICE. A goal mesh can say where the part's underside comes from: flat on
 * the stock's own bottom (the elephant), flipped and held by tabs (the panther), or on a plinth.
 * These tests build the meshes they read (no third-party files): a part with a flat base reads as
 * flat, a sphere reads as a flip, and each kind's floor is the Z the sampler clamps the cut to.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { crossSectionPolylines, goalUndersideOffer, silhouettePlane, undersideClearBaseZ, undersideFloorZ, undersideSentence, UNDERSIDE_PLINTH_MM, UNDERSIDE_TAB_THICKNESS_MM } from '@/engine/cnc/engrave/goalUnderside';
import { planUndersideFlip } from '@/engine/cnc/engrave/goalFlipSetups';
import { sampleGoalHeightfield } from '@/engine/cnc/engrave/goalHeightfield';
import { generateGoalProgram } from '@/workers/sim/engraveGenerate';
import { clearTargetObjectMeshCache } from '@/engine/import/targetObject';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';

afterEach(() => clearTargetObjectMeshCache());

type Tri = [[number, number, number], [number, number, number], [number, number, number]];

/** The solid's triangles, as a binary STL body (the import door reads the same bytes). */
function stlOf(solid: { getMesh: () => { vertProperties: Float32Array; triVerts: Uint32Array } }): string {
  const mesh = solid.getMesh();
  const vp = mesh.vertProperties;
  const tv = mesh.triVerts;
  const tris: Tri[] = [];
  for (let i = 0; i < tv.length; i += 3) {
    const p = (k: number): [number, number, number] => [
      vp[tv[i + k]! * 3]!,
      vp[tv[i + k]! * 3 + 1]!,
      vp[tv[i + k]! * 3 + 2]!,
    ];
    tris.push([p(0), p(1), p(2)]);
  }
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  let off = 84;
  for (const t of tris) {
    off += 12; // normal left 0 — the loader derives it
    for (const v of t) {
      dv.setFloat32(off, v[0], true);
      dv.setFloat32(off + 4, v[1], true);
      dv.setFloat32(off + 8, v[2], true);
      off += 12;
    }
    off += 2;
  }
  return Buffer.from(new Uint8Array(buf)).toString('base64');
}

/** A flat-based part: a 30 × 30 × 2 plate with a 10 × 10 × 8 body on it (the elephant's pose). */
function flatBasedStl(): string {
  const base = tl.Manifold.cube([30, 30, 2], true).translate(0, 0, 1);
  const body = tl.Manifold.cube([10, 10, 8], true).translate(0, 0, 6);
  return stlOf(base.add(body));
}

/** A shaped part: a ⌀20 sphere — its underside is a point, and its lower half faces down. */
function sphereStl(): string {
  return stlOf(tl.Manifold.sphere(10, 48));
}

/** A 30 × 30 ramp falling `depth` mm across Y — its surface reaches every Z between its top and
 *  bottom, so a floor clamp has something to bite (the plinth's own case). */
function rampStl(depth: number): string {
  const tris: Tri[] = [
    [
      [-15, -15, 0],
      [15, -15, 0],
      [15, 15, -depth],
    ],
    [
      [-15, -15, 0],
      [15, 15, -depth],
      [-15, 15, -depth],
    ],
  ];
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  let off = 84;
  for (const t of tris) {
    off += 12;
    for (const v of t) {
      dv.setFloat32(off, v[0], true);
      dv.setFloat32(off + 4, v[1], true);
      dv.setFloat32(off + 8, v[2], true);
      off += 12;
    }
    off += 2;
  }
  return Buffer.from(new Uint8Array(buf)).toString('base64');
}

let serial = 0;
function goalOf(data: string, size: { x: number; y: number; z: number }, over: Partial<EngraveTargetObject> = {}): EngraveTargetObject {
  return {
    id: `g-${serial}`,
    name: 'part.stl',
    format: 'stl',
    sha256: String(serial++).padStart(64, 'b'),
    data,
    size,
    position: { x: 50, y: 30, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
    ...over,
  };
}

function jobOf(target: EngraveTargetObject, thickness = 20): EngraveJob {
  return {
    ...defaultEngraveJob(),
    labels: [],
    shapes: [],
    stock: { ...defaultEngraveJob().stock, length: 100, width: 60, thickness },
    targetObject: target,
  };
}

import { goalWorkMesh } from '@/engine/cnc/engrave/goalFlipFindings';
const goalWorkMeshForTest = (goal: EngraveTargetObject) => goalWorkMesh(goal)!;

const FLAT = { x: 30, y: 30, z: 10 };
const SPHERE = { x: 20, y: 20, z: 20 };

describe('#898 — the proposal, read off the mesh', () => {
  it('a flat-based part is proposed flat on the stock bottom', () => {
    const goal = goalOf(flatBasedStl(), FLAT);
    const offer = goalUndersideOffer(goal);
    expect(offer).not.toBeNull();
    expect(offer!.kind).toBe('flat');
    // Its 30 × 30 base is one face at the lowest Z: the whole footprint.
    expect(offer!.flatShare).toBeGreaterThan(0.95);
    expect(offer!.reason).toContain('flat face');
  });

  it('a shaped underside is proposed flipped, held by tabs', () => {
    const goal = goalOf(sphereStl(), SPHERE);
    const offer = goalUndersideOffer(goal);
    expect(offer!.kind).toBe('flipped-tabs');
    expect(offer!.flatShare).toBeLessThan(0.1);
    expect(offer!.undercutMm2).toBeGreaterThan(0);
    expect(offer!.reason).toContain('faces down above its bottom');
  });

  it('a reference, a picture or a disabled mesh is not proposed for', () => {
    expect(goalUndersideOffer(goalOf(flatBasedStl(), FLAT, { role: 'reference' }))).toBeNull();
    expect(goalUndersideOffer(goalOf(flatBasedStl(), FLAT, { enabled: false }))).toBeNull();
    expect(goalUndersideOffer(goalOf(flatBasedStl(), FLAT, { format: 'png' }))).toBeNull();
  });
});

describe('#898 — the cut floor each kind gives', () => {
  it('a flat underside is cut to the mesh’s own surface; its SKIN raises the clear band instead', () => {
    const goal = goalOf(flatBasedStl(), FLAT, { underside: { kind: 'flat' } });
    // Nothing floors the part's own cut: the surface program runs to the mesh as it is.
    expect(undersideFloorZ(goal, { thickness: 20 })).toBeNull();
    // With no skin the clear band's floor is the part's base plane (today's band). The part's top
    // sits on the stock top (position.z 0), so its bottom is 10 mm down.
    expect(undersideClearBaseZ(goal)).toBeNull();
    const skinned = { ...goal, underside: { kind: 'flat' as const, skinMm: 0.5 } };
    expect(undersideClearBaseZ(skinned)).toBeCloseTo(-9.5, 6);
  });

  it('plinth stops a stated height above the blank’s bottom (the default when unstated)', () => {
    const goal = goalOf(flatBasedStl(), FLAT, { underside: { kind: 'plinth', plinthMm: 3 } });
    expect(undersideFloorZ(goal, { thickness: 20 })).toBeCloseTo(-17, 6);
    const dflt = goalOf(flatBasedStl(), FLAT, { underside: { kind: 'plinth' } });
    expect(undersideFloorZ(dflt, { thickness: 20 })).toBeCloseTo(-20 + UNDERSIDE_PLINTH_MM, 6);
  });

  it('the band is cut to the skinned floor, and the plinth clamps the part’s own cut', () => {
    const goal = goalOf(flatBasedStl(), FLAT, { underside: { kind: 'flat', skinMm: 0.5 } });
    const base = undersideClearBaseZ(goal)!;
    const hf = sampleGoalHeightfield(goal, {
      pitchMm: 0.5,
      clear: { kind: 'ring', widthMm: 3 },
      stockRect: { xMin: 0, xMax: 100, yMin: 0, yMax: 60 },
      baseZ: base,
      clip: { xMin: 0, xMax: 100, yMin: 0, yMax: 60 },
    });
    // The band around the part is cleared to the SKINNED plane, not to the part's bottom (−10):
    // the half millimetre left there is the skin that holds the part in.
    expect(hf.minZ).toBeCloseTo(-9.5, 5);
    // A plinth floors the cut itself: on a ramp that reaches 20 mm down, a 15 mm floor cuts the
    // bottom 5 mm away and leaves a base at −15.
    const ramp = goalOf(rampStl(20), { x: 30, y: 30, z: 20 }, { underside: { kind: 'plinth', plinthMm: 5 } });
    const pfloor = undersideFloorZ(ramp, { thickness: 20 })!;
    const phf = sampleGoalHeightfield(ramp, {
      pitchMm: 0.5,
      depthLimitZ: pfloor,
      clip: { xMin: 0, xMax: 100, yMin: 0, yMax: 60 },
    });
    expect(phf.minZ).toBeCloseTo(pfloor, 5);
  });

  it('the generated program carries the underside and its floor', async () => {
    const goal = goalOf(flatBasedStl(), FLAT, { underside: { kind: 'plinth', plinthMm: 4 } });
    const tool: Tool = flatEndMill(3, { name: 'flat', fluteLength: 40 });
    // #881 — the generator is async: the result is awaited before it is read.
    const out = await generateGoalProgram(jobOf(goal), goal, tool, null, { shop: {} });
    expect(out.ok, out.errors.map((e) => e.message).join('; ')).toBe(true);
    expect(out.surface3d?.underside).toEqual({ kind: 'plinth', floorZ: -16 });
    // The posted program never goes below the plinth's floor (Z words, the file's own frame).
    const zs = [...out.nc!.matchAll(/Z(-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
    expect(zs.length).toBeGreaterThan(0);
    expect(Math.min(...zs)).toBeGreaterThanOrEqual(-16 - 0.001);
  }, 120_000);

  it('a goal with no underside block has no floor of its own (today’s cut)', () => {
    const goal = goalOf(flatBasedStl(), FLAT);
    expect(undersideFloorZ(goal, { thickness: 20 })).toBeNull();
    expect(undersideSentence(goal)).toBeNull();
  });
});

describe('#898 — flipped, held by tabs', () => {
  it('the silhouette plane is the part’s widest cross-section — a sphere parts at its middle', () => {
    const goal = goalOf(sphereStl(), SPHERE);
    const plane = silhouettePlane(goal)!;
    // The sphere is placed with its top on the stock top: it spans −20…0, and its widest section
    // is its centre line. One sampling step (20/65 ≈ 0.31 mm) either side is the tolerance.
    expect(plane).toBeGreaterThan(-10.4);
    expect(plane).toBeLessThan(-9.6);
  });

  it('the two sides stop a tab band either side of that plane', () => {
    const goal = goalOf(sphereStl(), SPHERE, { underside: { kind: 'flipped-tabs', tabs: { count: 3, widthMm: 4, thicknessMm: 1 } } });
    const out = planUndersideFlip(jobOf(goal, 30), goal);
    expect(out.ok, out.ok ? '' : out.reason).toBe(true);
    if (!out.ok) return;
    const { planeZ, tabThicknessMm, goals, setups } = out.plan;
    expect(planeZ).toBeCloseTo(-10, 0);
    expect(tabThicknessMm).toBe(1);
    // Setup 1 stops at plane + tab; setup 2 (turned over) at plane − tab in its own frame.
    expect(goals).toHaveLength(2);
    expect(goals[0]!.bandMm).toBeCloseTo(goal.position.z - (planeZ + 1), 2);
    expect(goals[1]!.bandMm).toBeCloseTo(planeZ - 1 - (goal.position.z - 20), 2);
    expect(goals[0]!.setupId).toBe(setups[0]!.id);
    expect(goals[1]!.setupId).toBe(setups[1]!.id);
    // The band left standing between them is the tab material: 2 × the half-thickness.
    const depth = goal.position.z - (goal.position.z - 20);
    expect(goals[0]!.bandMm! + goals[1]!.bandMm!).toBeCloseTo(depth - 2 * tabThicknessMm, 2);
  });

  it('refuses a goal that is not set to be cut from both sides, and a band that cannot fit', () => {
    const flat = goalOf(flatBasedStl(), FLAT);
    expect(planUndersideFlip(jobOf(flat), flat).ok).toBe(false);
    const fat = goalOf(sphereStl(), SPHERE, { underside: { kind: 'flipped-tabs', tabs: { count: 2, widthMm: 4, thicknessMm: 12 } } });
    const out = planUndersideFlip(jobOf(fat, 30), fat);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain('tab band');
  });

  it('the section contour at a height is a closed loop — the freeing cut follows it', () => {
    const goal = goalOf(sphereStl(), SPHERE);
    const mesh = { positions: new Float32Array(0), indices: new Uint32Array(0) };
    void mesh;
    // The sphere's section at its centre: one closed loop around the centre, its area the disc's.
    const loops = crossSectionPolylines(goalWorkMeshForTest(goal), -10);
    expect(loops).toHaveLength(1);
    const loop = loops[0]!;
    let area = 0;
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i]!;
      const b = loop[(i + 1) % loop.length]!;
      area += a[0] * b[1] - b[0] * a[1];
    }
    const disc = Math.abs(area) / 2;
    // A faceted ⌀20 sphere: within 5% of π r² (48 facets).
    expect(disc).toBeGreaterThan(Math.PI * 100 * 0.95);
    expect(disc).toBeLessThan(Math.PI * 100 * 1.05);
  });

  it('the default tab band is the labelled half-thickness', () => {
    expect(UNDERSIDE_TAB_THICKNESS_MM).toBe(1);
  });
});

describe('#898 — the document', () => {
  it('the block round-trips through the schema, and an absent one stays absent', () => {
    const base = jobOf(goalOf(flatBasedStl(), FLAT));
    const withBlock: EngraveJob = {
      ...base,
      targetObject: { ...base.targetObject!, underside: { kind: 'flat', skinMm: 0.4, tabs: { count: 3, widthMm: 4, thicknessMm: 1 } , source: 'user' } },
    };
    const parsed = parseEngraveJob(JSON.parse(JSON.stringify(withBlock)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job.targetObject?.underside).toEqual({
      kind: 'flat',
      skinMm: 0.4,
      tabs: { count: 3, widthMm: 4, thicknessMm: 1 },
      source: 'user',
    });
    const plain = parseEngraveJob(JSON.parse(JSON.stringify(base)));
    expect(plain.ok).toBe(true);
    if (!plain.ok) return;
    expect('underside' in (plain.job.targetObject ?? {})).toBe(false);
  });

  it('the sentence says what the chosen kind does', () => {
    expect(undersideSentence(goalOf(flatBasedStl(), FLAT, { underside: { kind: 'flat', skinMm: 0.5 } }))).toContain('0.5 mm skin');
    expect(undersideSentence(goalOf(flatBasedStl(), FLAT, { underside: { kind: 'flat', tabs: { count: 3, widthMm: 4, thicknessMm: 1 } } }))).toContain('3 tabs');
    expect(undersideSentence(goalOf(flatBasedStl(), FLAT, { underside: { kind: 'plinth', plinthMm: 3 } }))).toContain('3 mm above');
    expect(undersideSentence(goalOf(sphereStl(), SPHERE, { underside: { kind: 'flipped-tabs' } }))).toContain('both sides');
  });
});
