// Which registry entry a `.nc` header names (#316). Pure — no store, no wasm, no worker: the
// matcher is handed the list, which is the whole reason it left `simSetupStore`.

import { describe, it, expect } from 'vitest';
import { matchHeaderTool } from '@/engine/cnc/headerMatch';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';

const entry = (key: string, tool: Tool): ToolLibraryEntry => ({ key, tool, provenance: 'test' });

// Makera's own catalogue lists SIX 3.175 mm flat end mills that differ only in length (#316). Two
// of them are the whole point of this file, so they are spelled out as the registry would hold
// them: the built-in is the 12 mm cutter verbatim (`toolLibrary.ts`), and the 42 mm row is the
// catalogue's, under a `cat:` key.
const FLAT_12 = entry(
  'flat-3.175x12-metal',
  flatEndMill(3.175, { id: '112111313812', name: '3.175*12mm Flat End(Metal)', fluteLength: 12, shoulderLength: 12 }),
);
const CAT_12 = entry(
  'cat:112111313812',
  flatEndMill(3.175, { id: '112111313812', name: '3.175*12mm Flat End(Metal)', fluteLength: 12, shoulderLength: 12 }),
);
const CAT_42 = entry(
  'cat:111011313842',
  flatEndMill(3.175, { id: '111011313842', name: '3.175*42mm Flat End', fluteLength: 42, shoulderLength: 42 }),
);

/** The header's TOOL record, as `toolFromMkrRecord` hands it over: a `Tool` and nothing else. */
const header = (opts: Partial<Tool>): Tool => flatEndMill(3.175, opts);

describe('matchHeaderTool (#316)', () => {
  it('takes the 42 mm flat over the 12 mm one, on the lengths the file states', () => {
    // The bug: shape + diameter alone ties for all six, and "first hit wins" is the built-in.
    const m = matchHeaderTool(header({ id: null, fluteLength: 42, shoulderLength: 42 }), [FLAT_12, CAT_42]);
    expect(m).toEqual({ key: 'cat:111011313842', strength: 'exact', provenance: 'shape' });
  });

  it('takes it by the id too, when the file names the catalogue row and the lengths back it up', () => {
    const m = matchHeaderTool(
      header({ id: '111011313842', fluteLength: 42, shoulderLength: 42 }),
      [FLAT_12, CAT_42],
    );
    expect(m).toEqual({ key: 'cat:111011313842', strength: 'exact', provenance: 'id' });
  });

  it('is a SUGGESTION when the file names the 42 and only the 12 is in the registry', () => {
    // The wrong answer this issue is about, now labelled as one: the entry is named anyway, but
    // the panel can say the file states lengths it does not match.
    const m = matchHeaderTool(header({ id: null, fluteLength: 42, shoulderLength: 42 }), [FLAT_12]);
    expect(m).toEqual({ key: 'flat-3.175x12-metal', strength: 'suggested', provenance: 'shape' });
  });

  it('resolves the built-in / catalogue tie to the service’s row, and back for the built-in', () => {
    // #316's decision of 2026-10-09. Both rows carry the same g_ID and the same lengths, so the
    // only thing that separates them is which tier answered.
    const h = header({ id: '112111313812', fluteLength: 12, shoulderLength: 12 });
    expect(matchHeaderTool(h, [FLAT_12, CAT_12])).toEqual({ key: 'cat:112111313812', strength: 'exact', provenance: 'id' });
    // With no service there is no `cat:` row, and the built-in is the answer — never null.
    expect(matchHeaderTool(h, [FLAT_12])).toEqual({ key: 'flat-3.175x12-metal', strength: 'exact', provenance: 'id' });
  });

  it('never claims an exact match on a file that states no lengths (#305’s id=0 fixture)', () => {
    // Shape and diameter IS the evidence then, and the strength has to say so.
    const m = matchHeaderTool(header({ id: '0' }), [FLAT_12]);
    expect(m).toEqual({ key: 'flat-3.175x12-metal', strength: 'suggested', provenance: 'shape' });
  });

  it('an id the file states whose lengths disagree does not win by id', () => {
    // A hand-edited or mis-generated header: the g_ID is the 12 mm cutter's, the lengths are the
    // 42 mm one's. The id is not enough on its own — the lengths would have to agree.
    const m = matchHeaderTool(header({ id: '112111313812', fluteLength: 42, shoulderLength: 42 }), [CAT_12]);
    expect(m).toEqual({ key: 'cat:112111313812', strength: 'suggested', provenance: 'shape' });
  });

  it('a length only the file states is not a match — unknown is not agreement', () => {
    // The entry does not state a flute length (a pre-#220 list, or a row nobody measured): it
    // cannot be shown to be the cutter the file names, so the match drops to a suggestion rather
    // than being believed.
    const unmeasured = entry('cat:unmeasured', flatEndMill(3.175, { id: null }));
    const m = matchHeaderTool(header({ id: null, fluteLength: 12, shoulderLength: null }), [unmeasured]);
    expect(m).toEqual({ key: 'cat:unmeasured', strength: 'suggested', provenance: 'shape' });
  });

  it('one stated length that agrees is enough for an exact shape match', () => {
    // The file states only a shoulder length — what a post wrote for an engraver whose flute
    // length it does not know. One agreement is evidence; it is not "shape and diameter alone".
    const m = matchHeaderTool(header({ id: null, shoulderLength: 42 }), [FLAT_12, CAT_42]);
    expect(m).toEqual({ key: 'cat:111011313842', strength: 'exact', provenance: 'shape' });
  });

  it('is null when nothing in the list is the right shape or size', () => {
    expect(matchHeaderTool(header({ id: null, fluteLength: 12, shoulderLength: 12, shape: 'ball', tipDiameter: 6.35, diameter: 6.35 }), [FLAT_12, CAT_42])).toBeNull();
    // And a header whose cutting diameter is unstated cannot be matched on it either.
    expect(matchHeaderTool(flatEndMill(3.175, { id: null, tipDiameter: null, diameter: null }), [FLAT_12])).toBeNull();
  });
});

// ---- #332: the file's own `;@CM|TOOL|key=` line, which leads the whole order -----------------------
// The one identity a clone or a hand-typed definition has (#212 keeps the vendor `g_ID` off them),
// and the reason the order starts here rather than at the id.

describe('matchHeaderTool: the stated key (#332)', () => {
  it('answers with the key, exact, before the vendor id is even looked at', () => {
    // The file names a cutter of ours by key. Nothing the MKR line says can improve on that, so
    // even a g_ID pointing elsewhere does not get a look in.
    const m = matchHeaderTool(header({ id: '112111313812', fluteLength: 12, shoulderLength: 12 }), [FLAT_12, CAT_42], 'cat:111011313842');
    expect(m).toEqual({ key: 'cat:111011313842', strength: 'exact', provenance: 'key' });
  });

  it('a key the registry does not hold caps everything under it at `suggested`', () => {
    // "I was cut with user:six-flat-copy" — a cutter this house does not have. The geometry rules
    // can still name the closest entry, but calling that EXACT would contradict the file.
    const m = matchHeaderTool(header({ id: '112111313812', fluteLength: 12, shoulderLength: 12 }), [FLAT_12], 'user:six-flat-copy');
    expect(m).toEqual({ key: 'flat-3.175x12-metal', strength: 'suggested', provenance: 'id' });
  });

  it('an unresolvable key with nothing close is still null', () => {
    const ball = header({ id: null, shape: 'ball', tipDiameter: 6.35, diameter: 6.35 });
    expect(matchHeaderTool(ball, [FLAT_12], 'user:six-flat-copy')).toBeNull();
  });

  it('is unaffected when the file states no key at all', () => {
    // The default argument: every file posted before #332, and every file from another CAM package.
    const h = header({ id: '112111313812', fluteLength: 12, shoulderLength: 12 });
    expect(matchHeaderTool(h, [FLAT_12])).toEqual(matchHeaderTool(h, [FLAT_12], null));
  });
});
