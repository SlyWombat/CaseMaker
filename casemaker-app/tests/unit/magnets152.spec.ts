// Issue #152 — magnet pockets on the case, the captured variant, and the
// swappable nameplate.
//
// What these guard:
//   • every table size: its pocket numbers, and the pocket it cuts
//   • a pocket in a real case wall leaves the stated floor (backing) — a 2 mm
//     wall gets an inside boss rather than a pocket that breaks through
//   • the captured variant is CLOSED, with the stated skin, and its pause height
//   • the plate's pockets and the case's pockets share centres in the assembled
//     frame, on a side face and on the lid
//   • the plate is its own part and lies flat on export
//   • a project with no magnets compiles to the SAME plan (byte-equal JSON) and
//     the same mesh volume and bbox

import { describe, it, expect } from 'vitest';
import {
  MAGNETS,
  MAGNET_CAPTURE_SKIN,
  MAGNET_PRESS_CLEARANCE,
  magnetCapturePauseZ,
  magnetPocket,
  magnetPocketDiameterForRetention,
} from '@/engine/compiler/fasteners';
import {
  MAGNET_BACKING,
  magnetFactsForProject,
  nameplateNodeId,
} from '@/engine/compiler/magnets';
import { compileProject } from '@/engine/compiler/ProjectCompiler';
import { cube, difference, translate, type BuildNode } from '@/engine/compiler/buildPlan';
import { createDefaultProject } from '@/store/projectStore';
import { serializeProject, parseProject } from '@/store/persistence';
import { computePartTransforms, applyPartTransform } from '@/engine/exportLayout';
import { hardwareForProject } from '@/engine/exporters/hardwareList';
import { buildMagnetSizesCoupon } from '@/engine/compiler/fitCoupons';
import { MAGNET_SIZES, type CaseFace, type MeshNode, type NameplateParams, type Project } from '@/types';
import { Manifold, exec, tl, type ManifoldInstance } from './helpers/manifoldExec';

type V3 = [number, number, number];

function solidAt(m: ManifoldInstance, p: V3, s = 0.12): boolean {
  const c = Manifold.cube([s, s, s], true).translate(p);
  const i = Manifold.intersection([m, c]);
  const v = i.volume();
  i.delete();
  c.delete();
  return v > (s * s * s) / 2;
}

const add = (a: V3, b: readonly number[], k = 1): V3 => [a[0] + b[0]! * k, a[1] + b[1]! * k, a[2] + b[2]! * k];

const OUT: Record<CaseFace, V3> = {
  '+x': [1, 0, 0],
  '-x': [-1, 0, 0],
  '+y': [0, 1, 0],
  '-y': [0, -1, 0],
  '+z': [0, 0, 1],
  '-z': [0, 0, -1],
};
/** The face's +u direction (coords.ts faceFrame). */
const U_AXIS: Record<CaseFace, V3> = {
  '+x': [0, 1, 0],
  '-x': [0, 1, 0],
  '+y': [1, 0, 0],
  '-y': [1, 0, 0],
  '+z': [1, 0, 0],
  '-z': [1, 0, 0],
};

function node(project: Project, id: string): BuildNode {
  const n = compileProject(project).nodes.find((x) => x.id === id);
  if (!n) throw new Error(`no node ${id}`);
  return n;
}

function withCase(patch: Partial<Project['case']>): Project {
  const p = createDefaultProject('rpi-4b');
  return { ...p, case: { ...p.case, ...patch } };
}

describe('the magnet table (all seven sizes)', () => {
  it('lists the common discs, each pocket disc + 0.5 Ø and + 0.4 deep, all derived', () => {
    expect([...MAGNET_SIZES]).toEqual(['6x2', '6x3', '8x2', '8x3', '10x2', '10x3', '12x3']);
    for (const s of MAGNET_SIZES) {
      const m = MAGNETS[s];
      const [d, h] = s.split('x').map(Number);
      expect(m.d, s).toBe(d);
      expect(m.h, s).toBe(h);
      expect(m.pocket.d, s).toBeCloseTo(d! + 0.5, 9);
      expect(m.pocket.h, s).toBeCloseTo(h! + 0.4, 9);
      expect(m.source, `${s} is unprinted`).toBe('derived');
      expect(magnetPocketDiameterForRetention(s, 'press'), s).toBeCloseTo(d! + MAGNET_PRESS_CLEARANCE, 9);
      expect(magnetPocketDiameterForRetention(s, 'captured'), s).toBe(m.pocket.d);
    }
  });

  it('cuts each size at its table diameter and depth', () => {
    for (const s of MAGNET_SIZES) {
      const m = exec(
        difference([translate([-10, -10, 0], cube([20, 20, 10])), magnetPocket({ size: s, at: [0, 0, 10], axis: '-z' })]),
      );
      try {
        const { d, h } = MAGNETS[s].pocket;
        const mid = 10 - h / 2;
        expect(solidAt(m, [d / 2 - 0.25, 0, mid]), `${s}: void inside Ø`).toBe(false);
        expect(solidAt(m, [d / 2 + 0.25, 0, mid]), `${s}: wall outside Ø`).toBe(true);
        expect(solidAt(m, [0, 0, 10 - h + 0.2]), `${s}: void to depth`).toBe(false);
        expect(solidAt(m, [0, 0, 10 - h - 0.2]), `${s}: floor under it`).toBe(true);
      } finally {
        m.delete();
      }
    }
  });

  it('states the captured pause height: skin + depth, up to a whole 0.2 mm layer', () => {
    expect(MAGNET_CAPTURE_SKIN).toBe(0.6);
    expect(magnetCapturePauseZ('6x2')).toBe(3.0); // 0.6 + 2.4
    expect(magnetCapturePauseZ('8x3')).toBe(4.0); // 0.6 + 3.4
    expect(magnetCapturePauseZ('6x2', 0.5)).toBe(3.0); // 2.9 rounds up to 3.0
    expect(magnetCapturePauseZ('6x2', 0.6, 0.25)).toBe(3.0);
  });
});

describe('case magnet pockets', () => {
  it('cuts into the front wall and leaves the stated backing, on an inside boss', () => {
    for (const size of ['6x2', '12x3'] as const) {
      const project = withCase({
        magnetPockets: [{ id: 'm', face: '-y', u: 40, v: 15, size, enabled: true }],
      });
      const facts = magnetFactsForProject(project);
      const p = facts.pockets[0]!;
      const { d, h } = MAGNETS[size].pocket;
      // The 2 mm wall is too thin for the pocket + backing, so a boss is added.
      expect(p.wall).toBe(2);
      expect(p.boss).toEqual({ diameter: d + 3.2, length: h + MAGNET_BACKING });
      const m = exec(node(project, 'shell').op);
      try {
        const at = p.world; // on the y = 0 face, pocket runs +y
        expect(solidAt(m, [at[0], 0.2, at[2]]), `${size}: mouth open`).toBe(false);
        expect(solidAt(m, [at[0], h - 0.2, at[2]]), `${size}: void to depth`).toBe(false);
        expect(solidAt(m, [at[0], h + 0.2, at[2]]), `${size}: backing starts at depth`).toBe(true);
        expect(solidAt(m, [at[0], h + MAGNET_BACKING - 0.2, at[2]]), `${size}: backing is ${MAGNET_BACKING} mm`).toBe(true);
        expect(solidAt(m, [at[0], h + MAGNET_BACKING + 0.3, at[2]]), `${size}: cavity behind the boss`).toBe(false);
        expect(solidAt(m, [at[0] + d / 2 + 0.3, 1.0, at[2]]), `${size}: wall around the pocket`).toBe(true);
      } finally {
        m.delete();
      }
    }
  });

  it('cuts a row of `count` pockets at the pitch', () => {
    const project = withCase({
      magnetPockets: [{ id: 'm', face: '-y', u: 40, v: 15, size: '6x2', count: 3, pitch: 12, enabled: true }],
    });
    expect(magnetFactsForProject(project).pockets.map((p) => p.u)).toEqual([28, 40, 52]);
  });

  it('the captured variant is closed by the stated skin, on the floor', () => {
    const project = withCase({
      magnetPockets: [{ id: 'm', face: '-z', u: 30, v: 30, size: '6x2', retention: 'captured', enabled: true }],
    });
    const p = magnetFactsForProject(project).pockets[0]!;
    expect(p.cut).toBe('captured');
    expect(p.skin).toBe(MAGNET_CAPTURE_SKIN);
    expect(p.pauseZ).toBe(3.0);
    const m = exec(node(project, 'shell').op);
    try {
      const { d, h } = MAGNETS['6x2'].pocket;
      const s = MAGNET_CAPTURE_SKIN;
      expect(solidAt(m, [30, 30, 0.1]), 'skin at the bed face').toBe(true);
      expect(solidAt(m, [30, 30, s - 0.1]), 'skin is 0.6 mm').toBe(true);
      expect(solidAt(m, [30, 30, s + 0.1]), 'void begins above the skin').toBe(false);
      expect(solidAt(m, [30, 30, s + h - 0.1]), 'void is the pocket depth').toBe(false);
      expect(solidAt(m, [30, 30, s + h + 0.1]), 'roof above the void').toBe(true);
      expect(solidAt(m, [30 + d / 2 - 0.3, 30, s + h / 2]), 'void is the pocket Ø').toBe(false);
      // Closed: the void adds no surface at the face. Compare with the open cut.
      const open = exec(
        node(withCase({ magnetPockets: [{ id: 'm', face: '-z', u: 30, v: 30, size: '6x2', enabled: true }] }), 'shell').op,
      );
      try {
        expect(solidAt(open, [30, 30, 0.1]), 'the glue pocket IS open at the face').toBe(false);
        // Same boss, same Ø: the captured part keeps the skin's disc of material.
        const skinVol = Math.PI * (d / 2) ** 2 * s;
        expect(m.volume() - open.volume()).toBeGreaterThan(skinVol * 0.6);
      } finally {
        open.delete();
      }
    } finally {
      m.delete();
    }
  });

  it('a captured pocket on a side wall is cut open for glue, and says why', () => {
    const project = withCase({
      magnetPockets: [{ id: 'm', face: '-y', u: 40, v: 15, size: '6x2', retention: 'captured', enabled: true }],
    });
    const facts = magnetFactsForProject(project);
    expect(facts.pockets[0]!.cut).toBe('glue');
    expect(facts.pockets[0]!.skin).toBe(0);
    expect(facts.notes.join(' ')).toMatch(/cannot be captured/);
  });
});

const PLATE: NameplateParams = {
  enabled: true,
  face: '-y',
  u: 40,
  v: 18,
  width: 50,
  height: 16,
  thickness: 4,
  text: 'PI',
  textSize: 7,
  textMode: 'engrave',
  textDepth: 0.6,
  magnetSize: '6x2',
  magnetCount: 2,
};

describe('nameplate', () => {
  for (const face of ['-y', '-x', '+z'] as CaseFace[]) {
    it(`plate pockets and case pockets share centres on the ${face} face`, () => {
      const project = withCase({ nameplate: { ...PLATE, face, u: face === '+z' ? 40 : PLATE.u } });
      const facts = magnetFactsForProject(project);
      expect(facts.nameplate!.nodeId).toBe(nameplateNodeId(face));
      const plan = compileProject(project);
      const plateNode = plan.nodes.find((n) => n.id === nameplateNodeId(face))!;
      expect(plateNode, 'the plate is its own part').toBeDefined();
      const caseNode = plan.nodes.find((n) => n.id === (face === '+z' ? 'lid' : 'shell'))!;
      const plate = exec(plateNode.op);
      const body = exec(caseNode.op);
      try {
        const n = OUT[face];
        const u = U_AXIS[face];
        const r = MAGNETS['6x2'].pocket.d / 2;
        expect(facts.pockets).toHaveLength(2);
        for (const p of facts.pockets) {
          // The plate's pocket opens on its back, at the face, going OUTWARD.
          const inPlate = add(p.world, n, 1.2);
          const inCase = add(p.world, n, -1.2);
          for (const [solid, at, what] of [
            [plate, inPlate, 'plate'],
            [body, inCase, 'case'],
          ] as const) {
            expect(solidAt(solid, at), `${what} pocket at the shared centre`).toBe(false);
            expect(solidAt(solid, add(at, u, r - 0.3)), `${what}: void to +r`).toBe(false);
            expect(solidAt(solid, add(at, u, -(r - 0.3))), `${what}: void to −r`).toBe(false);
            expect(solidAt(solid, add(at, u, r + 0.3)), `${what}: wall past +r`).toBe(true);
            expect(solidAt(solid, add(at, u, -(r + 0.3))), `${what}: wall past −r`).toBe(true);
          }
        }
        // The plate's back sits ON the face: solid just outside it between the pockets.
        const mid = add(facts.pockets[0]!.world, u, (facts.pockets[1]!.u - facts.pockets[0]!.u) / 2);
        expect(solidAt(plate, add(mid, n, 0.1)), 'plate back on the face').toBe(true);
        expect(solidAt(plate, add(mid, n, -0.1)), 'and not inside the case').toBe(false);
      } finally {
        plate.delete();
        body.delete();
      }
    });
  }

  it('spreads its magnets edge to edge and flags a plate too thin for them', () => {
    const facts = magnetFactsForProject(withCase({ nameplate: PLATE }));
    // 50 wide, 6.5 pocket, 3 mm edge: centres ±(25 − 3.25 − 3).
    expect(facts.nameplate!.offsets).toEqual([-18.75, 18.75]);
    expect(facts.notes).toEqual([]);
    const thin = magnetFactsForProject(withCase({ nameplate: { ...PLATE, thickness: 3 } }));
    expect(thin.nameplate!.plateDepth).toBe(1.8);
    expect(thin.notes.join(' ')).toMatch(/3 mm thick.*needs 3.6 mm.*0.2 mm proud/);
  });

  it('lies flat, back down, in the print layout', () => {
    for (const face of ['-y', '+y', '-x', '+x', '+z', '-z'] as CaseFace[]) {
      const project = withCase({ nameplate: { ...PLATE, face, u: 30, v: face === '+z' || face === '-z' ? 30 : 15 } });
      const n = node(project, nameplateNodeId(face));
      const m = exec(n.op);
      const mesh = m.getMesh();
      const positions = new Float32Array(mesh.vertProperties);
      m.delete();
      const meshNode = { id: n.id, buffer: { positions, indices: mesh.triVerts } } as unknown as MeshNode;
      const t = computePartTransforms([meshNode]).get(n.id)!;
      const laid = applyPartTransform(positions, t);
      let zMax = -Infinity;
      for (let i = 2; i < laid.length; i += 3) zMax = Math.max(zMax, laid[i]!);
      expect(zMax, `${face}: plate height on the bed is its thickness`).toBeCloseTo(PLATE.thickness, 3);
      // Back down: the pockets open onto the bed, so a slice at the bed has
      // less plate in it than one just above the pockets (2.6–2.8 mm).
      const laidM = new tl.Manifold(new tl.Mesh({ numProp: 3, vertProperties: laid, triVerts: mesh.triVerts }));
      const slice = (z0: number) => {
        const box = Manifold.cube([1000, 1000, 0.2]).translate([-500, -500, z0]);
        const i = Manifold.intersection([laidM, box]);
        const v = i.volume();
        i.delete();
        box.delete();
        return v;
      };
      const pocketArea = 2 * Math.PI * (MAGNETS['6x2'].pocket.d / 2) ** 2;
      expect(slice(2.6) - slice(0), `${face}: pockets on the bed`).toBeGreaterThan(pocketArea * 0.2 * 0.8);
      laidM.delete();
    }
  });

  it('round-trips through the schema', () => {
    const original = withCase({
      nameplate: PLATE,
      magnetPockets: [{ id: 'm', face: '+z', u: 5, v: 5, size: '12x3', count: 2, pitch: 20, retention: 'captured', enabled: true }],
    });
    const parsed = parseProject(serializeProject(original));
    expect(parsed.case.nameplate).toEqual(PLATE);
    expect(parsed.case.magnetPockets).toEqual(original.case.magnetPockets);
  });

  it('bills the magnets: one per case pocket, two per nameplate position', () => {
    const items = hardwareForProject(
      withCase({
        nameplate: PLATE,
        magnetPockets: [{ id: 'm', face: '-z', u: 5, v: 5, size: '6x2', count: 2, enabled: true }],
      }),
    );
    const mags = items.filter((i) => i.id.startsWith('magnets-'));
    expect(mags).toHaveLength(1);
    expect(mags[0]!.count).toBe(2 + 2 * 2);
    expect(hardwareForProject(createDefaultProject('rpi-4b')).some((i) => i.id.startsWith('magnets-'))).toBe(false);
  });
});

describe('pockets and ports', () => {
  it('says so when a pocket runs into a port cutout (the Pi 4B USB end)', () => {
    const facts = magnetFactsForProject(
      withCase({ magnetPockets: [{ id: 'm', face: '+x', u: 21, v: 15, size: '6x2', enabled: true }] }),
    );
    expect(facts.notes.join(' ')).toMatch(/runs into the .* cutout/);
    const clear = magnetFactsForProject(
      withCase({ magnetPockets: [{ id: 'm', face: '-x', u: 40, v: 15, size: '6x2', enabled: true }] }),
    );
    expect(clear.notes).toEqual([]);
  });
});

describe('a project without magnets is unchanged', () => {
  it('compiles to a byte-identical plan whether the fields are absent, empty or disabled', () => {
    const base = createDefaultProject('rpi-4b');
    const json = (p: Project) => JSON.stringify(compileProject(p).nodes);
    const ref = json(base);
    expect(json({ ...base, case: { ...base.case, magnetPockets: [] } })).toBe(ref);
    expect(json({ ...base, case: { ...base.case, nameplate: { ...PLATE, enabled: false } } })).toBe(ref);
    expect(
      json({ ...base, case: { ...base.case, magnetPockets: [{ id: 'x', face: '-y', u: 9, v: 9, size: '6x2', enabled: false }] } }),
    ).toBe(ref);
  });
});

describe('magnet size coupon', () => {
  it('carries one labelled pocket of every table size, at the table fit', () => {
    const labels: string[] = [];
    const built = buildMagnetSizesCoupon((text) => {
      labels.push(text);
      return [];
    });
    expect(labels).toEqual(['62', '63', '82', '83', '102', '103', '123']);
    const m = exec(built.op);
    try {
      expect(m.decompose().length).toBe(1);
      expect(m.genus(), 'every pocket blind').toBe(0);
      MAGNET_SIZES.forEach((s, i) => {
        const { d, h } = MAGNETS[s].pocket;
        const c = built.columns[i]!;
        const top = built.dims.z;
        expect(solidAt(m, [c.x + d / 2 - 0.25, 18, top - h / 2]), `${s} void`).toBe(false);
        expect(solidAt(m, [c.x + d / 2 + 0.25, 18, top - h / 2]), `${s} wall`).toBe(true);
        expect(solidAt(m, [c.x, 18, top - h - 0.2]), `${s} floor`).toBe(true);
      });
    } finally {
      m.delete();
    }
  });
});
