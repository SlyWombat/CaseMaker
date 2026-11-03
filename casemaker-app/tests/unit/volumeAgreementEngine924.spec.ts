/**
 * Gate statement 6 as an engine test (#924, review M4; #943 line 1). Single straight strokes, swept
 * by the real engines with real Tool records, against closed forms derived from the cutter's own
 * shape (`designCheck.ts` part 2), never from the sweep's code.
 *
 * Engines: a V cutter always sweeps on the column engine. A flat takes the exact sweeper on a
 * sparse program and the column engine only on a dense one (>1000 Z levels), so the flats are run
 * twice: one pass, and the same line stepped down in 1100 layers (whose union is one capsule).
 * Tolerance: the sweep's own band times the stroke's top-face perimeter times its depth.
 */
import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { cappedVGrooveVolumeMm3, checkVolumeAgreement, flatCapsuleVolumeMm3 } from '@/engine/cnc/engrave/designCheck';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { toSetup } from '@/engine/cnc/engrave/jobSetup';
import { Z1 } from '@/engine/cnc/machine';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { createSimSession } from '@/workers/sim/session';

const L = 40;

/** A straight 40 mm stroke along X at Y 30, in one pass or stepped down in `layers`. */
function stroke(depth: number, layers = 1): string {
  const lines = ['G90 G21', 'T1 M6', 'M331', 'G53 G0 Z-3', 'G0 X30 Y30', 'S12000 M3', 'G0 Z5', 'G0 Z1'];
  for (let i = 1; i <= layers; i++) {
    lines.push(`G1 Z${(-(depth * i) / layers).toFixed(6)} F150`, `G1 X${i % 2 === 1 ? 30 + L : 30} Y30 F400`);
  }
  lines.push('G0 Z1', 'G0 Z5', 'G0 Z15', 'M332', 'M05', 'G28', 'M02');
  return `${lines.join('\n')}\n`;
}

const flat = (d: number): Tool => flatEndMill(d, { fluteLength: 20 });
/** An engraving bit as the catalogue states one: tip, half angle, body (shank) diameter. */
const vBit = (tip: number, half: number, body: number | null): Tool => ({
  ...flatEndMill(3.175, { fluteLength: 20 }),
  name: `${half * 2}° V`,
  typeText: 'Engraving',
  shape: 'engraving',
  tipDiameter: tip,
  halfAngle: half,
  angle: null,
  diameter: body,
});

function sweep(tool: Tool, nc: string, depth: number) {
  const job = defaultEngraveJob();
  const session = createSimSession(tl);
  try {
    const loaded = session.load(nc, toSetup(job, Z1), tool, Z1.id);
    if (!loaded.ok) throw new Error(`the sim refused the stroke: ${JSON.stringify(loaded.diagnostics)}`);
    const band = session.levelCut(-depth / 2)?.bandMm;
    if (band === undefined) throw new Error('no band at the stroke’s mid depth');
    return { volume: loaded.stats.removedVolume, column: loaded.flatField != null, band };
  } finally {
    session.dispose();
  }
}

/** The tolerance in mm³ and the agreement report for one stroke. */
function agree(label: string, simulated: number, analytic: number, band: number, topRadius: number, depth: number) {
  const perimeter = 2 * L + 2 * Math.PI * topRadius;
  const tolerance = band * perimeter * depth;
  return checkVolumeAgreement(label, simulated, analytic, { toleranceFraction: tolerance / analytic });
}

describe('gate 6 — the engines against the closed forms', () => {
  // 1.2 mm, not 1: the timeline merges Z levels closer than 0.001 mm, so a dense stroke needs at
  // least 1.1 mm of depth to reach the column engine's 1000-level threshold in 1100 layers.
  const flats: [number, number][] = [
    [1, 1.2],
    [1, 3],
    [3.175, 1.2],
    [3.175, 3],
  ];
  for (const [dia, depth] of flats) {
    for (const [engine, layers] of [['exact', 1], ['column', 1100]] as const) {
      it(`flat ⌀${dia} at ${depth} mm on the ${engine} engine`, () => {
        const s = sweep(flat(dia), stroke(depth, layers), depth);
        expect(s.column).toBe(engine === 'column');
        const report = agree(`flat ⌀${dia} ${depth} mm`, s.volume, flatCapsuleVolumeMm3(L, dia / 2, depth), s.band, dia / 2, depth);
        expect(report.ok, report.sentence).toBe(true);
      }, 120_000);
    }
  }

  const vs: [string, number, number, number][] = [
    ['30° tip 0.5', 0.5, 15, 1],
    ['90° tip 0.1', 0.1, 45, 1],
  ];
  for (const [name, tip, half, depth] of vs) {
    it(`V ${name} at ${depth} mm, below its cone, on the column engine`, () => {
      const s = sweep(vBit(tip, half, 3.175), stroke(depth), depth);
      expect(s.column).toBe(true);
      const analytic = cappedVGrooveVolumeMm3(L, tip / 2, half, 3.175 / 2, depth);
      const top = Math.min(tip / 2 + depth * Math.tan((half * Math.PI) / 180), 3.175 / 2);
      const report = agree(`V ${name}`, s.volume, analytic, s.band, top, depth);
      expect(report.ok, report.sentence).toBe(true);
    }, 120_000);
  }

  it('#741: the 90° ⌀3.175 bit at 5.1 mm, past its 1.54 mm cone, agrees with the capped groove', () => {
    const s = sweep(vBit(0.1, 45, 3.175), stroke(5.1), 5.1);
    const report = agree('#741 90° ⌀3.175 5.1 mm', s.volume, cappedVGrooveVolumeMm3(L, 0.05, 45, 3.175 / 2, 5.1), s.band, 3.175 / 2, 5.1);
    expect(report.ok, report.sentence).toBe(true);
  }, 120_000);

  it('#741 red: a record stating no body sweeps an uncapped cone, and the gate fails it by name', () => {
    const s = sweep(vBit(0.1, 45, null), stroke(5.1), 5.1);
    // The real bit's body caps the cone; the uncapped sweep is the defect #741 reported.
    const report = agree('#741 90° ⌀3.175 5.1 mm', s.volume, cappedVGrooveVolumeMm3(L, 0.05, 45, 3.175 / 2, 5.1), s.band, 3.175 / 2, 5.1);
    expect(report.ok).toBe(false);
    expect(report.excessFraction).toBeGreaterThan(0.5);
    expect(report.sentence).toContain('#741 90° ⌀3.175 5.1 mm');
    // And the closed form is right about what it did sweep: the uncapped groove.
    const uncapped = cappedVGrooveVolumeMm3(L, 0.05, 45, null, 5.1);
    expect(Math.abs(s.volume - uncapped)).toBeLessThan(s.band * (2 * L + 2 * Math.PI * 5.15) * 5.1);
  }, 120_000);

  it('the capped-groove closed form agrees with numerical quadrature of its own slices', () => {
    for (const [tip, half, body, depth] of [
      [0.25, 15, 1.5875, 1],
      [0.05, 45, 1.5875, 5.1],
      [0.05, 45, null, 5.1],
    ] as const) {
      const t = Math.tan((half * Math.PI) / 180);
      const n = 20_000;
      let q = 0;
      for (let i = 0; i < n; i++) {
        const h = ((i + 0.5) / n) * depth;
        const rho = Math.min(tip + h * t, body ?? Infinity);
        q += (2 * rho * L + Math.PI * rho * rho) * (depth / n);
      }
      expect(cappedVGrooveVolumeMm3(L, tip, half, body, depth)).toBeCloseTo(q, 3);
    }
  });
});
