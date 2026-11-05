"""A page section for a CANDIDATE engine sha (#955): the tray and organizer seven-line cards with
the rebuilt engine's own stored acceptance facts beside the old engine (main) and Makera's NC.

Nothing here re-runs the app: the candidate column is the acceptance run's posted facts
(`ours/<sha>/<part>-posted-facts.json`), the old-engine column is the page's manifest card for the
same part, and the vendor column is that card's vendor goal check. The sha is stated as a
candidate — it is not on main.

usage: python candidate_section.py <page-manifest.json> <ours-dir> <candidate-sha> <label> <out.html>
"""
import json
import os
import sys

PILL = ('<span class="pill gap" style="background:#8a6d1c">Candidate</span>')  # the page's own pill


def load(path):
    try:
        return json.load(open(path))
    except (OSError, ValueError):
        return None


def pct(x, d=2):
    return '—' if x is None else f'{x * 100:.{d}f} %'


def num(x, d=1):
    return '—' if x is None else f'{x:.{d}f}'


def vendor_cells(card):
    v = (card or {}).get('vendor') or {}
    g = v.get('numbers') or {}
    st = v.get('stats') or {}
    if not g:
        return ['not scored'] * 7
    tools = ((g.get('programs') or [{}])[0].get('tools') or [])
    secs = (g.get('programs') or [{}])[0].get('vendorSeconds')
    return [
        f"{100 - g['leftover0p1Pct']:.2f} %" if 'leftover0p1Pct' in g else '—',
        f"{g.get('cutInto0p1Pct', 0):.2f} % · max {g.get('maxCutIntoMm', 0):.3f} mm",
        f"{secs / 60:.1f} min (its NC header)" if secs else '—',
        pct(st.get('airFraction')),
        num(st.get('rapidsPer1k')),
        str(len(tools)),
        'yes — its own stock and holding',
    ]


def old_cells(card):
    if not card:
        return ['—'] * 7
    if str(card.get('verdict')) == 'refused':
        return ['refused — no program to score'] * 7
    n = card.get('numbers') or {}
    o = card.get('ours') or {}
    return [
        f"{n['coveragePct']:.2f} %" if 'coveragePct' in n else '—',
        f"{n.get('cutIntoPct', 0):.2f} % · max {n.get('maxCutIntoMm', 0):.3f} mm",
        f"{o['cycleSeconds'] / 3600:.1f} h" if o.get('cycleSeconds') else (card.get('time') or '—'),
        pct(o.get('airFraction')),
        num(o.get('rapidsPer1k')),
        str(o.get('cutters') or '—'),
        'yes' if card.get('verdict') in ('match', 'deviates') else '—',
    ]


def new_cells(facts):
    if not facts:
        return ['no stored facts'] * 7
    ci = facts.get('cutInto') or {}
    cut = ci.get('adjudicatedFraction') or 0
    at = ci.get('maxAt')
    where = f" at ({at['x']:.1f}, {at['y']:.1f})" if at else ''
    lines = {l['key']: l for l in facts.get('sevenLines', {}).get('lines', [])}
    return [
        pct(facts.get('coverage')),
        f"{cut * 100:.2f} % adjudicated · raw max {ci.get('maxMm') or 0:.3f} mm{where}",
        f"{facts['cycleSeconds'] / 60:.1f} min",
        pct(facts.get('airFraction')),
        num(facts.get('rapidsPer1000FeedLines')),
        str(len(facts.get('cutters') or [])),
        lines.get('postsAsFiled', {}).get('ours', 'yes'),
    ]


def article(card, facts, part, title, sha, label, idx):
    v = vendor_cells(card)
    o = old_cells(card)
    n = new_cells(facts)
    rows = [
        ('coverage, top surface', v[0], o[0], n[0]),
        ('cut-into (0.1 mm floor)', v[1], o[1], n[1]),
        ('cycle time', v[2], o[2], n[2]),
        ('air fraction', v[3], o[3], n[3]),
        ('rapids per 1,000 feed moves', v[4], o[4], n[4]),
        ('cutters', v[5], o[5], n[5]),
        ('posts as filed', v[6], o[6], n[6]),
    ]
    body = ''.join(f'<tr><td>{k}</td><td>{a}</td><td>{b}</td><td>{c}</td></tr>' for k, a, b, c in rows)
    unreach = (facts or {}).get('unreachable') or []
    notes = (facts or {}).get('notes') or []
    extra = ''
    if unreach:
        extra += f'<p class="notes">{len(unreach)} pocket(s) not cut: {unreach[0]}' + (f' (+{len(unreach) - 1} more)' if len(unreach) > 1 else '') + '</p>'
    for m in notes[:3]:
        extra += f'<p class="notes">{m}</p>'
    if len(notes) > 3:
        extra += f'<p class="notes">… and {len(notes) - 3} more stated notes (the run\'s own facts).</p>'
    return f'''<article class="job" id="{part}-cand">
  <div class="job-head">
    <p class="eyebrow">candidate engine · {label} · not on main · the old engine beside it and Makera Studio’s own NC</p>
    <h2>{title} — {label} @ {sha[:8]} beside the old engine and Makera’s</h2>
    <p class="src">{part}-cand · source: the acceptance run’s stored outputs (ours/{sha[:8]}/{part}-posted-facts.json)</p>
  </div>
  <p>{PILL} <span class="notes">The candidate column is the acceptance run’s own posted facts at {sha[:8]}; the old-engine column is this page’s card at the stated app sha; the vendor column is Makera’s NC on the same goal surface.</span></p>
  <div class="tablewrap"><table>
    <tr><th>line</th><th>Makera Studio</th><th>Old engine (main)</th><th>{label} @ {sha[:8]} (candidate)</th></tr>
    {body}
  </table></div>
  {extra}
</article>'''


def main():
    manifest, ours_dir, sha, label, out = sys.argv[1:6]
    m = load(manifest) or {}
    cards = {c['id']: c for c in (m.get('cards') or [])}
    parts = [
        ('tray', 'ref-tray70', 'Tool tray 70 mm, top side'),
        ('organizer', 'ref-organizer', 'Makera tool organizer, top side'),
    ]
    html = ''.join(
        article(cards.get(cid), load(os.path.join(ours_dir, f'{part}-posted-facts.json')),
                part, title, sha, label, i)
        for i, (part, cid, title) in enumerate(parts))
    open(out, 'w').write(html)
    print(f'{out}: {len(html)} bytes')


if __name__ == '__main__':
    main()
