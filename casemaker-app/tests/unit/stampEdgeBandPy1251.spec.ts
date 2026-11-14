// #1251 — THE PAGE'S CHECKER AND THE APP'S STAMP MUST AGREE CELL FOR CELL ON THE EDGE BAND.
//
// The rule is stated twice: in the app's `stampField` (`workers/sim/sweptPoint.ts`, `goal.z` +
// `goal.edgeBandMm`) and in the bench page's `goal_check.py` (`stamp`/`stamp_mkr`, `goal=` with
// `EDGE_BAND`). The page's own parity contract (`goal-check-parity.py`) is about the adjudicated
// fraction on real runs; this spec pins the STAMP ITSELF, cell for cell, on the same program and
// the same goal grid, including the edge band's floor and wall cases.
//
// The Python half needs the bench's environment (numpy and Pillow; the location document for
// `render.py`'s module-level read is the committed fixture below). The interpreter is `CM_PYTHON`
// (the interpreter PATH, not a venv directory) when set, else `python3` — the same contract as
// `pageChecker1267.spec.ts` (#1267): there is NO silent skip. When the interpreter cannot import
// numpy and Pillow the first test FAILS and says how to fix it; the one way out is the explicit
// `CM_SKIP_PAGE_CHECKER=1`, which runs a test that prints why nothing ran. Gate runs never set it.

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

const PY = process.env.CM_PYTHON || 'python3';
const SKIP = process.env.CM_SKIP_PAGE_CHECKER === '1';
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

const FIX =
  `The edge-band parity spec needs numpy and Pillow. Point CM_PYTHON at an interpreter that has both ` +
  `(the interpreter path, not the venv directory): dave-1 ~/casemaker-manager/venv/bin/python, ` +
  `k3 ~/v02-stage/venv/bin/python. To run without them deliberately, set CM_SKIP_PAGE_CHECKER=1 ` +
  `(it prints why it skipped; gate runs never set it).`;

describe('#1251 the edge band: the app’s stamp and goal_check.py agree cell for cell', () => {
  it.runIf(SKIP)('CM_SKIP_PAGE_CHECKER=1 — the edge-band parity (app stamp vs goal_check.py) was NOT run', () => {
    console.warn(
      '#1251: CM_SKIP_PAGE_CHECKER=1 — the app-versus-page edge-band parity spec was NOT run. A gate run must not set this.',
    );
  });

  it.skipIf(SKIP)('the checker’s Python can import numpy and Pillow', () => {
    expect(probe.status, `${PY} cannot import numpy/Pillow (${String(probe.stderr || probe.error || '').trim().split('\n').pop()}). ${FIX}`).toBe(0);
  });

  it.skipIf(SKIP)('a floor at the edge — the tray top’s fin case', () => {
    expectSameCells(goalGrid(() => -5), 64.012);
  });

  it.skipIf(SKIP)('a wall at the edge — the clamp cards’ gouge case', () => {
    expectSameCells(goalGrid((x) => (x < 65.6 - 1e-9 ? -5 : 0)), 64.013);
  });

  it.skipIf(SKIP)('a real cut-in past the band is charged by both', () => {
    expectSameCells(goalGrid((x) => (x < 65.6 - 1e-9 ? -5 : 0)), 64.02);
  });
});
