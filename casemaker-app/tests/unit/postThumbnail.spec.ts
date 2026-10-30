// #771 — the thumbnail block in the posted `.nc`.
//
// The format is Studio's, read from a real Z1-generated file (`Z1/TopClamp.nc`, the release asset
// the reference-corpus script fetches): `M02`, then `;(thumbnail_image_begin)`, ONE `;`-prefixed
// base64 line, then `;(thumbnail_image_end)`. These tests pin the syntax, the one-line rule, the
// 20 kB cap, both picture sources, and — the point of a comment block — that the parser, the
// timeline and the verifier cannot see it: the file with the block behaves exactly like the file
// without it, and the motion bytes are identical apart from the appended lines.
//
// The corpus is git-ignored and not redistributed; no vendor bytes are committed here. The PNGs
// this spec builds come from our own renderer or a hand-built two-triangle mesh.

import { describe, it, expect } from 'vitest';
import {
  appendThumbnail,
  heightfieldTopViewPng,
  planViewPng,
  simulationTopViewPng,
  stripThumbnail,
  thumbnailBlock,
  THUMBNAIL_BEGIN,
  THUMBNAIL_END,
  THUMBNAIL_MAX_BYTES,
} from '@/engine/cnc/post/thumbnail';
import { postZ1, type PostContext } from '@/engine/cnc/post/z1';
import { parseGcode } from '@/engine/cnc/gcode';
import { buildTimeline } from '@/engine/cnc/emulator/timeline';
import { verifyProgram, stockDepthLimit, type VerifyContext } from '@/engine/cnc/verify';
import { decodePng } from '@/engine/import/png';
import { flatEndMill } from '@/engine/cnc/tool';
import { Z1 } from '@/engine/cnc/machine';
import { stubSetup } from '@/engine/cnc/setup';
import { rectProfile } from '@/engine/compiler/profile';
import { estimateSeconds, type CamMove, type CamOperation, type ToolpathIR } from '@/engine/cnc/cam/ir';

const STOCK = { length: 20, width: 10, thickness: 5 };

const CTX: PostContext = {
  jobName: 'thumbnail',
  stock: STOCK,
  materialName: 'softwood',
  zDatum: 'probed-top-face',
  origin: 'topFrontLeft',
  camVersion: '1.0.0',
  toolKey: 'flat-1.0',
};

const rapid = (x: number, y: number, z: number): CamMove => ({ kind: 'rapid', x, y, z });
const cut = (x: number, y: number, z: number, f: number): CamMove => ({ kind: 'feed', x, y, z, f });

function operation(number: number, name: string, labelId: string, depth: number, moves: CamMove[]): CamOperation {
  return { number, name, labelId, depth, moves, estimatedSeconds: estimateSeconds(moves) };
}

/** A short, valid flat program inside the 20 × 10 × 5 test stock. */
function makeIr(): ToolpathIR {
  return {
    frame: 'flat',
    tool: flatEndMill(1),
    toolNumber: 1,
    spindleRpm: 12000,
    air: true,
    safeZ: 5,
    hopZ: 1,
    operations: [
      operation(1, '[T1]Engrave "A" 1.0mm', 'a', 1, [
        rapid(2, 2, 1),
        cut(2, 2, -1, 200),
        cut(8, 2, -1, 500),
        cut(8, 8, -1, 500),
        cut(2, 8, -1, 500),
        cut(2, 2, -1, 500),
        rapid(2, 2, 5),
      ]),
    ],
  };
}

const NO_THUMBNAIL = (() => {
  const posted = postZ1(makeIr(), CTX, Z1);
  if (!posted.ok) throw new Error(posted.errors.join('; '));
  return posted.text;
})();

/** A real PNG from the design renderer — square-ish, a few hundred bytes, always under the cap. */
const PNG = (() => {
  const png = planViewPng(STOCK, [
    {
      polygons: [
        [[2, 2], [18, 2], [18, 8], [2, 8]],
        // A HOLE, wound the opposite way to the outer ring (the letter-counter case). Nonzero
        // must leave it as bare stock, not paint it with the cut ink.
        [[8, 4], [8, 6], [12, 6], [12, 4]],
      ],
    },
  ]);
  if (png === null) throw new Error('the design renderer produced no PNG');
  return png;
})();

const SETUP = stubSetup(
  { kind: 'prism', outline: rectProfile(STOCK.length, STOCK.width), thickness: STOCK.thickness },
  { kind: 'tape-down', contact: rectProfile(STOCK.length, STOCK.width) },
  { startingTool: 1 },
  Z1,
);

/** Min/max luminance without `Math.max(...128k bytes)`, which overflows a call stack. */
function greyRange(grey: Uint8Array): { min: number; max: number } {
  let min = 255;
  let max = 0;
  for (const value of grey) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return { min, max };
}

const VERIFY_CTX: VerifyContext = {
  setup: SETUP,
  machine: Z1,
  tool: flatEndMill(1),
  depthLimit: stockDepthLimit(STOCK, 1),
  minRapidZ: 1,
};

describe('the block as Studio writes it (#771)', () => {
  it('is the two markers and ONE `;`-prefixed base64 line, after M02', () => {
    expect(THUMBNAIL_BEGIN.length).toBe(24);
    expect(THUMBNAIL_END.length).toBe(22);
    const block = thumbnailBlock(PNG);
    expect(block).not.toBeNull();
    if (block === null) return;
    const lines = block.split('\n');
    expect(lines[0]).toBe(';(thumbnail_image_begin)');
    expect(lines[1]?.startsWith(';')).toBe(true);
    expect(lines[1]?.includes(' ')).toBe(false);
    expect(lines[2]).toBe(';(thumbnail_image_end)');
    expect(lines[3]).toBe('');
    // Exactly one payload line: 4 base64 characters per 3 bytes, rounded up, plus the `;`.
    expect(lines[1]!.length).toBe(1 + Math.ceil(PNG.length / 3) * 4);
    expect(Buffer.from(lines[1]!.slice(1), 'base64')).toEqual(Buffer.from(PNG));

    const posted = postZ1(makeIr(), CTX, Z1, { thumbnail: PNG });
    expect(posted.ok).toBe(true);
    if (!posted.ok) return;
    const tail = posted.text.trimEnd().split('\n').slice(-4);
    expect(tail).toEqual([
      'M02',
      ';(thumbnail_image_begin)',
      expect.stringMatching(/^;iVBORw0KGgo/),
      ';(thumbnail_image_end)',
    ]);
  });

  it('keeps the PNG under 20 kB and refuses an oversized or non-PNG payload', () => {
    expect(PNG.length).toBeLessThanOrEqual(THUMBNAIL_MAX_BYTES);
    expect(thumbnailBlock(new Uint8Array(THUMBNAIL_MAX_BYTES + 1))).toBeNull();
    expect(thumbnailBlock(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });

  it('appends and strips without touching one motion byte, and never appends to an M30 file', () => {
    const withBlock = appendThumbnail(NO_THUMBNAIL, PNG);
    expect(withBlock).not.toBeNull();
    if (withBlock === null) return;
    expect(withBlock.startsWith(NO_THUMBNAIL)).toBe(true);
    expect(stripThumbnail(withBlock)).toBe(NO_THUMBNAIL);
    // Replacing is idempotent: the old block goes before the new one is appended.
    expect(appendThumbnail(withBlock, PNG)).toBe(withBlock);
    // The rotary dialect has no evidence for this block; M30 is not M02.
    expect(appendThumbnail('G90 G21\nM30\n', PNG)).toBeNull();
  });
});

describe('the parser, the timeline and the verifier skip the block (#771)', () => {
  const withBlock = appendThumbnail(NO_THUMBNAIL, PNG)!;

  it('a file with and without the thumbnail parses identically', () => {
    const plain = parseGcode(NO_THUMBNAIL);
    const thumbed = parseGcode(withBlock);
    expect(thumbed.events).toEqual(plain.events);
    expect(thumbed.diagnostics).toEqual(plain.diagnostics);
    expect(thumbed.header).toEqual(plain.header);
    expect({ ...thumbed.summary, lines: 0 }).toEqual({ ...plain.summary, lines: 0 });
    // The only summary field that moves is the physical line count — the block is three lines.
    expect(thumbed.summary.lines).toBe(plain.summary.lines + 3);
  });

  it('the timeline is identical with and without the block', () => {
    const plain = buildTimeline(parseGcode(NO_THUMBNAIL), SETUP, Z1);
    const thumbed = buildTimeline(parseGcode(withBlock), SETUP, Z1);
    expect(thumbed.summary).toEqual(plain.summary);
    expect(thumbed.events).toEqual(plain.events);
    expect(thumbed.segments).toEqual(plain.segments);
    expect(thumbed.airMoves).toEqual(plain.airMoves);
    expect(thumbed.diagnostics).toEqual(plain.diagnostics);
  });

  it('the verifier’s verdict and findings are unchanged; only the line count grows', () => {
    const plain = verifyProgram(NO_THUMBNAIL, VERIFY_CTX);
    const thumbed = verifyProgram(withBlock, VERIFY_CTX);
    expect(plain.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(thumbed.ok).toBe(plain.ok);
    expect(thumbed.findings).toEqual(plain.findings);
    expect({ ...thumbed.stats, lines: 0 }).toEqual({ ...plain.stats, lines: 0 });
    expect(thumbed.stats.lines).toBe(plain.stats.lines + 3);
  });
});

describe('the two picture sources (#771)', () => {
  it('draws the design preview from the opened cut polygons, stock frame and no cuts → no picture', () => {
    const decoded = decodePng(PNG);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    // Page y = −job y: the 20 mm side is horizontal and the 10 mm side vertical.
    expect(decoded.image.width).toBeGreaterThan(decoded.image.height);
    expect(decoded.image.width).toBeLessThanOrEqual(480);
    // The stock's own near-white face and at least one dark cut pixel are both present.
    const designRange = greyRange(decoded.image.grey);
    expect(designRange.max).toBeGreaterThan(240);
    expect(designRange.min).toBeLessThan(100);
    // The fixture's hole sits at the stock centre (job 10, 5 mm), and the picture's centre pixel
    // is that job point: NONZERO must leave it bare stock. Painting each ring on its own would
    // ink it (the hole ring's interior is never winding zero on its own).
    const { width, height, grey } = decoded.image;
    expect(grey[(height >> 1) * width + (width >> 1)]).toBeGreaterThan(240);
    // …while a point inside the outer ring and outside the hole (job ~5, 5 mm) is inked.
    const ringX = Math.round(width * 0.265);
    const ringY = Math.round(height * 0.5);
    expect(grey[ringY * width + ringX]).toBeLessThan(100);
    // A facing pass (no cuts) has no design picture.
    expect(planViewPng(STOCK, [])).toBeNull();
    expect(planViewPng({ length: 0, width: 10 }, [{ polygons: [] }])).toBeNull();
  });

  it('draws the top view of a simulated result mesh, deeper material darker', () => {
    // Two side-by-side quads: the left half at Z=0, the right half cut to Z=−1. No walls are
    // needed for a top view; the z-buffer only ever sees the two top faces.
    const positions = new Float32Array([
      0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0,
      10, 0, -1, 20, 0, -1, 20, 10, -1, 10, 10, -1,
    ]);
    const indices = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
    const png = simulationTopViewPng({
      positions,
      indices,
      bbox: { min: [0, 0, -1], max: [20, 10, 0] },
    });
    expect(png).not.toBeNull();
    if (png === null) return;
    expect(png.length).toBeLessThanOrEqual(THUMBNAIL_MAX_BYTES);
    const decoded = decodePng(png);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.image.width).toBeGreaterThan(decoded.image.height);
    // The uncut face is the light end of the ramp; the −1 mm half is the dark end.
    const simRange = greyRange(decoded.image.grey);
    expect(simRange.max).toBeGreaterThan(240);
    expect(simRange.min).toBeLessThan(100);
    // No triangles is no picture, not a blank one.
    expect(simulationTopViewPng({ positions, indices: new Uint32Array(), bbox: { min: [0, 0, -1], max: [20, 10, 0] } })).toBeNull();
  });

  it('draws a 3D goal heightfield in the blank frame, and nothing when no cell is covered', () => {
    const nx = 10;
    const ny = 5;
    const covered = new Uint8Array(nx * ny).fill(1);
    const z = new Float32Array(nx * ny);
    // A 2 mm trench down the first column; the rest of the goal is at the stock top.
    for (let j = 0; j < ny; j++) z[j * nx] = -2;
    const field = {
      nx,
      ny,
      x0: 1,
      y0: 1,
      pitch: 1,
      topZ: 0,
      minZ: -2,
      z,
      covered,
      coveredCount: nx * ny,
    };
    const png = heightfieldTopViewPng(STOCK, field);
    expect(png).not.toBeNull();
    if (png === null) return;
    expect(png.length).toBeLessThanOrEqual(THUMBNAIL_MAX_BYTES);
    const decoded = decodePng(png);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const range = greyRange(decoded.image.grey);
    expect(range.max).toBeGreaterThan(240);
    expect(range.min).toBeLessThan(100);
    expect(heightfieldTopViewPng(STOCK, { ...field, coveredCount: 0 })).toBeNull();
  });
});
