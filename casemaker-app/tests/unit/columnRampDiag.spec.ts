// #629, #758 — the column engine names a ramp that crosses a level, FOR A PLAIN V-BIT ONLY. A feed
// whose Z ramps along its XY segment is swept at its deep end (`min(z0, z1)`) by a V, and that
// removes more than the machine would. Since #758 every other cutter follows Z along the move (the
// flat, ball and bull finishes and the thread mill), so their picture no longer over-removes and
// the warning stays silent. The caller passes half the job's smallest level step, so a thread's
// ~0.01 mm per chord stays silent and only a ramp past the threshold is named. Pure: no wasm.
import { describe, expect, it } from 'vitest';
import { buildTimeline, MACHINES, parseGcode, stubSetup } from '@/engine/cnc';
import { rectProfile } from '@/engine/compiler/profile';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { columnSweep } from '@/workers/geometry/columnEngine';

const setup = (): ReturnType<typeof stubSetup> =>
  stubSetup(
    { kind: 'prism', outline: rectProfile(40, 40), thickness: 10 },
    { kind: 'tape-down', contact: rectProfile(40, 40) },
    {},
    MACHINES.Z1,
  );

/** The catalogue's 90° chamfer: a plain V-bit, the one cutter still swept at its segment's low end. */
const V: Tool = { ...flatEndMill(3.175), name: '3.175mm*90º Chamfer', typeText: 'Chamfer', shape: 'chamfer', tipDiameter: 0.1, diameter: 3.175, angle: 90, halfAngle: null, cornerRadius: null };

/** The `ramp-over-removed` messages a sweep raised for the program, with the threshold applied. */
function rampDiags(src: string, thresholdMm: number | null, tool: Tool = V): string[] {
  const timeline = buildTimeline(parseGcode(src), setup(), MACHINES.Z1);
  const out = columnSweep(timeline, tool, setup(), { rampThresholdMm: thresholdMm });
  return (out.ok ? out.diagnostics : [])
    .filter((d) => d.code === 'ramp-over-removed')
    .map((d) => d.message);
}

const BIG = 'S1000 M3\nG0 X0 Y0 Z1\nG1 Z-0.5 F100\nG1 X20 Z-1.5 F500\n';
const SMALL = 'S1000 M3\nG0 X0 Y0 Z1\nG1 Z-0.5 F100\nG1 X20 Z-0.51 F500\n';

describe('#629 the column engine names a ramp that crosses a level', () => {
  it('a V-bit’s 1 mm ramp fires and a ~0.01 mm one stays silent at a 0.25 mm threshold', () => {
    const bigDiags = rampDiags(BIG, 0.25);
    expect(bigDiags).toHaveLength(1);
    expect(bigDiags[0]).toContain('swept at its lowest Z');
    expect(rampDiags(SMALL, 0.25)).toHaveLength(0);
  });

  it('a FLAT ramp is followed along the move and says nothing (#758)', () => {
    // The flat engine follows Z at each column's foot, so the picture is not "swept at its lowest
    // Z" and the info would be false — the same threshold and ramp that fires for a V.
    expect(rampDiags(BIG, 0.25, flatEndMill(1))).toHaveLength(0);
  });

  it('no threshold leaves the check off — a pre-#629 caller sees nothing new', () => {
    expect(rampDiags(BIG, null)).toHaveLength(0);
    expect(rampDiags(BIG, 0)).toHaveLength(0);
  });
});
