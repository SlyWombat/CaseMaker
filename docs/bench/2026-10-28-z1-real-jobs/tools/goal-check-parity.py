#!/usr/bin/env python3
"""Parity test: the page's checker against the app's own goal report (#1092, gate v8).

The gate's rule is stated twice — in the app's `checkGoalCutInto` (`designCheck.ts`) and in this
directory's `goal_check.py`. The two must agree cell for cell on the same run: the ruler the page
prints must be the ruler the app judges by. This script takes card run directories (the ones
`build.py` writes: `receipt.json`, `job.json`, the goal heightfield pair and the posted `.nc`
programs) and compares the app receipt's `details.goal` block with a fresh run of `goal_check.py`
over the same programs and the same goal grid.

usage: goal-check-parity.py <rundir> [<rundir> ...] [--location <location.json>] [--job <job.json>]
                            [--tolerance <fraction>]

  --location    the location document the card ran with (default $CM_LOCATION); the checker must
                read the same tool records and pass line the app did.
  --job         a job file to use for every run directory (default: the run's own job.json).
  --tolerance   the largest allowed difference in the ADJUDICATED fraction, as a fraction of the
                covered cells (default 0.0001 = 0.01 % — the #1092 acceptance).

Exit status is 0 only when every run directory agrees within the tolerance; the difference in the
raw figure and in each excluded class is printed beside it (a class difference larger than the
tolerance is called out as NOISY, but only the adjudicated fraction decides the exit).
"""
import glob
import json
import os
import sys


def load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def goal_block(receipt):
    """The app's run-level goal report: `details.goal` (the receipt schema), or a top-level `goal`."""
    if not isinstance(receipt, dict):
        return None
    details = receipt.get('details')
    if isinstance(details, dict) and isinstance(details.get('goal'), dict):
        return details['goal']
    goal = receipt.get('goal')
    return goal if isinstance(goal, dict) else None


def side1_ncs(rundir, receipt, job):
    """The program files the app's goal report folded: the first setup's programs, in receipt order."""
    progs = []
    details = receipt.get('details') if isinstance(receipt, dict) else None
    if isinstance(details, dict):
        progs = details.get('programs') or []
    setups = (job or {}).get('setups') or []
    first = setups[0].get('id') if setups else None
    files = [os.path.join(rundir, p['ncFile']) for p in progs
             if isinstance(p, dict) and p.get('ncFile')
             and (not setups or p.get('setupId') in (None, first))]
    files = [f for f in files if os.path.exists(f)]
    if files:
        return files
    return sorted(f for f in glob.glob(os.path.join(rundir, '*.nc'))
                  if not f.endswith('-frame.nc'))


def main():
    args = sys.argv[1:]
    location = None
    job_override = None
    tol = 0.0001
    rundirs = []
    i = 0
    while i < len(args):
        a = args[i]
        if a == '--location':
            location = args[i + 1]; i += 2
        elif a == '--job':
            job_override = args[i + 1]; i += 2
        elif a == '--tolerance':
            tol = float(args[i + 1]); i += 2
        else:
            rundirs.append(a); i += 1
    if not rundirs:
        print('usage: goal-check-parity.py <rundir> [<rundir> ...] [--location <file>] '
              '[--job <file>] [--tolerance <fraction>]', file=sys.stderr)
        return 2
    # The checker imports render.py, which reads the location export at import time.
    if location:
        os.environ['CM_LOCATION'] = location
    if 'CM_LOCATION' not in os.environ and not os.path.exists(
            os.path.join(os.path.dirname(os.path.abspath(__file__)), 'location.json')):
        print('goal-check-parity: no location — pass --location or set CM_LOCATION', file=sys.stderr)
        return 2

    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import goal_check

    failed = 0
    checked = 0
    for rundir in rundirs:
        name = os.path.basename(os.path.normpath(rundir))
        receipt = load(os.path.join(rundir, 'receipt.json'))
        app = goal_block(receipt)
        if app is None:
            print(f'{name}: NO GOAL BLOCK in receipt.json — not a goal run, or the receipt predates #953')
            failed += 1
            continue
        if not app.get('ran'):
            print(f'{name}: the app did not run the goal check ({app.get("reason")})')
            failed += 1
            continue
        job = load(job_override) if job_override else (load(os.path.join(rundir, 'job.json')))
        if job is None:
            print(f'{name}: no job.json in the run directory and no --job — the edge-break '
                  'statement cannot be read')
            failed += 1
            continue
        prefix = os.path.join(rundir, 'goal')
        if not (os.path.exists(prefix + '.json') and os.path.exists(prefix + '.bin')
                and os.path.exists(prefix + '.cov')):
            print(f'{name}: no goal heightfield (goal.json/.bin/.cov) in the run directory')
            failed += 1
            continue
        ncs = side1_ncs(rundir, receipt, job)
        if not ncs:
            print(f'{name}: no posted programs found')
            failed += 1
            continue
        stock = (job.get('stock') or {}).get('thickness')
        if stock is None:
            print(f'{name}: the job states no stock thickness')
            failed += 1
            continue
        try:
            s = goal_check.run_check(prefix, float(stock), '', ncs, job=job, write=False)
        except Exception as e:  # a run the checker cannot score is a failed parity, named
            print(f'{name}: the checker failed: {type(e).__name__}: {e}')
            failed += 1
            continue
        checked += 1
        n = max(int(s['goalCells']), 1)
        app_adj = float(app.get('adjudicatedFraction') or 0.0)
        tool_adj = float(s['adjudicatedFraction'])
        delta = abs(app_adj - tool_adj)
        ok = delta <= tol
        if not ok:
            failed += 1
        app_cells = round(app_adj * n)
        print(f"{name}: {'PASS' if ok else 'FAIL'}  adjudicated {app_adj * 100:.4f} % (app) vs "
              f"{tool_adj * 100:.4f} % (checker) — Δ {delta * 100:.4f} pp = {abs(app_cells - s['adjudicatedCells'])} "
              f"cell(s) of {n}; deepest {app.get('adjudicatedMaxMm')} vs {s['adjudicatedMaxMm']} mm")
        raw_app = float(app.get('cutIntoFraction') or 0.0)
        raw_delta = abs(raw_app - float(s['rawCutIntoFraction']))
        print(f'    raw cut-into {raw_app * 100:.4f} % (app) vs {s["rawCutIntoFraction"] * 100:.4f} % '
              f'(checker) — Δ {raw_delta * 100:.4f} pp'
              + ('  NOISY' if raw_delta > tol else ''))
        for key, cells_key in (('edgeBreakFraction', 'edgeBreakCells'),
                               ('wallNotScoredFraction', 'wallNotScoredCells'),
                               ('shadowNotScoredFraction', 'shadowNotScoredCells')):
            a = float(app.get(key) or 0.0)
            b = float(s[cells_key]) / n
            d = abs(a - b)
            print(f'    {key:24s} {a * 100:.4f} % (app) vs {b * 100:.4f} % (checker) — Δ {d * 100:.4f} pp'
                  + ('  NOISY' if d > tol else ''))
        leftovers = app.get('leftoverFractions') or []
        if leftovers:
            a_cov = 1.0 - float(leftovers[0])
            t_cov = 1.0 - float(s['leftover0p1Pct']) / 100.0
            d = abs(a_cov - t_cov)
            print(f'    top-surface coverage    {a_cov * 100:.4f} % (app) vs {t_cov * 100:.4f} % '
                  f'(checker) — Δ {d * 100:.4f} pp' + ('  NOISY' if d > tol else ''))
        # #1092 — the silhouette proof's own count and the removed classes' counters.
        app_sil = app.get('silhouetteExcusedCells')
        if app_sil is not None:
            diff = abs(float(app_sil) - float(s['silhouetteExcusedCells']))
            print(f'    silhouette excused      {app_sil} (app) vs {s["silhouetteExcusedCells"]} '
                  f'(checker) — Δ {diff:g} cell(s) of {n}'
                  + ('  NOISY' if diff / n > tol else ''))
            app_deep = app.get('silhouetteDeepest')
            if app_deep or s['silhouetteDeepest']:
                fmt = (lambda v: 'null' if not v else
                       f"{v['mm']:.3f} mm at {v['x']:.2f}, {v['y']:.2f} (CL {v['clDistanceMm']} mm)")
                print(f'    silhouette deepest      {fmt(app_deep)} (app) vs '
                      f'{fmt(s["silhouetteDeepest"])} (checker)')
        deepest = s.get('overReliefDeepest')
        print(f'    over-relief: wall {s["wallOverReliefCells"]}, border {s["borderOverReliefCells"]}, '
              f'shadow {s["shadowOverReliefCells"]}'
              + (f'; deepest {deepest["mm"]:.3f} mm at {deepest["x"]:.2f}, {deepest["y"]:.2f} '
                 f'({deepest["cls"]})' if deepest else ''))
        print(f'    edge break: {"stated" if s["edgeBreakStated"] else "not stated"}'
              + (f' (T{s["edgeBreakToolNumber"]}, reach {s["edgeBreakReachMm"]} mm, '
                 f'leg {s["edgeBreakLegMm"]} mm, edges {s["edgeBreakEdges"]})'
                 if s['edgeBreakStated'] else '')
              + f'; relief radius {s["reliefRadiusMm"]} mm; straddling excused '
                f'{s["straddlingNotScoredCells"]} (max step {s["straddlingMaxStepMm"]} mm)')
    print(f'\n{checked} run(s) scored, {failed} failed — tolerance {tol * 100:g} % '
          f'(the adjudicated fraction is the pass line)')
    return 0 if failed == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
