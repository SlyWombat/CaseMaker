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
import subprocess
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
W = os.path.dirname(HERE)                      # docs/bench/2026-10-28-z1-real-jobs
JOBS = os.path.join(W, 'jobs')
sys.path.insert(0, HERE)
from cards import CARDS, APPENDIX, SAMPLES      # noqa: E402

TOL = 0.02          # fraction of an item's area; the same 2 % the issue's verdict rule names
NOISE = {'vise-default', 'sacrificial-default', 'plunge-unproven'}
PILL = {'match': ('ok', 'Matches the design'), 'deviates': ('gap', 'Deviates'),
        'refused': ('fail', 'Refused'), 'unchecked': ('right', 'Not checkable'), 'error': ('cant', 'Not run')}


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
    p.add_argument('--only', help='comma-separated card ids (debug)')
    p.add_argument('--timeout', type=int, default=1800, help='seconds per job (default 1800)')
    return p.parse_args()


def sh(cmd, cwd, timeout):
    t0 = datetime.datetime.now()
    try:
        p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)
        return {'exit': p.returncode, 'stdout': p.stdout, 'stderr': p.stderr,
                'wall': round((datetime.datetime.now() - t0).total_seconds(), 1), 'timeout': False}
    except subprocess.TimeoutExpired as e:
        return {'exit': 124, 'stdout': e.stdout or '', 'stderr': e.stderr or '',
                'wall': round((datetime.datetime.now() - t0).total_seconds(), 1), 'timeout': True}


def git_sha(repo):
    return subprocess.run(['git', '-C', repo, 'rev-parse', 'HEAD'], capture_output=True,
                          text=True, check=True).stdout.strip()


def read_json(path, default=None):
    try:
        return json.load(open(path))
    except (OSError, ValueError):
        return default


def materialise_job(job_path, rundir, meshes):
    """The committed 3D jobs carry no mesh bytes: the meshes are shop-owned local inputs. Put the
    file the job names back in, by the job's own sha256, into the run directory (never the repo)."""
    import hashlib
    j = read_json(job_path)
    if not j:
        return job_path
    t = j.get('targetObject') or (j.get('targetObjects') or [None])[0]
    if not t or t.get('data') or not t.get('name'):
        return job_path
    src = os.path.join(meshes, t['name'])
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
    job = os.path.join(JOBS, c['job'])
    rundir = os.path.join(args.out, 'runs', sha, rid)
    assets = os.path.join(rundir, 'assets')
    os.makedirs(assets, exist_ok=True)
    receipt_path = os.path.join(rundir, 'receipt.json')
    card = dict(c)
    card['kind'] = c['kind']
    card['figures'] = []
    card['problems'] = []

    run_job = materialise_job(job, rundir, args.meshes)
    job = run_job if run_job != job else job   # the design check and goal reader take the same bytes
    if not os.path.exists(receipt_path):
        r = sh(['npm', 'run', '-s', 'casemaker', '--', 'cut', run_job, '--out', rundir,
                '--json', '--location', loc], os.path.join(args.repo, 'casemaker-app'), args.timeout)
        open(receipt_path, 'w').write(r['stdout'])
        open(os.path.join(rundir, 'stderr.txt'), 'w').write(r['stderr'])
        json.dump({'exit': r['exit'], 'wall': r['wall'], 'timeout': r['timeout']},
                  open(os.path.join(rundir, 'run.json'), 'w'))
    run = read_json(os.path.join(rundir, 'run.json'), {})
    if run.get('timeout'):
        card['verdict'], card['sentence'] = 'error', f"the command ran {args.timeout} s with no result and was stopped"
        return card
    rc = load_receipt(rundir)
    if rc['ok'] is None and not os.path.getsize(receipt_path):
        card['verdict'], card['sentence'] = 'error', 'the command wrote no receipt'
        return card
    card['time'] = rc['time']
    card['warnings'] = rc['warnings']
    ncs = sorted(os.path.join(rundir, f) for f in os.listdir(rundir)
                 if f.endswith('.nc') and not f.endswith('-frame.nc'))

    # Render before/after from the same sweep the checks use.
    subprocess.run([sys.executable, os.path.join(HERE, 'render.py'), '--location', loc, job, assets, *ncs],
                   check=False, capture_output=True, text=True)
    card['figures'].append(('Before', inline_img(os.path.join(assets, 'before.png'))))
    card['figures'].append(('After · independent sweep', inline_img(os.path.join(assets, 'after.png'))))

    kind = c['kind']
    if kind == 'goal' and ncs:
        # The goal check writes its own surfaces; Z 0 is the stock top for side 1 only.
        prefix = os.path.join(rundir, 'goal')
        app = os.path.join(args.repo, 'casemaker-app')
        hf = subprocess.run(['npx', '--no-install', 'tsx', '--tsconfig', 'tsconfig.app.json',
                             os.path.join(HERE, 'goal-hf.mts'), app, job, prefix],
                            cwd=app, capture_output=True, text=True, timeout=300)
        gc = None
        if hf.returncode == 0:
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
        if gc is None:
            card['verdict'], card['sentence'] = 'error', 'the goal heightfield could not be sampled (not a mesh goal?)'
            return card
        card['verdict'], card['sentence'], card['numbers'] = goal_verdict(rc, gc)
        # The app's own second coverage number, from its `goal-unreached` warning: the share of the
        # WHOLE goal surface this setup reproduces (top-facing and reachable), as against this card's
        # top-heightfield coverage. Read from the receipt, never re-derived here.
        reach = None
        for w in rc['warnings']:
            m = re.search(r"reproduces (\d+(?:\.\d+)?) % of the goal's surface", w)
            if m:
                reach = float(m.group(1))
                break
        card['numbers']['wholeSurfacePct'] = reach
        if len(rc['programs']) > 1:
            card['sentence'] += ' (goal check: side 1 only)'
    elif kind == 'goal':
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


def page(cards, args, sha, loc, cat):
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
  <p class="meta">Case Maker main <b>{html.escape(sha)}</b> · demo cards on {html.escape(str(loc.get('id')))} “{html.escape(str(loc.get('name')))}”
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
  3D: zero cut-into the goal, coverage ≥ 95 %), <b>Deviates</b> (with the numbers and where), or <b>Refused</b>
  (the app’s sentence). Photo-judged verdicts and material proxies are retired; the as-filed job is judged.</p>
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
                          ('Cut into the goal', f"{n['cutIntoPct']} % · {n['cutIntoAreaMm2']} mm² · max {n['maxCutIntoMm']} mm"),
                          ('Top-surface coverage', f"{n['coveragePct']} % (the card’s pass line)"),
                          ('Whole-surface reach', f"{n['wholeSurfacePct']} % from this setup (the remainder: under-faces and undercuts)"
                           if n.get('wholeSurfacePct') is not None else 'not stated by the app for this setup'),
                          ('Leftover', f"{n['leftover0p1Pct']} % > 0.1 mm · {n['leftover0p3Pct']} % > 0.3 mm"),
                          ('Smallest cutter', f"⌀{n['idealCutterMm']} mm")]
        else:
            if 'measuredItems' in n:
                facts += [('Measured items', str(n['measuredItems'])),
                          ('Cut outside the design', f"{n['outsideMm2']} mm²" + (f" (deepest {n['outsideDeepestMm']} mm)" if n['outsideDeepestMm'] else '')),
                          ('Verifier errors', str(n['verifierErrors']))]
        if c.get('referenceRemovedMm3') is not None:
            facts.append(('Reference program removed', f"{c['referenceRemovedMm3']} mm³"))
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
    <p class="eyebrow">{html.escape(c['material'])} · {html.escape(c['kind'])} check · {html.escape(c['job'])}{' · local-input' if c.get('input') == 'local' else ''} · {html.escape(str(c.get('locationName', '')))} ({c.get('locationCutters', 0)} cutters)</p>
    <h2>{html.escape(c['title'])}</h2>
    <p class="src">{html.escape(c['id'])} · source: {html.escape(c.get('source', ''))}</p>
  </div>
  <p><span class="pill {pill_cls}">{pill_txt}</span> <span class="notes">{html.escape(c.get('sentence') or '')}</span></p>
  <div class="frames">{figs}</div>
  <dl class="facts">{facts_html}</dl>
  {detail}
</article>''')
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
    todo = [c for c in CARDS if not only or c['id'] in only]
    os.makedirs(args.out, exist_ok=True)
    out_cards = []
    for i, c in enumerate(todo, 1):
        print(f'[{i}/{len(todo)}] {c["id"]} {c["job"]}', flush=True)
        try:
            card = run_card(c, args, sha, cat)
        except Exception as e:                        # keep going: one broken card must not lose the page
            card = dict(c, verdict='error', sentence=f'{type(e).__name__}: {e}', figures=[], numbers={})
        print(f'    {card.get("verdict")}: {card.get("sentence")}', flush=True)
        out_cards.append(card)
    page_path = os.path.join(args.out, 'page.html')
    open(page_path, 'w').write(page(out_cards, args, sha, loc, cat))
    manifest = {'sha': sha, 'builtAt': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
                'location': {'path': args.location, 'id': loc.get('id'), 'name': loc.get('name'),
                             'cutters': len(loc.get('inventory') or [])},
                'k3Location': {'path': args.k3_location,
                               'id': (read_json(args.k3_location) or {}).get('id'),
                               'name': (read_json(args.k3_location) or {}).get('name'),
                               'cutters': len((read_json(args.k3_location) or {}).get('inventory') or [])},
                'catalogue': {'path': args.catalogue, 'syncedAt': cat.get('syncedAt'),
                              'cutters': len(cat.get('tools') or []), 'rows': len(cat.get('feeds') or [])},
                'appendix': [{'card': a, 'why': b} for a, b in APPENDIX],
                'cards': [{k: v for k, v in c.items() if k not in ('design', 'figures')} for c in out_cards]}
    json.dump(manifest, open(os.path.join(args.out, 'manifest.json'), 'w'), indent=1)
    print(f'page: {page_path} (app sha {sha}, worktree HEAD {head})')
    print(f'manifest: {os.path.join(args.out, "manifest.json")}')
    bad = [c['id'] for c in out_cards if c.get('verdict') == 'error']
    if bad:
        sys.exit(f'not run: {", ".join(bad)}')


if __name__ == '__main__':
    main()
