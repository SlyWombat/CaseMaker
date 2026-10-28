"""Builds the v2 Z1 demo-jobs page (one self-contained HTML, images inlined as JPEG) and manifest.json."""
import json, os, io, base64, html, re, sys
from PIL import Image
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cards import CARDS, ISS
S = os.path.dirname(os.path.abspath(__file__))
os.chdir(S)
E = html.escape

PILL = {'match': ('ok', 'Matches the photo'), 'partly': ('gap', 'Partly'), 'fails': ('fail', 'Fails'),
        'nophoto': ('cant', 'No photo to compare')}


def img(path, w=760):
    if not path or not os.path.exists(path):
        return None
    im = Image.open(path).convert('RGB')
    if im.width > w:
        im = im.resize((w, int(im.height * w / im.width)))
    b = io.BytesIO(); im.save(b, 'JPEG', quality=80)
    return 'data:image/jpeg;base64,' + base64.b64encode(b.getvalue()).decode()


def receipt(run):
    d = os.path.join('runs', run)
    out = {'exit': None, 'refusal': None, 'time': None, 'removed': None, 'warnings': []}
    try:
        out['exit'] = open(os.path.join(d, 'exit.txt')).read().strip()
    except OSError:
        pass
    try:
        r = json.load(open(os.path.join(d, 'receipt.json')))
    except Exception:
        if out['exit'] and out['exit'].startswith('exit=124'):
            out['refusal'] = ('timeout', 'The command ran for 30 minutes with no result and was stopped.')
        return out
    errs = [x for x in r.get('diagnostics', []) if x.get('severity') == 'error']
    ref = [x for x in r.get('refusals', []) if x.get('code') not in ('stopped', 'nothing-written')]
    if errs:
        out['refusal'] = (errs[0]['code'], errs[0]['message'])
    elif ref:
        out['refusal'] = (ref[0]['code'], ref[0]['reason'])
    out['warnings'] = [x['message'] for x in r.get('diagnostics', []) if x.get('severity') == 'warning'
                       and x.get('code') not in ('vise-default', 'sacrificial-default', 'plunge-unproven')]
    for p in (r.get('details') or {}).get('programs') or []:
        out['time'] = (p.get('sheet') or {}).get('estimatedTime')
        out['removed'] = (p.get('sim') or {}).get('removedVolumeMm3')
    return out


def frame(cap, src, alt, extra=''):
    if src:
        return f'<figure><figcaption>{cap}</figcaption><div class="plate">{extra}<img src="{src}" alt="{E(alt)}" loading="lazy"></div></figure>'
    return f'<figure><figcaption>{cap}</figcaption><div class="plate"><p class="none">{E(alt)}</p></div></figure>'


def intended_fig(card):
    it = card.get('intended')
    if not it:
        return frame('Intended · from the source', None, 'The source shows no finished part.')
    srcs = [img(f) for f in it['files']]
    cap = 'Intended · ' + ('Makera’s own program' if it['kind'] == 'makera' else 'the input picture' if it['kind'] == 'input' else 'from the source')
    name, url = it['credit'][0], it['credit'][-1]
    more = ''
    if len(srcs) > 1 and srcs[1]:
        more = f'<details class="top"><summary>{"Makera’s preview" if it["kind"] == "makera" else "The model used"}</summary><img src="{srcs[1]}" alt="second view"></details>'
    note = f'<p class="credit">{E(it.get("caption", "Photo"))}: <a href="{E(url)}" target="_blank" rel="noopener">{E(name)}</a></p>'
    return (f'<figure><figcaption>{cap}</figcaption><div class="plate photo">{more}'
            f'<img src="{srcs[0]}" alt="{E(it.get("caption", "the intended part"))}" loading="lazy">{note}</div></figure>')


def run_block(card, run, first_asset):
    title, pill, job, asset, why, note = run
    rc = receipt(job)
    a = asset or first_asset
    before = img(f'assets/{a}/before.png') if a else None
    after = img(f'assets/{asset}/after.png') if asset and pill == 'ok' else None
    top = img(f'assets/{asset}/after-top.png') if asset and pill == 'ok' else None
    toph = f'<details class="top"><summary>Top view</summary><img src="{top}" alt="top view"></details>' if top else ''
    label = '<span class="pill ok">Program written and simulated</span>' if pill == 'ok' else \
        '<span class="pill fail">' + ('Did not finish' if rc['refusal'] and rc['refusal'][0] == 'timeout' else 'Refused') + '</span>'
    proxy = '<span class="pill cant">Proxy</span> ' if title.startswith('Proxy') else ''
    no_after = 'No part: ' + ('the run did not finish.' if rc['refusal'] and rc['refusal'][0] == 'timeout' else 'the job was refused.')
    h = [f'<div class="run"><h4 class="run-title">{E(title)}</h4><div class="run-head">{proxy}{label}</div><div class="frames">',
         frame('Before · raw blank', before, 'The raw blank'),
         frame('After · our program, swept', after, no_after if not after else 'the part', toph) if after else frame('After · our program, swept', None, no_after),
         intended_fig(card), '</div>']
    if rc['refusal']:
        h.append(f'<blockquote class="refusal"><span class="code">{E(rc["refusal"][0])}</span>{E(rc["refusal"][1])}</blockquote>')
    facts = []
    if rc['time']: facts.append(('Predicted time', rc['time']))
    if rc['removed']: facts.append(('Removed (app)', f'{rc["removed"]:.0f} mm³'))
    facts.append(('Job file', f'{job}.json'))
    h.append('<dl class="facts">' + ''.join(f'<div><dt>{E(k)}</dt><dd>{E(str(v))}</dd></div>' for k, v in facts) + '</dl>')
    if note:
        h.append(f'<p class="notes">{E(note)}</p>')
    h.append('</div>')
    return ''.join(h)


def card_html(c):
    cls, word = PILL[c['verdict']]
    s = c['src']
    issues = ' '.join(f'<a href="{ISS}{n}" target="_blank" rel="noopener">#{n}</a>' for n in c['issues'])
    h = [f'<article class="job" id="{c["id"]}"><header class="job-head"><p class="eyebrow">{E(c["eyebrow"])}</p>',
         f'<h3>{E(c["title"])}</h3>',
         f'<p class="src">Source: <a href="{E(s[0])}" target="_blank" rel="noopener">{E(s[1])}</a> · {E(s[2])}</p></header>',
         f'<div class="verdict"><span class="pill {cls}">{word}</span> <span>{E(c["sentence"])}</span></div>']
    if issues:
        h.append(f'<p class="src">Filed: {issues}</p>')
    if c.get('geometry'):
        h.append(f'<p class="notes"><b>What was modelled.</b> {E(c["geometry"])}</p>')
    first = next((r[3] for r in c['runs'] if r[3]), None)
    if c['runs']:
        for r in c['runs']:
            h.append(run_block(c, r, first))
    else:
        h.append('<div class="run"><div class="frames">' + frame('Before', None, 'Nothing to run: the job cannot be described.')
                 + frame('After', None, 'No part.') + intended_fig(c) + '</div></div>')
    h.append('</article>')
    return ''.join(h)


def main():
    head = open('page-head.html').read()
    head = head.replace('</style>', '.verdict{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;font-size:15px}\n'
                        '.verdict span:last-child{flex:1 1 30ch}\n</style>')
    counts = {k: sum(1 for c in CARDS if c['verdict'] == k) for k in PILL}
    rows = ''.join(f'<tr><td><a href="#{c["id"]}">{E(c["title"])}</a></td><td><span class="pill {PILL[c["verdict"]][0]}">{PILL[c["verdict"]][1]}</span></td>'
                   f'<td>{" ".join(f"#{n}" for n in c["issues"]) or "—"}</td></tr>' for c in CARDS)
    chips = ''.join(f'<li><span class="pill {PILL[k][0]}">{PILL[k][1]}</span><b>{counts[k]}</b></li>' for k in PILL)
    body = f'''<div class="wrap">
  <header>
    <h1>Z1 demo jobs, cut for real</h1>
    <p class="lede">18 typical jobs for the Makera Z1 and similar desktop mills. Each one now models the part in the maker’s photo — its text, its layout, its relief — and runs through Case Maker’s own generate-and-simulate path. Every card was checked by eye against the photo.</p>
    <p class="meta">Case Maker main ce5fdbc3 · command line <code>casemaker cut</code> · run 2026-10-28 · no machine was used</p>
  </header>
  <section>
    <h2>The honest count</h2>
    <div class="panel"><ul class="chips">{chips}</ul>
      <p class="lede" style="margin-top:12px"><b>Yesterday’s page overstated success.</b> It counted a job as a success when the app wrote a program that passed its own simulation, and most of its inputs were stand-ins that did not resemble the parts — a ripple dish for the wolf, a smiley for the portrait, two pockets for a 23-pocket tray. Two of its pictures were also wrong for a reason of ours: the sweep drew a 1 mm ball as 3.175 mm.</p>
      <p class="lede">Today one job matches its photo and two partly do. Thirteen fail: seven because a material Makera cuts gets no feeds, two because the program the app writes fails its own simulation, two because the app cannot describe the job, and two because it plans the V-bit wrongly or cannot make an inlay’s plug. On a plastic stand-in for the refused material, the Top Clamp, the sign and the wrench plate come out right, and the coin and the keychain outline partly.</p></div>
    <div class="panel tablewrap"><table><thead><tr><th>Job</th><th>Verdict</th><th>Issues</th></tr></thead><tbody>{rows}</tbody></table></div>
  </section>
  <section class="panel how">
    <h2>How to read a card</h2>
    <p><b>Verdict</b> is for the job as the maker did it, in their material. A run marked <span class="pill cant">Proxy</span> changes one thing, said in its title — usually plastic in place of a metal the app refuses — and is there to show whether the shape itself comes out.</p>
    <p><b>After</b> is an independent sweep of the program Case Maker wrote: every move, with the cutter’s real cutting shape, on a 0.1 mm grid or finer. The command line cannot export the app’s own simulation picture. The removed volume agrees with the app’s figure to within about 2% on flat and ball cutters; on V-bits the app removes 20–60% more, which is part of issue #741.</p>
    <p><b>Intended</b> photos belong to their authors and are shown for internal reference, each linked to its source. Where a source’s own file is not public, the card names the input used instead.</p>
  </section>
  <section>
    <h2>The jobs</h2>
    {''.join(card_html(c) for c in CARDS)}
  </section>
  <footer>Job files, the manifest and a README are in docs/bench/2026-10-28-z1-real-jobs/ on main. Inputs downloaded for this run are not committed: the wolf model (CC BY-NC-ND 4.0, used unmodified in the repository and scaled only on this machine), the portrait (public domain) and the helmet artwork (OpenMoji, CC BY-SA 4.0). Wood was stated as PLA, since this shop does not cut wood.</footer>
</div>'''
    open('z1-demo-jobs.html', 'w').write(head + body)
    man = [{'id': c['id'], 'title': c['title'], 'source': {'url': c['src'][0], 'title': c['src'][1], 'credit': c['src'][2]},
            'verdict': PILL[c['verdict']][1], 'sentence': c['sentence'], 'issues': c['issues'], 'modelled': c.get('geometry'),
            'runs': [{'title': r[0], 'job': f'jobs/{r[2]}.json', 'result': 'simulated' if r[1] == 'ok' else 'refused-or-timeout',
                      'refusal': (receipt(r[2])['refusal'] or [None, None])[1], 'predictedTime': receipt(r[2])['time'],
                      'removedMm3App': receipt(r[2])['removed'], 'note': r[5]} for r in c['runs']]} for c in CARDS]
    json.dump({'run': '2026-10-28', 'main': 'ce5fdbc3', 'counts': {PILL[k][1]: v for k, v in counts.items()}, 'jobs': man},
              open('manifest.json', 'w'), indent=1, ensure_ascii=False)
    print(counts, os.path.getsize('z1-demo-jobs.html'))


main()
