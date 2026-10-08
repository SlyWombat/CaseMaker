// `concatToolpathIR` (#219/#287). The CAM is two modules — `generateEngrave` for the region
// operations, `generateTrace` for the single-line traces — and each numbers its operations from 1
// because each is usable alone (`cam/trace.ts`). The program the machine runs is ONE list, so the
// worker joins them here; this pins that join.
//
// Pure: no Manifold, no wasm. The byte-identity claim is proven where it matters — against the
// POSTED text the machine would read, not against the IR the post reads it from.

import { describe, it, expect } from 'vitest';

import { concatToolpathIR, type CamMove, type CamOperation, type ToolpathIR } from '@/engine/cnc/cam/ir';
import { postZ1, type PostContext } from '@/engine/cnc/post/z1';
import { Z1 } from '@/engine/cnc/machine';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';

const TOOL: Tool = flatEndMill(1.0, { number: 1 });

/** The post context `engraveGenerate` builds, so a hand-posted program carries the same header. */
const CTX: PostContext = {
  jobName: 'job',
  stock: { length: 100, width: 60, thickness: 12 },
  materialName: 'softwood',
  zDatum: 'probed-top-face',
  origin: 'topFrontLeft',
  camVersion: 'test',
};

/** One short cut at `x`, whose moves name the operation they came from. */
const cut = (x: number): CamMove[] => [
  { kind: 'rapid', x, y: 0, z: 1 },
  { kind: 'feed', x: x + 5, y: 0, z: -1, f: 200 },
];

function op(number: number, name: string, moves: CamMove[] = cut(number * 10)): CamOperation {
  return { number, name, labelId: name, depth: 1, moves, estimatedSeconds: 0 };
}

function ir(operations: CamOperation[] = [], overrides: Partial<ToolpathIR> = {}): ToolpathIR {
  return {
    frame: 'flat',
    tool: TOOL,
    toolNumber: 1,
    spindleRpm: 12000,
    air: false,
    safeZ: 5,
    hopZ: 1,
    operations,
    ...overrides,
  };
}

describe('concatToolpathIR (#219/#287)', () => {
  it('joins the two lists in the given order and renumbers the whole program from 1', () => {
    // Both CAM calls number from 1, so a naive concat would leave two operations numbered 1 — an
    // IR that lies about itself. (The post happens to renumber positionally, so today's `.nc` is
    // unaffected either way; the IR is the thing this function keeps honest.)
    const regions = ir([op(1, 'Engrave "CASE"'), op(2, 'Engrave "MAKER"')]);
    const traces = ir([op(1, 'Trace line (2 points)'), op(2, 'Trace text "wifi"')]);
    expect(regions.operations.map((o) => o.number)).toEqual([1, 2]); // the inputs are already 1-based

    const merged = concatToolpathIR(regions, traces);
    expect(merged.operations.map((o) => o.name)).toEqual([
      'Engrave "CASE"',
      'Engrave "MAKER"',
      'Trace line (2 points)',
      'Trace text "wifi"',
    ]);
    expect(merged.operations.map((o) => o.number)).toEqual([1, 2, 3, 4]);
    // The header of the FIRST IR is the merged program's: same machine, same cutter, same heights.
    expect(merged.tool).toBe(TOOL);
    expect(merged.safeZ).toBe(5);
    expect(merged.hopZ).toBe(1);
  });

  it('leaves both inputs untouched', () => {
    const regions = ir([op(1, 'a'), op(2, 'b')]);
    const traces = ir([op(1, 't')]);
    const merged = concatToolpathIR(regions, traces);
    expect(regions.operations.map((o) => o.number)).toEqual([1, 2]);
    expect(traces.operations.map((o) => o.number)).toEqual([1]);
    merged.operations[0]!.number = 99; // the merged list is its own array of its own objects
    expect(regions.operations[0]!.number).toBe(1);
  });

  // #287 — the common case: a job with no traces. `generateTrace([])` returns a header with an
  // empty operations list, and joining it must not disturb the posted bytes by one character.
  it('an empty second list posts byte-identical text', () => {
    const regions = ir([op(1, 'Engrave "CASE"'), op(2, 'Engrave "MAKER"')]);
    const merged = concatToolpathIR(regions, ir());

    expect(merged.operations.map((o) => o.number)).toEqual([1, 2]);
    const before = postZ1(regions, CTX, Z1);
    const after = postZ1(merged, CTX, Z1);
    expect(before.ok).toBe(true);
    expect(after.ok).toBe(true);
    if (before.ok && after.ok) expect(after.text).toBe(before.text);
  });

  // The assert exists so a merge can never silently post one program's moves under another's
  // spindle or safe height. Every field the post reads for the machine state is checked.
  it('refuses to join two IRs that disagree on the machine state', () => {
    const base = ir([op(1, 'a')]);
    const disagreeing: [string, Partial<ToolpathIR>][] = [
      ['frame', { frame: 'rotary' }],
      ['toolNumber', { toolNumber: 2 }],
      ['spindleRpm', { spindleRpm: 8000 }],
      ['air', { air: true }],
      ['safeZ', { safeZ: 10 }],
      ['hopZ', { hopZ: 3 }],
      ['tool', { tool: flatEndMill(3.175, { number: 1 }) }],
    ];
    for (const [field, override] of disagreeing) {
      expect(() => concatToolpathIR(base, ir([op(1, 't')], override)), field).toThrow(/concatToolpathIR/);
    }
    // The control: with nothing changed it joins cleanly, so the throws above are the assert and
    // not this helper refusing everything.
    expect(() => concatToolpathIR(base, ir([op(1, 't')]))).not.toThrow();
  });
});
