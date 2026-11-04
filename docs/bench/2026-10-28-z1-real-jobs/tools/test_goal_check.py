"""Pinned self-tests for the page's checker (tools/goal_check.py, #955).

Three synthetic programs with answers known before the checker runs, so a change to the stamp, the
allowances or the cut-into rule shows up here before it reaches a card. Run with the venv python:

    ~/casemaker-manager/venv/bin/python test_goal_check.py

Each fixture writes a synthetic goal heightfield (float32 .bin + covered .cov + header .json) and an
NC carrying the `;@MKR|TOOL|` header the checker reads its cutter from, runs `goal_check.py` on the
pair, and asserts the report's numbers against the pinned values below.

A · PLUNGE — a 2 mm flat plunges 1 mm into a flat 20 x 10 mm goal at a cell centre. The charged
    cells are the lattice points strictly inside the disc (`i^2 + j^2 < 100` on the 0.1 mm grid):
    **305 cells = 1.52 %**, max depth 1.000 mm, the rest stands 1 mm proud (leftover 98.47 %).
B · CLEAN POCKET — a 4 x 4 mm goal floor at -0.5 mm is rastered at -0.5 with a 1 mm flat, pass
    pitch 0.4 mm: every cell centre is inside a pass's disc, so the swept top EQUALS the goal:
    cut-into 0.00 %, leftover 0.00 %, coverage 100.00 %, over 4,941 covered cells.
C · BOUNDARY-TANGENT CONTOUR — a half-plane part whose outline row is at x = 10.05; a 2 mm flat
    contours at x = 9.05, so the disc's edge is exactly on that row's cell centres. The strict
    footprint edge (#964) charges nothing: cut-into 0.00 %. Under the old `distance <= radius` line
    that row (100 cells, 1.00 %) was charged — the 134-cell phantom class of #959, in miniature.
"""
import json
import os
import subprocess
import sys
import tempfile

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
PITCH = 0.1
NX, NY = 200, 100          # 20 x 10 mm
T = 2.0                    # stock thickness, mm
TOOL = (';@MKR|TOOL|number=1|id=test|name=test flat|type=Flat End|handlediameter=3.175|'
        'sticklength=0|shoulderlength=10|flutelength=10|diameter={d}|tipdiameter={d}|'
        'cornerradius=0|angle=0|halfAngle=0')


def goal(prefix, covered, z):
    """covered: boolean (ny, nx); z: the goal's height where covered (rest reads the stock top)."""
    cov = covered.astype(np.uint8)
    zz = np.where(covered, float(z), 0.0).astype(np.float32)
    zz.tofile(prefix + '.bin')
    cov.tofile(prefix + '.cov')
    json.dump({'nx': NX, 'ny': NY, 'x0': 0.0, 'y0': 0.0, 'pitch': PITCH, 'topZ': 0,
               'minZ': float(z), 'coveredCount': int(covered.sum())}, open(prefix + '.json', 'w'))


def run(nc_text, prefix, out):
    nc = prefix + '.nc'
    open(nc, 'w').write(nc_text)
    os.makedirs(out, exist_ok=True)
    env = dict(os.environ)
    # render.py reads the location export (its defaults carry the pass line); the demo export is
    # the one the page was built with, and any export gives the same pass rule for these fixtures.
    env.setdefault('CM_LOCATION', os.path.expanduser('~/casemaker-manager/demo-build/location.json'))
    r = subprocess.run([sys.executable, os.path.join(HERE, 'goal_check.py'), prefix, str(T), out, nc],
                       capture_output=True, text=True, env=env)
    if r.returncode != 0:
        raise SystemExit(f'goal_check.py failed:\n{r.stdout[-800:]}\n{r.stderr[-2000:]}')
    return json.load(open(os.path.join(out, 'goalcheck.json')))


def cells(test):
    jj, ii = np.mgrid[0:NY, 0:NX]
    return test(ii, jj)


def approx(a, b, tol=1e-9):
    return abs(float(a) - float(b)) <= tol


def fixture_plunge(tmp):
    prefix = os.path.join(tmp, 'goal-plunge')
    goal(prefix, np.ones((NY, NX), bool), -0.5)          # a flat floor 0.5 mm under the stock top
    nc = '\n'.join([TOOL.format(d=2.0), 'G90 G21', 'S10000 M3', 'G0 X10.0 Y5.0 Z5',
                    'G1 Z-1.5 F300', 'G0 Z5', 'M2', ''])  # one plunge, 1 mm into the floor, at a cell centre
    return run(nc, prefix, os.path.join(tmp, 'out-plunge'))


def fixture_pocket(tmp):
    prefix = os.path.join(tmp, 'goal-pocket')
    cov = cells(lambda i, j: (i >= 60) & (i <= 140) & (j >= 20) & (j <= 80))  # x 6.05..14.05, y 2.05..8.05
    goal(prefix, cov, -0.5)
    lines = [TOOL.format(d=1.0), 'G90 G21', 'S10000 M3', 'G0 Z1']
    y = 2.05
    left = True
    while y <= 8.05 + 1e-9:  # 0.4 mm pitch: every cell centre within 0.2 of a pass
        lines += [f'G0 X{5.0 if left else 15.0:.2f} Y{y:.2f}', 'G0 Z-0.5', 'G1 Z-0.5 F300',
                  f'G1 X{15.0 if left else 5.0:.2f} F700', 'G0 Z1']
        left = not left
        y += 0.4
    lines += ['M2', '']
    return run('\n'.join(lines), prefix, os.path.join(tmp, 'out-pocket'))


def fixture_contour(tmp):
    prefix = os.path.join(tmp, 'goal-contour')
    cov = cells(lambda i, j: i >= 100)                      # the part: x >= 10.0 (a cell centre row)
    goal(prefix, cov, 0.0)
    nc = '\n'.join([TOOL.format(d=2.0), 'G90 G21', 'S10000 M3', 'G0 Z5',
                    'G0 X9.0 Y-1', 'G1 Z-1 F300', 'G1 Y11 F400',  # disc edge on x = 10.0 exactly
                    'G0 Z5', 'M2', ''])
    return run(nc, prefix, os.path.join(tmp, 'out-contour'))


def check(name, s, expect):
    bad = {k: (s.get(k), v) for k, v in expect.items() if not approx(s.get(k, float('nan')), v)}
    state = 'PASS' if not bad else 'FAIL'
    print(f'{name}: {state}')
    for k, v in expect.items():
        print(f'   {k:24s} {s.get(k)!s:>12s}  (pinned {v})')
    if bad:
        raise AssertionError(f'{name}: {bad}')


def main():
    with tempfile.TemporaryDirectory(prefix='goal-check-selftest-') as tmp:
        # A — a plunge: the disc's lattice points strictly inside r = 1.0; max depth exactly 1 mm.
        s = fixture_plunge(tmp)
        check('A plunge', s, {'goalCells': 20000, 'cutIntoInclEdgePct': 1.52,
                              'cutInto0p1Pct': 1.52, 'maxCutIntoMm': 1.0,
                              'leftover0p1Pct': 98.47, 'medianMm': 0.5})
        # B — a clean pocket: the sweep equals the goal, so nothing is cut into or left.
        s = fixture_pocket(tmp)
        check('B clean pocket', s, {'goalCells': 4941, 'cutIntoInclEdgePct': 0.0,
                                    'cutInto0p1Pct': 0.0, 'maxCutIntoMm': 0.0,
                                    'leftover0p1Pct': 0.0, 'medianMm': 0.0})
        # C — boundary-tangent contour: the strict edge charges nothing (the old rule charged 1.00 %).
        s = fixture_contour(tmp)
        check('C boundary-tangent contour', s, {'goalCells': 10000, 'cutIntoInclEdgePct': 0.0,
                                               'cutInto0p1Pct': 0.0, 'maxCutIntoMm': 0.0,
                                               'leftover0p1Pct': 0.0, 'wallNotScoredPct': 0.0})
    print('all three fixtures hold')


if __name__ == '__main__':
    main()
