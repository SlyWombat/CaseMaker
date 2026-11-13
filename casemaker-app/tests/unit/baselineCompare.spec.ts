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
      { part: 'part-a', verdict: 'match', wall: 190 },
    ];
    const after: RefFacts[] = [
      { part: 'tray70', verdict: 'match', wall: 800 },
      { part: 'part-a', verdict: 'match', wall: 180 },
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
        part: 'part-a',
        makera: { pct: 0.5, floorMm: 0.1, afterAllowances: true, maxMm: 0.3 },
        before: { pct: 0, floorMm: 0.1, afterAllowances: true },
        after: { pct: 0.22, floorMm: 0.01, afterAllowances: false },
      },
    ];
    const rows = cutIntoRows(parts, { floorMm: 0.1, afterAllowances: true });
    expect(rows).toHaveLength(1);
    const [part, makera, before, after, change] = rows[0]!;
    expect(part).toBe('part-a');
    expect(makera).toContain('0.5 %');
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

  it('10. a section the after folder never ran is said so, not shown as zeros and removals', () => {
    const doc = buildComparison({
      before: { sha: 'a'.repeat(40), tag: 'v0.2', harnessPatches: [] },
      after: { sha: 'b'.repeat(40), tag: null, harnessPatches: [] },
      headline: { before: head(8005, 100), after: head(8005, 100) },
      references: { before: [{ part: 'part-a', verdict: 'match' }], after: [] },
      cutInto: [],
      samples: { before: [{ id: 's', status: 'pass/pass/pass' }], after: [] },
      cards: { before: [{ id: 'j01', status: 'match' }], after: [] },
      programs: [{ group: 'reference part-a', rows: programRows({ 'p1.nc': 'x' }, {}) }],
      pictures: [{ label: 'part-a', beforeRel: 'pictures/b.png', afterRel: null }],
    });
    expect(doc).toContain('the after folder holds none');
    expect(doc).toContain('Programs exist in the before folder only');
    expect(doc).toContain('no picture in this run');
    expect(doc).not.toMatch(/\| fail \| 1 \| 0 \|/);
  });

  it('11. repeats print min / median and the change is median against median; one run says so', () => {
    const mk = (walls: number[] | undefined, wall: number): HeadlineInput => ({ tray: { 'app-top': { wall, walls } }, suites: {} });
    const rows = headlineRows(mk(undefined, 79.2), mk([83.4, 76.3, 76.8], 83.4));
    const row = rows.find((r) => r.label === 'app-top: Generate wall (s)')!;
    expect(row.before).toBe('79.2 (one run)');
    expect(row.after).toBe('min 76.3 / median 76.8 (3 runs)');
    // 79.2 → 76.8 is −3.0 %: inside the noise, so not a change
    expect(row.change).toContain('within noise');
    const both = headlineRows(mk([79.2, 77.0, 76.2], 79.2), mk([100, 101, 99], 100)).find((r) => r.label === 'app-top: Generate wall (s)')!;
    expect(both.before).toBe('min 76.2 / median 77.0 (3 runs)');
    expect(both.change).toContain('+29.9 %');
  });

  it('12. a run whose load went above the guard at any point is named busy in the header', () => {
    const base = { sha: 'a'.repeat(40), tag: null, harnessPatches: [] as string[] };
    const doc = buildComparison({
      before: { ...base, busyRuns: undefined },
      after: { ...base, sha: 'b'.repeat(40), busyRuns: ['tray-timed_2'] },
      headline: { before: head(1), after: head(1) },
      references: { before: [], after: [] },
      cutInto: [],
      samples: { before: [], after: [] },
      cards: { before: [], after: [] },
      programs: [],
      pictures: [],
    });
    expect(doc).toContain('load not recorded');
    expect(doc).toContain('BUSY: tray-timed_2');
  });

  it('13. a refused tray run prints its refusal, never its 2.8 s wall or its memory as a result', () => {
    const before: HeadlineInput = { tray: { 'app-top': { wall: 76.4, walls: [76.4], peakRssMiB: 3603 } }, suites: {} };
    const after: HeadlineInput = {
      tray: { 'app-top': { wall: 2.8, walls: [2.8, 2.7], peakRssMiB: 554, refused: 'refused at cam: could not be cloned' } },
      suites: {},
    };
    const rows = headlineRows(before, after);
    const wall = rows.find((r) => r.label === 'app-top: Generate wall (s)')!;
    expect(wall.after).toContain('refused at cam');
    expect(wall.after).not.toContain('2.8');
    expect(wall.change).toBe('—');
    const mem = rows.find((r) => r.label === 'app-top: peak memory (MiB)')!;
    expect(mem.after).toContain('refused at cam');
    expect(mem.change).toBe('—');
  });
});
