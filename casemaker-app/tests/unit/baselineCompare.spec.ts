/**
 * #1233 — THE BASELINE COMPARISON'S PURE TABLES (tools/baseline/compareTables.ts), on hand-made
 * inputs: objects, not folders. The six cases are the issue's step 3; the rest pin the document's
 * order and the suite-log readers the folders depend on.
 */
import { describe, expect, it } from 'vitest';
import {
  NOISE_PCT,
  buildComparison,
  changeText,
  cutIntoRows,
  headlineRows,
  parseCargoLog,
  parseE2eLog,
  parseVitestLog,
  programRows,
  referenceRows,
  statusTables,
  type CutPart,
  type HeadlineInput,
  type RefFacts,
} from '../../tools/baseline/compareTables';

const head = (owned: number | null, wall: number | null = null): HeadlineInput => ({
  tray: { 'plain-top': { owned, wall } },
  suites: {},
});

describe('#1233 baseline comparison tables', () => {
  it('1. the headline cycle row for 8005 → 6597 prints −1408 and −17.6 %', () => {
    const row = headlineRows(head(8005), head(6597)).find((r) => r.label === 'plain-top: cycle, owned (s)');
    expect(row).toBeDefined();
    expect(row!.before).toBe('8005');
    expect(row!.after).toBe('6597');
    expect(row!.change).toContain('−1408');
    expect(row!.change).toContain('−17.6 %');
  });

  it('2. a Generate wall of 100 → 103 is within noise; 100 → 120 prints +20.0 %', () => {
    expect(NOISE_PCT).toBe(5);
    const near = headlineRows(head(1, 100), head(1, 103)).find((r) => r.label === 'plain-top: Generate wall (s)')!;
    expect(near.change).toContain('within noise');
    const far = headlineRows(head(1, 100), head(1, 120)).find((r) => r.label === 'plain-top: Generate wall (s)')!;
    expect(far.change).toContain('+20.0 %');
    expect(far.change).not.toContain('within noise');
    // the noise rule is the wall's alone: a cycle that moves 3 % is a change, not noise
    expect(changeText(100, 103, { noise: false })).not.toContain('within noise');
  });

  it('3. a part refused before and matched after is a highlighted row with its reason', () => {
    const before: RefFacts[] = [
      { part: 'tray70', verdict: 'refused', reason: 'the shank reaches into the vise jaw', wall: 929 },
      { part: 'organizer', verdict: 'match', wall: 1936 },
    ];
    const after: RefFacts[] = [
      { part: 'tray70', verdict: 'match', wall: 800 },
      { part: 'organizer', verdict: 'match', wall: 1900 },
    ];
    const t = referenceRows(before, after);
    expect(t.rows).toHaveLength(2);
    expect(t.highlighted).toHaveLength(1);
    expect(t.highlighted[0]!.part).toBe('tray70');
    expect(t.highlighted[0]!.text).toContain('refused');
    expect(t.highlighted[0]!.text).toContain('the shank reaches into the vise jaw');
  });

  it('4. a figure missing after prints —, never 0', () => {
    expect(changeText(8005, null)).toBe('—');
    expect(changeText(null, 5)).toBe('—');
    const row = headlineRows(head(8005), head(null)).find((r) => r.label === 'plain-top: cycle, owned (s)')!;
    expect(row.after).toBe('—');
    expect(row.change).toBe('—');
  });

  it('5. the cut-into table never pairs figures recorded at different floors', () => {
    const parts: CutPart[] = [
      {
        part: 'organizer',
        makera: { pct: 0.09, floorMm: 0.1, afterAllowances: true, maxMm: 0.141 },
        before: { pct: 0, floorMm: 0.1, afterAllowances: true },
        after: { pct: 0.22, floorMm: 0.01, afterAllowances: false },
      },
    ];
    const rows = cutIntoRows(parts, { floorMm: 0.1, afterAllowances: true });
    expect(rows).toHaveLength(1);
    const [part, makera, before, after, change] = rows[0]!;
    expect(part).toBe('organizer');
    expect(makera).toContain('0.09 %');
    expect(before).toBe('0 %');
    expect(after).toBe('not recorded at this floor');
    expect(change).toBe('—');
    // the same data read at the other floor flips which side is missing
    const raw = cutIntoRows(parts, { floorMm: 0.01, afterAllowances: false })[0]!;
    expect(raw[1]).toBe('not recorded at this floor');
    expect(raw[2]).toBe('not recorded at this floor');
    expect(raw[3]).toBe('0.22 %');
  });

  it('6. the program table marks identical, changed, added and removed files from two md5 lists', () => {
    const rows = programRows(
      { 'p1.nc': 'aaa', 'p2.nc': 'bbb', 'p3.nc': 'ccc' },
      { 'p1.nc': 'aaa', 'p2.nc': 'ddd', 'p4.nc': 'eee' },
    );
    const by = Object.fromEntries(rows.map((r) => [r.name, r.status]));
    expect(by).toEqual({ 'p1.nc': 'identical', 'p2.nc': 'changed', 'p3.nc': 'removed', 'p4.nc': 'added' });
  });

  it('7. status tables list the changed items by name, count each status, and rank wall changes', () => {
    const t = statusTables(
      [
        { id: 'a', status: 'pass', seconds: 10 },
        { id: 'b', status: 'pass', seconds: 100 },
        { id: 'c', status: 'fail', seconds: 5 },
      ],
      [
        { id: 'a', status: 'pass', seconds: 11 },
        { id: 'b', status: 'fail', seconds: 40 },
        { id: 'c', status: 'fail', seconds: 5 },
      ],
    );
    expect(t.counts).toEqual([
      ['fail', '1', '2'],
      ['pass', '2', '1'],
    ]);
    expect(t.changed).toEqual([['b', 'pass', 'fail']]);
    expect(t.largest[0]![0]).toBe('b');
    expect(t.largest[0]![3]).toContain('−60');
  });

  it('8. the suite readers take the counts out of the raw logs', () => {
    expect(
      parseVitestLog(' Test Files  1 failed | 1046 passed | 6 skipped (1053)\n      Tests  1 failed | 12086 passed | 12 expected fail | 62 skipped (12161)\nwall_seconds=525'),
    ).toEqual({ passed: 12086, failed: 1, skipped: 62, wall: 525 });
    expect(parseCargoLog('test result: ok. 293 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 9.45s\nCARGO_RC=0 CARGO_SECONDS=52')).toEqual({
      passed: 293,
      failed: 0,
      skipped: 1,
      wall: 52,
    });
    expect(parseE2eLog('  9 failed\n  6 skipped\n  283 passed (9.6m)\ne2e_rc=1 seconds=575')).toEqual({
      passed: 283,
      failed: 9,
      skipped: 6,
      wall: 575,
    });
  });

  it('9. the document names its sections in the issue’s order', () => {
    const doc = buildComparison({
      before: { sha: 'c2dd27afa0cab74377f49cb4894af048993bd0cb', tag: 'v0.2', startedAt: '2026-11-11T14:00Z', machine: 'kdocker3', harnessPatches: ['mesh flag'] },
      after: { sha: '1111111111111111111111111111111111111111', tag: null, startedAt: '2026-11-12T10:00Z', machine: 'kdocker3', harnessPatches: [] },
      headline: { before: head(8005, 100), after: head(6597, 120) },
      references: { before: [], after: [] },
      cutInto: [],
      samples: { before: [], after: [] },
      cards: { before: [], after: [] },
      programs: [],
      pictures: [],
    });
    const order = ['## 1. Header', '## 2. Headline', '## 3. Reference parts against Makera', '## 4. Cut-into, like for like', '## 5. Samples', '## 6. Demo cards', '## 7. Programs', '## 8. Pictures'];
    const at = order.map((h) => doc.indexOf(h));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((x, y) => x - y)).toEqual(at);
    expect(doc).toContain('c2dd27afa');
    expect(doc).toContain('mesh flag');
  });
});
