#!/usr/bin/env python3
"""The gate's one command: run every card's job on a sha, sweep and check it independently, and
write the page and its manifest.

  tools/build.sh <sha>                 (or: python3 tools/build.py --repo <worktree> [--sha S])

Nothing in this file decides a verdict by eye. Each card gets one of:
  Matches the design  verifier 0 errors and the design check (2.5D) or the goal check (3D) passes
  Deviates            a computed number is outside the rule; the number is shown
  Refused             the app refused to write the program; its sentence is shown
The design check is this repo's own sweep against the job's design until #924 (the app's independent
oracle) lands; the page says so.
"""
import argparse
import base64
import datetime
import html
import io
import json
import os
import re
import signal
import subprocess
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
W = os.path.dirname(HERE)                      # docs/bench/2026-10-28-z1-real-jobs
JOBS = os.path.join(W, 'jobs')
sys.path.insert(0, HERE)
from cards import CARDS, APPENDIX, SAMPLES      # noqa: E402
import limits                                    # noqa: E402

# The reference parts (#955) are DATA kept off the repo: the table of vendor parts (names, files, hashes)
# and the reference cards. `--references <file>` loads them at run time (init_references); without it the
# build has no reference cards and says so. Nothing from that file is committed.
REFS = []
PARKED = []
REF_CARDS = []
REF_BY_ID = {}
REFERENCES_FILE = None        # {'path': ..., 'sha256': ...} once loaded; recorded in the page manifest
LIMIT_TABLE = None            # the per-card reference seconds (limits.load_table), or None: every card has the fixed default limit
LIMITS_FILE = None            # {'path', 'sha256', 'baseline', 'margin', 'floor'} once loaded; recorded in the page manifest

# The app's Z1 rapid profile (machine.ts): 5000 mm/min XY, 1000 mm/min Z. Used for the vendor
# file's air-fraction estimate until #964's scorer (which owns the shared implementation) lands.
RAPID_XY_MM_MIN = 5000.0
RAPID_Z_MM_MIN = 1000.0


def references_notice(path, n_ref):
    """The line the build prints about its reference data: never silent when there is none."""
    if not path:
        return ('references: --references not given — the reference cards (ref-*) are NOT in this build '
                '(the reference parts are data kept off the repo); nothing is scored against them')
    if n_ref == 0:
        return f'references: {path} adds no reference cards'
    return f'references: {path} loaded ({n_ref} reference cards, sha256 {REFERENCES_FILE["sha256"][:12]}…)'


def init_limits(path, default_seconds):
    """Load the per-card reference table (a deliberate file written by derive_limits.py; a run only READS it)."""
    global LIMIT_TABLE, LIMITS_FILE
    if not path:
        print(f'limits: --limits not given — every card has the fixed limit of {default_seconds} s', flush=True)
        return
    import hashlib
    LIMIT_TABLE = limits.load_table(path)
    LIMITS_FILE = {'path': os.path.abspath(path), 'sha256': hashlib.sha256(open(path, 'rb').read()).hexdigest(),
                   'baseline': LIMIT_TABLE.get('baseline'), 'margin': LIMIT_TABLE.get('margin'), 'floor': LIMIT_TABLE.get('floor')}
    print(f"limits: {path} (baseline {LIMIT_TABLE['baseline']['name']}, margin {LIMIT_TABLE['margin']}, floor {LIMIT_TABLE['floor']} s, "
          f"{len(LIMIT_TABLE['cards'])} reference times)", flush=True)


def init_references(path):
    """Load the reference data file by path. Returns the number of reference cards it adds (0 when none given)."""
    global REFS, PARKED, REF_CARDS, REF_BY_ID, REFERENCES_FILE
    if not path:
        REFS, PARKED, REF_CARDS, REF_BY_ID, REFERENCES_FILE = [], [], [], {}, None
        return 0
    import hashlib
    import importlib.util
    spec = importlib.util.spec_from_file_location('references_data', path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    REFS, PARKED, REF_CARDS = list(mod.REFS), list(getattr(mod, 'PARKED', [])), list(getattr(mod, 'CARDS', []))
    REF_BY_ID = {r['id']: r for r in REFS}
    REFERENCES_FILE = {'path': os.path.abspath(path), 'sha256': hashlib.sha256(open(path, 'rb').read()).hexdigest()}
    return len(REF_CARDS)

TOL = 0.02          # fraction of an item's area; the same 2 % the issue's verdict rule names
NOISE = {'vise-default', 'sacrificial-default', 'plunge-unproven'}
PILL = {'match': ('ok', 'Matches the design'), 'deviates': ('gap', 'Deviates'),
        'refused': ('fail', 'Refused'), 'unchecked': ('right', 'Not checkable'), 'error': ('cant', 'Not run'),
        'over-limit': ('cant', 'Over its limit')}


def arg_parse():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--repo', required=True, help='the worktree checked out at the sha to judge')
    p.add_argument('--sha', help='the sha the page states (default: the repo HEAD; must match it)')
    p.add_argument('--location', default=os.path.expanduser('~/casemaker-manager/demo-build/location.json'),
                   help='the demo full-library location (demo cards: any catalogue cutter may be chosen)')
    p.add_argument('--k3-location', default=os.path.expanduser('~/casemaker-manager/demo-build/k3/location.json'),
                   help='the k3 house export (sample cards: owned cutters only, as the bench will run them)')
    p.add_argument('--catalogue', default=os.path.expanduser('~/casemaker-manager/demo-build/catalogue.json'))
    p.add_argument('--out', default=os.path.expanduser('~/casemaker-manager/demo-build'))
    p.add_argument('--meshes', default=os.environ.get('CM_MESHES', '/mnt/c/projects/Case Maker/samples/3d'),
                   help='where the shop-owned mesh files live (the committed 3D jobs carry no bytes)')
    p.add_argument('--references', default=os.environ.get('CM_REFERENCES', ''),
                   help='the reference-parts data file (kept off the repo; see init_references). Without it the '
                        'build has NO reference cards and says so')
    p.add_argument('--makerables', default=os.environ.get('CM_MAKERABLES', ''),
                   help='the Makerables evaluation downloads (dl/<slug>/): vendor NCs and models, '
                        'matched by name and sha256, never committed')
    p.add_argument('--candidate', action='store_true',                   help='the app sha is a candidate branch, not main: the page says so')
    p.add_argument('--section-html', help='an extra HTML fragment appended before the page footer '
                                          '(the candidate-engine section, tools/candidate_section.py)')
    p.add_argument('--only', help='comma-separated card ids (debug)')
    p.add_argument('--limits', default=os.environ.get('CM_LIMITS', ''),
                   help='the per-card reference-seconds table (written by derive_limits.py from a named baseline; a run never '
                        'rewrites it). A card limit = max(floor, margin x its reference); no table: every card has --timeout')
    p.add_argument('--timeout', type=int, default=limits.LIMIT_DEFAULT_S,
                   help=f'the limit of a card with no reference time, seconds (default {limits.LIMIT_DEFAULT_S})')
    return p.parse_args()


def sh(cmd, cwd, timeout):
    """Run one command with a wall-clock limit, and on a timeout kill its WHOLE PROCESS GROUP.

    The child starts its own session (`start_new_session`), so a timeout can signal the group.
    `subprocess.run`'s timeout kills only the direct child: `npm run` exits, its `tsx` and node
    grandchildren survive, and on 2026-11-07 three timed-out cards' nodes kept running as orphans
    (7.0 + 4.1 + 2.7 GB) after their builds had moved on. Draining `communicate()` AFTER the group
    is dead also keeps the captured output text: `TimeoutExpired` hands it back as bytes (that is
    what crashed the j27/j29 cards at `write(r['stderr'])`).
    """
    t0 = datetime.datetime.now()

    def wall():
        return round((datetime.datetime.now() - t0).total_seconds(), 1)

    p = subprocess.Popen(cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         text=True, start_new_session=True)
    try:
        out, err = p.communicate(timeout=timeout)
        return {'exit': p.returncode, 'stdout': out, 'stderr': err, 'wall': wall(), 'timeout': False}
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(p.pid), signal.SIGKILL)
        except ProcessLookupError:
            pass
        out, err = p.communicate()                 # drains the pipes now every holder is dead
        return {'exit': 124, 'stdout': out or '', 'stderr': err or '', 'wall': wall(), 'timeout': True}


def git_sha(repo):
    return subprocess.run(['git', '-C', repo, 'rev-parse', 'HEAD'], capture_output=True,
                          text=True, check=True).stdout.strip()


def read_json(path, default=None):
    try:
        return json.load(open(path))
    except (OSError, ValueError):
        return default


def makerable(args, name, sha):
    """The vendor input by name under --makerables, checked by sha256 before use. None when absent."""
    if not getattr(args, '_mkr_index', None) and args.makerables and os.path.isdir(args.makerables):
        idx = {}
        for root, _, files in os.walk(args.makerables):
            for f in files:
                idx.setdefault(f, os.path.join(root, f))
        args._mkr_index = idx
    path = (getattr(args, '_mkr_index', None) or {}).get(name)
    if not path:
        return None
    import hashlib
    got = hashlib.sha256(open(path, 'rb').read()).hexdigest()
    if got != sha:
        raise SystemExit(f'{path}: sha256 {got} is not the reference\'s {sha}; refusing to score another download')
    return path


def vendor_stats(nc, cycle_s):
    """Air fraction and rapids per 1,000 feed moves from the vendor's own file, on the app's Z1
    rapid profile (5000 mm/min XY, 1000 Z). #964's scorer owns the shared implementation."""
    import math
    sys.path.insert(0, HERE)
    from goal_check import mkr_moves          # noqa: E402
    rap = feed = 0
    rs = 0.0
    for _tn, a, b, rapid in mkr_moves(nc):
        dx = math.hypot(b[0] - a[0], b[1] - a[1]); dz = abs(b[2] - a[2])
        if rapid:
            rap += 1
            rs += 60 * (dx / RAPID_XY_MM_MIN + dz / RAPID_Z_MM_MIN)
        else:
            feed += 1
    return {'rapids': rap, 'feedMoves': feed, 'rapidSeconds': round(rs, 1),
            'airFraction': round(rs / cycle_s, 4) if cycle_s else None,
            'rapidsPer1k': round(rap / feed * 1000, 1) if feed else None}


def our_cutters(ncs):
    """The app's own cutter keys from the posted programs (`;@CM|TOOL|key=` headers)."""
    keys = set()
    for f in ncs:
        for line in open(f, errors='replace'):
            m = re.search(r';@CM\|TOOL\|key=(\S+)', line)
            if m:
                keys.add(m.group(1).strip())
    return keys


def design_numbers(dc):
    """Area-weighted coverage and the outside cut from a design check's report (2.5D cards)."""
    items = [i for i in (dc or {}).get('items', []) if 'left' in i]
    tot = sum(i.get('areaMm2') or 0 for i in items)
    cov = (1 - sum(i['left'] * (i.get('areaMm2') or 0) for i in items) / tot) if tot else None
    out = (dc or {}).get('outside') or {}
    return {'coveragePct': round(cov * 100, 2) if cov is not None else None,
            'items': len(items), 'areaMm2': round(tot, 1),
            'maxLeftPct': round(100 * max((i['left'] for i in items), default=0.0), 2),
            'outsideMm2': out.get('areaMm2'), 'deepestOutsideMm': out.get('deepestMm')}


def vendor_section(nc, tool, out):
    """One tool's block of the vendor program (header comments kept): a design-side comparison must
    score the same operation ours does — the maker's contour and chamfer are a different one."""
    active = None; lines = []
    for line in open(nc, errors='replace'):
        if line.startswith(';'):
            lines.append(line.rstrip()); continue
        m = re.search(r'\bT(\d+)\b', line)
        if m and re.search(r'\bM6\b', line):
            active = int(m.group(1)); continue
        if active == tool:
            lines.append(line.rstrip())
    open(out, 'w').write('\n'.join(lines) + '\n')
    return out


def materialise_job(job_path, rundir, meshes, args=None):
    """The committed 3D jobs carry no mesh bytes: the meshes are shop-owned (or the vendor's
    evaluation-only) local inputs. Put the file the job names back in, by the job's own sha256, into
    the run directory (never the repo)."""
    import hashlib
    j = read_json(job_path)
    if not j:
        return job_path
    t = j.get('targetObject') or (j.get('targetObjects') or [None])[0]
    if not t or t.get('data') or not t.get('name'):
        return job_path
    src = os.path.join(meshes, t['name'])
    if not os.path.exists(src) and args is not None:
        src = makerable(args, t['name'], t.get('sha256')) or src
    raw = open(src, 'rb').read()
    got = hashlib.sha256(raw).hexdigest()
    if got != t.get('sha256'):
        raise SystemExit(f'{src}: sha256 {got} is not the job\'s {t.get("sha256")}; refusing to cut another mesh')
    t['data'] = base64.b64encode(raw).decode()
    out = os.path.join(rundir, 'job.json')
    json.dump(j, open(out, 'w'))
    return out


def load_receipt(rundir):
    r = read_json(os.path.join(rundir, 'receipt.json'))
    errs = [d for d in (r or {}).get('diagnostics', []) if d.get('severity') == 'error']
    refs = [x for x in (r or {}).get('refusals', []) if x.get('code') not in ('stopped', 'nothing-written')]
    out = {'ok': (r or {}).get('ok'), 'programs': ((r or {}).get('details') or {}).get('programs') or [],
           'errors': errs, 'refusals': refs,
           'warnings': [d['message'] for d in (r or {}).get('diagnostics', [])
                        if d.get('severity') == 'warning' and d.get('code') not in NOISE]}
    if errs:
        out['sentence'] = errs[0].get('message', '')
        out['code'] = errs[0].get('code', '')
    elif refs:
        out['sentence'] = refs[0].get('reason', '')
        out['code'] = refs[0].get('code', '')
    else:
        out['sentence'] = None
        out['code'] = None
    out['verifierErrors'] = sum(int((p.get('sim') or {}).get('errorCount') or 0) for p in out['programs'])
    out['seconds'] = sum(int((p.get('cam') or {}).get('estimatedSeconds') or 0) for p in out['programs'])
    # #927's own terms, summed over the job's programs: the air/rapids lines (#955) read these.
    eff = [(p.get('cam') or {}).get('efficiency') or {} for p in out['programs']]
    cyc = sum(float(e.get('cycleSeconds') or 0) for e in eff)
    rap = sum(float(e.get('rapidSeconds') or 0) for e in eff)
    out['cycleSeconds'] = round(cyc, 1) if cyc else None
    out['airFraction'] = round(rap / cyc, 4) if cyc else None
    out['hops'] = sum(int(e.get('hopCount') or 0) for e in eff)
    out['feedMoves'] = sum(int((p.get('cam') or {}).get('cuttingMoves') or 0) for p in out['programs'])
    out['rapidsPer1k'] = round(out['hops'] / out['feedMoves'] * 1000, 1) if out['feedMoves'] else None
    # #953 — the app's own goal report rides the receipt: details.goal (the run's) and each
    # program's details.programs[i].goal (the evidence). Preferred over our recomputation.
    det = (r or {}).get('details') or {}
    out['goal'] = det.get('goal')
    out['programGoals'] = [p.get('goal') for p in out['programs'] if p.get('goal')]
    times = [((p.get('sheet') or {}).get('estimatedTime')) for p in out['programs']]
    out['time'] = ' + '.join(t for t in times if t) or None
    return out


def design_verdict(rc, dc):
    """(verdict, sentence, numbers) from the receipt and the design check's report."""
    problems = []
    outside = (dc or {}).get('outside') or {}
    if outside.get('cells', 0) > 0:
        problems.append(f"cut outside the design: {outside['areaMm2']} mm², deepest {outside['deepestMm']} mm")
    measured = 0
    for it in (dc or {}).get('items', []):
        if it.get('kind') == 'label':
            if 'reachRatio' not in it:
                continue
            measured += 1
            if it['reachRatio'] < 0.99:
                problems.append(f"{it['id']} label reaches {it['reachRatio']:.3f} of its {it['depth']} mm depth")
            if it.get('deep', 0) > TOL:
                problems.append(f"{it['id']} label cut {it['deep'] * 100:.1f} % below its depth")
            continue
        if 'left' not in it and 'over' not in it:
            continue
        measured += 1
        if it.get('v'):
            bad = it.get('over', 0)
            if bad > TOL:
                problems.append(f"{it['id']} V region cut past its depth on {bad * 100:.1f} % of its area")
        else:
            deep = it.get('deepPastBreak', it.get('deep', 0))
            if it.get('left', 0) > TOL:
                problems.append(f"{it['id']} has material left on {it['left'] * 100:.1f} % of its area")
            if deep > TOL:
                problems.append(f"{it['id']} cut past its floor on {deep * 100:.1f} % of its area")
    numbers = {'measuredItems': measured,
               'outsideMm2': outside.get('areaMm2', 0), 'outsideDeepestMm': outside.get('deepestMm', 0),
               'verifierErrors': rc['verifierErrors']}
    if rc['verifierErrors']:
        problems.insert(0, f"the verifier reports {rc['verifierErrors']} error(s)")
    if rc['ok'] is False and rc['sentence']:
        return 'refused', rc['sentence'] + (f" [{rc['code']}]" if rc['code'] else ''), numbers
    if measured == 0:
        return 'unchecked', 'the design has no measurable item for the interim check (chamfers and cut-outs are not modelled); #924’s oracle is needed', numbers
    if problems:
        more = f'; and {len(problems) - 3} more item(s)' if len(problems) > 3 else ''
        return 'deviates', '; '.join(problems[:3]) + more, numbers
    return 'match', f"verifier 0 errors; {measured} measured item(s) at their floor; no cut outside the design", numbers


def app_goal_numbers(g):
    """The app's own goal report (#953 details.goal), in the card's number shape: coverage is its
    first leftover band, cut-into its own 0.01 mm floor fraction."""
    lo = list(g.get('leftoverFractions') or [0.0, 0.0, 0.0])
    ws = g.get('wholeSurface') or {}
    return {'coveragePct': round(100 * (1 - lo[0]), 2),
            'cutIntoPct': round(100 * float(g.get('cutIntoFraction') or 0), 2),
            'maxCutIntoMm': g.get('maxCutIntoMm'), 'cutIntoAreaMm2': None,
            'leftover0p1Pct': round(100 * lo[0], 2), 'leftover0p3Pct': round(100 * lo[1], 2),
            'leftover1Pct': round(100 * lo[2], 2),
            'passCoveragePct': round(100 * float(g.get('passCoverage') or 0.95), 2),
            'wholeSurfacePct': round(100 * float(ws['fraction']), 2) if ws.get('fraction') is not None else None,
            'source': 'receipt'}


def goal_verdict(rc, gc):
    if rc['ok'] is False and rc['sentence']:
        return 'refused', rc['sentence'] + (f" [{rc['code']}]" if rc['code'] else ''), {}
    if not gc:
        return 'error', 'the goal check did not run', {}
    cut = gc['cutInto0p1Pct']
    cover = round(100.0 - gc['leftover0p1Pct'], 2)
    # #948 — the pass line is the shop's `goal.passCoverage` (goal_check.py reads it from the same
    # location), not a number this script owns. An older goalcheck.json has no key: the seed.
    pass_pct = gc.get('passCoveragePct', 95.0)
    numbers = {'cutIntoPct': cut, 'cutIntoAreaMm2': gc['cutIntoAreaMm2'], 'maxCutIntoMm': gc['maxCutIntoMm'],
               'coveragePct': cover, 'leftover0p1Pct': gc['leftover0p1Pct'], 'leftover0p3Pct': gc['leftover0p3Pct'],
               'idealCutterMm': gc['idealCutter'], 'goalCells': gc['goalCells'],
               'verifierErrors': rc['verifierErrors']}
    problems = []
    if cut > 0:
        problems.append(f"cut into the goal on {cut} % of the surface, {gc['cutIntoAreaMm2']} mm², up to {gc['maxCutIntoMm']} mm deep")
    if cover < pass_pct:
        problems.append(f"coverage {cover} % of the goal surface (the rule asks {pass_pct:g} %)")
    if rc['verifierErrors']:
        problems.append(f"the verifier reports {rc['verifierErrors']} error(s)")
    if problems:
        more = f'; and {len(problems) - 3} more item(s)' if len(problems) > 3 else ''
        return 'deviates', '; '.join(problems[:3]) + more, numbers
    return 'match', f"zero cut-into the goal; coverage {cover} %", numbers


def inline_img(path, w=760):
    if not path or not os.path.exists(path):
        return None
    from PIL import Image
    im = Image.open(path).convert('RGB')
    if im.width > w:
        im = im.resize((w, int(im.height * w / im.width)))
    b = io.BytesIO()
    im.save(b, 'JPEG', quality=80)
    return 'data:image/jpeg;base64,' + base64.b64encode(b.getvalue()).decode()


def figure(cap, src, none='no picture'):
    if src:
        return f'<figure><figcaption>{html.escape(cap)}</figcaption><div class="plate"><img src="{src}" alt="{html.escape(cap)}" loading="lazy"></div></figure>'
    return f'<figure><figcaption>{html.escape(cap)}</figcaption><div class="plate"><p class="none">{html.escape(none)}</p></div></figure>'


def goal_picture(prefix, stock):
    """The goal surface rendered from the same view the sweep's 'after' uses."""
    import numpy as np
    import render as R
    gh = read_json(prefix + '.json')
    if not gh:
        return None
    G = np.fromfile(prefix + '.bin', np.float32).reshape(gh['ny'], gh['nx']).astype(float)
    C = np.fromfile(prefix + '.cov', np.uint8).reshape(gh['ny'], gh['nx']) > 0
    T = float(stock['thickness'])
    F = np.where(C, G, -T)
    p, c = R.heightfield_points(F, float(gh['pitch']), T, R.COLOURS.get(stock.get('material'), (200, 200, 200)))
    view = R.view_matrix(-30, 35)
    bp, bc = R.bed_points(stock['length'], stock['width'], T, float(gh['pitch']))
    P = np.concatenate([bp, p]); Cc = np.concatenate([bc, c])
    Pv = P @ view.T
    img, _ = R.splat(P, Cc, view, fit=(Pv[:, :2].min(0), Pv[:, :2].max(0)), pix=2)
    out_path = prefix + '-goal.png'
    from PIL import Image
    Image.fromarray(img).save(out_path)
    return out_path


def card_location(c, args):
    """The location a card is judged on: the sample cards are real cuts, so they run on the k3 house
    export (owned cutters only); the demo cards keep the full-library demo location."""
    path = args.k3_location if c.get('location') == 'k3' else args.location
    doc = read_json(path) or {}
    return path, doc


def run_card(c, args, sha, cat):
    rid = c['id']
    loc, loc_doc = card_location(c, args)
    os.environ['CM_LOCATION'] = loc
    c = dict(c, locationName=str(loc_doc.get('name')), locationCutters=len(loc_doc.get('inventory') or []))
    rundir = os.path.join(args.out, 'runs', sha, rid)
    job = os.path.join(JOBS, c['job'])
    ref0 = REF_BY_ID.get(c.get('vendor') or '')
    if ref0 and ref0.get('svg'):
        # A drawn reference's job is built at build time through the app's own importer (#968): the
        # SVG itself is the vendor's evaluation-only input and is never committed.
        svg = makerable(args, ref0['svg'][0], ref0['svg'][1])
        job = os.path.join(rundir, 'job.json')
        if svg and not os.path.exists(job):
            os.makedirs(rundir, exist_ok=True)
            L, W, T = ref0['stock']
            spec = {'name': c['title'], 'length': L, 'width': W, 'thickness': T,
                    'material': c['material'], 'depth': ref0.get('depth', 0.8),
                    'toolKey': ref0.get('toolKey', ''), 'strokeWidth': ref0.get('strokeWidth'),
                    'scale': ref0.get('scale'), 'regions': ref0.get('regions'),
                    'hold': {'kind': 'bracket', 'bracket': {'anchor': 1, 'variant': 'thin',
                             'clamps': [{'edge': 'back', 'at': W / 2}, {'edge': 'right', 'at': L / 2}],
                             'source': 'default'}}}
            spec_path = os.path.join(rundir, 'spec.json')
            json.dump(spec, open(spec_path, 'w'))
            app = os.path.join(args.repo, 'casemaker-app')
            subprocess.run(['npx', '--no-install', 'tsx', '--tsconfig', 'tsconfig.app.json',
                            os.path.join(HERE, 'svg-design-job.mts'), app, svg, job, spec_path],
                           cwd=app, capture_output=True, text=True, timeout=300)
    assets = os.path.join(rundir, 'assets')
    os.makedirs(assets, exist_ok=True)
    receipt_path = os.path.join(rundir, 'receipt.json')
    card = dict(c)
    card['kind'] = c['kind']
    card['figures'] = []
    card['problems'] = []

    run_job = materialise_job(job, rundir, args.meshes, args)
    job = run_job if run_job != job else job   # the design check and goal reader take the same bytes
    # A receipt that exists but is EMPTY is a crashed command's leavings, not a result: retrying a
    # card must re-run the CLI (j28 was stuck on a 0-byte receipt from a failed first attempt).
    if not os.path.exists(receipt_path) or os.path.getsize(receipt_path) == 0:
        # #1257 — THE CARD'S OWN LIMIT, from its own reference seconds in the named baseline (the fixed default when
        # it has none), and the command runs traced so a card that goes over says how far it got.
        lim = limits.card_limit((LIMIT_TABLE or {}).get('cards', {}).get(rid),
                                *( (LIMIT_TABLE['margin'], LIMIT_TABLE['floor'], args.timeout) if LIMIT_TABLE else (limits.LIMIT_MARGIN, limits.LIMIT_FLOOR_S, args.timeout)))
        if LIMIT_TABLE is None:
            lim = {'limitSeconds': args.timeout, 'referenceSeconds': None, 'margin': None, 'floor': None, 'source': 'no-limits-table'}
        lim['baseline'] = (LIMIT_TABLE or {}).get('baseline', {}).get('name')
        r = limits.run_limited(['npm', 'run', '-s', 'casemaker', '--', 'cut', run_job, '--out', rundir,
                                '--json', '--location', loc], os.path.join(args.repo, 'casemaker-app'),
                               lim['limitSeconds'], os.path.join(rundir, 'trace.jsonl'))
        open(receipt_path, 'w').write(r['stdout'])
        open(os.path.join(rundir, 'stderr.txt'), 'w').write(r['stderr'])
        json.dump({'exit': r['exit'], 'wall': r['wall'], 'timeout': r['timeout'], 'limit': lim, 'reached': r['reached']},
                  open(os.path.join(rundir, 'run.json'), 'w'))
    run = read_json(os.path.join(rundir, 'run.json'), {})
    # The card's own WALL-CLOCK compute time — the CLI command's wall as it actually spent it, from
    # the cached `run.json` (a timed-out card records the whole window it was given). Printed on the
    # card beside the CAM's estimate so a run's cost is visible, not inferred.
    if run.get('wall') is not None:
        card['computeSeconds'] = round(float(run['wall']), 1)
    if run.get('limit'):
        card['limit'] = run['limit']              # the reference seconds, baseline, margin and limit this card ran under
    if run.get('timeout'):
        # OVER LIMIT is its own outcome, not an error: both numbers and how far the card got (#1257)
        lim_s = (run.get('limit') or {}).get('limitSeconds') or args.timeout
        rec = limits.over_limit_record(lim_s, run.get('wall'), run.get('reached'))
        card['verdict'], card['overLimit'], card['sentence'] = 'over-limit', rec, limits.over_limit_sentence(rec)
        return card
    rc = load_receipt(rundir)
    if rc['ok'] is None and not os.path.getsize(receipt_path):
        # A killed command is a COST finding, and the two ways it dies read differently: a timeout
        # names its window (above), an out-of-memory kill names its ceiling and its wall time.
        errtext = ''
        try:
            errtext = open(os.path.join(rundir, 'stderr.txt'), errors='replace').read()
        except OSError:
            pass
        if run.get('exit') == 134 or 'heap out of memory' in errtext.lower():
            wall = run.get('wall')
            card['verdict'] = 'error'
            card['sentence'] = (
                'the command ran out of memory (exit 134'
                + (f' after {wall:.0f} s' if wall is not None else '')
                + '): JavaScript heap out of memory at the Node heap ceiling, and no receipt was written')
            card['numbers'] = {'oomWallSeconds': wall}
        else:
            card['verdict'], card['sentence'] = 'error', 'the command wrote no receipt'
        return card
    card['time'] = rc['time']
    card['warnings'] = rc['warnings']
    ncs = sorted(os.path.join(rundir, f) for f in os.listdir(rundir)
                 if f.endswith('.nc') and not f.endswith('-frame.nc'))
    card['ours'] = {'airFraction': rc['airFraction'], 'rapidsPer1k': rc['rapidsPer1k'],
                    'cycleSeconds': rc['cycleSeconds'], 'hops': rc['hops'],
                    'feedMoves': rc['feedMoves'], 'cutters': len(our_cutters(ncs)) or len(ncs)}


    # Render before/after from the same sweep the checks use.
    subprocess.run([sys.executable, os.path.join(HERE, 'render.py'), '--location', loc, job, assets, *ncs],
                   check=False, capture_output=True, text=True)
    card['figures'].append(('Before', inline_img(os.path.join(assets, 'before.png'))))
    card['figures'].append(('After · independent sweep', inline_img(os.path.join(assets, 'after.png'))))

    kind = c['kind']
    prefix = os.path.join(rundir, 'goal')
    gc = None
    if kind == 'goal':
        # The goal heightfield is the card's reference, and the vendor's program is scored against
        # exactly the same surface: it is built whether or not the app wrote a program (#955).
        app = os.path.join(args.repo, 'casemaker-app')
        hf_ok = os.path.exists(prefix + '.bin') and os.path.exists(prefix + '.json')
        if not hf_ok:
            hf = subprocess.run(['npx', '--no-install', 'tsx', '--tsconfig', 'tsconfig.app.json',
                                 os.path.join(HERE, 'goal-hf.mts'), app, job, prefix],
                                cwd=app, capture_output=True, text=True, timeout=300)
            hf_ok = hf.returncode == 0
        if ncs and hf_ok:
            # Every program of the first setup sweeps the same side (a goal's flat rough and ball
            # finish are two programs). A job with setups names each program's side.
            setups = (read_json(job) or {}).get('setups') or []
            first_id = setups[0].get('id') if setups else None
            # The receipt names each program's own file. (Reconstructing it from the job's display
            # name gets `<name>.nc`, which does not exist — the files are slugified — and the `.nc`
            # it falls back to is the alphabetically FIRST program, i.e. usually the rest pass.)
            side1 = [os.path.join(rundir, p['ncFile'])
                     for p in rc['programs']
                     if (not setups or p.get('setupId') in (None, first_id))]
            side1 = [f for f in side1 if os.path.exists(f)] or ncs[:1]
            subprocess.run([sys.executable, os.path.join(HERE, 'goal_check.py'), prefix,
                            str(job_stock(job)['thickness']), rundir, *side1],
                           check=False, capture_output=True, text=True)
            gc = read_json(os.path.join(rundir, 'goalcheck.json'))
            if gc:
                gp = goal_picture(prefix, job_stock(job))
                card['figures'].append(('Goal · the app’s own heightfield', inline_img(gp)))
                card['figures'].append(('Deviation map · red = cut into the goal', inline_img(os.path.join(rundir, 'goalcheck.png'))))
                gh = read_json(prefix + '.json') or {}
                pitch = gc['pitchMm']
                card['goalSize'] = {'x': round(gh.get('nx', 0) * pitch, 1), 'y': round(gh.get('ny', 0) * pitch, 1)}
            else:
                card['verdict'], card['sentence'] = 'error', 'the goal check did not run'
                return card
    if kind == 'goal':
        if ncs and gc is None and not os.path.exists(prefix + '.bin'):
            card['verdict'], card['sentence'] = 'error', 'the goal heightfield could not be sampled (not a mesh goal?)'
            return card
        if ncs and gc is not None:
            # #953 — THE APP'S OWN GOAL REPORT WINS. details.goal rides the receipt; when it is there
            # the card prints and judges exactly what the app does, and tools/goal_check.py is kept
            # only for the deviation map and the edge-break/wall/shadow shares (the vendor table's
            # allowances). Without it the card falls back to this tool's recomputation, and says so.
            appg = rc.get('goal') if isinstance(rc.get('goal'), dict) else None
            if appg and appg.get('ran'):
                card['goalSource'] = 'receipt'
                card['numbers'] = app_goal_numbers(appg)
                lo = (appg.get('leftoverFractions') or [1.0])[0]
                covers = 100.0 * (1.0 - float(lo))
                passp = 100.0 * float(appg.get('passCoverage') or 0.95)
                # THE RULE THE PAGE STATES: cut-into BEYOND the edge-break allowance. The raw
                # fraction counts the cells the app's own rule excuses (the edge break and the wall
                # cells the heightfield cannot adjudicate; on ref-ringbox all 3.3e-5 of it was wall
                # cells, so a card whose sentence says "no cell cut more than 0.1 mm" read
                # "deviates"); the app's adjudicatedFraction is the one the rule names. The raw
                # share stays a fact on the card (app_goal_numbers).
                problems = []
                adj = appg.get('adjudicatedFraction')
                cut = float(adj if adj is not None else (appg.get('cutIntoFraction') or 0.0))
                if cut > 0:
                    problems.append(f"cut into the goal on {round(100 * cut, 2)} % of the surface")
                if covers < passp:
                    problems.append(f"coverage {round(covers, 2)} % of the goal's top surface (the app's pass line asks {round(passp):g} %)")
                card['verdict'] = 'deviates' if problems else 'match'
                card['sentence'] = appg.get('sentence') or '; '.join(problems) or \
                    f"the app's own goal check: zero cut-into; coverage {round(covers, 2)} %"
                # The page's own allowance analysis rides along under page* names: the app has no
                # edge-break/wall/shadow fields, and cutIntoPct must NOT be overwritten by ours.
                card['numbers'].update({f'page{k[0].upper()}{k[1:]}': gc[k] for k in
                                        ('edgeBreakPct', 'wallNotScoredPct', 'shadowNotScoredPct',
                                         'cutIntoInclEdgePct', 'cutInto0p1Pct')})
            else:
                card['goalSource'] = 'recomputed'
                card['verdict'], card['sentence'], card['numbers'] = goal_verdict(rc, gc)
            # The app's own second coverage number, from its `goal-unreached` warning: the share of
            # the WHOLE goal surface this setup reproduces (top-facing and reachable), as against this
            # card's top-heightfield coverage. Read from the receipt, never re-derived here.
            if card['numbers'].get('wholeSurfacePct') is None:
                reach = None
                for w in rc['warnings']:
                    m = re.search(r"reproduces (\d+(?:\.\d+)?) % of the goal's surface", w)
                    if m:
                        reach = float(m.group(1))
                        break
                card['numbers']['wholeSurfacePct'] = reach
            if len(rc['programs']) > 1:
                card['sentence'] += ' (goal check: side 1 only)'
        else:
            if rc['sentence']:
                card['verdict'], card['sentence'] = 'refused', rc['sentence'] + (f" [{rc['code']}]" if rc['code'] else '')
            else:
                card['verdict'], card['sentence'] = 'error', 'no program was written'
            card['numbers'] = {}
    else:
        dc = None
        p = subprocess.run([sys.executable, os.path.join(HERE, 'design_check.py'), '--location', loc,
                            job, rundir, *ncs], capture_output=True, text=True)
        try:
            dc = json.loads(p.stdout.strip().splitlines()[-1]) if p.stdout.strip() else None
        except ValueError:
            dc = None
        if dc is None:
            card['verdict'], card['sentence'] = 'error', 'the design check did not produce a report'
            return card
        card['figures'].append(('Design check · outlines green, above-floor red, below-floor blue',
                                inline_img(os.path.join(rundir, 'overlay.png'))))
        card['verdict'], card['sentence'], card['numbers'] = design_verdict(rc, dc)
        card['design'] = dc
        card['oursDesign'] = design_numbers(dc)

    # #955 — the vendor's own program beside ours: the same reference, the same checker.
    ref = REF_BY_ID.get(c.get('vendor')) if c.get('vendor') else None
    if ref and kind == 'design':
        card['vendor'] = {'ref': ref}
        nc = makerable(args, ref['nc'][0], ref['nc'][1])
        if nc is None:
            card['vendor']['missing'] = True
        else:
            vdir = os.path.join(rundir, 'vendor')
            os.makedirs(vdir, exist_ok=True)
            sec = os.path.join(vdir, 'vendor-tool.nc')
            if not os.path.exists(sec):
                vendor_section(nc, ref.get('tool'), sec)
            rep = os.path.join(vdir, 'design.json')
            if not os.path.exists(rep):                      # cached like the receipt
                p = subprocess.run([sys.executable, os.path.join(HERE, 'design_check.py'),
                                    '--location', loc, job, vdir, sec], capture_output=True, text=True)
                open(rep, 'w').write(p.stdout.strip().splitlines()[-1] if p.stdout.strip() else '{}')
            dv = read_json(rep)
            sys.path.insert(0, HERE)
            from goal_check import mkr_time                 # noqa: E402
            if dv:
                card['vendor'].update({'numbers': design_numbers(dv), 'nc': ref['nc'][0],
                                       'seconds': mkr_time(nc),
                                       'stats': vendor_stats(sec, mkr_time(nc))})
                card['figures'].append((f"Makera Studio’s own program · its T{ref.get('tool')} pass on our design",
                                        inline_img(os.path.join(vdir, 'overlay.png'))))
            else:
                card['vendor']['failed'] = True
    if ref and kind == 'goal':
        card['vendor'] = {'ref': ref}
        nc = makerable(args, ref['nc'][0], ref['nc'][1])
        if nc is None or not os.path.exists(prefix + '.bin'):
            card['vendor']['missing'] = True
        else:
            vdir = os.path.join(rundir, 'vendor')
            os.makedirs(vdir, exist_ok=True)
            if not os.path.exists(os.path.join(vdir, 'goalcheck.json')):   # cached like the receipt
                subprocess.run([sys.executable, os.path.join(HERE, 'goal_check.py'), prefix,
                                str(job_stock(job)['thickness']), vdir, '--mkr', '--dz', str(ref['dz']), nc],
                               check=False, capture_output=True, text=True)
            gv = read_json(os.path.join(vdir, 'goalcheck.json'))
            if gv:
                card['vendor'].update({'numbers': gv, 'nc': ref['nc'][0],
                                       'stats': vendor_stats(nc, gv.get('vendorSeconds'))})
                card['figures'].append(('Makera Studio’s own program · deviation map (red = below the goal)',
                                        inline_img(os.path.join(vdir, 'goalcheck.png'))))
            else:
                card['vendor']['failed'] = True

    if kind == 'reference':
        ref = c.get('reference') or {}
        ref_path = os.path.join(args.out, 'reference', os.path.basename(ref.get('url', 'reference.nc')))
        os.makedirs(os.path.dirname(ref_path), exist_ok=True)
        if ref.get('url') and not os.path.exists(ref_path):
            try:
                urllib.request.urlretrieve(ref['url'], ref_path)
            except OSError as e:
                ref_path = None
                card['problems'].append(f'reference program could not be downloaded: {e}')
        if ref_path and os.path.exists(ref_path):
            ra = os.path.join(rundir, 'assets-ref')
            os.makedirs(ra, exist_ok=True)
            rp = subprocess.run([sys.executable, os.path.join(HERE, 'render.py'), '--location', loc,
                                 job, ra, ref_path], capture_output=True, text=True)
            card['figures'].append((f"Reference · {ref.get('name', 'reference program')} swept on the same blank",
                                    inline_img(os.path.join(ra, 'after.png'))))
            try:
                card['referenceRemovedMm3'] = json.loads(rp.stdout.strip().splitlines()[-1]).get('removedMm3')
            except (ValueError, IndexError):
                pass
    return card


def job_stock(job_path):
    return (read_json(job_path) or {}).get('stock') or {}


def seven_lines(c):
    """The plan-v2 §3 lines side by side: Makera Studio's own program and ours on the same reference.
    Every number is printed as measured; a line ours cannot state reads 'refused', not a guess."""
    v = (c.get('vendor') or {}).get('numbers') or {}
    st = (c.get('vendor') or {}).get('stats') or {}
    n = c.get('numbers') or {}
    o = c.get('ours') or {}
    design = 'coveragePct' in v and 'cutInto0p1Pct' not in v   # 2.5D: the design check's report
    od = c.get('oursDesign') or {}
    def pct(x):
        return '—' if x is None else f'{x * 100:.1f} %'
    def f(x, d=1, unit=''):
        return '—' if x is None else f'{x:.{d}f}{unit}'
    if design:
        vsecs = (c.get('vendor') or {}).get('seconds')
        rows = [
            ('coverage of the design', f"{f(v.get('coveragePct'), 2)} % of the drawn band" if v else 'not scored',
             f"{f(od.get('coveragePct'), 2)} % of the drawn band" if od else 'refused — no program to score'),
            ('cut outside the design', f"{f(v.get('outsideMm2'), 1)} mm² (max {f(v.get('deepestOutsideMm'), 2)} mm)" if v else 'not scored',
             f"{f(od.get('outsideMm2'), 1)} mm² (max {f(od.get('deepestOutsideMm'), 2)} mm)" if od else 'refused — no program to score'),
            ('cycle time', f"{f((vsecs or 0) / 60, 1)} min (its whole NC: engrave + contour + chamfer)" if vsecs else '—',
             f(o['cycleSeconds'] / 3600, 2, ' h') if o.get('cycleSeconds') else (c.get('time') or 'refused — no program to score')),
            ('air fraction', pct(st.get('airFraction')), pct(o.get('airFraction'))),
            ('rapids per 1,000 feed moves', f(st.get('rapidsPer1k')), f(o.get('rapidsPer1k'))),
            ('cutters', '3 (engraver, ⌀3.175 flat, chamfer)' if v else '—', str(o.get('cutters') or '—')),
            ('posts as filed', 'yes — its own stock and holding' if v else '—',
             {'match': 'yes', 'deviates': 'yes'}.get(str(c.get('verdict')), html.escape(str(c.get('verdict') or '—')))),
        ]
        allow = ('<p class="notes">Both columns are scored against the same design (our job’s own drawn band) '
                 'and by the same design check; the vendor column is its engraving pass, the operation our job '
                 'performs — its contour and chamfer are a different one and are left out of the design comparison.</p>')
        # A reference NC whose design check scored no items (ref-coasters, ref-badge at e741c9266)
        # states outsideMm2 with coveragePct null: print the measured cut, never do arithmetic on a
        # number the check did not produce.
        if v and v.get('outsideMm2') is not None and v.get('coveragePct') is not None:
            allow += (f"<p class=\"notes\">The vendor’s engraving leaves {f(100 - v.get('coveragePct'), 1)} % of the drawn "
                      f"band above the floor: a 0.3 mm engraver clears a groove inside a band wider than itself — a "
                      f"property of a V-engraving, printed as a fact.</p>")
        body = ''.join(f'<tr><td>{k}</td><td>{a}</td><td>{b}</td></tr>' for k, a, b in rows)
        return (f"<details open><summary>The seven lines, ours and Makera’s</summary>"
                f"<div class=\"tablewrap\"><table><tr><th>line</th><th>Makera Studio</th><th>Case Maker</th></tr>{body}</table></div>"
                f"{allow}</details>")
    # A receipt carries the app's floats raw; print them as measured at the card's own precision.
    ours_cut = (f"{f(n['cutIntoPct'], 2)} % · max {f(n['maxCutIntoMm'], 3)} mm" if 'cutIntoPct' in n
                else 'refused — no program to score')
    vend_cut = (f"{f(v['cutInto0p1Pct'], 2)} % · max {f(v['maxCutIntoMm'], 3)} mm" if v else 'not scored')
    rows = [
        ('coverage, top surface', f"{f(100 - v['leftover0p1Pct'], 2)} %" if v else 'not scored',
         f"{f(n['coveragePct'], 2)} %" if 'coveragePct' in n else 'refused — no program to score'),
        ('cut-into' + (" (the app\u2019s own goal check, 0.01 mm floor)" if n.get('source') == 'receipt'
                                else ' &gt; 0.1 mm (allowances stated below)'), vend_cut, ours_cut),
        ('cycle time', f"{f((v.get('vendorSeconds') or 0) / 60, 1)} min (the NC header)" if v else '—',
         f(o['cycleSeconds'] / 3600, 1, ' h') if o.get('cycleSeconds') else (c.get('time') or 'refused — no program to score')),
        ('air fraction', pct(st.get('airFraction')), pct(o.get('airFraction'))),
        ('rapids per 1,000 feed moves', f(st.get('rapidsPer1k')) , f(o.get('rapidsPer1k'))),
        ('cutters', str(len(((v.get('programs') or [{}])[0].get('tools') or []))) if v else '—',
         str(o.get('cutters') or '—')),
        ('posts as filed', 'yes — its own stock and holding' if v else '—',
         {'match': 'yes', 'deviates': 'yes'}.get(str(c.get('verdict')), html.escape(str(c.get('verdict') or '—')))),
    ]
    body = ''.join(f'<tr><td>{k}</td><td>{a}</td><td>{b}</td></tr>' for k, a, b in rows)
    allow = ''
    if v:
        allow = (f"<p class=\"notes\">The vendor’s excluded, unadjudicated share: edge break {v.get('edgeBreakPct')} % "
                 f"(max {v.get('edgeBreakMaxMm')} mm), wall cells {v.get('wallNotScoredPct')} %, "
                 f"wall shadow {v.get('shadowNotScoredPct')} %; raw cut-into below 0.01 mm {v.get('cutIntoInclEdgePct')} %. "
                 f"The same rule scores both columns.</p>")
        if (v.get('cutInto0p1Pct') or 0) > 0:
            allow += (f"<p class=\"notes\">Makera’s own program misses the cut-into line on this part "
                      f"({v['cutInto0p1Pct']} % of cells, max {v.get('maxCutIntoMm')} mm): its number is printed as a "
                      f"fact beside the line, and the line is not the vendor’s floor — it is not lowered to it.</p>")
    return (f"<details open><summary>The seven lines, ours and Makera’s</summary>"
            f"<div class=\"tablewrap\"><table><tr><th>line</th><th>Makera Studio</th><th>Case Maker</th></tr>{body}</table></div>"
            f"{allow}</details>")


def page(cards, args, sha, loc, cat):
    def vof(c):
        v = c.get('vendor')
        return v if isinstance(v, dict) else {}
    k3 = read_json(args.k3_location) or {}
    # The gate table keeps computed verdicts only; a card the interim check cannot measure waits in
    # its own appendix until #924's oracle can say something about it.
    gate = [c for c in cards if c.get('verdict') != 'unchecked']
    waiting = [c for c in cards if c.get('verdict') == 'unchecked']
    counts = {k: sum(1 for c in gate if c.get('verdict') == k) for k in PILL}
    head = open(os.path.join(HERE, 'page-head.html')).read()
    rows = []
    for c in gate:
        pill_cls, pill_txt = PILL.get(c.get('verdict'), PILL['error'])
        rows.append(f"<tr><td>{html.escape(c['id'])}</td><td>{html.escape(c['title'])}</td>"
                    f"<td>{html.escape(c['kind'])}</td><td><span class=\"pill {pill_cls}\">{pill_txt}</span></td>"
                    f"<td>{html.escape((c.get('sentence') or '')[:180])}</td></tr>")
    waiting_section = ('<section class="panel"><h2>Appendix — an objective reference exists but the '
                       'interim check cannot measure it (waits on #924)</h2><ul class="findings">' +
                       ''.join(f'<li><span class="pill right">Not checkable</span><p><b>{html.escape(c["id"])}</b> '
                               f'{html.escape(c["title"])} — <span class="notes">{html.escape(c.get("sentence") or "")}</span></p></li>'
                               for c in waiting) + '</ul></section>') if waiting else ''
    body = [f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">{head}
<style>.frames {{ grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }} .card {{ white-space: normal; }}</style>
</head><body><div class="wrap">
<header>
  <h1>Z1 Demo Jobs</h1>
  <p class="lede">Every card below is judged by a computed check against an objective reference drawn on it:
  the job’s own design (outline overlay and under/over numbers), the app’s goal heightfield (deviation map and
  coverage), or a reference program swept the same way. No maker’s photo decides a verdict; the source line is
  provenance only.</p>
  <p class="meta">Case Maker {('candidate' if getattr(args, 'candidate', False) else 'main')} <b>{html.escape(sha)}</b>{' — a candidate branch, not main: these cards were built before it landed' if getattr(args, 'candidate', False) else ''} · demo cards on {html.escape(str(loc.get('id')))} “{html.escape(str(loc.get('name')))}”
  ({len(loc.get('inventory') or [])} cutters) · sample cards on “{html.escape(str(k3.get('name')))}” ({len(k3.get('inventory') or [])} owned cutters, the k3 export) ·
  catalogue {len(cat.get('tools') or [])} cutters / {len(cat.get('feeds') or [])} feed rows,
  synced {html.escape(str(cat.get('syncedAt')))} · built {datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d %H:%M UTC')} · no machine was used</p>
  <p class="meta">The design check is this repo’s own sweep against the job’s design until #924 lands (the app’s
  independent oracle). The page is rebuilt on the pinned sha at every wave end; one command rebuilds it —
  <code>tools/build.sh &lt;sha&gt;</code>.</p>
  <ul class="chips">
    <li><span class="pill ok">Matches the design</span><b>{counts['match']}</b></li>
    <li><span class="pill gap">Deviates</span><b>{counts['deviates']}</b></li>
    <li><span class="pill fail">Refused</span><b>{counts['refused']}</b></li>
    <li><span class="pill cant">Not run</span><b>{counts['error']}</b></li>
  </ul>
</header>
<section class="panel"><h2>The rule</h2><div class="how">
  <p>A card stays only if its reference is objective and drawn on it, and its verdict is computed:
  <b>Matches the design</b> (verifier 0 errors, every measured item at its floor, nothing cut outside the design;
  3D: zero cut-into the goal beyond the edge-break allowance, coverage ≥ 95 %), <b>Deviates</b> (with the numbers
  and where), or <b>Refused</b> (the app’s sentence). Photo-judged verdicts and material proxies are retired;
  the as-filed job is judged. The 3D cut-into line counts a cell only when its swept top is more than 0.1 mm
  below the goal — the goal heightfield’s own pitch — outside three stated classes: the <b>edge break</b> (a V
  bit within its reach of a design edge, no deeper than its leg), <b>wall cells</b> (a vertical wall lands on one
  side of a cell boundary or the other) and the <b>wall shadow</b> (material a cutter cannot reach behind a wall,
  which the heightfield stamp nevertheless spreads over). Each excluded share is printed on the card. A card is judged on the app’s <b>adjudicated</b>
  cut-into — cells past the edge-break, wall and wall-shadow allowances are not counted against it,
  and the raw share is printed as a fact.</p>
  <p>Two scoring rules on the design check, stated so the numbers can be read: a cell within the
  check’s own 0.3 mm erosion of a <b>deeper item’s region</b> is that item’s cut, not this one’s
  over-depth (a ray that starts inside the head pocket’s V flank); and a <b>painted band cut by a V
  cutter</b> is scored as a cone — its walls are the design — whether or not the job carries
  <code>vCarveDepth</code>.</p>
  <p>Not reproducible here, so not cards: {html.escape('; '.join(f'{a} — {b}' for a, b in APPENDIX))}.</p>
  <h3>The five hardwood samples (#936–#941, the 36 × 36 × 100 sticks)</h3>
  <p>A sample joins the card table below as soon as its job file is committed; until then this is what
  the bench has and what is still missing. The bench sessions run from the app, and their cards are
  judged by the same computed checks.</p>
  <div class="tablewrap"><table>
  <tr><th>sample</th><th>issue</th><th>what it measures</th><th>state</th></tr>
  {''.join(f"<tr><td>{s}</td><td>#{n}</td><td>{html.escape(t)}</td><td>{html.escape(st)}</td></tr>" for s, n, t, st in SAMPLES)}
  </table></div>
</div></section>
<section class="panel"><h2>Reference section — Makera Studio’s own programs</h2><div class="how">
  <p>Each <code>ref-*</code> card below is a maker’s published project with <b>Makera Studio’s own NC</b>
  scored on the same goal heightfield, the same checker and the same rule as ours. The card states the
  project, its author and its licence; the vendor’s files are evaluation-only downloads and are never
  committed — the build finds them by sha256 when they are on this machine, and a card whose inputs are
  absent says so instead of guessing.</p>
  {('<p>Not yet beside ours: ' + '; '.join(f'<b>{html.escape(t)}</b> — {html.escape(w)}' for _i, t, w in PARKED) + '.</p>') if PARKED else ''}
</div></section>
<section class="panel"><h2>All cards</h2><div class="tablewrap"><table>
<tr><th>id</th><th>job</th><th>check</th><th>verdict</th><th>what the check says</th></tr>
{''.join(rows)}
</table></div></section>
{waiting_section}''']
    for c in gate:
        pill_cls, pill_txt = PILL.get(c.get('verdict'), PILL['error'])
        figs = ''.join(figure(cap, src) for cap, src in c.get('figures', []))
        facts = []
        n = c.get('numbers') or {}
        if c['kind'] == 'goal':
            if 'coveragePct' in n:
                facts += [('Goal surface', f"{c.get('goalSize', {}).get('x', '?')} × {c.get('goalSize', {}).get('y', '?')} mm"),
                          ('Goal check', "the app’s own report (details.goal)"
                           if c.get('goalSource') == 'receipt'
                           else 'recomputed by tools/goal_check.py — the receipt carried no goal report'),
                          ('Cut into the goal', f"{n['cutIntoPct']} %"
                           + (f" · {n['cutIntoAreaMm2']} mm²" if n.get('cutIntoAreaMm2') is not None else '')
                           + f" · max {n['maxCutIntoMm']} mm"),
                          ('Top-surface coverage', f"{n['coveragePct']} % (the card’s pass line)"),
                          ('Whole-surface reach', f"{n['wholeSurfacePct']} % from this setup (the remainder: under-faces and undercuts)"
                           if n.get('wholeSurfacePct') is not None else 'not stated by the app for this setup'),
                          ('Leftover', f"{n['leftover0p1Pct']} % > 0.1 mm · {n['leftover0p3Pct']} % > 0.3 mm")]
                if n.get('idealCutterMm') is not None:
                    facts.append(('Smallest cutter', f"⌀{n['idealCutterMm']} mm"))
                if n.get('pageCutIntoInclEdgePct') is not None:
                    facts.append(('Page sweep, independent', f"{n['pageCutIntoInclEdgePct']} % below the goal at 0.01 mm · "
                                  f"{n['pageCutInto0p1Pct']} % at 0.1 mm after the allowances (tools/goal_check.py)"))
        else:
            if 'measuredItems' in n:
                facts += [('Measured items', str(n['measuredItems'])),
                          ('Cut outside the design', f"{n['outsideMm2']} mm²" + (f" (deepest {n['outsideDeepestMm']} mm)" if n['outsideDeepestMm'] else '')),
                          ('Verifier errors', str(n['verifierErrors']))]
        if c.get('referenceRemovedMm3') is not None:
            facts.append(('Reference program removed', f"{c['referenceRemovedMm3']} mm³"))
        if c.get('computeSeconds') is not None:
            w = float(c['computeSeconds'])
            facts.append(('Compute time (wall)', f"{w:.0f} s" + (f" ({w / 60:.1f} min)" if w >= 120 else '')))
        if c.get('time'):
            facts.append(('Estimated time', c['time']))
        if c.get('warnings'):
            facts.append(('Warnings', ' · '.join(c['warnings'][:3])))
        facts_html = ''.join(f'<div><dt>{html.escape(k)}</dt><dd>{html.escape(v)}</dd></div>' for k, v in facts)
        detail = ''
        items = (c.get('design') or {}).get('items') or []
        if items:
            irows = ''.join(
                f"<tr><td>{html.escape(str(i.get('id')))}</td><td>{html.escape(str(i.get('kind')))}</td>"
                f"<td>{html.escape(str(i.get('depth', '')))}</td><td>{html.escape('%.4f' % i['left'] if 'left' in i else '—')}</td>"
                f"<td>{html.escape('%.4f' % i['deep'] if 'deep' in i else ('%.4f' % i['over'] if 'over' in i else '—'))}</td>"
                f"<td>{html.escape('%.3f' % i['reachRatio'] if 'reachRatio' in i else '—')}</td></tr>" for i in items)
            detail = (f"<details><summary>Every measured item</summary><div class=\"tablewrap\"><table>"
                      f"<tr><th>item</th><th>kind</th><th>depth mm</th><th>left</th><th>deep/over</th><th>reach</th></tr>{irows}</table></div></details>")
        body.append(f'''<article class="job" id="{html.escape(c['id'])}">
  <div class="job-head">
    <p class="eyebrow">{html.escape(c['material'])} · {html.escape(c['kind'])} check · {html.escape(c['job'])}{' · local-input' if c.get('input') == 'local' else ''}{(' · Makera Studio’s own NC · ' + html.escape(vof(c).get('ref', {}).get('licence', ''))) if vof(c) else ''} · {html.escape(str(c.get('locationName', '')))} ({c.get('locationCutters', 0)} cutters)</p>
    <h2>{html.escape(c['title'])}</h2>
    <p class="src">{html.escape(c['id'])} · source: {html.escape(c.get('source', ''))}</p>
    {('<p class="notes">' + html.escape(vof(c).get('ref', {}).get('note', '')) + '</p>') if vof(c) and vof(c).get('ref', {}).get('note') else ''}
  </div>
  <p><span class="pill {pill_cls}">{pill_txt}</span> <span class="notes">{html.escape(c.get('sentence') or '')}</span></p>
  <div class="frames">{figs}</div>
  <dl class="facts">{facts_html}</dl>
  {seven_lines(c) if vof(c).get('numbers') else ''}
  {detail}
</article>''')
    if getattr(args, 'section_html', None) and os.path.exists(args.section_html):
        body.append(open(args.section_html).read())
    body.append('''<footer>Job files, the tools that build this page and its manifest are in
docs/bench/2026-10-28-z1-real-jobs/ on main. The maintainer’s meshes (samples/3d) are local inputs,
marked on their cards and never moved. No machine was used.</footer></div></body></html>''')
    return '\n'.join(body)


def main():
    args = arg_parse()
    os.environ['CM_LOCATION'] = args.location          # read by render.py at import
    head = git_sha(args.repo)
    sha = head
    if args.sha:
        # The page states the sha the APP was built from. This column's tooling commits sit on top
        # of it; that is only sound while the app itself is byte-identical.
        if not args.sha.startswith(head) and head != args.sha:
            ok = subprocess.run(['git', '-C', args.repo, 'merge-base', '--is-ancestor', args.sha, head]).returncode == 0
            diff = subprocess.run(['git', '-C', args.repo, 'diff', '--name-only', args.sha, head, '--',
                                   'casemaker-app/src', 'casemaker-app/src-tauri', 'casemaker-app/scripts',
                                   'casemaker-app/package.json', 'casemaker-app/package-lock.json'],
                                  capture_output=True, text=True).stdout.strip()
            if not ok or diff:
                sys.exit(f'--sha {args.sha} is not {head} and the app differs: {diff or "not an ancestor"}')
        sha = args.sha
    loc = read_json(args.location) or {}
    cat = read_json(args.catalogue) or {}
    only = set(args.only.split(',')) if args.only else None
    n_ref = init_references(args.references)
    print(references_notice(args.references, n_ref), flush=True)
    init_limits(args.limits, args.timeout)
    todo = [c for c in CARDS + REF_CARDS if not only or c['id'] in only]
    no_reference = limits.no_reference_cards(LIMIT_TABLE['cards'], [c['id'] for c in todo]) if LIMIT_TABLE else []
    if no_reference:
        print(f"limits: no reference time for {', '.join(no_reference)} — they get the default limit of {args.timeout} s", flush=True)
    os.makedirs(args.out, exist_ok=True)
    out_cards = []
    for i, c in enumerate(todo, 1):
        print(f'[{i}/{len(todo)}] {c["id"]} {c["job"]}', flush=True)
        try:
            card = run_card(c, args, sha, cat)
            # Cache the finished card beside its run: a later pass over a subset (a card rebuilt on
            # another machine, one card re-run after a harness fix) regenerates the whole page
            # without re-running or re-rendering the cards that already have one.
            cache = os.path.join(args.out, 'runs', sha, c['id'])
            os.makedirs(cache, exist_ok=True)
            json.dump(card, open(os.path.join(cache, 'card.json'), 'w'))
        except Exception as e:                        # keep going: one broken card must not lose the page
            card = dict(c, verdict='error', sentence=f'{type(e).__name__}: {e}', figures=[], numbers={})
        print(f'    {card.get("verdict")}: {card.get("sentence")}', flush=True)
        out_cards.append(card)
    # THE PAGE IS EVERY CARD THAT HAS A RESULT, in the table's own order: this pass's cards, plus
    # any cached card from an earlier pass over this out dir. A subset run (`--only`, a rebuild of
    # the slow cards) refreshes its own cards and leaves the rest on the page as they were.
    built = {c['id']: c for c in out_cards}
    page_cards = []
    for c in CARDS + REF_CARDS:
        if c['id'] in built:
            page_cards.append(built[c['id']])
            continue
        cached = read_json(os.path.join(args.out, 'runs', sha, c['id'], 'card.json'))
        if cached:
            page_cards.append(cached)
    page_path = os.path.join(args.out, 'page.html')
    open(page_path, 'w').write(page(page_cards, args, sha, loc, cat))
    manifest = {'sha': sha, 'candidate': bool(getattr(args, 'candidate', False)), 'builtAt': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
                'location': {'path': args.location, 'id': loc.get('id'), 'name': loc.get('name'),
                             'cutters': len(loc.get('inventory') or [])},
                'k3Location': {'path': args.k3_location,
                               'id': (read_json(args.k3_location) or {}).get('id'),
                               'name': (read_json(args.k3_location) or {}).get('name'),
                               'cutters': len((read_json(args.k3_location) or {}).get('inventory') or [])},
                'catalogue': {'path': args.catalogue, 'syncedAt': cat.get('syncedAt'),
                              'cutters': len(cat.get('tools') or []), 'rows': len(cat.get('feeds') or [])},
                'limits': dict(LIMITS_FILE, noReference=no_reference) if LIMITS_FILE else None,   # the table's path/sha256/baseline; cards listed with no reference
                'references': REFERENCES_FILE,   # the data file's path and sha256, or null when none was given
                'appendix': [{'card': a, 'why': b} for a, b in APPENDIX],
                'cards': [{k: v for k, v in c.items() if k not in ('design', 'figures')} for c in page_cards]}
    json.dump(manifest, open(os.path.join(args.out, 'manifest.json'), 'w'), indent=1)
    print(f'page: {page_path} (app sha {sha}, worktree HEAD {head})')
    print(f'manifest: {os.path.join(args.out, "manifest.json")}')
    bad = [c['id'] for c in out_cards if c.get('verdict') == 'error']
    if bad:
        sys.exit(f'not run: {", ".join(bad)}')


if __name__ == '__main__':
    main()
