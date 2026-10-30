/**
 * #672 — IMAGE TO RELIEF: a picture's luminance becomes the goal heightfield, and the EXISTING
 * goal pipeline surfaces it.
 *
 * The seams are pinned here: the map is one function with two numbers; the picture enters
 * `sampleGoalHeightfield` (no parallel CAM path); the document stores the image and the numbers,
 * never the heightfield; and the expected heights in the tests are built from the PNG's OWN BYTES
 * — a constructed gradient — not from the mapping function.
 */

import { describe, it, expect } from 'vitest';
import { zlibSync } from 'fflate';

import { decodePng, pngPixelSize } from '@/engine/import/png';
import { DEFAULT_RELIEF_DEPTH_MM, reliefDepthMm, reliefNumbers } from '@/engine/cnc/cam/relief';
import { sampleGoalHeightfield, generateSurface3dForGoal } from '@/engine/cnc/cam/surface3d';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { generateGoalProgram } from '@/workers/sim/engraveGenerate';
import { validateJob } from '@/engine/cnc/engrave/jobSetup';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import { flatEndMill } from '@/engine/cnc/tool';
import { FLAT, type ColumnCutter, type CutMove } from '@/workers/geometry/columnEngine';
import { stubSetup, type Setup } from '@/engine/cnc/setup';
import { rectProfile } from '@/engine/compiler/profile';
import type { RapidEstimate, CamMove } from '@/engine/cnc/cam/ir';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';

// ---- a minimal PNG writer, so the fixtures are PIXELS we constructed -------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** An 8-bit greyscale PNG from a row-major grey buffer. `colourType` lets a test make others. */
function greyPng(width: number, height: number, grey: ArrayLike<number>, hdr?: { bitDepth?: number; colourType?: number; interlace?: number }): Uint8Array {
  const bitDepth = hdr?.bitDepth ?? 8;
  const colourType = hdr?.colourType ?? 0;
  const interlace = hdr?.interlace ?? 0;
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = bitDepth;
  ihdr[9] = colourType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = interlace;
  const raw = new Uint8Array(height * (width + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0; // filter: none
    for (let x = 0; x < width; x++) raw[y * (width + 1) + 1 + x] = grey[y * width + x]! & 0xff;
  }
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

let shaCounter = 0;
function reliefTarget(
  png: Uint8Array,
  size: { x: number; y: number },
  relief?: EngraveTargetObject['relief'],
): EngraveTargetObject {
  return {
    id: 'relief-1',
    name: 'picture.png',
    format: 'png',
    sha256: `${(shaCounter++).toString(16).padStart(64, 'a')}`,
    data: toBase64(png),
    size: { x: size.x, y: size.y, z: relief?.maxDepthMm ?? DEFAULT_RELIEF_DEPTH_MM },
    position: { x: 20, y: 15, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
    ...(relief === undefined ? {} : { relief }),
  };
}

/** A 256 × 8 ramp: column x has grey x — the picture's own bytes carry the expected heights. */
function rampPng(): Uint8Array {
  const width = 256;
  const height = 8;
  const grey = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) grey[y * width + x] = x;
  return greyPng(width, height, grey);
}

describe('the PNG reader (#672)', () => {
  it('decodes a constructed gradient to the greys the fixture wrote', () => {
    const decoded = decodePng(rampPng());
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.image.width).toBe(256);
    expect(decoded.image.height).toBe(8);
    // The pixel values ARE the fixture's: column x is x.
    for (const x of [0, 1, 64, 128, 255]) expect(decoded.image.grey[3 * 256 + x]).toBe(x);
    expect(pngPixelSize(rampPng())).toEqual({ width: 256, height: 8 });
  });

  it('refuses what it does not read, by name', () => {
    const sixteen = greyPng(4, 4, new Uint8Array(16), { bitDepth: 16 });
    expect(decodePng(sixteen).ok).toBe(false);
    expect(decodePng(sixteen).ok === false && decodePng(sixteen).ok === false ? (decodePng(sixteen) as { error: string }).error : '').toContain('8');

    const palette = greyPng(4, 4, new Uint8Array(16), { colourType: 3 });
    const paletteResult = decodePng(palette);
    expect(paletteResult.ok).toBe(false);
    if (!paletteResult.ok) expect(paletteResult.error).toContain('palette');

    const interlaced = greyPng(4, 4, new Uint8Array(16), { interlace: 1 });
    const interlacedResult = decodePng(interlaced);
    expect(interlacedResult.ok).toBe(false);
    if (!interlacedResult.ok) expect(interlacedResult.error).toContain('interlaced');

    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    const jpegResult = decodePng(jpeg);
    expect(jpegResult.ok).toBe(false);
    if (!jpegResult.ok) expect(jpegResult.error).toContain('not a PNG');
  });
});

describe('the relief map — one function, two numbers (#672)', () => {
  it('resolves the depth and its source, and maps white to the top face by default', () => {
    const defaults = reliefNumbers(undefined);
    expect(defaults.maxDepthMm).toBe(DEFAULT_RELIEF_DEPTH_MM);
    expect(defaults.depthSource).toBe('the CAM’s default');
    expect(defaults.invert).toBe(false);
    const typed = reliefNumbers({ maxDepthMm: 3, invert: true });
    expect(typed.maxDepthMm).toBe(3);
    expect(typed.depthSource).toBe('typed');
    expect(typed.invert).toBe(true);
    // The map: white is 0 deep; black is the full depth; inverted, they swap.
    expect(reliefDepthMm(255, 2, false)).toBe(0);
    expect(reliefDepthMm(0, 2, false)).toBe(2);
    expect(reliefDepthMm(255, 2, true)).toBe(2);
    expect(reliefDepthMm(128, 2, false)).toBeCloseTo(2 * (1 - 128 / 255), 9);
  });
});

describe('the picture becomes the goal heightfield (#672)', () => {
  it('maps the ramp INDEPENDENTLY: the height comes from the fixture’s bytes, not the map', () => {
    const size = { x: 25.6, y: 0.8 }; // 256 px over 25.6 mm = 0.1 mm per pixel
    const target = reliefTarget(rampPng(), size, { maxDepthMm: 2 });
    const hf = sampleGoalHeightfield(target, { pitchMm: 0.5 });
    expect(hf.coveredCount).toBeGreaterThan(0);
    // For a cell at world x, the picture's continuous column is u = (x − left) / 0.1, its grey
    // (white-high) is the ramp's `u − 0.5` clamped, and the depth is 2 × (1 − grey/255) — all
    // computed from the fixture, no `reliefDepthMm` in the expectation.
    const left = target.position.x - size.x / 2;
    for (let i = 0; i < hf.nx; i++) {
      const x = hf.x0 + i * hf.pitch;
      const j = Math.floor(hf.ny / 2);
      const idx = j * hf.nx + i;
      if (hf.covered[idx] === 0) continue;
      const u = (x - left) / (size.x / 256);
      const grey = Math.min(255, Math.max(0, u - 0.5));
      const expected = 0 - 2 * (1 - grey / 255);
      expect(hf.z[idx], `x=${x}`).toBeCloseTo(expected, 2);
    }
    // The deepest relief is the darkest column, at the stated depth.
    expect(hf.minZ).toBeLessThan(-1.9);
    expect(hf.resolutionNote).toContain('256 × 8 px image over 25.6 × 0.8 mm');
    expect(hf.resolutionNote).toContain('0.1 mm per pixel');
  });

  it('a two-band picture gives the top face and the full depth exactly; invert swaps them', () => {
    // 4 × 1: two black columns then two white — sampled away from the boundary.
    const band = greyPng(4, 1, new Uint8Array([0, 0, 255, 255]));
    const low = sampleGoalHeightfield(reliefTarget(band, { x: 4, y: 4 }, { maxDepthMm: 3 }), { pitchMm: 0.5 });
    const zAt = (hf: ReturnType<typeof sampleGoalHeightfield>, x: number): number => {
      const i = Math.round((x - hf.x0) / hf.pitch);
      const j = Math.floor(hf.ny / 2);
      return hf.z[j * hf.nx + i] as number;
    };
    expect(zAt(low, 19)) .toBeCloseTo(-3, 2); // the black half: 3 mm deep
    expect(zAt(low, 21)).toBeCloseTo(0, 2); // the white half: the top face

    const inverted = sampleGoalHeightfield(
      reliefTarget(band, { x: 4, y: 4 }, { maxDepthMm: 3, invert: true }),
      { pitchMm: 0.5 },
    );
    expect(zAt(inverted, 19)).toBeCloseTo(0, 2);
    expect(zAt(inverted, 21)).toBeCloseTo(-3, 2);
  });

  it('is gouge-free to sample: a linear ramp stays linear between pixels (bilinear)', () => {
    const hf = sampleGoalHeightfield(reliefTarget(rampPng(), { x: 25.6, y: 0.8 }, { maxDepthMm: 2 }), { pitchMm: 0.25 });
    const xs = [10, 10.5, 11, 11.5];
    const zs = xs.map((x) => {
      const i = Math.round((x - hf.x0) / hf.pitch);
      return hf.z[Math.floor(hf.ny / 2) * hf.nx + i] as number;
    });
    // Equal x steps give equal z steps — the ramp has no stair-steps at the pixel pitch.
    expect(zs[1]! - zs[0]!).toBeCloseTo(zs[2]! - zs[1]!, 2);
    expect(zs[2]! - zs[1]!).toBeCloseTo(zs[3]! - zs[2]!, 2);
  });
});

describe('the relief rides the goal pipeline (#672)', () => {
  const RAPID: RapidEstimate = { xyMmPerMin: 1200, zMmPerMin: 600, accelMmPerS2: 150, source: 'test' };
  const BALL = flatEndMill(1, { shape: 'ball', name: '1 mm ball' });

  function reliefJob(target: EngraveTargetObject): EngraveJob {
    const base = defaultEngraveJob();
    return {
      ...base,
      labels: [],
      shapes: [],
      stock: { ...base.stock, length: 60, width: 40 },
      toolKey: 'ball-1',
      tool: BALL,
      targetObject: target,
    };
  }

  it('generates the same goal program a mesh would: the surface check, the passes, the bbox', () => {
    const target = reliefTarget(rampPng(), { x: 25.6, y: 8 }, { maxDepthMm: 2 });
    const job = reliefJob(target);
    const out = generateGoalProgram(job, target, BALL, [], null, {
      surfaceGrid: { pitchMm: { value: 0.4, source: 'chosen' } },
    });
    expect(out.ok, JSON.stringify(out.errors)).toBe(true);
    expect(out.programs).toHaveLength(1);
    const program = out.programs[0]!;
    // #535 — the same check: a surface program, no 2.5D report, the grid and the passes.
    expect(program.verify).toBeNull();
    expect(program.surfaceCheck?.kind).toBe('surface');
    expect(program.surfaceCheck?.gridPitchMm).toBeCloseTo(0.4, 9);
    expect(program.surfaceCheck?.passes).toHaveLength(2);
    expect(program.surfaceCheck?.resolutionNote).toContain('mm per pixel');
    // The operation's facts are the goal path's own.
    expect(out.surface3d?.gridPitchMm).toBeCloseTo(0.4, 9);
    expect(out.surface3d?.notes.join(' ')).toContain('mm per pixel');
    // #671's passes are available on a picture exactly as on a mesh. A VALLEY picture — tones
    // darkest at the middle — is a concave crease, so the pencil pass has a corner to follow.
    const valley = new Uint8Array(64 * 4);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 64; x++) valley[y * 64 + x] = Math.min(255, Math.abs(x - 32) * 16);
    const withPasses = generateSurface3dForGoal({
      target: reliefTarget(greyPng(64, 4, valley), { x: 16, y: 1 }, { maxDepthMm: 2 }),
      tool: BALL,
      toolNumber: 1,
      spindleRpm: 12000,
      air: true,
      feeds: { feed: 500, plungeFeed: 200, stepDown: 0.5, roughStepOver: 0.8, finishStepOver: 0.4 },
      rapid: RAPID,
      sample: { pitchMm: 0.4 },
      opts: { scallop: true, pencil: true },
    });
    expect(withPasses?.ir.operations.map((op) => op.name.slice(op.name.indexOf('3D')))).toEqual([
      '3D rough — 0.3 mm to leave',
      '3D finish',
      '3D scallop',
      '3D pencil',
    ]);
  }, 90_000);

  it('the sweep meets the picture on the dexel grid', () => {
    // The same end-to-end check the mesh goal has: sweep the posted operations and read the
    // relief back off the grid, against the fixture's own ramp.
    const size = { x: 25.6, y: 8 };
    const target = reliefTarget(rampPng(), size, { maxDepthMm: 2 });
    const job = reliefJob(target);
    const out = generateGoalProgram(job, target, BALL, [], null, {
      surfaceGrid: { pitchMm: { value: 0.2, source: 'chosen' } },
    });
    expect(out.ok).toBe(true);
    const hf = sampleGoalHeightfield(target, { pitchMm: 0.2 });
    const setup: Setup = stubSetup(
      { kind: 'prism', outline: rectProfile(60, 40), thickness: 12 },
      { kind: 'tape-down', contact: rectProfile(60, 40) },
    );
    const cutter: ColumnCutter = { radius: 0, tanHalf: null, cornerRadius: 0.5, outerRadius: 0.5 };
    // The posted moves, resolved into the column engine's segments (z = the lower endpoint).
    const moves: CamMove[] = [];
    const ncOps = generateSurface3dForGoal({
      target,
      tool: BALL,
      toolNumber: 1,
      spindleRpm: 12000,
      air: true,
      feeds: { feed: 500, plungeFeed: 200, stepDown: 0.5, roughStepOver: 0.8, finishStepOver: 0.4 },
      rapid: RAPID,
      sample: { pitchMm: 0.2 },
    });
    expect(ncOps).not.toBeNull();
    for (const op of ncOps!.ir.operations) moves.push(...op.moves);
    const cut: CutMove[] = [];
    for (let k = 1; k < moves.length; k++) {
      const a = moves[k - 1]!;
      const b = moves[k]!;
      if (b.kind !== 'feed') continue;
      cut.push({ step: k, line: k, u0: a.x, u1: b.x, v0: a.y, v1: b.y, z: Math.min(a.z, b.z) });
    }
    const grid = FLAT.buildGrid(setup, cutter, cut, { dx: hf.pitch, dThetaDeg: hf.pitch });
    for (const m of cut) FLAT.applyMove(grid, m, cutter);
    const heightAt = (x: number, y: number): number => {
      const i = Math.round((x - grid.u0) / grid.du);
      const j = Math.round((y - grid.v0) / grid.dv);
      return grid.h[j * grid.nu + i] as number;
    };
    // Far from the footprint's edges, the stock must meet the picture within the finishing
    // step-over plus the grid.
    const tol = 0.4 + 3 * hf.pitch;
    const imgLeft = target.position.x - size.x / 2;
    for (const x of [12, 16, 20, 24, 28]) {
      const u = (x - imgLeft) / (size.x / 256);
      const grey = Math.min(255, Math.max(0, u - 0.5));
      const expected = -2 * (1 - grey / 255);
      const got = heightAt(x, 15);
      expect(got, `x=${x}`).toBeGreaterThan(expected - tol);
      expect(got, `x=${x}`).toBeLessThan(expected + tol);
    }
  }, 90_000);
});

describe('the document keeps the picture and the numbers, never the field (#672)', () => {
  it('round-trips a picture goal; an unknown relief key is refused', () => {
    const job = { ...defaultEngraveJob(), labels: [], shapes: [], targetObject: reliefTarget(rampPng(), { x: 20, y: 4 }, { maxDepthMm: 2.5, invert: true }) };
    const parsed = parseEngraveJob(JSON.parse(JSON.stringify(job)) as unknown);
    expect(parsed.ok, parsed.ok ? '' : parsed.errors.join('; ')).toBe(true);
    if (!parsed.ok) return;
    const target = parsed.job.targetObject!;
    expect(target.format).toBe('png');
    expect(target.relief).toEqual({ maxDepthMm: 2.5, invert: true });
    // Nothing derived is stored: no heightfield, no grid, no pixels.
    const keys = Object.keys(target);
    expect(keys).not.toContain('heightfield');
    expect(keys).not.toContain('grey');
    expect(keys).not.toContain('field');
    // An unknown relief key is refused (the block is strict).
    const bad = {
      ...job,
      targetObject: { ...job.targetObject!, relief: { maxDepthMm: 1, gamma: 2 } },
    };
    expect(parseEngraveJob(bad).ok).toBe(false);
  });

  it('bounds the RESOLVED depth by the blank, not by size.z', () => {
    const job = { ...defaultEngraveJob(), labels: [], shapes: [], targetObject: reliefTarget(rampPng(), { x: 20, y: 4 }, { maxDepthMm: 20 }) };
    const f = validateJob(job).find((x) => x.code === 'goal-object-oversize');
    // #784 — a relief deeper than the blank is INFORMED (clipped), not refused: the check still
    // reads the RESOLVED depth (20 mm), not size.z, and names how far it goes past the bottom.
    expect(f?.severity).toBe('warning');
    // The relief's 20 mm depth on this 12 mm blank is 8 mm past the bottom: the number proves the
    // RESOLVED depth was read (a size.z-based check would see nothing past the blank).
    expect(f?.message).toContain("8 mm below the stock's bottom face");
  });
});
