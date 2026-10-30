/**
 * The verifier's rotary refusals (#240 slice 2, `/Rotary.md` §6.4 and design §3.9/§4).
 *
 * A rotary program is checked on the FILE, not on the job: each refusal carries the step's line
 * and the SAME sentence the findings panel and the map use (`rotary/wrap.ts`), so the picture and
 * the file cannot word one fault two ways. The rotary frame's rules replace the flat ones — a
 * depth limit and a stock rectangle are flat-frame quantities and do not translate — so each test
 * below writes a program the flat checks would wave through and asserts the rotary one.
 *
 * CODES ARE DATA. Every refusal is asserted on the operator's sentence; the internal code is read
 * from the finding and must NOT appear in its message (first-job §4's no-codes rule).
 */

import { describe, expect, it } from 'vitest';

import { verifyProgram, type VerifyContext } from '@/engine/cnc/verify';
import { stubSetup, type Setup } from '@/engine/cnc/setup';
import { flatEndMill } from '@/engine/cnc/tool';
import { CARVERA_AIR, Z1 } from '@/engine/cnc/machine';

const CODE =
  /axis-crossing|rotary-y-off-axis|wrap-into-clamp|wrap-off-free-end|rotary-rapid-engaged|rapid-into-chuck|stock-exceeds-module|rotary-unsupported/;

function cyl(diameter = 20, length = 100): Setup {
  return stubSetup(
    { kind: 'cylinder', diameter, length },
    { kind: 'rotary-chuck', jawDiameter: diameter, stickout: 85 },
    { startingTool: 1 },
    Z1,
  );
}

function ctx(over: Partial<VerifyContext> = {}): VerifyContext {
  return {
    setup: cyl(),
    machine: Z1,
    tool: flatEndMill(1),
    depthLimit: () => 0, // a flat-frame quantity; the rotary checks never read it
    minRapidZ: 1,
    rotary: { radius: 10, stickout: 85, tailstock: true },
    ...over,
  };
}

/** The post's own shape: the preamble, the spindle after a known Z, and the rotary ending. */
const HEAD = ['%', 'G17 G21 G54 G90', 'M5', 'T1M6', 'G01 Z15 F200', 'G01 Y0 Z15', 'M3 S12000'];
const TAIL = ['G0 Z15', 'G92.4A0S0', 'M9', 'M5', 'M30'];
const program = (body: string[]): string => [...HEAD, ...body, ...TAIL].join('\n');

function report(body: string[], over: Partial<VerifyContext> = {}): ReturnType<typeof verifyProgram> {
  return verifyProgram(program(body), ctx(over));
}

const finding = (body: string[], code: string, over: Partial<VerifyContext> = {}) =>
  report(body, over).findings.find((f) => f.code === code);

/** The 1-based source line of the first program line containing `needle`. */
function lineOf(body: string[], needle: string): number {
  return program(body).split('\n').findIndex((l) => l.includes(needle)) + 1;
}

describe('the rotary dialect', () => {
  it('admits A words — and only a rotary program does', () => {
    const body = ['G0 X20 Z15 A0', 'G1 Z9.5 F100', 'G1 X30 A10 F500', 'G0 Z15'];
    expect(report(body).findings.some((f) => f.code === 'not-our-dialect')).toBe(false);
    // The same words without the rotary frame are foreign words, as they were before #240.
    expect(report(body, { rotary: undefined }).findings.some((f) => f.code === 'not-our-dialect')).toBe(true);
  });

  it('a clean wrapped program passes every check', () => {
    const r = report(['G0 X20 Z15 A0', 'G1 Z9.5 F100', 'G1 X30 A10 F500', 'G0 Z15']);
    // #759 review — the ordinary perimeter shortfall is a run-sheet fact, not a finding: a plain
    // wrapped cut at a below-cap A rate and no Z demand raises nothing at all.
    expect(r.findings).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

describe('the rotary refusals — operator words, at the step', () => {
  it('Y off the axis — “leaves the line over the axis”', () => {
    const body = ['G0 X20 Z15 A0', 'G1 Z9.5 F100', 'G1 Y1 A20 F500'];
    const f = finding(body, 'rotary-y-off-axis');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('error');
    expect(f!.line).toBe(lineOf(body, 'G1 Y1 A20'));
    expect(f!.message).toContain('leaves the line over the axis');
    expect(f!.message).toContain('(Y 1 mm)');
    expect(f!.message).toContain('every Y is 0');
    expect(f!.message).not.toMatch(CODE);
  });

  it('a tip past the axis — “cuts through the centre”, with how far past', () => {
    const body = ['G0 X20 Z15 A0', 'G1 Z-2 F100'];
    const f = finding(body, 'axis-crossing');
    expect(f).toBeDefined();
    expect(f!.line).toBe(lineOf(body, 'G1 Z-2'));
    expect(f!.message).toContain('cuts through the centre');
    expect(f!.message).toContain('reaches 2 mm past the axis');
    expect(f!.message).toContain('use a shallower depth or a larger diameter');
    expect(f!.message).not.toMatch(CODE);
  });

  it('a tip on the axis — the exact case has its own sentence', () => {
    const f = finding(['G0 X20 Z15 A0', 'G1 Z0 F100'], 'axis-crossing');
    expect(f).toBeDefined();
    expect(f!.message).toContain('reaches the axis exactly');
    expect(f!.message).not.toContain('0 mm past the axis');
    expect(f!.message).not.toMatch(CODE);
  });

  it('the cutter EDGE into the jaws’ band — “runs into the jaws”', () => {
    // The move ends at X 3.4 with a 1 mm cutter: the edge is at X 2.9, inside the 3 mm keep-out.
    const body = ['G0 X20 Z15 A0', 'G1 Z9.5 F100', 'G1 X3.4 F500'];
    const f = finding(body, 'wrap-into-clamp');
    expect(f).toBeDefined();
    expect(f!.line).toBe(lineOf(body, 'G1 X3.4'));
    expect(f!.message).toContain('runs into the jaws');
    expect(f!.message).toContain('X 2.9 mm');
    expect(f!.message).toContain('first 3 mm of the stick-out');
    expect(f!.message).not.toMatch(CODE);
  });

  it('the cutter EDGE into the tailstock’s band — “runs into the tailstock’s band”', () => {
    const body = ['G0 X70 Z15 A0', 'G1 Z9.5 F100', 'G1 X84.6 F500'];
    const f = finding(body, 'wrap-into-clamp');
    expect(f).toBeDefined();
    expect(f!.message).toContain("runs into the tailstock's band");
    expect(f!.message).toContain('X 85.1 mm');
    expect(f!.message).toContain('last 10 mm of the stick-out');
    expect(f!.message).toContain('X 75–85 mm');
    expect(f!.message).not.toMatch(CODE);
  });

  it('the cutter past the free end with the tailstock OUT — “runs off the free end of the rod”', () => {
    // The move ends at X 84.6 with a 1 mm cutter: the edge is at X 85.1, past the stick-out, and
    // with no tailstock there is nothing at the end to name.
    const body = ['G0 X70 Z15 A0', 'G1 Z9.5 F100', 'G1 X84.6 F500'];
    const OUT = { rotary: { radius: 10, stickout: 85, tailstock: false } } as const;
    const f = finding(body, 'wrap-off-free-end', OUT);
    expect(f).toBeDefined();
    expect(f!.line).toBe(lineOf(body, 'G1 X84.6'));
    expect(f!.message).toContain('runs off the free end of the rod');
    expect(f!.message).toContain('X 85.1 mm');
    expect(f!.message).toContain('stick-out is 85 mm');
    expect(f!.message).not.toContain('tailstock');
    expect(f!.message).not.toMatch(CODE);
    // With the tailstock in, the same move is the band's, as it always was.
    expect(finding(body, 'wrap-into-clamp')).toBeDefined();
  });

  it('a rapid that TURNS the stock in the cut — “turns the stock while the cutter is in it”', () => {
    const body = ['G0 X20 Z15 A0', 'G1 Z9.5 F100', 'G0 A90'];
    const f = finding(body, 'rotary-rapid-engaged');
    expect(f).toBeDefined();
    expect(f!.line).toBe(lineOf(body, 'G0 A90'));
    expect(f!.message).toContain('turns the stock while the cutter is in it');
    expect(f!.message).toContain('0.5 mm inside the stock');
    expect(f!.message).toContain('Z 9.5 mm');
    expect(f!.message).toContain('3 mm of clearance');
    expect(f!.message).toContain('Z 13 mm');
    expect(f!.message).not.toMatch(CODE);

    // Clear of the stock by the 3 mm the rule asks, the same turn is fine.
    expect(finding(['G0 X20 Z15 A0', 'G0 A90'], 'rotary-rapid-engaged')).toBeUndefined();
  });

  it('#729 item 5 — a straight drill through the axis is a cross-hole, not a crossing fault', () => {
    // One X, one Y, one A: down through the centre and out the far side.
    expect(finding(['G0 X40 Z15 A90', 'G1 Z-11 F100', 'G0 Z15'], 'axis-crossing')).toBeUndefined();
    // Moving along X below the axis drags the cutter across the centre: still refused.
    expect(finding(['G0 X40 Z15 A90', 'G1 Z-2 F100', 'G1 X50 F300', 'G0 Z15'], 'axis-crossing')).toBeDefined();
    // So is turning A while below the axis.
    expect(finding(['G0 X40 Z15 A90', 'G1 Z-2 F100', 'G1 A120 F300', 'G0 Z15'], 'axis-crossing')).toBeDefined();
  });

  it('#729 — a rapid into the chuck: past the jaw face below the rod’s clearance', () => {
    // From above the rod down and back over the jaws: both ends could look clear, the line is not.
    const body = ['G0 X20 Z15 A0', 'G0 X-5 Z11'];
    const f = finding(body, 'rapid-into-chuck');
    expect(f).toBeDefined();
    expect(f!.line).toBe(lineOf(body, 'G0 X-5 Z11'));
    expect(f!.message).toContain('past the jaw face (X 0) below Z 13');
    expect(f!.message).not.toMatch(CODE);
    // Over the chuck above the clearance height is fine.
    expect(finding(['G0 X20 Z15 A0', 'G0 X-5 Z15'], 'rapid-into-chuck')).toBeUndefined();
  });

  it('a rapid that TRAVERSES along the axis in the cut is the same hazard', () => {
    const f = finding(['G0 X20 Z15 A0', 'G1 Z9.5 F100', 'G0 X40'], 'rotary-rapid-engaged');
    expect(f).toBeDefined();
    expect(f!.message).toContain('turns the stock while the cutter is in it');
    expect(f!.message).not.toMatch(CODE);
  });

  it('a stock outside the module’s ⌀80 × 150 — “does not fit the rotary’s ⌀80 × 150 mm”', () => {
    const body = ['G0 X20 Z15 A0', 'G1 Z9.5 F100', 'G1 X30 F500'];
    const tooFat = finding(body, 'stock-exceeds-module', {
      setup: cyl(90, 100),
      rotary: { radius: 45, stickout: 85, tailstock: true },
    });
    expect(tooFat).toBeDefined();
    expect(tooFat!.message).toContain("does not fit the rotary's ⌀80 × 150 mm");
    expect(tooFat!.message).toContain('⌀90 × 100 mm');
    expect(tooFat!.message).not.toMatch(CODE);

    const tooLong = finding(body, 'stock-exceeds-module', { setup: cyl(20, 160) });
    expect(tooLong).toBeDefined();
    expect(tooLong!.message).toContain('⌀20 × 160 mm');
    expect(tooLong!.message).not.toMatch(CODE);
  });

  it('the module’s envelope is the MACHINE’s: the Carvera Air holds what the Z1 refuses (#773)', () => {
    const body = ['G0 X20 Z15 A0', 'G1 Z9.5 F100', 'G1 X30 F500'];
    const over = { setup: cyl(90, 100), rotary: { radius: 45, stickout: 85, tailstock: true } };
    // ⌀90 does not fit the Z1's ⌀80 × 150 module...
    expect(finding(body, 'stock-exceeds-module', over)).toBeDefined();
    // ...and does fit the Air's ⌀92 × 200 one, so nothing is refused about the module.
    expect(finding(body, 'stock-exceeds-module', { ...over, machine: CARVERA_AIR })).toBeUndefined();
    // The sentence names the Air's own figures when something really is too big.
    const tooFat = finding(body, 'stock-exceeds-module', {
      ...over,
      setup: cyl(95, 100),
      machine: CARVERA_AIR,
      rotary: { radius: 47.5, stickout: 85, tailstock: true },
    });
    expect(tooFat).toBeDefined();
    expect(tooFat!.message).toContain("does not fit the rotary's ⌀92 × 200 mm");
  });
});

// #759 — feed-at-radius (/Rotary.md §1.2, §6.4): the firmware's perimeter scaling, then the A cap,
// leaves the material slower than F; a warning, never a refusal, in the operator's numbers.
describe('#759 feed-at-radius', () => {
  it('warns with the speed the material really sees, and names the A ceiling when it binds', () => {
    const body = ['G0 X20 Z15 A0', 'G1 Z9.5 F100', 'G1 X30 A10 F1200', 'G0 Z15'];
    const f = finding(body, 'feed-at-radius');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('warning');
    expect(f!.line).toBe(lineOf(body, 'G1 X30'));
    expect(f!.message).toMatch(/turns A at \d+ °\/s, its 60 °\/s ceiling/);
    expect(f!.message).toContain('the material sees about');
    expect(f!.message).not.toMatch(CODE);
  });

  it('warns when a simultaneous path asks most of the Z axis, even with A below its cap', () => {
    // r 9.5 at F600 asks 40 °/s (under the 60 cap), but the move descends 3.5 mm over 10° of A:
    // the Z axis is asked for ~841 mm/min against its 600 — the demand this warning exists for.
    const steep = ['G0 X20 Z15 A0', 'G1 Z9.5 F100', 'G1 X30 Z6 A10 F600', 'G0 Z15'];
    const f = finding(steep, 'feed-at-radius');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('warning');
    expect(f!.message).toContain('the material sees about');
    expect(f!.message).toContain('not the 600 asked');
    expect(f!.message).toMatch(/the Z axis alone is asked for \d+ mm\/min of its 600/);
  });

  it('says nothing on a plain wrapped program or one that does not turn A', () => {
    // The dowel shape: a constant-Z wrap at F600, A at 40 °/s — under the cap, no Z demand.
    expect(report(['G0 X20 Z15 A0', 'G1 Z9.5 F100', 'G1 X30 A360 F600', 'G0 Z15']).findings).toEqual([]);
    // And with no A word there is no rotary feed for the firmware to scale.
    const flat = ['G0 X20 Z15', 'G1 Z9.5 F100', 'G1 X30 F1200', 'G0 Z15'];
    expect(report(flat).findings.some((f) => f.code === 'feed-at-radius')).toBe(false);
  });
});
