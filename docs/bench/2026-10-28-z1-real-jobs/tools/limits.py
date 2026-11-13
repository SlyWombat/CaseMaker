"""Per-card time limits for the demo build (#1257). Stdlib only.

A fixed limit for every card (3,600 s) sat 6 % above the slowest card's normal time, so that card flipped between a
verdict and "not run" on machine noise alone. A limit is there to catch a hang or a runaway; it must sit well clear of a
card's ordinary variation. So each card's limit comes from that card's OWN measured time in a NAMED baseline, and the
table of those times is re-derived only by a deliberate command (derive_limits.py), never by a run.
"""
import json
import os
import signal
import subprocess
import time

# A card may take this many times its own reference seconds before it counts as over limit: room for a slower or busier
# box and for the trace's own cost, while a hang or a plan that costs 2x still trips it.
LIMIT_MARGIN = 1.5
# No limit is below this many seconds, so a card that takes 40 s is not killed by a slow start (the toolchain's cold load).
LIMIT_FLOOR_S = 600
# A card with no reference time keeps the old fixed limit and is listed as "no reference", so the gap is visible.
LIMIT_DEFAULT_S = 3600


def card_limit(reference_seconds, margin=LIMIT_MARGIN, floor=LIMIT_FLOOR_S, default=LIMIT_DEFAULT_S):
    """The limit record for one card: limitSeconds, and what it was derived from (stated on the card and in the manifest)."""
    if not isinstance(reference_seconds, (int, float)) or isinstance(reference_seconds, bool) or reference_seconds <= 0:
        return {'limitSeconds': default, 'referenceSeconds': None, 'margin': None, 'floor': None, 'source': 'no-reference'}
    return {'limitSeconds': round(max(floor, margin * reference_seconds), 1), 'referenceSeconds': reference_seconds,
            'margin': margin, 'floor': floor, 'source': 'reference'}


def no_reference_cards(table_cards, card_ids):
    """The cards of this run that the table has no reference time for (they get the default limit and are listed)."""
    return [c for c in card_ids if not isinstance(table_cards.get(c), (int, float)) or table_cards.get(c) <= 0]


def derive_reference_seconds(baseline_dir):
    """card id -> compute seconds, read from a baseline folder's saved card.json files (demo/runs/**, the j28/j29 rerun).
    A card with no computeSeconds (an error, a card that was not run) has no reference."""
    out = {}
    for root in (os.path.join(baseline_dir, 'demo', 'runs'), os.path.join(baseline_dir, 'demo', 'rerun-j28-j29', 'runs'),
                 os.path.join(baseline_dir, 'demo-j28-j29', 'runs')):
        if not os.path.isdir(root):
            continue
        for a in sorted(os.listdir(root)):
            cands = [os.path.join(root, a)] + [os.path.join(root, a, b) for b in sorted(os.listdir(os.path.join(root, a))) if os.path.isdir(os.path.join(root, a, b))]
            for d in cands:
                p = os.path.join(d, 'card.json')
                if not os.path.isfile(p):
                    continue
                try:
                    card = json.load(open(p))
                except ValueError:
                    continue
                secs = card.get('computeSeconds')
                if isinstance(secs, (int, float)) and card.get('verdict') not in ('error', 'over-limit') and secs > 0:
                    out[os.path.basename(d)] = secs
    return out


def write_table(path, baseline_name, baseline_dir, cards, margin=LIMIT_MARGIN, floor=LIMIT_FLOOR_S):
    """Write the reference table. ONLY derive_limits.py calls this: a run never rewrites its own limits."""
    doc = {'baseline': {'name': baseline_name, 'folder': os.path.abspath(baseline_dir)}, 'margin': margin, 'floor': floor,
           'derivedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'cards': dict(sorted(cards.items()))}
    with open(path, 'w') as f:
        json.dump(doc, f, indent=1)
        f.write('\n')
    return doc


def load_table(path):
    return json.load(open(path))


# ---- how far a card got ---------------------------------------------------------------------------------------------
# The CLI's --mem-trace / CASEMAKER_MEM_TRACE file: one JSON object per line, {"t": ms, "stage": "plan:start", ...}.
# The stages group into the four phases a reader can act on.
def _phase_of(stage):
    if stage.startswith('sweep:'):
        return 'check'
    if stage.startswith('rank:'):
        return 'rank'
    if stage.startswith('chain:'):
        return 'chain'
    if stage in ('goal-field', 'pipeline:start'):
        return 'goal-field' if stage == 'goal-field' else 'start'
    return 'plan'


def last_phase(trace_path):
    """{'phase', 'tMs', 'stage'} of the last complete trace line, or None when there is no trace (the card could not be traced)."""
    try:
        lines = open(trace_path, errors='replace').read().split('\n')
    except OSError:
        return None
    for line in reversed(lines):
        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except ValueError:
            continue                      # a line cut off by the kill
        if isinstance(ev, dict) and 'stage' in ev:
            return {'phase': _phase_of(str(ev['stage'])), 'tMs': ev.get('t'), 'stage': str(ev['stage'])}
    return None


def run_limited(cmd, cwd, limit_seconds, trace_path, env=None):
    """Run one card's command with a wall-clock limit, traced (CASEMAKER_MEM_TRACE), killing the whole process group on a
    timeout. Returns exit, stdout, stderr, wall, timeout and — only when it timed out — `reached`, the last trace phase."""
    e = dict(os.environ if env is None else env)
    e['CASEMAKER_MEM_TRACE'] = trace_path
    try:
        os.remove(trace_path)
    except OSError:
        pass
    t0 = time.time()
    p = subprocess.Popen(cmd, cwd=cwd, env=e, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
    try:
        out, err = p.communicate(timeout=limit_seconds)
        return {'exit': p.returncode, 'stdout': out, 'stderr': err, 'wall': round(time.time() - t0, 1), 'timeout': False, 'reached': None}
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(p.pid), signal.SIGKILL)
        except ProcessLookupError:
            pass
        out, err = p.communicate()
        return {'exit': 124, 'stdout': out or '', 'stderr': err or '', 'wall': round(time.time() - t0, 1), 'timeout': True,
                'reached': last_phase(trace_path)}


def over_limit_record(limit_seconds, elapsed_seconds, reached):
    """A card over its limit is its own outcome (not an error): both numbers and how far it had got (None: no trace)."""
    return {'outcome': 'over-limit', 'limitSeconds': limit_seconds, 'elapsedSeconds': elapsed_seconds, 'reached': reached}


def over_limit_sentence(rec):
    r = rec.get('reached')
    where = f"reached: {r['phase']} at {round((r.get('tMs') or 0) / 1000)} s of the trace" if r else 'reached: not traced'
    return f"over limit after {round(rec['elapsedSeconds'])} s (limit {round(rec['limitSeconds'])} s; {where})"
