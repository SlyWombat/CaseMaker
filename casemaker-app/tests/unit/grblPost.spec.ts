/**
 * #845 — THE GRBL 1.1 POST. A golden-file test of the parts the issue names: the header (a `;`
 * comment block, no `;@MKR`), the manual tool-change PAUSE with the tool named and the re-zero
 * stated, the coolant, and the ending. And the two refusals by name: a rotary program, and a
 * cutting move that is really air.
 */
import { describe, it, expect } from 'vitest';

import { postGrbl } from '@/engine/cnc/post/grbl';
import type { CamMove, ToolpathIR } from '@/engine/cnc/cam/ir';
import { Z1 } from '@/engine/cnc/machine';
import { flatEndMill } from '@/engine/cnc/tool';
import type { PostContext } from '@/engine/cnc/post/z1';

const TOOL = { ...flatEndMill(1, { name: '1 mm flat end' }), id: null };
const MACHINE = { ...Z1, id: 'grbl-demo', name: 'Shapeoko 4 (demo)', maxCutFeed: 4000, maxRpm: 24000, hasATC: false };

const CTX: PostContext = {
  jobName: 'demo pocket',
  stock: { length: 20, width: 10, thickness: 5 },
  materialName: 'PLA',
  zDatum: 'probed-top-face',
  origin: 'topFrontLeft',
  camVersion: '1.0.0',
  toolKey: 'flat-1.0',
};

const plunge: CamMove[] = [
  { kind: 'rapid', x: 2, y: 2, z: 3 },
  { kind: 'feed', x: 2, y: 2, z: -0.5, f: 300 },
  { kind: 'feed', x: 6, y: 2, z: -0.5, f: 600 },
  { kind: 'rapid', x: 6, y: 2, z: 3 },
];

function ir(moves: CamMove[] = plunge, over: Partial<ToolpathIR> = {}): ToolpathIR {
  return {
    frame: 'flat',
    tool: TOOL,
    toolNumber: 1,
    spindleRpm: 12000,
    air: true,
    safeZ: 3,
    hopZ: 1,
    operations: [
      { number: 1, name: '[T1]pocket 0.5mm', labelId: 'pocket', depth: 0.5, depthPasses: 1, passStepMm: 0.5, moves, estimatedSeconds: 4 },
    ],
    ...over,
  };
}

describe('#845 the GRBL post', () => {
  it('writes the header, the manual-change pause and the ending, as a golden file', () => {
    const out = postGrbl(ir(), CTX, MACHINE);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // The estimate is the IR's own clock; the rest is the golden text.
    const text = out.text.replace(/^; estimated cycle time: \d+ s$/m, '; estimated cycle time: N s');
    expect(text).toBe(
      [
        '; Case Maker — demo pocket',
        '; dialect: GRBL 1.1',
        '; machine: Shapeoko 4 (demo)',
        '; tool: T1 1 mm flat end (flat-1.0)',
        '; stock: 20 x 10 x 5 mm, PLA',
        '; origin: topFrontLeft — X0 Y0 at the stock\'s front-left, Z0 on the probed top face',
        '; estimated cycle time: N s',
        '; toolpath 1: [T1]pocket 0.5mm',
        '',
        'G21 G90',
        'G54',
        '',
        '; change to T1 1 mm flat end — then re-zero Z on the top face and resume',
        'M0',
        '',
        'M8',
        'G0 Z3',
        'G0 X2 Y2',
        'M3 S12000',
        '; toolpath 1: [T1]pocket 0.5mm',
        'G1 Z-0.5 F300',
        'G1 X6 F600',
        'G0 Z3',
        'G0 Z3',
        'G0 Z10',
        'M9',
        'M5',
        'M30',
        '',
      ].join('\n'),
    );
    // The Z1's own words are never in a GRBL file.
    for (const word of ['M6', 'M331', 'M332', ';@MKR', 'G28']) expect(out.text).not.toContain(word);
  });

  it('refuses a rotary program by name, and does not write a 4th-axis file', () => {
    const out = postGrbl(ir(plunge, { frame: 'rotary' }), CTX, MACHINE);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.errors.join(' ')).toContain('fourth axis');
  });

  it('refuses a cutting move that is really air, as the Z1 post does', () => {
    const air: CamMove[] = [
      { kind: 'rapid', x: 2, y: 2, z: 3 },
      { kind: 'feed', x: 2, y: 2, z: 0.5, f: 300 },
      { kind: 'rapid', x: 2, y: 2, z: 3 },
    ];
    const out = postGrbl(ir(air), CTX, MACHINE);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.errors.join(' ')).toContain('a cut in the air');
  });
});
