"""Pinned self-tests for the per-card time limits (limits.py, #1257). Stdlib only.

    python3 test_limits.py        (vitest runs it too: casemaker-app/tests/unit/demoCardLimits1257.spec.ts)

The figures are made up; no vendor number is used.
"""
import hashlib
import json
import os
import sys
import tempfile
import textwrap

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import limits  # noqa: E402


def test_limits_per_card():
    a = limits.card_limit(3400.0)          # a card whose own reference is 3,400 s
    assert a['limitSeconds'] == 5100.0 and a['source'] == 'reference' and a['referenceSeconds'] == 3400.0
    assert a['margin'] == 1.5 and a['floor'] == 600
    b = limits.card_limit(40.0)            # a quick card is not killed by a slow start: the floor
    assert b['limitSeconds'] == 600 and b['source'] == 'reference'
    c = limits.card_limit(None)            # no reference: the old fixed limit, and it is listed
    assert c['limitSeconds'] == 3600 and c['source'] == 'no-reference' and c['referenceSeconds'] is None
    assert limits.no_reference_cards({'a': 3400.0}, ['a', 'b']) == ['b']


def test_derive_and_table_is_never_rewritten_by_a_run():
    with tempfile.TemporaryDirectory() as d:
        base = os.path.join(d, 'baseline')
        for cid, secs in (('j01', 81.7), ('j29', 3396.6)):
            os.makedirs(os.path.join(base, 'demo', 'runs', 'abc123', cid))
            json.dump({'computeSeconds': secs, 'verdict': 'match'}, open(os.path.join(base, 'demo', 'runs', 'abc123', cid, 'card.json'), 'w'))
        os.makedirs(os.path.join(base, 'demo', 'runs', 'abc123', 'jerr'))
        json.dump({'verdict': 'error'}, open(os.path.join(base, 'demo', 'runs', 'abc123', 'jerr', 'card.json'), 'w'))
        table_path = os.path.join(d, 'limits.json')
        limits.write_table(table_path, 'v-test', base, limits.derive_reference_seconds(base))
        table = limits.load_table(table_path)
        assert table['baseline']['name'] == 'v-test' and table['cards'] == {'j01': 81.7, 'j29': 3396.6}   # an error card has no reference
        assert table['margin'] == 1.5 and table['floor'] == 600
        before = hashlib.sha256(open(table_path, 'rb').read()).hexdigest()
        # what a normal run does with the table: read it and state each card's limit; it never writes
        for cid in ('j01', 'j29', 'jerr'):
            limits.card_limit(table['cards'].get(cid))
        assert hashlib.sha256(open(table_path, 'rb').read()).hexdigest() == before
        src = open(os.path.join(HERE, 'build.py')).read()
        assert 'write_table' not in src, 'build.py must not write the limits table; only derive_limits.py does'


def test_over_limit_records_both_numbers_and_the_last_phase():
    with tempfile.TemporaryDirectory() as d:
        trace = os.path.join(d, 'trace.jsonl')
        # a fake card: writes a few phase marks, then sleeps far past a 2 s limit
        script = textwrap.dedent('''
            import json, os, sys, time
            f = open(os.environ["CASEMAKER_MEM_TRACE"], "a")
            for t, stage in ((10, "pipeline:start"), (120, "goal-field"), (900, "plan:start"), (1500, "rank:start"), (4200, "rank:end"), (4300, "chain:start")):
                f.write(json.dumps({"t": t, "stage": stage}) + "\\n"); f.flush()
            f.write('{"t": 5000, "stage": "chain:st')   # a line cut off by the kill
            f.flush(); time.sleep(60)
        ''')
        r = limits.run_limited([sys.executable, '-c', script], cwd=d, limit_seconds=2, trace_path=trace)
        assert r['timeout'] is True and r['exit'] == 124 and r['wall'] < 30
        rec = limits.over_limit_record(2, r['wall'], r['reached'])
        assert rec['outcome'] == 'over-limit' and rec['limitSeconds'] == 2 and rec['elapsedSeconds'] == r['wall']
        assert rec['reached'] == {'phase': 'chain', 'tMs': 4300, 'stage': 'chain:start'}
        s = limits.over_limit_sentence(rec)
        assert 'over limit after' in s and 'limit 2 s' in s and 'reached: chain' in s
        # a card that finishes inside its limit has no reach to report
        ok = limits.run_limited([sys.executable, '-c', 'print(1)'], cwd=d, limit_seconds=30, trace_path=os.path.join(d, 't2.jsonl'))
        assert ok['timeout'] is False and ok['exit'] == 0 and ok['reached'] is None


def test_a_card_that_asks_the_tab_question_is_its_own_outcome_and_is_never_answered():
    import build
    asked = [{'code': 'stopped', 'reason': 'stopped at cam'},
             {'code': 'tab-choice-needed', 'reason': "This part can't be held within both of the shop's tab rules. Choose one: --tab-choice inside-margin"}]
    q = limits.tab_choice_question(asked)
    assert q is not None and q.startswith("This part can't be held") and 'inside-margin' in q
    assert limits.needs_choice_record(q) == {'outcome': 'needs-choice', 'question': q}
    # an ordinary refusal, a stage error and no refusals at all are not the question
    assert limits.tab_choice_question([{'code': 'stage-error', 'reason': 'boom'}]) is None
    assert limits.tab_choice_question([]) is None and limits.tab_choice_question(None) is None
    # the receipt reader keeps it among the real refusals (only `stopped` and `nothing-written` are dropped)
    with tempfile.TemporaryDirectory() as d:
        json.dump({'ok': False, 'stage': 'cam', 'refusals': asked}, open(os.path.join(d, 'receipt.json'), 'w'))
        rc = build.load_receipt(d)
        assert limits.tab_choice_question(rc['refusals']) == q
    # it has its own pill, and the builder records the question without ever passing an answer
    assert build.PILL['needs-choice'][1] == "Needs the operator's choice"
    src = open(os.path.join(HERE, 'build.py')).read()
    assert "'--tab-choice'" not in src and '"--tab-choice"' not in src, 'the builder never answers the question'


def test_last_phase_maps_stages_and_says_when_there_is_no_trace():
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, 't.jsonl')
        assert limits.last_phase(os.path.join(d, 'absent.jsonl')) is None      # the builder could not trace this card
        open(p, 'w').write('{"t": 5, "stage": "plan:start"}\n{"t": 90, "stage": "sweep:checkpoint"}\n')
        assert limits.last_phase(p) == {'phase': 'check', 'tMs': 90, 'stage': 'sweep:checkpoint'}


def test_build_says_so_when_there_is_no_reference_data_and_records_the_file_when_there_is():
    import build
    assert build.init_references('') == 0 and build.REF_CARDS == [] and build.REFERENCES_FILE is None
    note = build.references_notice('', 0)
    assert '--references not given' in note and 'NOT in this build' in note and 'nothing is scored' in note
    with tempfile.TemporaryDirectory() as d:
        data = os.path.join(d, 'data.py')
        open(data, 'w').write("REFS = [dict(id='ref-x', slug='x')]\nCARDS = [dict(id='ref-x', title='t', job='j.json', kind='goal', input='local', material='m', vendor='ref-x', source='s')]\n")
        assert build.init_references(data) == 1
        assert build.REFERENCES_FILE['sha256'] == hashlib.sha256(open(data, 'rb').read()).hexdigest() and build.REF_BY_ID['ref-x']['slug'] == 'x'
        assert 'loaded (1 reference cards' in build.references_notice(data, 1)
    build.init_references('')   # leave the module as it was found


if __name__ == '__main__':
    for name, fn in sorted(globals().items()):
        if name.startswith('test_') and callable(fn):
            fn()
            print('ok', name)
