import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import ManifoldModule from 'manifold-3d';
import * as opentype from 'opentype.js';
import { executeOpSync, executeProfile } from '@/workers/geometry/evaluateOp';
import { glyphProfile, capHeightEm } from '@/engine/compiler/glyphs';
import { aabbOfProfile, type Profile } from '@/engine/compiler/profile';
import { buildTextLabelOps } from '@/engine/compiler/textLabels';
import { compileProject } from '@/engine/compiler/ProjectCompiler';
import { resolveFont, BUNDLED_FONTS } from '@/engine/fonts/registry';
import { faceFrame } from '@/engine/coords';
import { computeShellDims } from '@/engine/compiler/caseShell';
import { computeLidDims } from '@/engine/compiler/lid';
import { createDefaultProject } from '@/store/projectStore';
import { parseProject, serializeProject } from '@/store/persistence';
import type { TextLabel } from '@/types/textLabel';

type TL = Awaited<ReturnType<typeof ManifoldModule>>;
let tl: TL;

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  tl = await ManifoldModule({ locateFile: () => require.resolve('manifold-3d/manifold.wasm') });
  tl.setup();
});

function contours(p: Profile) {
  if (p.kind !== 'p-poly') throw new Error('expected p-poly');
  return p.contours;
}

function area(p: Profile): number {
  const cs = executeProfile(tl, p);
  const a = cs.area();
  cs.delete();
  return a;
}

const sans = () => resolveFont('sans-default');

describe('glyphProfile (issue #169)', () => {
  it('uses the NonZero fill rule', () => {
    expect(glyphProfile('o', sans(), 5)).toMatchObject({ kind: 'p-poly', fillRule: 'NonZero' });
  });

  it('contour count matches the glyph set: o=2, B=3, I=1, i=2, "oB"=5', () => {
    const f = sans();
    expect(contours(glyphProfile('o', f, 5)).length).toBe(2);
    expect(contours(glyphProfile('B', f, 5)).length).toBe(3);
    expect(contours(glyphProfile('I', f, 5)).length).toBe(1);
    expect(contours(glyphProfile('i', f, 5)).length).toBe(2);
    expect(contours(glyphProfile('oB', f, 5)).length).toBe(5);
  });

  it('whitespace yields no contours', () => {
    expect(contours(glyphProfile('   ', sans(), 5)).length).toBe(0);
  });

  it('scales by CAP height, y-up, baseline at 0', () => {
    for (const def of BUNDLED_FONTS) {
      const b = aabbOfProfile(glyphProfile('H', resolveFont(def.id), 5))!;
      expect(b.min[1]).toBeCloseTo(0, 2);
      expect(b.max[1]).toBeCloseTo(5, 1);
    }
  });

  it('capHeightEm reads OS/2 sCapHeight, falling back to the measured H', () => {
    const f = sans();
    expect(capHeightEm(f)).toBeCloseTo(0.7, 3);
    const saved = f.tables.os2!.sCapHeight;
    try {
      f.tables.os2!.sCapHeight = 0;
      expect(capHeightEm(f)).toBeCloseTo(0.7, 2);
    } finally {
      f.tables.os2!.sCapHeight = saved;
    }
  });

  it("total area matches a reference: 'I' is a plain bar, and 'o' ring area equals the shoelace sum", () => {
    // 'I' in Barlow is (nearly) one rectangle: area ~ ink width x cap height.
    const iProf = glyphProfile('I', sans(), 5);
    const ib = aabbOfProfile(iProf)!;
    const rect = (ib.max[0] - ib.min[0]) * (ib.max[1] - ib.min[1]);
    expect(Math.abs(area(iProf) - rect) / rect).toBeLessThan(0.01); // within 1% of its bbox

    // Independent reference for a curved glyph: outer minus inner via shoelace.
    const o = glyphProfile('o', sans(), 5);
    const [c0, c1] = contours(o);
    const shoelace = (c: [number, number][]) => {
      let s = 0;
      for (let i = 0; i < c.length; i++) {
        const [x0, y0] = c[i]!;
        const [x1, y1] = c[(i + 1) % c.length]!;
        s += x0 * y1 - x1 * y0;
      }
      return Math.abs(s) / 2;
    };
    const ref = Math.abs(shoelace(c0!) - shoelace(c1!));
    expect(ref).toBeGreaterThan(1);
    expect(area(o)).toBeCloseTo(ref, 3);
  });

  it('kerning shortens "AV" relative to no kerning', () => {
    const f = sans();
    const w = (k: boolean) => {
      const b = aabbOfProfile(glyphProfile('AV', f, 5, { kerning: k }))!;
      return b.max[0] - b.min[0];
    };
    expect(w(true)).toBeLessThan(w(false));
  });

  it('a glyph made of OVERLAPPING same-direction contours is solid, not holed', () => {
    // 'H' is the cap-height reference; 'A' is two overlapping squares.
    const sq = (x0: number, x1: number) => {
      const p = new opentype.Path();
      p.moveTo(x0, 0);
      p.lineTo(x0, 700);
      p.lineTo(x1, 700);
      p.lineTo(x1, 0);
      p.close();
      return p;
    };
    const both = new opentype.Path();
    both.commands.push(...sq(0, 700).commands, ...sq(350, 1050).commands);
    const font = new opentype.Font({
      familyName: 'Overlap',
      styleName: 'Regular',
      unitsPerEm: 1000,
      ascender: 800,
      descender: -200,
      glyphs: [
        new opentype.Glyph({ name: '.notdef', advanceWidth: 600, path: new opentype.Path() }),
        new opentype.Glyph({ name: 'A', unicode: 65, advanceWidth: 1100, path: both }),
        new opentype.Glyph({ name: 'H', unicode: 72, advanceWidth: 800, path: sq(0, 700) }),
      ],
    });
    font.tables.os2 = { sCapHeight: 700 };

    const prof = glyphProfile('A', font, 7); // 1 font unit = 0.01 mm
    expect(contours(prof).length).toBe(2);
    const union = 1050 * 700 * 1e-4;
    expect(area(prof)).toBeCloseTo(union, 3); // solid: overlap NOT cut out

    // Same contours under even-odd (the global default) read the overlap as a hole:
    // A + B - 2*overlap = union - overlap.
    const asEvenOdd: Profile = { kind: 'p-poly', contours: contours(prof) };
    expect(area(asEvenOdd)).toBeCloseTo(union - 350 * 700 * 1e-4, 3);
  });
});

describe('text labels on the case (issue #169)', () => {
  const faces = ['+z', '-z', '+x', '-x', '+y', '-y'] as const;
  const mk = (face: TextLabel['face'], mode: TextLabel['mode']): TextLabel => ({
    id: `l-${face}`,
    text: 'I   .',
    font: 'sans-default',
    weight: 'regular',
    size: 5,
    face,
    position: { u: 20, v: 12 },
    rotation: 0,
    depth: 0.6,
    mode,
    enabled: true,
  });
  const dot = (a: readonly number[], b: readonly number[]) =>
    a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;

  for (const face of faces) {
    for (const mode of ['emboss', 'engrave'] as const) {
      it(`${mode} on ${face}: reads left-to-right and upright from OUTSIDE, on the correct side of the wall`, () => {
        const project = createDefaultProject('rpi-4b');
        const ops = buildTextLabelOps([mk(face, mode)], project.board, project.case);
        // Issue #179 — a +z label belongs to the lid node (lid-local coords),
        // not the shell; every other face stays on the shell.
        const onLid = face === '+z';
        const group = onLid
          ? mode === 'emboss' ? ops.lidAdditive : ops.lidSubtractive
          : mode === 'emboss' ? ops.additive : ops.subtractive;
        expect(group.length).toBe(1);
        const solid = executeOpSync(tl, group[0]!);
        const parts = solid.decompose();
        expect(parts.length).toBe(2); // the 'I' and the '.'
        const info = parts.map((m) => {
          const b = m.boundingBox();
          return {
            c: [0, 1, 2].map((i) => (b.min[i]! + b.max[i]!) / 2),
            ext: [0, 1, 2].map((i) => b.max[i]! - b.min[i]!),
            min: b.min as number[],
            max: b.max as number[],
          };
        });

        const d = computeShellDims(project.board, project.case, [], () => undefined);
        const frameZ = onLid
          ? computeLidDims(project.board, project.case).z
          : d.outerZ;
        const frame = faceFrame(face, d.outerX, d.outerY, frameZ);
        const tall = info.slice().sort((a, b) => spanAlong(b, frame.vAxis) - spanAlong(a, frame.vAxis));
        const iPart = tall[0]!;
        const dotPart = tall[1]!;

        // 'I' is cap height (5mm) along the face's v axis.
        expect(spanAlong(iPart, frame.vAxis)).toBeCloseTo(5, 1);

        // Reading direction (I -> dot), seen from outside. faceFrame's (u,v) is
        // left-handed about the outward normal on -z, +y, -x; text must NOT mirror.
        const cross = [
          frame.uAxis[1] * frame.vAxis[2] - frame.uAxis[2] * frame.vAxis[1],
          frame.uAxis[2] * frame.vAxis[0] - frame.uAxis[0] * frame.vAxis[2],
          frame.uAxis[0] * frame.vAxis[1] - frame.uAxis[1] * frame.vAxis[0],
        ];
        const rightHanded = dot(cross, frame.outwardAxis) > 0;
        const right = frame.uAxis.map((x) => (rightHanded ? x : -x));
        const reading = dotPart.c.map((x, i) => x - iPart.c[i]!);
        expect(dot(reading, right)).toBeGreaterThan(5);

        // Depth side: along the outward axis the solid spans the face plane.
        const outCoord = (p: number[]) => dot(p, frame.outwardAxis);
        const planeAt = dot(placeOrigin(frame), frame.outwardAxis);
        const lo = Math.min(outCoord(iPart.min), outCoord(iPart.max));
        const hi = Math.max(outCoord(iPart.min), outCoord(iPart.max));
        if (mode === 'emboss') {
          // Issue #179 — the emboss base embeds a hair BELOW the face plane
          // (volumetric overlap so the union fuses), and the ink still stands
          // `depth` proud of the surface.
          expect(lo).toBeLessThan(planeAt);
          expect(lo).toBeGreaterThan(planeAt - 0.5);
          expect(hi).toBeCloseTo(planeAt + 0.6, 2);
        } else {
          expect(lo).toBeCloseTo(planeAt - 0.6, 2);
          expect(hi).toBeGreaterThan(planeAt); // breaks out through the face
        }
      });
    }
  }

  function placeOrigin(f: ReturnType<typeof faceFrame>) {
    return f.origin;
  }
  function spanAlong(p: { min: number[]; max: number[] }, axis: readonly number[]) {
    return Math.abs(
      (p.max[0]! - p.min[0]!) * axis[0]! + (p.max[1]! - p.min[1]!) * axis[1]! + (p.max[2]! - p.min[2]!) * axis[2]!,
    );
  }

  it('engraved text removes material from the shell wall (and none from an empty label)', () => {
    const project = createDefaultProject('rpi-4b');
    const shellVolume = (labels: TextLabel[]) => {
      const plan = compileProject({ ...project, textLabels: labels });
      const m = executeOpSync(tl, plan.nodes.find((n) => n.id === 'shell')!.op);
      const v = m.volume();
      m.delete();
      return v;
    };
    const none = shellVolume([]);
    const cut = shellVolume([{ ...mk('-y', 'engrave'), text: 'USB', position: { u: 30, v: 12 } }]);
    expect(cut).toBeLessThan(none - 1);
    expect(cut).toBeGreaterThan(none - 30); // a few mm^3, not the wall
  });

  it('a custom embedded font resolves; an unknown id falls back to the default', () => {
    const bytes = fs.readFileSync('src/engine/fonts/files/IBMPlexSerif-Regular.ttf');
    const data = bytes.toString('base64');
    const cf = [{ id: 'custom-1', name: 'Serif', data }];
    const custom = resolveFont('custom-1', 'regular', cf);
    expect(custom.names.en ?? custom.names.windows).toBeDefined();
    expect(resolveFont('gone', 'regular', cf)).toBe(sans());
    expect(glyphProfile('B', custom, 5)).toMatchObject({ kind: 'p-poly' });
  });
});

describe('project schema v8 (issue #169)', () => {
  it("a v7 project with font 'sans-default' / 'mono-default' loads, keeps its font ids, and compiles", () => {
    const v7 = {
      ...createDefaultProject('rpi-4b'),
      schemaVersion: 7,
      textLabels: [
        { id: 'a', text: 'USB-C', font: 'sans-default', weight: 'regular', size: 4, face: '+z', position: { u: 20, v: 20 }, rotation: 0, depth: 0.6, mode: 'engrave', enabled: true },
        { id: 'b', text: 'PWR', font: 'mono-default', weight: 'bold', size: 4, face: '-y', position: { u: 20, v: 6 }, rotation: 0, depth: 0.6, mode: 'emboss', enabled: true },
      ],
    } as Record<string, unknown>;
    delete v7.customFonts;
    const parsed = parseProject(JSON.stringify(v7));
    expect(parsed.schemaVersion).toBe(10);
    expect(parsed.customFonts).toEqual([]);
    expect(parsed.textLabels.map((l) => l.font)).toEqual(['sans-default', 'mono-default']);
    const plan = compileProject(parsed);
    expect(plan.nodes.length).toBeGreaterThan(0);
    for (const n of plan.nodes) executeOpSync(tl, n.op).delete();
  });

  it('a new font id and customFonts survive a serialize/parse round trip (schema does not strip them)', () => {
    const p = createDefaultProject('rpi-4b');
    p.customFonts = [{ id: 'custom-1', name: 'My font', data: 'AAAA' }];
    p.textLabels = [
      { id: 'a', text: 'Hi', font: 'serif-default', weight: 'regular', size: 4, face: '+z', position: { u: 1, v: 1 }, rotation: 0, depth: 0.6, mode: 'engrave', enabled: true },
      { id: 'b', text: 'Hi', font: 'custom-1', weight: 'regular', size: 4, face: '+z', position: { u: 1, v: 1 }, rotation: 0, depth: 0.6, mode: 'engrave', enabled: true },
    ];
    const back = parseProject(serializeProject(p));
    expect(back.customFonts).toEqual(p.customFonts);
    expect(back.textLabels.map((l) => l.font)).toEqual(['serif-default', 'custom-1']);
  });
});
