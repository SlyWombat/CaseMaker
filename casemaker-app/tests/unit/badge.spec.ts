import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';

import {
  BADGE_BOTTOM_NODE_ID,
  BADGE_TOP_NODE_ID,
  badgeOutline,
  buildBadgeNodes,
} from '@/engine/compiler/badge';
import { buildThreeMf } from '@/workers/export/threeMf';
import { derivedKind } from '@/engine/compiler/archetype';
import { compileProject } from '@/engine/compiler/ProjectCompiler';
import { defaultBadgeParams, badgeParamsProblem, type BadgeParams } from '@/types/badge';
import { findTemplate } from '@/library/templates';
import { createDefaultProject } from '@/store/projectStore';
import { exec } from './helpers/manifoldExec';

/**
 * Issue #167 — the badge compiler, checked against the one-time oracle.
 *
 * `samples/badge-blank/*.stl` are the output of `make_badge.py`, the Python
 * script this port replaces. It is the user's file and must not be touched;
 * here it is only read. The STLs are binary, so the reader below is 30 lines
 * rather than a dependency — and a skipped test is better than a fetched one,
 * so the oracle assertions skip when the samples are not checked out.
 */

const here = dirname(fileURLToPath(import.meta.url));
const samplesDir = join(here, '..', '..', '..', 'samples', 'badge-blank');
const ORACLE = {
  bottom: join(samplesDir, 'badge-blank-T2-bottom.stl'),
  top: join(samplesDir, 'badge-blank-T3-top.stl'),
};
const hasOracle = existsSync(ORACLE.bottom) && existsSync(ORACLE.top);

interface StlData {
  volume: number;
  bbox: { min: number[]; max: number[] };
  triangles: number;
}

/** Binary STL: 80-byte header, uint32 facet count, then 50 bytes per facet. */
function readBinaryStl(path: string): StlData {
  const buf = readFileSync(path);
  const triangles = buf.readUInt32LE(80);
  expect(buf.length, `${path} is a binary STL whose length matches its facet count`).toBe(
    84 + triangles * 50,
  );
  const vert = (base: number): [number, number, number] => [
    buf.readFloatLE(base),
    buf.readFloatLE(base + 4),
    buf.readFloatLE(base + 8),
  ];
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let volume = 0;
  for (let i = 0; i < triangles; i++) {
    const base = 84 + i * 50 + 12; // skip the stored normal; it is redundant
    const [a, b, c] = [vert(base), vert(base + 12), vert(base + 24)];
    for (const p of [a, b, c]) {
      for (let k = 0; k < 3; k++) {
        if (p[k]! < min[k]!) min[k] = p[k]!;
        if (p[k]! > max[k]!) max[k] = p[k]!;
      }
    }
    // Signed tetrahedra from the origin sum to the enclosed volume for a
    // closed, outward-oriented mesh, which is what the script emits.
    volume +=
      (a[0] * (b[1] * c[2] - b[2] * c[1]) -
        a[1] * (b[0] * c[2] - b[2] * c[0]) +
        a[2] * (b[0] * c[1] - b[1] * c[0])) /
      6;
  }
  return { volume: Math.abs(volume), bbox: { min, max }, triangles };
}

/** Outline area of the rounded rectangle: the full rect less the four corners. */
function outlineArea(b: BadgeParams): number {
  return b.width * b.height - (4 - Math.PI) * b.cornerRadius * b.cornerRadius;
}

function meshBox(b: BadgeParams) {
  const out = new Map<string, { volume: number; bbox: { min: number[]; max: number[] } }>();
  for (const node of buildBadgeNodes(b)!) {
    const m = exec(node.op);
    try {
      const bb = m.boundingBox();
      out.set(node.id, { volume: m.volume(), bbox: { min: [...bb.min], max: [...bb.max] } });
    } finally {
      m.delete();
    }
  }
  return out;
}

const DEFAULTS = defaultBadgeParams();

describe('#167 — badge compiler', () => {
  it('emits exactly two nodes, each one connected solid', () => {
    const nodes = buildBadgeNodes(DEFAULTS)!;
    expect(nodes.map((n) => n.id)).toEqual([BADGE_BOTTOM_NODE_ID, BADGE_TOP_NODE_ID]);
    for (const node of nodes) {
      const m = exec(node.op);
      try {
        const parts = m.decompose();
        expect(parts.length, `${node.id} is one connected solid`).toBe(1);
        parts.forEach((p) => p.delete());
      } finally {
        m.delete();
      }
    }
  });

  it('centres the outline on the origin, back face at z = 0 (#167 triage item 4)', () => {
    const nodes = buildBadgeNodes(DEFAULTS)!;
    const bottom = exec(nodes[0]!.op);
    const top = exec(nodes[1]!.op);
    try {
      const b = bottom.boundingBox();
      const t = top.boundingBox();
      expect(b.min[0]).toBeCloseTo(-38.1, 6);
      expect(b.max[0]).toBeCloseTo(38.1, 6);
      expect(b.min[1]).toBeCloseTo(-19.05, 6);
      expect(b.max[1]).toBeCloseTo(19.05, 6);
      expect(b.min[2]).toBeCloseTo(0, 6);
      expect(b.max[2]).toBeCloseTo(3.0, 6);
      expect(t.min[2]).toBeCloseTo(3.0, 6);
      expect(t.max[2]).toBeCloseTo(3.81, 6);
    } finally {
      bottom.delete();
      top.delete();
    }
  });

  it('carries the analytic volume (outline × each colour band, less the pocket)', () => {
    const { thickness: T, splitHeight: S } = DEFAULTS;
    const pocket = DEFAULTS.magnetPocket!;
    const area = outlineArea(DEFAULTS);
    const boxes = meshBox(DEFAULTS);
    const bottom = boxes.get(BADGE_BOTTOM_NODE_ID)!;
    const top = boxes.get(BADGE_TOP_NODE_ID)!;
    // 5 mm³ — the kernel approximates the corner arcs with its own segment
    // count, so neither band is the analytic prism to the last decimal.
    expect(Math.abs(bottom.volume - (area * S - pocket.length * pocket.width * pocket.depth)))
      .toBeLessThan(5);
    expect(Math.abs(top.volume - area * (T - S))).toBeLessThan(5);
  });

  it('omits the pocket when magnetPocket is null', () => {
    const plain = defaultBadgeParams({ magnetPocket: null });
    const bottom = meshBox(plain).get(BADGE_BOTTOM_NODE_ID)!;
    expect(Math.abs(bottom.volume - outlineArea(plain) * plain.splitHeight)).toBeLessThan(5);
  });

  it('refuses to build an unbuildable parameter set rather than emitting junk', () => {
    expect(buildBadgeNodes(defaultBadgeParams({ splitHeight: 5 }))).toBeNull(); // split ≥ thickness
    expect(buildBadgeNodes(defaultBadgeParams({ thickness: 0 }))).toBeNull();
  });

  it('badgeOutline is a translate (the origin-centred convention)', () => {
    expect(badgeOutline(DEFAULTS).kind).toBe('p-translate');
  });

  it.runIf(hasOracle)('matches the oracle STLs from make_badge.py', () => {
    const boxes = meshBox(DEFAULTS);
    for (const [id, path] of [
      [BADGE_BOTTOM_NODE_ID, ORACLE.bottom],
      [BADGE_TOP_NODE_ID, ORACLE.top],
    ] as const) {
      const oracle = readBinaryStl(path);
      const mine = boxes.get(id)!;
      expect(oracle.triangles, `${id} oracle has facets`).toBeGreaterThan(0);
      for (let a = 0; a < 3; a++) {
        expect(mine.bbox.min[a]!).toBeCloseTo(oracle.bbox.min[a]!, 2);
        expect(mine.bbox.max[a]!).toBeCloseTo(oracle.bbox.max[a]!, 2);
      }
      // 0.5 %: the script chords each corner with SEG = 16 while the kernel's
      // round-join offset picks its own segment count, so the two outlines are
      // the same shape approximated differently.
      expect(Math.abs(mine.volume - oracle.volume) / oracle.volume, `${id} volume`).toBeLessThan(
        0.005,
      );
    }
  });
});

describe('#167 — badgeParamsProblem', () => {
  it('passes the oracle defaults', () => {
    expect(badgeParamsProblem(DEFAULTS)).toBeNull();
  });

  it('names the split-through-pocket failure the script asserts', () => {
    const b = defaultBadgeParams({ magnetPocket: { length: 45, width: 13, depth: 3.5 } });
    expect(badgeParamsProblem(b)).toMatch(/colour split/);
  });

  it('catches a split at or above the thickness, and an oversized pocket', () => {
    expect(badgeParamsProblem(defaultBadgeParams({ splitHeight: 3.81 }))).toMatch(/thickness/);
    const b = defaultBadgeParams({ magnetPocket: { length: 76, width: 13, depth: 2 } });
    expect(badgeParamsProblem(b)).toMatch(/too big/);
  });
});

describe('#167 — archetype dispatch', () => {
  it('is rack > stand > badge > shell', () => {
    const base = createDefaultProject('rpi-4b');
    expect(derivedKind(base)).toBe('shell');
    // A null project (the welcome screen) is the plain shell, not a throw.
    expect(derivedKind(null)).toBe('shell');
    expect(derivedKind(findTemplate('badge-blank')!.build())).toBe('badge');

    // Real parameter sets from the templates that own them, so precedence is
    // checked against shapes that actually compile.
    const rack = findTemplate('mini-rack-10in')!.build().case.rack!;
    const stand = findTemplate('guition-desk-stand')!.build().case.stand!;
    const badgeCase = { ...base.case, badge: defaultBadgeParams() };

    expect(derivedKind({ ...base, case: badgeCase })).toBe('badge');
    expect(derivedKind({ ...base, case: { ...badgeCase, stand } })).toBe('stand');
    expect(derivedKind({ ...base, case: { ...badgeCase, stand, rack } })).toBe('rack');
  });

  it('the template compiles to exactly the two badge parts', () => {
    const plan = compileProject(findTemplate('badge-blank')!.build());
    expect(plan.nodes.map((n) => n.id)).toEqual([BADGE_BOTTOM_NODE_ID, BADGE_TOP_NODE_ID]);
    expect(plan.placementReport!.errorCount).toBe(0);
  });

  it('reports an unbuildable badge instead of crashing', () => {
    const project = findTemplate('badge-blank')!.build();
    project.case.badge = defaultBadgeParams({ splitHeight: 6 });
    const plan = compileProject(project);
    // It falls through to the shell rather than emitting a degenerate badge...
    expect(plan.nodes.some((n) => n.id === BADGE_BOTTOM_NODE_ID)).toBe(false);
    // ...and the placement report says why.
    const issue = plan.placementReport!.issues.find((i) => i.kind === 'badge-config');
    expect(issue, 'a badge-config issue is reported').toBeDefined();
    expect(issue!.severity).toBe('error');
  });
});

/**
 * Issue #168 — a two-colour badge is only "ready to print" if the slicer can
 * tell the two colours apart. The geometry above is unchanged by that; this is
 * the part that makes the exported file a multi-material object rather than two
 * loose ones.
 */
describe('#168 — the badge carries its tools to the slicer', () => {
  const b = defaultBadgeParams();

  /** The compiled nodes' geometry as the export path sees it. */
  function meshInputs(plan: ReturnType<typeof compileProject>) {
    return plan.nodes.map((n) => {
      const m = exec(n.op);
      try {
        const mesh = m.getMesh();
        const numProp = mesh.numProp;
        const numVert = mesh.vertProperties.length / numProp;
        const positions = new Float32Array(numVert * 3);
        for (let i = 0; i < numVert; i++) {
          for (let k = 0; k < 3; k++) positions[i * 3 + k] = mesh.vertProperties[i * numProp + k]!;
        }
        return {
          positions,
          indices: new Uint32Array(mesh.triVerts),
          material: n.material,
          name: n.id,
          triangles: mesh.triVerts.length / 3,
        };
      } finally {
        m.delete();
      }
    });
  }

  it('tags each colour with its own tool, straight off BadgeParams', () => {
    const custom = defaultBadgeParams({ bottomExtruder: 4, topExtruder: 1 });
    expect(buildBadgeNodes(custom)!.map((n) => n.material?.extruder)).toEqual([4, 1]);
    expect(buildBadgeNodes(b)!.map((n) => n.material?.extruder)).toEqual([2, 3]);
  });

  it('compiles to a 3MF the slicer reads as one two-part object', () => {
    const plan = compileProject(findTemplate('badge-blank')!.build());
    const meshes = meshInputs(plan);
    const zip = unzipSync(
      new Uint8Array(buildThreeMf(meshes, { objectName: 'badge-blank' })),
    );
    const model = new TextDecoder().decode(zip['3D/3dmodel.model']!);
    const config = new TextDecoder().decode(zip['Metadata/Slic3r_PE_model.config']!);

    expect(model.match(/<object /g)?.length, 'one object, not two').toBe(1);
    expect(config).toContain('<metadata type="object" key="name" value="badge-blank"/>');
    expect(config).toContain('<volume firstid="0"');
    // The split is the bottom band's own triangle count — the number that
    // breaks silently if the two ever stop being emitted from one outline.
    expect(config).toContain(`<volume firstid="${meshes[0]!.triangles}"`);
    expect(config).toContain('key="name" value="badge-bottom"');
    expect(config).toContain('key="name" value="badge-top"');
    // 2 for the bottom colour, 3 for the top — the oracle's `--ext 2 3`.
    expect(config).toContain('<metadata type="volume" key="extruder" value="2"/>');
    expect(config).toContain('<metadata type="volume" key="extruder" value="3"/>');
  });

  it('a single badge half exported alone still says which tool it is', () => {
    const plan = compileProject(findTemplate('badge-blank')!.build());
    const [bottomMesh] = meshInputs(plan);
    const zip = unzipSync(new Uint8Array(buildThreeMf([bottomMesh!])));
    const config = new TextDecoder().decode(zip['Metadata/Slic3r_PE_model.config']!);
    expect(config).toContain('<volume firstid="0"');
    expect(config).toContain('<metadata type="volume" key="extruder" value="2"/>');
  });
});
