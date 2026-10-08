// The two session inputs (#182 step 8b): a setup form prefilled from the file's header, and the
// in-repo tool list. The header is UNTRUSTED; every test here is a way it can lie.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGcode, setupFromHeader, TOOL_LIBRARY, ToolLibrarySchema, ToolSchema, resolveTool } from '@/engine/cnc';
import type { MkrHeader } from '@/engine/cnc/gcode';
import { parseMkrRecord } from '@/engine/cnc/gcode/mkrHeader';
import { cuttingRadiusForSweep, flatEndMill, toolFromMkrRecord } from '@/engine/cnc/tool';

// Verbatim from reference-gcode/Z1/TopClamp.nc.
const STOCK = ';@MKR|STOCK|id=cuboid|length=100|width=100|height=5|diameter=1';
const ORIGIN = ';@MKR|ORIGIN|id=0|type_name=topFrontLeft|x=-50|y=-50|z=2.5';
const TOOL = ';@MKR|TOOL|number=1|id=112111313812|name=3.175*12mm Flat End(Metal)|type=Flat End|handlediameter=3.175|sticklength=0|shoulderlength=12|flutelength=12|diameter=3.175|tipdiameter=3.175|cornerradius=0|angle=0|halfAngle=0';

const header = (...lines: string[]): MkrHeader => ({
  records: lines.map((l, i) => parseMkrRecord(l, i + 1)).filter((r): r is NonNullable<typeof r> => r !== null),
});
const codes = (h: MkrHeader) => setupFromHeader(h).diagnostics.map((d) => d.code);
const prism = (h: MkrHeader) => {
  const p = setupFromHeader(h).patch.part;
  return p && p.kind === 'prism' ? p : null;
};

describe('setupFromHeader: the real TopClamp lines', () => {
  it('prefills a 100 x 100 x 5 cuboid, tagged as header-sourced, with the corner verified', () => {
    const r = setupFromHeader(header(STOCK, ORIGIN));
    expect(r.diagnostics).toEqual([]);
    expect(r.source).toBe('header');
    expect(r.patch.part).toEqual({ kind: 'prism', outline: { kind: 'p-rect', size: [100, 100] }, thickness: 5 });
    expect(r.workOrigin).toEqual({ corner: 'top-front-left', source: 'header' });
    // It prefills the part and nothing the file cannot know: no placement, no WCS, no tool.
    expect(Object.keys(r.patch)).toEqual(['part']);
  });

  it('ignores diameter for a cuboid: the placeholder diameter=1 changes nothing', () => {
    const a = setupFromHeader(header(STOCK));
    const b = setupFromHeader(header(STOCK.replace('diameter=1', 'diameter=999')));
    const c = setupFromHeader(header(STOCK.replace('|diameter=1', '')));
    expect(b.patch).toEqual(a.patch);
    expect(c.patch).toEqual(a.patch);
    expect(c.diagnostics).toEqual([]);
  });

  it('a missing header, or one with neither record, prefills nothing', () => {
    expect(setupFromHeader(null).patch).toEqual({});
    expect(setupFromHeader(header(TOOL)).patch).toEqual({});
    expect(setupFromHeader(header(TOOL)).workOrigin).toBeNull();
  });
});

describe('setupFromHeader: STOCK is untrusted', () => {
  it("does not prefill geometry for a non-cuboid id", () => {
    const r = setupFromHeader(header(';@MKR|STOCK|id=cylinder|length=100|width=100|height=5|diameter=40', ORIGIN));
    expect(r.patch.part).toBeUndefined();
    expect(r.diagnostics.map((d) => d.code)).toContain('stock-shape-unsupported');
    expect(r.workOrigin).toBeNull(); // nothing to cross-check against
  });

  it.each([
    ['NaN', 'length=NaN'],
    ['Infinity', 'length=Infinity'],
    ['overflow', 'length=1e999'],
    ['negative', 'length=-100'],
    ['zero', 'length=0'],
    ['text', 'length=abc'],
    ['empty', 'length='],
  ])('skips a %s field with a warning and does not prefill a partial stock', (_n, bad) => {
    const h = header(`;@MKR|STOCK|id=cuboid|${bad}|width=100|height=5`);
    const r = setupFromHeader(h);
    expect(r.patch.part).toBeUndefined();
    const cs = r.diagnostics.map((d) => d.code);
    expect(cs).toContain('stock-incomplete');
    expect(cs.some((c) => c === 'stock-field-invalid' || c === 'stock-field-missing')).toBe(true);
    expect(r.diagnostics.every((d) => d.severity === 'warning')).toBe(true);
  });

  it('a missing field is a warning too, and every bad field is reported, not just the first', () => {
    const r = setupFromHeader(header(';@MKR|STOCK|id=cuboid|length=-1|height=0'));
    expect(r.patch.part).toBeUndefined();
    expect(r.diagnostics.filter((d) => d.code === 'stock-field-invalid')).toHaveLength(2);
    expect(r.diagnostics.filter((d) => d.code === 'stock-field-missing')).toHaveLength(1);
  });

  it('a non-square stock warns that the X/Y mapping is unverified', () => {
    const r = setupFromHeader(header(';@MKR|STOCK|id=cuboid|length=100|width=60|height=5'));
    expect(prism(header(';@MKR|STOCK|id=cuboid|length=100|width=60|height=5'))?.outline).toEqual({ kind: 'p-rect', size: [100, 60] });
    expect(r.diagnostics.map((d) => d.code)).toEqual(['stock-axes-unverified']);
  });

  it('reads the first of several STOCK records and says so', () => {
    const h = header(STOCK, ';@MKR|STOCK|id=cuboid|length=1|width=1|height=1');
    expect(prism(h)?.thickness).toBe(5);
    expect(codes(h)).toContain('stock-multiple');
  });
});

describe('setupFromHeader: ORIGIN picks a preset and is CROSS-CHECKED, never trusted', () => {
  it('numbers that disagree with the hypothesis withhold the origin and say the semantics are unverified', () => {
    for (const o of [
      ';@MKR|ORIGIN|id=0|type_name=topFrontLeft|x=-50|y=-50|z=-2.5', // wrong z sign
      ';@MKR|ORIGIN|id=0|type_name=topFrontLeft|x=-30|y=-50|z=2.5', // wrong x
      ';@MKR|ORIGIN|id=0|type_name=topFrontLeft|x=-50|y=-50|z=5', // z is the full height
      ';@MKR|ORIGIN|id=0|type_name=topFrontLeft|x=-50|y=-50', // missing z
      ';@MKR|ORIGIN|id=0|type_name=topFrontLeft|x=NaN|y=-50|z=2.5',
    ]) {
      const r = setupFromHeader(header(STOCK, o));
      expect(r.workOrigin, o).toBeNull();
      const d = r.diagnostics.find((x) => x.code === 'origin-semantics-unverified');
      expect(d?.message, o).toMatch(/unverified/);
      expect(r.patch.part).toBeDefined(); // the stock is independent of the origin
    }
  });

  it('|x| and |y| are compared as magnitudes (the sample is -50, but the sign is not the claim)', () => {
    expect(setupFromHeader(header(STOCK, ORIGIN.replace('x=-50', 'x=50'))).workOrigin).not.toBeNull();
  });

  it('the cross-check follows the stock: a 120 x 80 x 6 block', () => {
    const s = ';@MKR|STOCK|id=cuboid|length=120|width=80|height=6';
    expect(setupFromHeader(header(s, ';@MKR|ORIGIN|id=0|type_name=topFrontLeft|x=-60|y=-40|z=3')).workOrigin).not.toBeNull();
    expect(setupFromHeader(header(s, ORIGIN)).workOrigin).toBeNull();
  });

  it('any other type_name is not a preset we have evidence for', () => {
    for (const t of ['center', 'topCenter', 'bottomFrontLeft', '']) {
      const r = setupFromHeader(header(STOCK, ORIGIN.replace('topFrontLeft', t)));
      expect(r.workOrigin, t).toBeNull();
      expect(r.diagnostics.map((d) => d.code)).toContain('origin-preset-unverified');
    }
  });

  it('an ORIGIN with no usable STOCK is not prefilled', () => {
    const r = setupFromHeader(header(ORIGIN));
    expect(r.workOrigin).toBeNull();
    expect(r.diagnostics.map((d) => d.code)).toEqual(['origin-unchecked']);
  });
});

const CORPUS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'reference-gcode');
describe.skipIf(!existsSync(join(CORPUS, 'Z1/TopClamp.nc')))('the real TopClamp.nc header', () => {
  it('parses to the same prefill as the verbatim lines', () => {
    const parsed = parseGcode(readFileSync(join(CORPUS, 'Z1/TopClamp.nc'), 'latin1'));
    const r = setupFromHeader(parsed.header);
    expect(r.diagnostics).toEqual([]);
    expect(prism(parsed.header as MkrHeader)?.thickness).toBe(5);
    expect(r.workOrigin?.corner).toBe('top-front-left');
  });
});

describe('the tool library', () => {
  it('is valid against its own schema, with unique keys', () => {
    expect(ToolLibrarySchema.safeParse(TOOL_LIBRARY).success).toBe(true);
    const dup = ToolLibrarySchema.safeParse([TOOL_LIBRARY[0], TOOL_LIBRARY[0]]);
    expect(dup.success).toBe(false);
  });

  it("carries TopClamp's TOOL line exactly: the library entry IS the header's tool", () => {
    const fromHeader = toolFromMkrRecord(parseMkrRecord(TOOL, 1) as NonNullable<ReturnType<typeof parseMkrRecord>>);
    expect(resolveTool('flat-3.175x12-metal')).toEqual(fromHeader);
  });

  it('both seeded tools are flat end mills the sweep accepts, at their stated diameters', () => {
    const r1 = cuttingRadiusForSweep(resolveTool('flat-3.175x12-metal') as NonNullable<ReturnType<typeof resolveTool>>);
    const r2 = cuttingRadiusForSweep(resolveTool('flat-1.0') as NonNullable<ReturnType<typeof resolveTool>>);
    expect(r1).toEqual({ ok: true, radius: 3.175 / 2 });
    expect(r2).toEqual({ ok: true, radius: 0.5 });
  });

  it('does not invent lengths for the assumed 1 mm tool', () => {
    const t = resolveTool('flat-1.0');
    expect(t?.fluteLength).toBeNull();
    expect(t?.shoulderLength).toBeNull();
  });

  it('a listed non-flat tool is still refused BY NAME when it is the one selected', () => {
    const ball = { ...flatEndMill(3), name: 'Ball 3', typeText: 'Ball End', shape: 'ball' as const };
    expect(ToolSchema.safeParse(ball).success).toBe(true);
    const r = cuttingRadiusForSweep(ball);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/Ball 3/);
  });

  it('the schema rejects non-finite numbers and an unknown shape', () => {
    expect(ToolSchema.safeParse({ ...flatEndMill(3), diameter: Number.NaN }).success).toBe(false);
    expect(ToolSchema.safeParse({ ...flatEndMill(3), shape: 'spherical' }).success).toBe(false);
  });

  it('resolveTool returns a copy and null for an unknown key', () => {
    const a = resolveTool('flat-1.0') as NonNullable<ReturnType<typeof resolveTool>>;
    a.name = 'mutated';
    expect(resolveTool('flat-1.0')?.name).not.toBe('mutated');
    expect(resolveTool('nope')).toBeNull();
  });
});
