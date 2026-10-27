// #240 — the rotary dialect: the vendor's rotary STRUCTURE, and the refusals that keep a flat
// toolpath out of it (and a rotary one out of the flat post).
//
// THE VENDOR STRUCTURE, NOT THE VENDOR TEXT. `reference-gcode/Rotation/NefertitiRough.nc` is
// Makera's own rotary output and is fetched, not committed (`npm run reference-gcode:fetch`). The
// test compares WORD SEQUENCES AND ORDER — what the file says, in what shape — never its lines:
// the corpus licence rule is that no vendor line is copied into this repository.
//
// The vendor writes every axis on every motion; our emitter keeps A (and X, Z, F) modal. The
// shared fact is therefore "every cut runs at a KNOWN A", which the walk below proves on both
// files, rather than a literal `A` word on every one of our lines.

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { estimateSeconds, type CamMove, type CamOperation, type ToolpathIR } from '@/engine/cnc/cam/ir';
import { flatEndMill } from '@/engine/cnc/tool';
import { Z1 } from '@/engine/cnc/machine';
import { postZ1, type PostContext } from '@/engine/cnc/post/z1';

const HERE = dirname(fileURLToPath(import.meta.url));
const VENDOR = join(HERE, '..', '..', 'reference-gcode', 'Rotation', 'NefertitiRough.nc');

const rapid = (x: number, y: number, z: number, a?: number): CamMove =>
  a === undefined ? { kind: 'rapid', x, y, z } : { kind: 'rapid', x, y, z, a };
const cut = (x: number, y: number, z: number, f: number, a?: number): CamMove =>
  a === undefined ? { kind: 'feed', x, y, z, f } : { kind: 'feed', x, y, z, f, a };

function operation(moves: CamMove[]): CamOperation {
  return { number: 1, name: '[T1]Engrave rod', labelId: 'rod', depth: 0.5, moves, estimatedSeconds: estimateSeconds(moves) };
}

/** A small WRAP path: a few A/X moves and a plunge, every Y at 0, surface at the 10 mm radius. */
const WRAP: CamMove[] = [
  rapid(0, 0, 30, 0),
  cut(0, 0, 9.5, 500, 0),
  cut(10, 0, 9.5, 500, 0),
  cut(10, 0, 9.5, 500, 90),
  cut(20, 0, 9.5, 500, 90),
  rapid(20, 0, 15, 90),
];

function rotaryIr(over: Partial<ToolpathIR> = {}, moves: CamMove[] = WRAP): ToolpathIR {
  return {
    frame: 'rotary',
    rotary: { radius: 10 },
    tool: flatEndMill(1),
    toolNumber: 1,
    spindleRpm: 12000,
    air: true,
    safeZ: 5,
    hopZ: 1,
    operations: [operation(moves)],
    ...over,
  };
}

/** The rotary context: the origin is on the axis, so every Z is a distance ABOVE the axis (R6). */
const ROTARY_CTX: PostContext = {
  jobName: 'rod',
  stock: { length: 30, width: 10, thickness: 10 },
  materialName: 'softwood',
  zDatum: 'rotary-axis',
  origin: 'topFrontLeft',
  camVersion: '1.0.0',
  toolKey: 'flat-1.0',
};

/** The flat context, for the cross-frame refusals. */
const FLAT_CTX: PostContext = { ...ROTARY_CTX, zDatum: 'probed-top-face' };

// ---- Reading a program's STRUCTURE ------------------------------------------------

/** G-code words in a line. `G00`/`G01` are folded to `G0`/`G1` — one code, two spellings. */
function words(line: string): string[] {
  return (line.toUpperCase().match(/[A-Z][-+]?\d*\.?\d*/g) ?? []).map((w) =>
    w === 'G00' ? 'G0' : w === 'G01' ? 'G1' : w,
  );
}

/** One word as its SHAPE: axis words keep the letter, codes keep the number (`G21`, `M6`). */
function shape(word: string): string {
  return 'XYZFAS'.includes(word[0] as string) ? (word[0] as string) : word;
}

interface ProgramShape {
  /** The seven opening lines, as word shapes (the vendor's `%`, plane/units, `M5`, tool, spindle, two fed lines). */
  preamble: string[][];
  /** Every motion line after the preamble and before the ending, raw. */
  motions: string[];
  /** The closing lines, exactly as written. */
  ending: string[];
}

/** Split a program into preamble / motions / ending; comments are not structure. */
function shapeOf(text: string): ProgramShape {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith(';'));
  return {
    preamble: lines.slice(0, 7).map((l) => words(l).map(shape)),
    motions: lines.slice(7, Math.max(7, lines.length - 4)),
    ending: lines.slice(-4),
  };
}

/** The A value in force on each line: set by an `A` word, carried modally otherwise. */
function aWalk(motions: readonly string[]): { bad: number[]; stated: boolean } {
  let a: number | null = null;
  const bad: number[] = [];
  let stated = false;
  for (const [i, line] of motions.entries()) {
    const ws = words(line);
    const aWord = ws.find((w) => w[0] === 'A');
    if (aWord !== undefined) {
      a = Number(aWord.slice(1));
      stated = true;
    }
    const motion = ws[0] === 'G0' || ws[0] === 'G1';
    // A CUT (G1) with no A ever stated has no angular position: the machine would cut at wherever
    // the axis happened to be. This is the property the vendor's every-line-A style guarantees and
    // our modal emitter must guarantee too.
    if (motion && ws[0] === 'G1' && a === null) bad.push(i);
  }
  return { bad, stated };
}

/** Every Y word in the program, with its value — a rotary file holds the tool over the axis. */
function yWords(motions: readonly string[]): number[] {
  return motions
    .flatMap((l) => words(l))
    .filter((w) => w[0] === 'Y')
    .map((w) => Number(w.slice(1)));
}

// ---- The golden structure --------------------------------------------------------

describe.skipIf(!existsSync(VENDOR))('the rotary dialect against the vendor structure (#240)', () => {
  it('opens, moves and closes in the vendor’s own shape', () => {
    const posted = postZ1(rotaryIr(), ROTARY_CTX, Z1);
    if (!posted.ok) throw new Error(posted.errors.join('; '));
    const ours = shapeOf(posted.text);
    const vendor = shapeOf(readFileSync(VENDOR, 'utf8'));

    // The opening: `%`, the plane/unit/work-offset line, spindle off, the tool change, a fed line
    // to the safe height, ONE stated Y0 line — and the spindle.
    //
    // THE ONE INTENDED DIFFERENCE, by name: the vendor starts the spindle BEFORE the fed move
    // (`M5 / T1M6 / M3 S12000 / G01Z30.00 F1500 / G01Y0.00Z30.00`); we feed Z first, because
    // `M3` before any Z is established spins the cutter up wherever the last job left it
    // (#396's `spindle-at-unknown-z`, the flat post's order too). The relocation below is
    // asserted as exactly that, so ANY other drift in the preamble still fails.
    const spindleAt = (lines: readonly (readonly string[])[]): number =>
      lines.findIndex((l) => l[0] === 'M3');
    const fedZAt = (lines: readonly (readonly string[])[]): number =>
      lines.findIndex((l) => l[0] === 'G1' && l[1] === 'Z');
    expect(spindleAt(vendor.preamble), 'the vendor starts the spindle first').toBeLessThan(
      fedZAt(vendor.preamble),
    );
    expect(spindleAt(ours.preamble), 'our post starts the spindle after the fed Z move').toBeGreaterThan(
      fedZAt(ours.preamble),
    );
    // …and that relocation is the ONLY difference: moving the vendor's spindle line to the end
    // makes the two preambles equal, line for line.
    const vendorSpindle = vendor.preamble[spindleAt(vendor.preamble)]!;
    const vendorReordered = [
      ...vendor.preamble.filter((_, i) => i !== spindleAt(vendor.preamble)),
      vendorSpindle,
    ];
    expect(ours.preamble).toEqual(vendorReordered);
    expect(ours.preamble).toEqual([
      [],
      ['G17', 'G21', 'G54', 'G90'],
      ['M5'],
      ['T1', 'M6'],
      ['G1', 'Z', 'F'],
      ['G1', 'Y', 'Z'],
      ['M3', 'S'],
    ]);

    // The ending, the firmware's unwind included: `G92.4A0S0` EXACTLY (no spaces, S drops whole
    // turns keeping A modulo 360; R would RESET), then M9 / M5 / M30.
    expect(ours.ending).toEqual(vendor.ending);
    expect(ours.ending).toEqual(['G92.4A0S0', 'M9', 'M5', 'M30']);

    // Every vendor motion states A; ours carries it modally, and every CUT happens at a known A.
    expect(vendor.motions.length).toBeGreaterThan(100);
    expect(vendor.motions.every((l) => words(l).some((w) => w[0] === 'A'))).toBe(true);
    expect(aWalk(ours.motions).stated).toBe(true);
    expect(aWalk(ours.motions).bad).toEqual([]);

    // Y is never off the axis in either file; ours does not write a Y word at all after the
    // preamble's one `Y0` statement.
    expect(yWords(vendor.motions).every((v) => v === 0)).toBe(true);
    expect(yWords(ours.motions).every((v) => v === 0)).toBe(true);
    expect(ours.motions.some((l) => words(l).some((w) => w[0] === 'Y'))).toBe(false);

    // The unwind is the LAST MOTION: the only line between the motions and the ending is the fed
    // retract, and the unwind itself is the ending's first line.
    expect(ours.motions.at(-1)).toMatch(/^G0 /);
    expect(ours.motions.at(-1)).toContain('Z15');
  });

  it('writes no ;@MKR header on a rotary file, and says its provenance in ;@CM records', () => {
    const posted = postZ1(rotaryIr(), ROTARY_CTX, Z1);
    if (!posted.ok) throw new Error(posted.errors.join('; '));
    // The round stock's STOCK/ORIGIN forms are §9's open question; writing the candidate form
    // before the bench reads a Studio-generated rotary file is the invention the evidence rule
    // forbids. (The candidate is recorded in `post/z1.ts`'s header, for the bench.)
    expect(posted.text).not.toContain(';@MKR');
    expect(posted.text).toContain(';@CM|TOOL|key=flat-1.0');
    expect(posted.text).toContain(';@CM|ROTARY|radius=10');
  });

  it('emits the axis-frame safe height, and A only when it changes (modal)', () => {
    const posted = postZ1(rotaryIr(), ROTARY_CTX, Z1);
    if (!posted.ok) throw new Error(posted.errors.join('; '));
    const lines = posted.text.split('\n');
    // safeZ keeps its IR meaning in either frame — mm above the stock's TOP — and the top is the
    // radius in the axis frame, so the safe height is 10 + 5.
    expect(lines).toContain('G01 Z15 F500');
    expect(lines).toContain('G01 Y0 Z15');
    // A path at one angle is one A word; the 90° move states it once, and the moves after it do not.
    expect(lines.filter((l) => /\bA0\b/.test(l))).toHaveLength(1);
    expect(lines.filter((l) => /\bA90\b/.test(l))).toHaveLength(1);
    // The last motion before the unwind retracts to the safe height.
    const unwind = lines.indexOf('G92.4A0S0');
    expect(lines[unwind - 1]).toBe('G0 Z15');
  });
});

// ---- Refusals --------------------------------------------------------------------

describe('the rotary dialect’s refusals (#240)', () => {
  it('refuses a rotary move with no A position', () => {
    const ir = rotaryIr({}, [rapid(0, 0, 30), cut(0, 0, 9.5, 500)]);
    const res = postZ1(ir, ROTARY_CTX, Z1);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join(' ')).toMatch(/finite A position \(degrees\) on every move/);
  });

  it('refuses the flat datum on a rotary IR', () => {
    const res = postZ1(rotaryIr(), FLAT_CTX, Z1);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join(' ')).toMatch(/needs a flat-frame IR/);
  });

  it('refuses a non-zero Y in a rotary file', () => {
    const ir = rotaryIr({}, [rapid(0, 5, 30, 0), cut(0, 5, 9.5, 500, 0)]);
    const res = postZ1(ir, ROTARY_CTX, Z1);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join(' ')).toMatch(/Y=5 is not 0/);
  });

  it('refuses a rotary IR with no stock radius', () => {
    const res = postZ1(rotaryIr({ rotary: undefined }), ROTARY_CTX, Z1);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join(' ')).toMatch(/usable stock radius/);
  });

  it('refuses an A word in a flat-frame IR rather than dropping it', () => {
    const flat: ToolpathIR = {
      frame: 'flat',
      tool: flatEndMill(1),
      toolNumber: 1,
      spindleRpm: 12000,
      air: true,
      safeZ: 5,
      hopZ: 1,
      operations: [operation([rapid(0, 0, 1), cut(0, 0, -1, 200, 45)])],
    };
    const res = postZ1(flat, FLAT_CTX, Z1);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join(' ')).toMatch(/flat-frame but this move carries A=45/);
  });

  it('still posts an ordinary flat IR', () => {
    const flat: ToolpathIR = {
      frame: 'flat',
      tool: flatEndMill(1),
      toolNumber: 1,
      spindleRpm: 12000,
      air: true,
      safeZ: 5,
      hopZ: 1,
      operations: [operation([rapid(0, 0, 1), cut(0, 0, -1, 200), rapid(0, 0, 5)])],
    };
    const res = postZ1(flat, FLAT_CTX, Z1);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const motions = res.text.split('\n').filter((l) => /^G[01] /.test(l));
      expect(motions.length).toBeGreaterThan(0);
      expect(motions.some((l) => words(l).some((w) => w[0] === 'A'))).toBe(false);
    }
  });
});
