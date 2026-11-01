/**
 * #873 — the STEP-accuracy pair: one CAD part, saved as STEP and as a fine 3MF.
 *
 * There is no OCCT/FreeCAD/cadquery toolchain on the bench machine, so the STEP here is a
 * hand-authored AP214 B-rep in exactly the shape OpenCascade's own writer produces (see
 * `tests/fixtures/step/box-with-hole.step` for the reference): ADVANCED_BREP_SHAPE_REPRESENTATION
 * → MANIFOLD_SOLID_BREP → CLOSED_SHELL, every edge a SURFACE_CURVE with its pcurves, and every
 * face's loops authored in the surface's own parameter space (outer CCW, inner CW) with the
 * FACE_BOUND orientation equal to the face's `same_sense` — the algebra the reference file uses,
 * verified edge by edge against it.
 *
 * The solid (one big flat body plus the three features the accuracy check needs):
 *
 *   plate       60 × 40 × 10 mm, x,y ∈ [0,W]×[0,D], z ∈ [0,10]
 *   fillet      2 mm quarter-cylinder, axis (58,38,+Z), replacing the square corner at (60,40)
 *   hole        3 mm through hole, centre (20,20), axis +Z
 *   dome        spherical cap, sphere R20 centred (45,20,-8), above z = 10 (2 mm high,
 *               rim radius sqrt(76) mm) — a shallow smooth cap on the flat top
 *
 * The 3MF is the SAME solid built in Manifold from primitives and tessellated finely, so the two
 * files differ only in their surface approximations — which is what the spec measures.
 *
 * Run (from casemaker-app):
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/gen-step-fixture.mts
 *
 * The outputs are committed; the test reads the files, never regenerates them.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import ManifoldModule from 'manifold-3d';

import { buildThreeMf } from '../src/workers/export/threeMf';

// ── The solid's dimensions ────────────────────────────────────────────────────────────────────
const W = 60; // x
const D = 40; // y
const H = 10; // z
const RC = 2; // corner fillet radius
const AX = W - RC; // 58 — fillet axis x
const AY = D - RC; // 38 — fillet axis y
const HOLE_R = 1.5; // 3 mm hole
const HOLE_X = 20;
const HOLE_Y = 20;
const SPH_R = 20;
const SPH_X = 45;
const SPH_Y = 20;
const SPH_Z = -8; // centre below the plate, so the cap is shallow
// Rim circle: the sphere's section at z = H.
const RIM_R = Math.sqrt(SPH_R * SPH_R - (H - SPH_Z) * (H - SPH_Z)); // sqrt(76)
const V0 = Math.asin((H - SPH_Z) / SPH_R); // rim latitude, asin(0.9)
const TWO_PI = 2 * Math.PI;
const HALF_PI = Math.PI / 2;

// ── STEP writer ───────────────────────────────────────────────────────────────────────────────
const entities: string[] = [];
let nextId = 0;
const e = (body: string): string => {
  nextId += 1;
  entities.push(`#${nextId} = ${body};`);
  return `#${nextId}`;
};
const list = (...ids: string[]): string => `(${ids.join(',')})`;

/** A STEP real: always carries a decimal point, no exponent. Nine places is ample at mm scale. */
function f(v: number): string {
  if (!Number.isFinite(v)) throw new Error(`not a finite number: ${v}`);
  const s = (Object.is(v, -0) ? 0 : v).toFixed(9).replace(/0+$/, '');
  return s;
}

type V3 = [number, number, number];

const cp = (p: V3): string => e(`CARTESIAN_POINT('',(${f(p[0])},${f(p[1])},${f(p[2])}))`);
const dir = (p: V3): string => e(`DIRECTION('',(${f(p[0])},${f(p[1])},${f(p[2])}))`);
const vtx = (p: V3): string => e(`VERTEX_POINT('',${cp(p)})`);
const ax3 = (o: V3, axis: V3, ref: V3): string =>
  e(`AXIS2_PLACEMENT_3D('',${cp(o)},${dir(axis)},${dir(ref)})`);
const line3 = (o: V3, d: V3): string => e(`LINE('',${cp(o)},${e(`VECTOR('',${dir(d)},1.)`)})`);
const circle3 = (o: V3, axis: V3, ref: V3, r: number): string =>
  e(`CIRCLE('',${ax3(o, axis, ref)},${f(r)})`);
const plane = (o: V3, axis: V3, ref: V3): string => e(`PLANE('',${ax3(o, axis, ref)})`);
const cylinder = (o: V3, axis: V3, ref: V3, r: number): string =>
  e(`CYLINDRICAL_SURFACE('',${ax3(o, axis, ref)},${f(r)})`);
const sphere = (o: V3, axis: V3, ref: V3, r: number): string =>
  e(`SPHERICAL_SURFACE('',${ax3(o, axis, ref)},${f(r)})`);

// The single 2-D parameter-space context every pcurve's definitional representation uses.
const ctx2d = e(
  `( GEOMETRIC_REPRESENTATION_CONTEXT(2) PARAMETRIC_REPRESENTATION_CONTEXT() REPRESENTATION_CONTEXT('2D SPACE','') )`,
);

const cp2 = (x: number, y: number): string => e(`CARTESIAN_POINT('',(${f(x)},${f(y)}))`);
const dir2 = (x: number, y: number): string => e(`DIRECTION('',(${f(x)},${f(y)}))`);
const line2 = (x: number, y: number, dx: number, dy: number): string =>
  e(`LINE('',${cp2(x, y)},${e(`VECTOR('',${dir2(dx, dy)},1.)`)})`);
const circle2 = (cx: number, cy: number, rx: number, ry: number, r: number): string =>
  e(`CIRCLE('',${e(`AXIS2_PLACEMENT_2D('',${cp2(cx, cy)},${dir2(rx, ry)})`)},${f(r)})`);
const pcurve = (surface: string, curve2d: string): string =>
  e(`PCURVE('',${surface},${e(`DEFINITIONAL_REPRESENTATION('',(${curve2d}),${ctx2d})`)})`);

const surfaceCurve = (geom: string, pcurves: string[]): string =>
  e(`SURFACE_CURVE('',${geom},${list(...pcurves)},.PCURVE_S1.)`);
const seamCurve = (geom: string, pcurves: string[]): string =>
  e(`SEAM_CURVE('',${geom},${list(...pcurves)},.PCURVE_S1.)`);
const edge = (v0: string, v1: string, curve: string): string =>
  e(`EDGE_CURVE('',${v0},${v1},${curve},.T.)`);
const oe = (edgeId: string, sense: 'T' | 'F'): string =>
  e(`ORIENTED_EDGE('',*,*,${edgeId},.${sense}.)`);
const loop = (...oriented: string[]): string => e(`EDGE_LOOP('',${list(...oriented)})`);
const bound = (l: string, sense: 'T' | 'F'): string => e(`FACE_BOUND('',${l},.${sense}.)`);
const face = (bounds: string[], surface: string, sense: 'T' | 'F'): string =>
  e(`ADVANCED_FACE('',${list(...bounds)},${surface},.${sense}.)`);

// ── Product structure ─────────────────────────────────────────────────────────────────────────
const appContext = e(`APPLICATION_CONTEXT('core data for automotive mechanical design processes')`);
const productContext = e(`PRODUCT_CONTEXT('',${appContext},'mechanical')`);
const product = e(`PRODUCT('step-accuracy','step-accuracy','',(${productContext}))`);
const formation = e(`PRODUCT_DEFINITION_FORMATION('','',${product})`);
const defContext = e(`PRODUCT_DEFINITION_CONTEXT('part definition',${appContext},'design')`);
const productDef = e(`PRODUCT_DEFINITION('design','',${formation},${defContext})`);
const productDefShape = e(`PRODUCT_DEFINITION_SHAPE('','',${productDef})`);

// ── Surfaces ─────────────────────────────────────────────────────────────────────────────────
// Placements follow OpenCascade's own style (see box-with-hole.step): a plane's axis is the
// +world direction normal to it and its reference direction is +Z for the vertical sides, +X for
// the horizontal faces; a vertical cylinder or sphere stands on +Z with +X as its reference.
// `same_sense` is then true exactly when that surface normal is the solid's outward normal.
const S = {
  bottom: plane([0, 0, 0], [0, 0, 1], [1, 0, 0]), // (u,v) = (x, y)
  top: plane([0, 0, H], [0, 0, 1], [1, 0, 0]), // (u,v) = (x, y)
  x0: plane([0, 0, 0], [1, 0, 0], [0, 0, 1]), // (u,v) = (z, -y)
  x60: plane([W, 0, 0], [1, 0, 0], [0, 0, 1]), // (u,v) = (z, -y)
  y0: plane([0, 0, 0], [0, 1, 0], [0, 0, 1]), // (u,v) = (z, x)
  y40: plane([0, D, 0], [0, 1, 0], [0, 0, 1]), // (u,v) = (z, x)
  fillet: cylinder([AX, AY, 0], [0, 0, 1], [1, 0, 0], RC), // (u,v) = (angle, z)
  hole: cylinder([HOLE_X, HOLE_Y, 0], [0, 0, 1], [1, 0, 0], HOLE_R), // (u,v) = (angle, z)
  dome: sphere([SPH_X, SPH_Y, SPH_Z], [0, 0, 1], [1, 0, 0], SPH_R), // (u,v) = (lon, lat)
};

// ── Vertices ─────────────────────────────────────────────────────────────────────────────────
const B0 = vtx([0, 0, 0]);
const B1 = vtx([W, 0, 0]);
const B2 = vtx([W, AY, 0]);
const B3 = vtx([AX, D, 0]);
const B4 = vtx([0, D, 0]);
const HB = vtx([HOLE_X + HOLE_R, HOLE_Y, 0]);
const T0 = vtx([0, 0, H]);
const T1 = vtx([W, 0, H]);
const T2 = vtx([W, AY, H]);
const T3 = vtx([AX, D, H]);
const T4 = vtx([0, D, H]);
const HT = vtx([HOLE_X + HOLE_R, HOLE_Y, H]);
const DM = vtx([SPH_X + RIM_R, SPH_Y, H]);

// ── Edges (canonical direction: start vertex → end vertex) ───────────────────────────────────
const EB0 = edge(
  B0,
  B1,
  surfaceCurve(line3([0, 0, 0], [1, 0, 0]), [
    pcurve(S.bottom, line2(0, 0, 1, 0)),
    pcurve(S.y0, line2(0, 0, 0, 1)),
  ]),
);
const EB1 = edge(
  B1,
  B2,
  surfaceCurve(line3([W, 0, 0], [0, 1, 0]), [
    pcurve(S.bottom, line2(W, 0, 0, 1)),
    pcurve(S.x60, line2(0, 0, 0, -1)),
  ]),
);
const EB2 = edge(
  B2,
  B3,
  surfaceCurve(circle3([AX, AY, 0], [0, 0, 1], [1, 0, 0], RC), [
    pcurve(S.bottom, circle2(AX, AY, 1, 0, RC)),
    pcurve(S.fillet, line2(0, 0, 1, 0)),
  ]),
);
const EB3 = edge(
  B3,
  B4,
  surfaceCurve(line3([AX, D, 0], [-1, 0, 0]), [
    pcurve(S.bottom, line2(AX, D, -1, 0)),
    pcurve(S.y40, line2(0, AX, 0, -1)),
  ]),
);
const EB4 = edge(
  B4,
  B0,
  surfaceCurve(line3([0, D, 0], [0, -1, 0]), [
    pcurve(S.bottom, line2(0, D, 0, -1)),
    pcurve(S.x0, line2(0, -D, 0, 1)),
  ]),
);

const ET0 = edge(
  T0,
  T1,
  surfaceCurve(line3([0, 0, H], [1, 0, 0]), [
    pcurve(S.top, line2(0, 0, 1, 0)),
    pcurve(S.y0, line2(H, 0, 0, 1)),
  ]),
);
const ET1 = edge(
  T1,
  T2,
  surfaceCurve(line3([W, 0, H], [0, 1, 0]), [
    pcurve(S.top, line2(W, 0, 0, 1)),
    pcurve(S.x60, line2(H, 0, 0, -1)),
  ]),
);
const ET2 = edge(
  T2,
  T3,
  surfaceCurve(circle3([AX, AY, H], [0, 0, 1], [1, 0, 0], RC), [
    pcurve(S.top, circle2(AX, AY, 1, 0, RC)),
    pcurve(S.fillet, line2(0, H, 1, 0)),
  ]),
);
const ET3 = edge(
  T3,
  T4,
  surfaceCurve(line3([AX, D, H], [-1, 0, 0]), [
    pcurve(S.top, line2(AX, D, -1, 0)),
    pcurve(S.y40, line2(H, AX, 0, -1)),
  ]),
);
const ET4 = edge(
  T4,
  T0,
  surfaceCurve(line3([0, D, H], [0, -1, 0]), [
    pcurve(S.top, line2(0, D, 0, -1)),
    pcurve(S.x0, line2(H, -D, 0, 1)),
  ]),
);

const EV0 = edge(
  B0,
  T0,
  surfaceCurve(line3([0, 0, 0], [0, 0, 1]), [
    pcurve(S.x0, line2(0, 0, 1, 0)),
    pcurve(S.y0, line2(0, 0, 1, 0)),
  ]),
);
const EV1 = edge(
  B1,
  T1,
  surfaceCurve(line3([W, 0, 0], [0, 0, 1]), [
    pcurve(S.x60, line2(0, 0, 1, 0)),
    pcurve(S.y0, line2(0, W, 1, 0)),
  ]),
);
const EV2 = edge(
  B2,
  T2,
  surfaceCurve(line3([W, AY, 0], [0, 0, 1]), [
    pcurve(S.x60, line2(0, -AY, 1, 0)),
    pcurve(S.fillet, line2(0, 0, 0, 1)),
  ]),
);
const EV3 = edge(
  B3,
  T3,
  surfaceCurve(line3([AX, D, 0], [0, 0, 1]), [
    pcurve(S.fillet, line2(HALF_PI, 0, 0, 1)),
    pcurve(S.y40, line2(0, AX, 1, 0)),
  ]),
);
const EV4 = edge(
  B4,
  T4,
  surfaceCurve(line3([0, D, 0], [0, 0, 1]), [
    pcurve(S.y40, line2(0, 0, 1, 0)),
    pcurve(S.x0, line2(0, -D, 1, 0)),
  ]),
);

const EHB = edge(
  HB,
  HB,
  surfaceCurve(circle3([HOLE_X, HOLE_Y, 0], [0, 0, 1], [1, 0, 0], HOLE_R), [
    pcurve(S.bottom, circle2(HOLE_X, HOLE_Y, 1, 0, HOLE_R)),
    pcurve(S.hole, line2(0, 0, 1, 0)),
  ]),
);
const EHT = edge(
  HT,
  HT,
  surfaceCurve(circle3([HOLE_X, HOLE_Y, H], [0, 0, 1], [1, 0, 0], HOLE_R), [
    pcurve(S.top, circle2(HOLE_X, HOLE_Y, 1, 0, HOLE_R)),
    pcurve(S.hole, line2(0, H, 1, 0)),
  ]),
);
// The seam is one 3-D edge used twice by the hole's face, once on each branch of the cylinder's
// periodic parameter: u = 0 and u = 2π. OpenCascade writes it exactly this way.
const ESEAM = edge(
  HB,
  HT,
  seamCurve(line3([HOLE_X + HOLE_R, HOLE_Y, 0], [0, 0, 1]), [
    pcurve(S.hole, line2(0, 0, 0, 1)),
    pcurve(S.hole, line2(TWO_PI, 0, 0, 1)),
  ]),
);

const ED = edge(
  DM,
  DM,
  surfaceCurve(circle3([SPH_X, SPH_Y, H], [0, 0, 1], [1, 0, 0], RIM_R), [
    pcurve(S.top, circle2(SPH_X, SPH_Y, 1, 0, RIM_R)),
    pcurve(S.dome, line2(0, V0, 1, 0)),
  ]),
);

// ── Faces ────────────────────────────────────────────────────────────────────────────────────
// Each loop is authored in its surface's (u,v) space — outer CCW, inner CW — and the bound's
// orientation equals the face's same_sense, which is how OpenCascade's own files are written.
// The bottom, x = 0 and y = 0 faces therefore carry .F. bounds; the rest .T.

// Bottom (outward -Z; surface axis +Z, so same_sense .F.)
const F_bottom = face(
  [
    bound(
      loop(oe(EB0, 'T'), oe(EB1, 'T'), oe(EB2, 'T'), oe(EB3, 'T'), oe(EB4, 'T')),
      'F',
    ),
    bound(loop(oe(EHB, 'F')), 'F'),
  ],
  S.bottom,
  'F',
);

// Top (outward +Z; .T.) — the hole and the dome are inner bounds of the plane.
const F_top = face(
  [
    bound(
      loop(oe(ET0, 'T'), oe(ET1, 'T'), oe(ET2, 'T'), oe(ET3, 'T'), oe(ET4, 'T')),
      'T',
    ),
    bound(loop(oe(EHT, 'F')), 'T'),
    bound(loop(oe(ED, 'F')), 'T'),
  ],
  S.top,
  'T',
);

// x = 0 (outward -X; plane axis +X, so .F.)
const F_x0 = face(
  [bound(loop(oe(EV0, 'F'), oe(EB4, 'F'), oe(EV4, 'T'), oe(ET4, 'T')), 'F')],
  S.x0,
  'F',
);

// y = 0 (outward -Y; plane axis +Y, so .F.)
const F_y0 = face(
  [bound(loop(oe(EV0, 'T'), oe(ET0, 'T'), oe(EV1, 'F'), oe(EB0, 'F')), 'F')],
  S.y0,
  'F',
);

// x = W (outward +X; .T.)
const F_x60 = face(
  [bound(loop(oe(EV1, 'F'), oe(EB1, 'T'), oe(EV2, 'T'), oe(ET1, 'F')), 'T')],
  S.x60,
  'T',
);

// y = D (outward +Y; .T.)
const F_y40 = face(
  [bound(loop(oe(EV4, 'T'), oe(ET3, 'F'), oe(EV3, 'F'), oe(EB3, 'T')), 'T')],
  S.y40,
  'T',
);

// The fillet (convex quarter-cylinder: surface normal is radial outward, so .T.)
const F_fillet = face(
  [bound(loop(oe(EB2, 'T'), oe(EV3, 'T'), oe(ET2, 'F'), oe(EV2, 'F')), 'T')],
  S.fillet,
  'T',
);

// The hole (material outside the cylinder, so its outward normal is radial inward: .F.)
const F_hole = face(
  [bound(loop(oe(EHT, 'F'), oe(ESEAM, 'F'), oe(EHB, 'T'), oe(ESEAM, 'T')), 'F')],
  S.hole,
  'F',
);

// The dome (material inside the sphere, so .T.) — one closed bound at the rim, the cap's pole
// sitting inside the patch.
const F_dome = face([bound(loop(oe(ED, 'T')), 'T')], S.dome, 'T');

const shell = e(
  `CLOSED_SHELL('',${list(F_bottom, F_top, F_x0, F_y0, F_x60, F_y40, F_fillet, F_hole, F_dome)})`,
);
const solid = e(`MANIFOLD_SOLID_BREP('',${shell})`);

// ── The representation ───────────────────────────────────────────────────────────────────────
const rootPlacement = ax3([0, 0, 0], [0, 0, 1], [1, 0, 0]);
const lengthUnit = e(`( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) )`);
const angleUnit = e(`( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) )`);
const solidAngleUnit = e(`( NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT() )`);
const uncertainty = e(
  `UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),${lengthUnit},'distance_accuracy_value','confusion accuracy')`,
);
const geomContext = e(
  `( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((${uncertainty})) GLOBAL_UNIT_ASSIGNED_CONTEXT((${lengthUnit},${angleUnit},${solidAngleUnit})) REPRESENTATION_CONTEXT('Context #1','3D Context with UNIT and UNCERTAINTY') )`,
);
const absr = e(
  `ADVANCED_BREP_SHAPE_REPRESENTATION('',${list(rootPlacement, solid)},${geomContext})`,
);
const shapeDefRep = e(`SHAPE_DEFINITION_REPRESENTATION(${productDefShape},${absr})`);
const protocol = e(
  `APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,${appContext})`,
);
const category = e(`PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,(${product}))`);

const stepText = [
  'ISO-10303-21;',
  'HEADER;',
  "FILE_DESCRIPTION(('Case Maker #873 STEP-accuracy fixture'),'2;1');",
  "FILE_NAME('step-accuracy.step','2026-11-01T00:00:00',('Case Maker'),('Case Maker'),",
  "  'scripts/gen-step-fixture.mts','Case Maker #873','');",
  "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
  'ENDSEC;',
  'DATA;',
  ...entities,
  'ENDSEC;',
  'END-ISO-10303-21;',
  '',
].join('\n');

// ── The same solid, finely tessellated, as a 3MF ─────────────────────────────────────────────
const require = createRequire(import.meta.url);
const wasmPath = require.resolve('manifold-3d/manifold.wasm');
const tl = await ManifoldModule({ locateFile: () => wasmPath });
tl.setup();
const { Manifold } = tl;

const SEG = 256; // segments around every curved feature; sag is ~0.003 mm on the R20 dome

const plate = Manifold.cube([W, D, H]);
// The rounded corner: remove the square [58,60] x [38,40] minus its inscribed R2 quarter disc.
const cornerSquare = Manifold.cube([RC, RC, H]).translate([AX, AY, 0]);
const cornerDisc = Manifold.cylinder(H, RC, RC, SEG).translate([AX, AY, 0]);
const cornerCut = cornerSquare.subtract(cornerDisc);
// The hole, through the plate.
const hole = Manifold.cylinder(H, HOLE_R, HOLE_R, SEG).translate([HOLE_X, HOLE_Y, 0]);
// The dome: the part of the sphere above the plate's top, cut by a box that starts at z = H.
const domeBox = Manifold.cube([W, D, H]).translate([0, 0, H]);
const dome = Manifold.sphere(SPH_R, SEG)
  .translate([SPH_X, SPH_Y, SPH_Z])
  .intersect(domeBox);

const solidMesh = plate.subtract(cornerCut).subtract(hole).add(dome).getMesh();
const mesh = {
  positions: Float32Array.from(solidMesh.vertProperties),
  indices: Uint32Array.from(solidMesh.triVerts),
};
const threeMf = buildThreeMf([mesh]);

// ── Write the pair ───────────────────────────────────────────────────────────────────────────
const OUT = join(process.cwd(), 'tests', 'fixtures', 'goals');
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'step-accuracy.step'), stepText);
writeFileSync(join(OUT, 'step-accuracy-fine.3mf'), Buffer.from(threeMf));

const xs = mesh.positions.filter((_, i) => i % 3 === 0);
const ys = mesh.positions.filter((_, i) => i % 3 === 1);
const zs = mesh.positions.filter((_, i) => i % 3 === 2);
console.log(`step-accuracy.step: ${entities.length} entities`);
console.log(
  `step-accuracy-fine.3mf: ${mesh.indices.length / 3} triangles, ` +
    `bbox ${Math.min(...xs)}..${Math.max(...xs)} x ${Math.min(...ys)}..${Math.max(...ys)} x ` +
    `${Math.min(...zs)}..${Math.max(...zs)}`,
);
