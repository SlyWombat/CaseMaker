// Which registry entry a `.nc` header names (#316). Pure — no store, no wasm, no worker: the
// matcher is handed the list, which is the whole reason it left `simSetupStore`.

import { describe, it, expect } from 'vitest';
import { headerSignature, matchHeaderTool } from '@/engine/cnc/headerMatch';
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

// #316's ambiguous case, as the house really holds it: an item registered FROM the catalogue keeps
// the catalogue tool as its materialised snapshot (`inventoryEntryFor`), so the owned row carries
// the same `g_ID` as the `cat:` row it came from. Nothing about the file's TOOL record can then
// separate them.
const INV_12 = entry(
  'inv:box-1',
  flatEndMill(3.175, { id: '112111313812', name: '3.175*12mm Flat End(Metal)', fluteLength: 12, shoulderLength: 12 }),
);
// A second catalogue row answering the same evidence as CAT_12 — same tier, so not the tie #316
// asks about.
const CAT_12_B = entry(
  'cat:duplicate-row',
  flatEndMill(3.175, { id: '112111313812', name: '3.175*12mm Flat End(Metal)', fluteLength: 12, shoulderLength: 12 }),
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
    // …and it stays a decision, not a question: one namespaced row against a built-in is not the
    // two-tier tie #316 asks about, so no candidates come back.
    expect(matchHeaderTool(h, [FLAT_12, CAT_12])!.candidates).toBeUndefined();
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

  it('does not call a held key exact when the file states a diameter the entry lost (#316 review)', () => {
    // A `user:` cutter edited after the file was posted: the key still resolves, but the entry is
    // no longer the cutter the sweep was written for. The key is what the file SAYS, so it stays
    // the answer and the provenance stays `key` — the strength is what drops.
    const h = header({ id: null, fluteLength: 12, shoulderLength: 12, tipDiameter: 2, diameter: 2 });
    expect(matchHeaderTool(h, [FLAT_12], 'flat-3.175x12-metal')).toEqual({
      key: 'flat-3.175x12-metal',
      strength: 'suggested',
      provenance: 'key',
    });
    // A missing diameter on either side is not a disagreement — nothing can be shown to differ.
    expect(matchHeaderTool(flatEndMill(3.175, { id: null, tipDiameter: null, diameter: null }), [FLAT_12], 'flat-3.175x12-metal')).toEqual({
      key: 'flat-3.175x12-metal',
      strength: 'exact',
      provenance: 'key',
    });
  });

  it('resolves the key on a file with no TOOL record at all (#332 review)', () => {
    // Hand-edited, or posted by something that puts identity only in the CM line. Step (0) needs
    // no geometry, so the key still answers; every step below it does, and finds nothing.
    expect(matchHeaderTool(null, [FLAT_12, CAT_42], 'cat:111011313842')).toEqual({
      key: 'cat:111011313842',
      strength: 'exact',
      provenance: 'key',
    });
    // A key the list does not hold, and no geometry to suggest with: no answer rather than a guess.
    expect(matchHeaderTool(null, [FLAT_12], 'user:six-flat-copy')).toBeNull();
    expect(matchHeaderTool(null, [FLAT_12])).toBeNull();
  });
});

// ---- #316: two tiers answering the same evidence, which is a question and not a tie ------------
// The 2026-10-09 decision resolved a built-in against a namespaced row. It does not reach two
// NAMESPACED rows in different tiers: an owned cutter and the catalogue row it was registered from
// are two different things to say about the same program, and the file says neither.

describe('matchHeaderTool: the two-tier tie (#316)', () => {
  const AMBIGUOUS_BY_ID = {
    key: 'inv:box-1',
    strength: 'suggested',
    provenance: 'id',
    candidates: [
      { key: 'inv:box-1', tier: 'owned' },
      { key: 'cat:112111313812', tier: 'catalogue' },
    ],
  } as const;

  it('names both rows by the id, when the file states one and the lengths agree with each', () => {
    // Passed catalogue-first, so the ORDER in the answer is the tier order and not the list order —
    // the same order the Manage picker draws, which is what the person is choosing down.
    const h = header({ id: '112111313812', fluteLength: 12, shoulderLength: 12 });
    expect(matchHeaderTool(h, [CAT_12, INV_12])).toEqual(AMBIGUOUS_BY_ID);
  });

  it('names both by shape and diameter too, on the lengths and without them', () => {
    // The common real case: a file from another CAM package states no key and no vendor id, so the
    // only evidence is shape and diameter — and both rows offer exactly that.
    const lengths = header({ id: null, fluteLength: 12, shoulderLength: 12 });
    expect(matchHeaderTool(lengths, [CAT_12, INV_12])).toEqual({ ...AMBIGUOUS_BY_ID, provenance: 'shape' });

    // No lengths stated at all: step (c), which is a suggestion anyway — and still a question.
    const bare = header({ id: null });
    expect(matchHeaderTool(bare, [CAT_12, INV_12])).toEqual({ ...AMBIGUOUS_BY_ID, provenance: 'shape' });
  });

  it('is never exact while the question is open, however good the evidence for the pair is', () => {
    // The id and every stated length agree with BOTH rows. That is exact evidence that the cutter
    // is one of two, which is not an answer about which — so `suggested` is the strongest word the
    // match may use, and the caller that can ask does not apply `key`.
    const h = header({ id: '112111313812', fluteLength: 12, shoulderLength: 12 });
    expect(matchHeaderTool(h, [CAT_12, INV_12])!.strength).toBe('suggested');
  });

  it('keeps the first hit when both rows come from ONE tier', () => {
    // Two catalogue rows answering identically is a registry oddity, not this decision's case: no
    // tier is being chosen between, so there is nothing to ask and the first hit stands.
    const h = header({ id: '112111313812', fluteLength: 12, shoulderLength: 12 });
    const m = matchHeaderTool(h, [CAT_12, CAT_12_B]);
    expect(m).toEqual({ key: 'cat:112111313812', strength: 'exact', provenance: 'id' });
    expect(m!.candidates).toBeUndefined();
  });

  it('leaves the ordinary single-answer match with no candidates at all', () => {
    // The additive field: every match this issue did not change keeps exactly its old shape.
    expect(matchHeaderTool(header({ id: null, fluteLength: 42, shoulderLength: 42 }), [FLAT_12, CAT_42])!.candidates).toBeUndefined();
    expect(matchHeaderTool(header({ id: '0' }), [FLAT_12])!.candidates).toBeUndefined();
  });
});

// ---- #316: the signature a remembered pick is filed under --------------------------------------
// The header's own identity in the match order, so a choice follows the PROGRAM rather than the
// file name — the same file reopened, or the same post run again, asks no second time.

describe('headerSignature (#316)', () => {
  it('reads the three rungs of the match order, most specific first', () => {
    // The file's own key line outranks the vendor id it also states…
    expect(headerSignature(header({ id: '112111313812' }), 'cat:111011313842')).toBe('key=cat:111011313842');
    // …the vendor id outranks the shape…
    expect(headerSignature(header({ id: '112111313812' }), null)).toBe('id=112111313812');
    // …and shape with the diameter is what is left when the record states neither.
    expect(headerSignature(header({ id: null }), null)).toBe('shape=flat@3.175');
  });

  it('quantises the diameter the way the panel writes it, so one cutter is one signature', () => {
    // Two files stating the same cutter must land on the same string, or the memory silently
    // misses and the question is asked again — which is the failure this whole path exists to avoid.
    expect(headerSignature(flatEndMill(3.1750000000000003, { id: null }), null)).toBe('shape=flat@3.175');
    expect(headerSignature(flatEndMill(3.175, { id: null }), null)).toBe(headerSignature(flatEndMill(3.175, { id: null }), null));
  });

  it('is null when the record states none of the three, and for a file with no record', () => {
    // Nothing about such a file can tie, so there is nothing to remember — and the caller may not
    // file an answer under a signature it invented.
    expect(headerSignature(flatEndMill(3.175, { id: null, tipDiameter: null, diameter: null }), null)).toBeNull();
    expect(headerSignature(null, null)).toBeNull();
  });
});
