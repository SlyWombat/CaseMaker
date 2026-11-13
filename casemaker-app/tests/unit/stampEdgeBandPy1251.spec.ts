// #1251 — THE PAGE'S CHECKER AND THE APP'S STAMP MUST AGREE CELL FOR CELL ON THE EDGE BAND.
//
// The rule is stated twice: in the app's `stampField` (`workers/sim/sweptPoint.ts`, `goal.z` +
// `goal.edgeBandMm`) and in the bench page's `goal_check.py` (`stamp`/`stamp_mkr`, `goal=` with
// `EDGE_BAND`). The page's own parity contract (`goal-check-parity.py`) is about the adjudicated
// fraction on real runs; this spec pins the STAMP ITSELF, cell for cell, on the same program and
// the same goal grid, including the edge band's floor and wall cases.
//
// The Python half needs the bench's environment (numpy and Pillow, plus a location document for
// `render.py`'s module-level read). Set `CM_BENCH_PYTHON` to that interpreter; without it the
// spec tries `python3` and SKIPS when the imports are missing rather than failing on a machine
// that does not carry the bench tools.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildTimeline, parseGcode, stubSetup } from '@/engine/cnc';
import { flatEndMill } from '@/engine/cnc/tool';
import { exactSweptField } from '@/workers/sim/sweptPoint';

const PITCH = 0.1;
const NX = 801; // x 0 .. 80 mm
const NY = 3;
const R = 1.5875;
const BAND = 0.001;

const PY = process.env.CM_BENCH_PYTHON ?? 'python3';
const TOOLS = fileURLToPath(new URL('../../../docs/bench/2026-10-28-z1-real-jobs/tools', import.meta.url));
const LOCATION = fileURLToPath(new URL('./fixtures/location-doc.json', import.meta.url));
const env = { ...process.env, CM_LOCATION: LOCATION };
const probe = spawnSync(PY, ['-c', 'import numpy, PIL'], { env, encoding: 'utf8' });

const SLAB = { kind: 'prism' as const, outline: { kind: 'p-rect' as const, size: [82, 4] as [number, number] }, thickness: 10 };
const SETUP = stubSetup(SLAB, { kind: 'tape-down', contact: SLAB.outline });
const FLAT = flatEndMill(2 * R, { name: '3.175 mm flat', fluteLength: 30 });

const ncAt = (qx: number): string =>
  ['G21 G90', 'S1000 M3', 'G0 X' + qx + ' Z5', 'G0 Y-2', 'G1 Z-5 F200', 'G1 Y5 F400', 'G0 Z5', 'M2'].join('\n');

function goalGrid(zAt: (x: number) => number): Float32Array {
  const z = new Float32Array(NX * NY);
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) z[j * NX + i] = zAt(i * PITCH);
  return z;
}

const PY_SCRIPT = `
import sys, json
import numpy as np
cfg = json.load(open(sys.argv[1]))
sys.path.insert(0, cfg['tools'])
import goal_check as G
H = np.zeros((cfg['ny'], cfg['nx']), dtype=float)
goal = np.array(cfg['goal'], dtype=float).reshape(cfg['ny'], cfg['nx'])
if cfg['shape'] == 'ball':
    RR = cfg['R']
    prof = lambda r: RR - np.sqrt(np.maximum(RR * RR - r * r, 0))
else:
    prof = lambda r: np.zeros_like(r)
tool = {'name': 'parity', 'shape': cfg['shape'], 'R': cfg['R'], 'diameter': 2 * cfg['R'],
        'tip': 2 * cfg['R'], 'prof': prof, 'leg': 0.0, 'number': 1}
G.stamp(H, cfg['x0'], cfg['y0'], cfg['p'], cfg['nc'], t=tool, goal=goal)
print(json.dumps(H.ravel().tolist()))
`;

function pythonStamp(goal: Float32Array, qx: number): number[] {
  const dir = mkdtempSync(join(tmpdir(), 'stamp-parity-'));
  try {
    const nc = join(dir, 'parity.nc');
    writeFileSync(nc, ncAt(qx));
    const cfg = join(dir, 'cfg.json');
    writeFileSync(cfg, JSON.stringify({ tools: TOOLS, nc, x0: 0, y0: 0, p: PITCH, nx: NX, ny: NY, R, shape: 'flat', goal: Array.from(goal) }));
    const run = spawnSync(PY, ['-c', PY_SCRIPT, cfg], { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (run.status !== 0) throw new Error(`goal_check.py failed: ${run.stderr || run.stdout}`);
    return JSON.parse(run.stdout) as number[];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function tsStamp(goal: Float32Array, qx: number): Float32Array {
  const field = exactSweptField(
    { nx: NX, ny: NY, x0: 0, y0: 0, pitch: PITCH, z: goal, edgeBandMm: BAND },
    buildTimeline(parseGcode(ncAt(qx)), SETUP),
    FLAT,
  );
  expect(field).not.toBeNull();
  return field as Float32Array;
}

function expectSameCells(goal: Float32Array, qx: number): void {
  const ts = tsStamp(goal, qx);
  const py = pythonStamp(goal, qx);
  expect(py).toHaveLength(ts.length);
  let worst = 0;
  let at = -1;
  for (let k = 0; k < ts.length; k++) {
    const d = Math.abs(ts[k]! - py[k]!);
    if (d > worst) {
      worst = d;
      at = k;
    }
  }
  // Float32 (the app's field) against Python's float64: an exact-value comparison to 1e-5.
  expect(worst, `worst cell ${at} (x=${((at % NX) * PITCH).toFixed(1)}): app ${ts[at]} vs page ${py[at]}`).toBeLessThan(1e-5);
  // And the array shapes agree: every cell stamped or not in exactly the same places.
  const stampedTs = Array.from(ts, (v) => v !== 0);
  const stampedPy = py.map((v) => v !== 0);
  expect(stampedPy).toEqual(stampedTs);
}

describe.skipIf(probe.status !== 0)('#1251 the edge band: the app’s stamp and goal_check.py agree cell for cell', () => {
  it('a floor at the edge — the tray top’s fin case', () => {
    expectSameCells(goalGrid(() => -5), 64.012);
  });

  it('a wall at the edge — the clamp cards’ gouge case', () => {
    expectSameCells(goalGrid((x) => (x < 65.6 - 1e-9 ? -5 : 0)), 64.013);
  });

  it('a real cut-in past the band is charged by both', () => {
    expectSameCells(goalGrid((x) => (x < 65.6 - 1e-9 ? -5 : 0)), 64.02);
  });
});
