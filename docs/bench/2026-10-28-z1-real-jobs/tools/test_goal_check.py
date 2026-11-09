"""Pinned self-tests for the page's checker (tools/goal_check.py, #955 → #1092).

Three synthetic programs with answers known before the checker runs, so a change to the stamp, the
allowances or the cut-into rule shows up here before it reaches a card. Run with the venv python:

    ~/casemaker-manager/venv/bin/python test_goal_check.py

Each fixture writes a synthetic goal heightfield (float32 .bin + covered .cov + header .json) and an
NC carrying the `;@MKR|TOOL|` header the checker reads its cutter from, runs `goal_check.py` on the
pair, and asserts the report's numbers against the pinned values below.

D–H then drive `goal_check.judge` directly on hand-built fields — the gate's rule (v6/v8) with every
answer known by hand, so the relief ceiling, the class ordering, the who gate and the step-test
slack are each pinned on their own.

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
# render.py reads the location export at import time; the same demo export the page was built with.
os.environ.setdefault('CM_LOCATION', os.path.expanduser('~/casemaker-manager/demo-build/location.json'))
sys.path.insert(0, HERE)
import goal_check as GC          # noqa: E402
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


# --- the gate's rule (v6/v8), straight on the judge — no NC, no location ---------------------

def judge_on(z, cov, cuts, *, who=None, allowance=None, shadow_radius=0.0, thickness=5.0,
             breakthrough=0.0, cl=None):
    """`z`/`cov` (ny, nx); `cuts` = [(j, i, depth)] is the stamp that reached that far below the
    goal at that cell (every other cell untouched at the stock top). `cl` = (j, i, x, y) — the
    deepest stamp's cutter-location point at that cell. Returns the report."""
    z = np.asarray(z, np.float32).astype(np.float64)
    ny, nx = z.shape
    cov = np.asarray(cov, bool)
    H = np.zeros((ny, nx))
    for j, i, d in cuts:
        H[j, i] = z[j, i] - d
    w = np.zeros((ny, nx), np.uint8) if who is None else np.asarray(who, np.uint8)
    X = np.zeros((ny, nx)); Y = np.zeros((ny, nx))
    if cl is not None:
        points = cl if isinstance(cl, list) else [cl]
        for j, i, x, y in points:
            X[j, i] = x; Y[j, i] = y
    gh = {'nx': nx, 'ny': ny, 'x0': 0.0, 'y0': 0.0, 'pitch': PITCH, 'topZ': 0.0,
          'minZ': float(z[cov].min()) if cov.any() else 0.0}
    s, _ = GC.judge(z, cov, H, w, X, Y, gh, thickness, allowance=allowance,
                    shadow_radius=shadow_radius, breakthrough=breakthrough,
                    silhouette_thickness=thickness)
    return s


def step_goal(nx, ny, hi_z, lo_z, i_step):
    """A flat plateau at `hi_z` for i < i_step and `lo_z` beyond: a step of hi_z − lo_z."""
    jj, ii = np.mgrid[0:ny, 0:nx]
    return np.where(ii < i_step, hi_z, lo_z), np.ones((ny, nx), bool)


def pocket_goal():
    """A covered 8 × 6 mm island at -0.5 in the 20 × 10 mm grid: its edge is the silhouette, and
    designEdgeCells marks the island's ring as WALL cells (the silhouette step)."""
    jj, ii = np.mgrid[0:NY, 0:NX]
    cov = (ii >= 60) & (ii <= 140) & (jj >= 20) & (jj <= 80)
    return np.where(cov, -0.5, 0.0), cov


def fixture_wall_relief(shadow_radius):
    """D — the v8 relief ceiling on a wall cell, with and without the tool's disc."""
    z, cov = step_goal(60, 40, -1.0, -2.0, 30)          # a 1.0 mm step at i = 29 | 30
    s = judge_on(z, cov, [(20, 29, 0.5), (10, 30, 2.5)], shadow_radius=shadow_radius)
    return s


def fixture_silhouette(depth, cl_xy, *, shadow_radius=1.0, thickness=2.0, breakthrough=0.3):
    """S — the outline cell on the island's edge (j=50, i=60), cut `depth` below the goal, its
    deepest stamp's CL at `cl_xy` (work mm)."""
    z, cov = pocket_goal()
    return judge_on(z, cov, [(50, 60, depth)], shadow_radius=shadow_radius,
                    thickness=thickness, breakthrough=breakthrough,
                    cl=(50, 60, cl_xy[0], cl_xy[1]))


def stepped_island_goal():
    """The island with its rim column (i = 60) 0.5 mm proud of the floor: the outline cell's axial
    neighbour is a real step, so a failed silhouette can be excused by the general v6 proof."""
    jj, ii = np.mgrid[0:NY, 0:NX]
    cov = (ii >= 60) & (ii <= 140) & (jj >= 20) & (jj <= 80)
    z = np.where(cov, -0.8, 0.0)
    z = np.where(cov & (ii == 60), -0.3, z)
    return z, cov


def fixture_silhouette_fallthrough(depth=0.2):
    """U — a silhouette cell whose CL is INSIDE the part: the silhouette proof fails, and the cell
    falls through to the general straddling proof (the notch/pocket case, 0f's follow-up)."""
    z, cov = stepped_island_goal()
    # the inward neighbour dips 0.006 mm (below the raw floor, but enough to fail the witness),
    # so the silhouette's only excuse left is the general straddling proof across the rim's step.
    return judge_on(z, cov, [(50, 60, depth), (50, 61, 0.006)], shadow_radius=1.0, thickness=2.0,
                    breakthrough=0.3, cl=(50, 60, 6.5, 5.0))


def notch_goal():
    """A fully covered grid with ONE uncovered cell (the notch at i=59, j=50): its inward cell
    (50, 60) is a silhouette cell with three fully covered part-side candidates — (61, 50) and
    (60, 49) / (60, 51)."""
    z = np.full((NY, NX), -0.5)
    cov = np.ones((NY, NX), bool)
    cov[50, 59] = False
    return z, cov


def fixture_notch(dips):
    """N — the inward witness, ruled (iii): ALL fully covered part-side candidates must be uncut.
    `dips` = [(j, i, depth)] marks candidates as cut (a depth below 0.01 is not itself a raw-cut
    cell, so it only feeds the witness test)."""
    z, cov = notch_goal()
    return judge_on(z, cov, [(50, 60, 0.2)] + list(dips), shadow_radius=1.0, thickness=2.0,
                    breakthrough=0.3, cl=(50, 60, 6.5, 5.0))


def fixture_shadow_stock_top(depth=0.2):
    """T — a wall-shadow cell one step inside the island's rim: its relief disc reaches uncovered
    grid, so the stock top is the high side (0.5 mm), not a bare 0 — the rim strip's wall-foot
    cells (0f's v8 follow-up)."""
    z, cov = pocket_goal()
    return judge_on(z, cov, [(50, 61, depth)], shadow_radius=1.0, thickness=5.0,
                    cl=(50, 61, 7.0, 5.0))


def fixture_straddle(depth):
    """G — the general v6 proof on a 0.11 mm step (not a wall: the class needs > 0.2 mm)."""
    z, cov = step_goal(60, 40, -0.50, -0.61, 30)
    return judge_on(z, cov, [(5, 29, depth)], shadow_radius=0.0)


def fixture_allowance():
    """H — the edge-break allowance the app builds from the job's statement."""
    v = GC.tool_from_record({'shape': 'engraving', 'diameter': 3.175, 'tipDiameter': 0.1,
                             'angle': 90, 'name': 'v', 'number': 3})
    ball = GC.tool_from_record({'shape': 'ball', 'diameter': 6.0, 'tipDiameter': 3.0,
                                'name': 'b', 'number': 4})
    out = {'none': GC.edge_allowance(None, [v, ball])}
    a = GC.edge_allowance({'edges': 'all'}, [ball, v])
    out.update({'reach': a['reachMm'], 'leg': a['legMm'], 'number': a['toolNumber'],
                'edges': a['edges']})
    b = GC.edge_allowance({}, [v])
    out.update({'defaultEdges': b['edges']})
    return out


def fixture_who_gate():
    """I — the edge-break who gate: only the stated V's deepest cell is edge break."""
    z = np.full((30, 40), -0.5)
    cov = np.ones_like(z, bool)
    allow = {'reachMm': 1.0, 'legMm': 1.0, 'toolNumber': 2, 'edges': 'silhouette'}
    who2 = np.zeros((30, 40), np.uint8); who2[0, 10] = 2
    hit = judge_on(z, cov, [(0, 10, 0.2)], who=who2, allowance=allow)
    miss = judge_on(z, cov, [(0, 10, 0.2)], who=np.zeros((30, 40), np.uint8), allowance=allow)
    return {'hit': hit, 'miss': miss}


V_TOOL = (';@MKR|TOOL|number=1|id=v|name=test V|type=V-Bit|handlediameter=3.175|sticklength=0|'
          'shoulderlength=0|flutelength=0|diameter=3.175|tipdiameter=0.1|cornerradius=0|'
          'angle=90|halfAngle=45')


def fixture_edge_break(tmp, stated):
    """K — the whole path: a 90° V cuts a 0.2 mm groove into a flat floor 0.25 mm inside the grid's
    border. With the job's edge break stated the groove is edge break and nothing is adjudicated;
    with no statement at all it is judged."""
    prefix = os.path.join(tmp, 'goal-edgebreak-' + ('stated' if stated else 'plain'))
    goal(prefix, np.ones((NY, NX), bool), -0.5)
    nc = prefix + '.nc'
    open(nc, 'w').write('\n'.join([
        V_TOOL, 'G90 G21', 'S10000 M3', 'G0 X2 Y0.25 Z5', 'G1 Z-0.7 F200', 'G1 X8 F300',
        'G0 Z5', 'M2', '']))
    job = {'targetObject': {'edgeBreak': {'widthMm': 0.5}}} if stated else None
    return GC.run_check(prefix, T, os.path.join(tmp, 'out-edgebreak'), [nc], job=job, write=False)


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

        # D — the class proof, bounded by the goal's own relief (the 1.0 mm step, r = 1.0 disc):
        # the 0.5 mm cell is excused (its depth is within step and relief); the 2.5 mm cell is
        # COUNTED as a wall cell, because a heightfield mis-reads a cutter by at most the step.
        s = fixture_wall_relief(1.0)
        check('D wall relief', s, {'goalCells': 2400, 'wallNotScoredCells': 1,
                                   'wallOverReliefCells': 1, 'borderOverReliefCells': 0,
                                   'shadowNotScoredCells': 0, 'adjudicatedCells': 1,
                                   'adjudicatedMaxMm': 2.5, 'adjudicatedFraction': round(1 / 2400, 6)})
        assert s['overReliefDeepest']['cls'] == 'wall' and approx(s['overReliefDeepest']['mm'], 2.5), s['overReliefDeepest']
        # D0 — with NO tool disc the relief is one PITCH (the cell's own axial neighbours), so the
        # 0.5 mm cell is still excused on proof and the 2.5 mm cell is still counted.
        s = fixture_wall_relief(0.0)
        check('D0 wall relief, no tool disc (the pitch disc)', s, {'wallNotScoredCells': 1,
                                                                   'wallOverReliefCells': 1,
                                                                   'straddlingNotScoredCells': 0,
                                                                   'adjudicatedCells': 1,
                                                                   'adjudicatedMaxMm': 2.5})
        # S — THE SILHOUETTE (0f's ruling), on the island's outline cell, T=2, breakthrough=0.3:
        # the blank's floor is 2.3 mm below the stock top; the CL must also be on the UNCOVERED side
        # and at least r − one cell (0.9 mm) from the outline.
        s = fixture_silhouette(0.2, (4.9, 5.0))
        check('S silhouette excused (CL proof)', s, {'silhouetteExcusedCells': 1,
                                                     'silhouetteByWitnessCells': 0,
                                                     'adjudicatedCells': 0,
                                                     'wallNotScoredCells': 0,
                                                     'wallOverReliefCells': 0,
                                                     'borderOverReliefCells': 0})
        assert approx(s['silhouetteDeepest']['mm'], 0.2) and approx(
            s['silhouetteDeepest']['clDistanceMm'], 1.0), s['silhouetteDeepest']
        # the CL inside the part: the CL proof fails, but the INWARD WITNESS excuses — the first
        # fully covered inward neighbour is uncut, so the boundary read is the grid's edge.
        s = fixture_silhouette(0.2, (6.5, 5.0))
        check('S silhouette, CL inside excused by the witness', s, {
            'silhouetteExcusedCells': 1, 'silhouetteByWitnessCells': 1, 'adjudicatedCells': 0,
            'wallOverReliefCells': 0, 'borderOverReliefCells': 0})
        assert s['silhouetteDeepest'] is None, s['silhouetteDeepest']
        # deeper than the blank's floor: COUNTED whatever the CL
        s = fixture_silhouette(2.5, (4.9, 5.0))
        check('S silhouette, below the blank floor', s, {'silhouetteExcusedCells': 0,
                                                         'adjudicatedCells': 1,
                                                         'adjudicatedMaxMm': 2.5})
        # the CL on the uncovered side but at the disc's rim, inside r − one cell: the CL proof
        # fails, and the witness still excuses (its inward neighbour is uncut).
        s = fixture_silhouette(0.2, (5.6, 5.0))
        check('S silhouette, CL near the rim, excused by the witness', s, {
            'silhouetteExcusedCells': 1, 'silhouetteByWitnessCells': 1, 'adjudicatedCells': 0})
        # no tool set: no r, so the CL proof is unavailable — but the witness does not need r,
        # only the stated blank, so the cell is still excused on the inward neighbour.
        s = fixture_silhouette(0.2, (4.9, 5.0), shadow_radius=0.0)
        check('S silhouette, no tool radius, witness alone', s, {
            'silhouetteExcusedCells': 1, 'silhouetteByWitnessCells': 1, 'adjudicatedCells': 0})
        # R-a — no STATED stock thickness: the proof is UNAVAILABLE, the cell is counted, and the
        # count is named; never a guessed ceiling.
        s = fixture_silhouette(0.2, (4.9, 5.0), thickness=None)
        check('S silhouette, no stated thickness', s, {'silhouetteExcusedCells': 0,
                                                       'silhouetteUnavailableCells': 1,
                                                       'adjudicatedCells': 1})
        # U — the fall-through: a silhouette cell whose CL is inside fails the silhouette CL test
        # and is excused by the GENERAL straddling proof across the rim's step (0f's follow-up).
        s = fixture_silhouette_fallthrough()
        check('U silhouette falls through to straddling', s, {'silhouetteExcusedCells': 0,
                                                              'silhouetteByWitnessCells': 0,
                                                              'straddlingNotScoredCells': 1,
                                                              'wallNotScoredCells': 0,
                                                              'adjudicatedCells': 0})
        # N — the inward witness, ruled (iii). A one-cell notch makes (50, 60) a silhouette cell
        # with three fully covered part-side candidates; all uncut → excused.
        s = fixture_notch([])
        check('N witness: all candidates uncut', s, {'silhouetteExcusedCells': 1,
                                                     'silhouetteByWitnessCells': 1,
                                                     'adjudicatedCells': 0})
        # ... but ONE candidate cut 1 mm fails the witness (any candidate cut → no excuse), and the
        # notch cell is counted (the cut candidate is a real cut of its own and counts too).
        s = fixture_notch([(50, 61, 1.0)])
        check('N witness: one candidate cut 1 mm', s, {'silhouetteExcusedCells': 0,
                                                       'silhouetteByWitnessCells': 0,
                                                       'adjudicatedCells': 2,
                                                       'adjudicatedMaxMm': 1.0})
        # ... and 0f's amendment: a candidate that is ITSELF a silhouette cell counts too. On the
        # island, (51, 60) is a silhouette axial neighbour of (50, 60); uncut it leaves the witness
        # standing, cut 1 mm it fails it.
        z, cov = pocket_goal()
        s = judge_on(z, cov, [(50, 60, 0.2), (51, 60, 0.0)], shadow_radius=1.0,
                     thickness=2.0, breakthrough=0.3, cl=(50, 60, 6.5, 5.0))
        check('N witness: silhouette candidate uncut', s, {'silhouetteExcusedCells': 1,
                                                           'silhouetteByWitnessCells': 1,
                                                           'adjudicatedCells': 0})
        # both cells need a real CL inside the part: an unset (0, 0) lies off the island, which
        # would read as an uncovered-side CL and excuse the cut candidate itself.
        s = judge_on(z, cov, [(50, 60, 0.2), (51, 60, 1.0)], shadow_radius=1.0,
                     thickness=2.0, breakthrough=0.3,
                     cl=[(50, 60, 6.5, 5.0), (51, 60, 6.5, 5.0)])
        check('N witness: silhouette candidate cut 1 mm', s, {'silhouetteExcusedCells': 0,
                                                              'silhouetteByWitnessCells': 0,
                                                              'adjudicatedCells': 2,
                                                              'adjudicatedMaxMm': 1.0})
        # T — the relief disc reaching uncovered grid makes the stock top the high side: the rim
        # strip's shadow cell is excused on relief 0.5 mm, not counted on a bare 0.
        s = fixture_shadow_stock_top()
        check('T shadow cell, relief sees the blank', s, {'shadowNotScoredCells': 1,
                                                          'shadowOverReliefCells': 0,
                                                          'adjudicatedCells': 0})
        # G — the general v6 proof: on a 0.11 mm step, a 0.105 mm read is excused on proof; a
        # 0.112 mm read is NOT (the general proof carries no 0.005 mm slack — the class proof does);
        # a 0.2 mm read is not.
        s = fixture_straddle(0.105)
        check('G straddle excused', s, {'straddlingNotScoredCells': 1, 'adjudicatedCells': 0,
                                        'wallNotScoredCells': 0, 'wallOverReliefCells': 0})
        s = fixture_straddle(0.112)
        check('G straddle, no slack', s, {'straddlingNotScoredCells': 0, 'adjudicatedCells': 1,
                                          'adjudicatedMaxMm': 0.112})
        s = fixture_straddle(0.2)
        check('G straddle, too deep', s, {'straddlingNotScoredCells': 0, 'adjudicatedCells': 1})
        # J — the CLASS proof DOES carry the slack: a wall cell 0.004 mm deeper than the sampled
        # step is still excused (the tray's 2.884615 vs 2.885 mm, #1092).
        z, cov = step_goal(60, 40, -1.0, -1.496, 30)
        s = judge_on(z, cov, [(20, 29, 0.5)], shadow_radius=1.0)
        check('J class step-test slack', s, {'wallNotScoredCells': 1, 'wallOverReliefCells': 0,
                                             'adjudicatedCells': 0})
        # H — the allowance from the statement: the widest usable V, its reach and leg, its number,
        # the job's edge scope; no statement, no allowance.
        a = fixture_allowance()
        assert a.pop('none') is None, 'a job with no stated edge break must have no allowance'
        assert a.pop('edges') == 'all' and a.pop('defaultEdges') == 'silhouette', a
        check('H allowance', a, {'reach': 1.5875, 'leg': 1.5375, 'number': 3})
        # I — the who gate: with the allowance's number 2, a cell whose deepest stamp is T2 is edge
        # break; the same cell stamped by anything else falls to the SILHOUETTE branch (it faces
        # uncovered off-grid) and is counted, its CL inside the part.
        h = fixture_who_gate()
        check('I who gate, V deepest', h['hit'], {'edgeBreakCells': 1, 'adjudicatedCells': 0,
                                                  'borderOverReliefCells': 0})
        # ... and with another cutter it is not edge break: the silhouette branch takes it, its
        # inward neighbour is uncut, so the inward witness excuses it (the who gate still rules the
        # edge break itself — edgeBreakCells stays 0).
        check('I who gate, other cutter', h['miss'], {'edgeBreakCells': 0,
                                                      'silhouetteExcusedCells': 1,
                                                      'silhouetteByWitnessCells': 1,
                                                      'borderOverReliefCells': 0,
                                                      'wallOverReliefCells': 0,
                                                      'adjudicatedCells': 0})
        # K — the whole path, with and without the job's statement: the same V cut is edge break
        # when the job states one (inside the V's leg, on the silhouette band) and judged when not.
        k = fixture_edge_break(tmp, True)
        check('K edge break, stated', k, {'edgeBreakToolNumber': 1, 'edgeBreakLegMm': 1.5375,
                                          'edgeBreakReachMm': 1.5875, 'adjudicatedCells': 0})
        assert k['edgeBreakStated'] is True and k['edgeBreakCells'] > 0, k['edgeBreakCells']
        k = fixture_edge_break(tmp, False)
        assert k['edgeBreakStated'] is False and k['edgeBreakCells'] == 0, k['edgeBreakCells']
        assert k['adjudicatedCells'] > 0, 'the groove must be judged when the job states no edge break'
    print('all fixtures hold')


if __name__ == '__main__':
    main()
