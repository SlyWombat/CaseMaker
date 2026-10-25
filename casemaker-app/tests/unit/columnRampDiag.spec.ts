// #629 — the column engine names a ramp that crosses a level. A feed whose Z ramps along its XY
// segment is swept at its deep end (`min(z0, z1)`); the caller passes half the job's smallest level
// step, and a ramp past it gets the same `ramp-over-removed` info the exact engine already raises —
// while a thread's ~0.01 mm per chord stays silent. Pure: no wasm, so these run in milliseconds.
import { describe, expect, it } from 'vitest';
import { buildTimeline, MACHINES, parseGcode, stubSetup } from '@/engine/cnc';
import { rectProfile } from '@/engine/compiler/profile';
import { flatEndMill } from '@/engine/cnc/tool';
import { columnSweep } from '@/workers/geometry/columnEngine';

const setup = (): ReturnType<typeof stubSetup> =>
  stubSetup(
    { kind: 'prism', outline: rectProfile(40, 40), thickness: 10 },
    { kind: 'tape-down', contact: rectProfile(40, 40) },
    {},
    MACHINES.Z1,
  );

/** The `ramp-over-removed` messages a sweep raised for the program, with the threshold applied. */
function rampDiags(src: string, thresholdMm: number | null): string[] {
  const timeline = buildTimeline(parseGcode(src), setup(), MACHINES.Z1);
  const out = columnSweep(timeline, flatEndMill(1), setup(), { rampThresholdMm: thresholdMm });
  return (out.ok ? out.diagnostics : [])
    .filter((d) => d.code === 'ramp-over-removed')
    .map((d) => d.message);
}

describe('#629 the column engine names a ramp that crosses a level', () => {
  it('a 1 mm ramp fires and a ~0.01 mm one stays silent at a 0.25 mm threshold', () => {
    // A plunge to −0.5, then an XY move whose Z ramps down 1.0 mm: the deep-end sweep crosses a level.
    const big = 'S1000 M3\nG0 X0 Y0 Z1\nG1 Z-0.5 F100\nG1 X20 Z-1.5 F500\n';
    // The same move ramping only 0.01 mm — the thread helix's scale — does not.
    const small = 'S1000 M3\nG0 X0 Y0 Z1\nG1 Z-0.5 F100\nG1 X20 Z-0.51 F500\n';
    const bigDiags = rampDiags(big, 0.25);
    expect(bigDiags).toHaveLength(1);
    expect(bigDiags[0]).toContain('swept at its lowest Z');
    expect(rampDiags(small, 0.25)).toHaveLength(0);
  });

  it('no threshold leaves the check off — a pre-#629 caller sees nothing new', () => {
    const big = 'S1000 M3\nG0 X0 Y0 Z1\nG1 Z-0.5 F100\nG1 X20 Z-1.5 F500\n';
    expect(rampDiags(big, null)).toHaveLength(0);
    expect(rampDiags(big, 0)).toHaveLength(0);
  });
});
