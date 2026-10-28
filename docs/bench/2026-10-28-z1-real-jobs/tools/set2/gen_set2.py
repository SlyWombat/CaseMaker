"""Insert the second set into the published Z1 demo-jobs page (v2 cards untouched) and write the result."""
import json, os, io, base64, html, re, sys
from PIL import Image
HERE = os.path.dirname(os.path.abspath(__file__)); R = os.path.dirname(HERE)
sys.path.insert(0, HERE)
from set2_cards import CARDS, NOT_RUN, I
E = html.escape
PILL = {'Matches the photo': 'ok', 'Partly': 'gap', 'Fails': 'fail', 'No photo to compare': 'cant'}
GH = 'https://github.com/SlyWombat/CaseMaker/issues/'

def img(path, w=760, q=80):
    if not path or not os.path.exists(path): return None
    im = Image.open(path).convert('RGB')
    if im.width > w: im = im.resize((w, int(im.height * w / im.width)))
    b = io.BytesIO(); im.save(b, 'JPEG', quality=q)
    return 'data:image/jpeg;base64,' + base64.b64encode(b.getvalue()).decode()

def expand(run):
    parts = run.split('+')
    if len(parts) == 1: return [run]
    base = parts[0].rsplit('-', 1)[0]
    return [parts[0]] + [base + '-' + s for s in parts[1:]]

def result(name):
    d = os.path.join(R, 'runs', name)
    ex = open(os.path.join(d, 'exit.txt')).read().strip() if os.path.exists(os.path.join(d, 'exit.txt')) else ''
    try: r = json.load(open(os.path.join(d, 'receipt.json')))
    except Exception:
        st = open(os.path.join(d, 'stderr.txt')).read() if os.path.exists(os.path.join(d, 'stderr.txt')) else ''
        if 'RuntimeError' in st: return ('crash', 'The command crashed: RuntimeError: memory access out of bounds. No receipt was printed.', None)
        if ex.startswith('exit=124'): return ('timeout', 'The command ran for 15 minutes with no result and was stopped.', None)
        return ('crash', 'No receipt.', None)
    if r.get('ok'):
        p = ((r.get('details') or {}).get('programs') or [{}])[0]
        return ('ok', None, (p.get('sheet') or {}).get('estimatedTime'))
    errs = [x for x in r['diagnostics'] if x['severity'] == 'error']
    ref = [x for x in r['refusals'] if x['code'] not in ('stopped', 'nothing-written')]
    if errs: return ('refused', f"{errs[0]['code']}: {errs[0]['message']}", None)
    return ('refused', ref[0]['reason'] if ref else 'refused', None)

def card(c):
    a = os.path.join(R, 'assets', c['id'])
    before, after, top, intended = (img(os.path.join(a, n)) for n in ('before.png', 'after.png', 'after-top.png', 'intended.jpg'))
    url, title, credit = c['source']
    iss = ' '.join(f'<a href="{GH}{I[k]}" target="_blank" rel="noopener">#{I[k]}</a>' for k in c['issues']) or '—'
    h = [f'<article class="job" id="{c["id"]}"><header class="job-head"><p class="eyebrow">{E(c["category"])}</p><h3>{E(c["title"])}</h3>'
         f'<p class="src">Source: <a href="{url}" target="_blank" rel="noopener">{E(title)}</a> · {E(credit)}</p></header>'
         f'<div class="verdict"><span class="pill {PILL[c["verdict"]]}">{E(c["verdict"])}</span> <span>{E(c["sentence"])}</span></div>'
         f'<p class="src">Filed: {iss}</p><p class="notes"><b>What was modelled.</b> {E(c["modelled"])}</p>']
    h.append('<div class="run"><div class="frames">')
    h.append(f'<figure><figcaption>Before · raw blank</figcaption><div class="plate"><img src="{before}" alt="The raw blank" loading="lazy"></div></figure>' if before else '')
    if after:
        h.append(f'<figure><figcaption>After · our programs, swept in order</figcaption><div class="plate"><details class="top"><summary>Top view</summary><img src="{top}" alt="the part from above" loading="lazy"></details><img src="{after}" alt="the part" loading="lazy"></div></figure>')
    else:
        h.append('<figure><figcaption>After · our programs, swept in order</figcaption><div class="plate"><p class="none">No part: no program was produced.</p></div></figure>')
    h.append(f'<figure><figcaption>Intended · from the source</figcaption><div class="plate photo"><img src="{intended}" alt="the maker’s finished part" loading="lazy"><p class="credit">Photo: <a href="{url}" target="_blank" rel="noopener">{E(credit)}</a></p></div></figure>')
    h.append('</div>')
    h.append(f'<dl class="facts"><div><dt>Material</dt><dd>{E(c["material"])}</dd></div><div><dt>Stock</dt><dd>{E(c["stock"])}</dd></div><div><dt>Held by</dt><dd>{E(c["held"])}</dd></div><div><dt>Cutters</dt><dd>{E(c["cutters"])}</dd></div></dl>')
    rows = []
    for rt, run in c['runs']:
        rs = [result(n) for n in expand(run)]
        bad = [x for x in rs if x[0] != 'ok']
        if not bad:
            pill = '<span class="pill ok">Generated</span>'; text = ''
        else:
            kind = bad[0][0]
            pill = {'refused': '<span class="pill fail">Refused</span>', 'timeout': '<span class="pill fail">No result</span>', 'crash': '<span class="pill fail">Crashed</span>'}[kind]
            text = E(bad[0][1])
        rows.append(f'<tr><td>{E(rt)}</td><td>{pill}</td><td class="src">{text}</td></tr>')
    h.append('<div class="tablewrap"><table><thead><tr><th>Run</th><th>Result</th><th>First refusal</th></tr></thead><tbody>' + ''.join(rows) + '</tbody></table></div>')
    h.append('</div></article>')
    return ''.join(h)

def section():
    from collections import Counter
    n = Counter(c['verdict'] for c in CARDS)
    chips = ''.join(f'<li><span class="pill {PILL[k]}">{k}</span><b>{n.get(k, 0)}</b></li>' for k in ('Matches the photo', 'Partly', 'Fails'))
    table = ''.join(f'<tr><td><a href="#{c["id"]}">{E(c["title"])}</a></td><td><span class="pill {PILL[c["verdict"]]}">{c["verdict"]}</span></td><td>{" ".join("#" + str(I[k]) for k in c["issues"]) or "—"}</td></tr>' for c in CARDS)
    notrun = ''.join(f'<li><b>{E(a)}</b>: {E(b)}</li>' for a, b in NOT_RUN)
    s = [f'''<section id="set2">
    <h2>Second set: seven more jobs</h2>
    <div class="panel"><ul class="chips">{chips}</ul>
      <p class="lede" style="margin-top:12px">Seven more typical desktop-mill jobs, chosen because their sources publish the finished part and something real to build from. From <b>CutRocket</b> (Carbide 3D’s project site), the maker’s own Carbide Create design file; from <b>Makerables</b> (Makera’s project library), the maker’s stated sizes, artwork or photos. They cover what the first set did not: an accuracy sample made for the Z1, a tray with a raised letter, an epoxy-inlay coaster, a compartment tray, a two-colour sign and two aluminium bike tools.</p>
      <p class="lede">This time the house cutters carry their confirmed Makera matches (#732), so aluminium and the plastics get Makera’s own feeds. Wood jobs are cut in PLA, as in the first set. <b>None matches its photo yet.</b> The most common block is new. A job that needs a second cutter for its own features (small holes, an engraving, a cut-out) is refused as one job (#746): four of the seven only generate when split by hand into one job per cutter. Two jobs produce no program at all (#747, #750), and one crashes the command (#749).</p>
      <p class="meta">Case Maker main 9538601f · <code>casemaker cut</code> with the house location and the synced Makera catalogue · run 2026-10-28 · no machine was used</p></div>
    <div class="panel tablewrap"><table><thead><tr><th>Job</th><th>Verdict</th><th>Issues</th></tr></thead><tbody>{table}</tbody></table></div>''']
    s += [card(c) for c in CARDS]
    s.append(f'<div class="panel how"><h2>Looked at, not run</h2><ul>{notrun}</ul><p>Job files, the manifest’s <code>set2</code> section and the pipeline are in docs/bench/2026-10-28-z1-real-jobs/ on main. The jobs built from CutRocket files and the traced sign are not committed (their licence is unstated or forbids modified copies); the README gives the downloads and rebuild steps.</p></div>')
    s.append('</section>')
    return '\n'.join(s)

if __name__ == '__main__':
    src, out = sys.argv[1], sys.argv[2]
    page = open(src).read()
    assert 'id="set2"' not in page
    i = page.rfind('  <footer>')
    page = page[:i] + section() + '\n' + page[i:]
    note = '<p class="meta">A <a href="#set2">second set of seven jobs</a> follows the first eighteen.</p>'
    j = page.find('</header>')
    page = page[:j] + note + page[j:]
    open(out, 'w').write(page)
    print('wrote', out, len(page))
