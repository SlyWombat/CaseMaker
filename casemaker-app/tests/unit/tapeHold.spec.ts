// #711 (BM-4 of #707) — the tape hold rule: `taped area ≥ holdRatio × (cutter ⌀ × step-down)`,
// on the STOCK and on every piece a through cut frees, plus the tall-block note. Design:
// `docs/design/bed-mounts-flow.md` §3.4 (the rule), §3.7 (the sentences) and §6 fixtures 1–2b.
//
// The design's own arithmetic is the rectangle model — the badge's 72.2 × 34.1 = 2 462.02 mm²,
// 100 × 1 × 0.5 = 50 mm², 100 × 3.175 × 1 = 317.5 mm², a 12 × 12 piece tapering to 8 × 8 = 64,
// a 40 × 30 tag to 36 × 26 = 936. The STOCK's numbers here ARE that model (its footprint is a
// rectangle). A PIECE's are measured: its footprint eroded by the tool radius and the tape's
// inset, with the corners round, which is a few per cent under the rectangle ideal — always in
// the conservative direction.

import { describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { KNOWN_DEFAULTS, readDefault } from '@/platform/defaultsClient';
import { flatEndMill } from '@/engine/cnc/tool';
import { generate } from './helpers/engravePipeline';
import { tl } from './helpers/manifoldExec';
import { requiredHoldArea, tapedArea, tapeHoldFindings, type TapedPiece } from '@/engine/cnc/engrave/tapeHold';
import type { EngraveCutout, EngraveJob, TapeHold } from '@/types/engraveJob';

const TAPE: TapeHold = { width: 20, thickness: 0.1, inset: 2, where: null, squareTo: 'front', source: 'default' };

/** A freed piece as the worker measures it — the design's figures, rounded as it quotes them. */
const piece = (name: string, widthMm: number, heightMm: number, tapedAreaMm2: number): TapedPiece => ({ name, widthMm, heightMm, tapedAreaMm2 });

describe('#711 the rule’s arithmetic (design §3.4)', () => {
  it('the taped area is the footprint 2 mm in from every edge; the need is k × ⌀ × step-down', () => {
    // The badge on tape: 72.2 × 34.1 = 2 462.02 mm² of tape; 100 × 1 mm × 0.5 mm = 50 mm² needed.
    expect(tapedArea(76.2, 38.1, 2)).toBeCloseTo(2462.02, 2);
    expect(requiredHoldArea(100, 1, 0.5)).toBeCloseTo(50, 9);
    // A ⌀3.175 flat at 1 mm a pass needs 317.5 mm²: about an 18 × 18 mm piece.
    expect(requiredHoldArea(100, 3.175, 1)).toBeCloseTo(317.5, 6);
    expect(tapedArea(18, 18, 0)).toBeGreaterThan(317.5);
    // A piece smaller than the inset in either direction has no tape under it at all.
    expect(tapedArea(3, 40, 2)).toBe(0);
  });
});

describe('#711 the stock and the pieces (design §3.7 sentences)', () => {
  it('the taped badge holds: 2 462.02 mm² of tape against 50 mm² needed', () => {
    expect(
      tapeHoldFindings({
        stock: { length: 76.2, width: 38.1, thickness: 3.81 },
        tape: TAPE,
        cutterWords: 'flat end',
        biteDiameterMm: 1,
        stepDownMm: 0.5,
        holdRatio: 100,
        pieces: [],
      }),
    ).toEqual([]);
  });

  it('the stock is refused in the design’s words when the tape is too small', () => {
    const f = tapeHoldFindings({
      stock: { length: 15, width: 10, thickness: 3 },
      tape: TAPE,
      cutterWords: 'flat end',
      biteDiameterMm: 3.175,
      stepDownMm: 1,
      holdRatio: 100,
      pieces: [],
    });
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe('error');
    expect(f[0]!.code).toBe('tape-hold-stock');
    expect(f[0]!.message).toBe(
      'The tape under this 15 × 10 mm plate cannot hold it against the ⌀3.175 mm flat end — clamp it in ' +
        'the bracket, or cut it with a smaller cutter. (66.00 mm² taped; 317.50 mm² needed at 100 × the cutter’s bite.)',
    );
  });

  it('a freed piece is refused by its own tape area — the Star, not the stock', () => {
    const f = tapeHoldFindings({
      stock: { length: 100, width: 60, thickness: 2 },
      tape: TAPE,
      cutterWords: 'flat end',
      biteDiameterMm: 3.175,
      stepDownMm: 1,
      holdRatio: 100,
      pieces: [piece('Star', 12, 12, 64)],
    });
    expect(f.map((x) => x.code)).toEqual(['tape-hold-piece']);
    expect(f[0]!.message).toBe(
      '“Star” is cut free as a 12 × 12 mm piece; the tape under it cannot hold it against the ⌀3.175 mm ' +
        'flat end — leave two tabs, or cut it with a smaller cutter. (64.00 mm² taped; 317.50 mm² needed at 100 × the cutter’s bite.)',
    );
  });

  it('the through-cut tag’s piece holds: 936 mm² of tape against 317.5 mm² needed', () => {
    expect(
      tapeHoldFindings({
        stock: { length: 80, width: 60, thickness: 2 },
        tape: TAPE,
        cutterWords: 'flat end',
        biteDiameterMm: 3.175,
        stepDownMm: 1,
        holdRatio: 100,
        pieces: [piece('Tag', 40, 30, 936)],
      }),
    ).toEqual([]);
  });

  it('a block taller than its narrowest width is a NOTE, never a blocker', () => {
    const f = tapeHoldFindings({
      stock: { length: 25, width: 30, thickness: 30 },
      tape: TAPE,
      cutterWords: 'flat end',
      biteDiameterMm: 1,
      stepDownMm: 0.1,
      holdRatio: 100,
      pieces: [],
    });
    expect(f.map((x) => x.code)).toEqual(['tape-tall-stock']);
    expect(f[0]!.severity).toBe('warning');
    expect(f[0]!.message).toBe('The block is 30 mm tall and 25 mm wide: tape alone may let it tip — hold it in the bracket and clamps.');
    // Not taller than its narrowest width: no note.
    expect(
      tapeHoldFindings({
        stock: { length: 100, width: 60, thickness: 12 },
        tape: TAPE,
        cutterWords: 'flat end',
        biteDiameterMm: 1,
        stepDownMm: 0.5,
        holdRatio: 100,
        pieces: [],
      }),
    ).toEqual([]);
  });

  it('with no usable cutter width or pass the rule says nothing rather than guessing', () => {
    expect(
      tapeHoldFindings({
        stock: { length: 15, width: 10, thickness: 3 },
        tape: TAPE,
        cutterWords: 'flat end',
        biteDiameterMm: null,
        stepDownMm: 1,
        holdRatio: 100,
        pieces: [piece('Star', 12, 12, 0)],
      }),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------
// Through the real pipeline.

/** A 12 × 12 shape the job only REFERENCES, and a cut-out that frees it with no tabs. */
const STAR: EngraveJob['shapes'][number] = {
  kind: 'rect',
  id: 'shape-star',
  name: 'Star',
  width: 12,
  height: 12,
  cornerRadius: 0,
  position: { x: 50, y: 30 },
  rotation: 0,
  depth: 1,
  enabled: true,
  construction: true,
};
const STAR_CUT: EngraveCutout = {
  kind: 'cutout',
  id: 'cut-star',
  name: 'Star',
  enabled: true,
  of: 'shape-star',
  side: 'outside',
  inset: 0,
  tabs: { count: 0, width: 4, height: 1 },
};

/** A 2 mm MDF board under the stock: a through cut needs one (#218). */
const BOARD = {
  under: { thickness: 2, overhang: { left: 0, right: 0, front: 0, back: 0 }, attach: 'tape' as const },
  sides: { left: null, right: null, front: null, back: null },
  source: 'saved' as const,
};

function tapedJob(over: Partial<EngraveJob> = {}): EngraveJob {
  const base = defaultEngraveJob();
  return { ...base, toolKey: 'flat-1.0', tool: flatEndMill(1), workholding: { kind: 'tape', tape: { ...TAPE } }, sacrificial: BOARD, ...over };
}

describe('#711 the rule in the pipeline', () => {
  it('a taped job that holds generates, with no tape findings', () => {
    const g = generate(tl, tapedJob());
    expect(g.ok, `${g.stage} ${JSON.stringify(g.errors)}`).toBe(true);
    expect(g.findings.filter((f) => f.code.startsWith('tape-'))).toEqual([]);
  });

  it('a cut-out that frees a piece too small for the tape is refused, and the piece is measured', () => {
    // ⌀1 at a 1 mm step-down: 100 mm² needed. The stock's 96 × 56 mm of tape holds; the Star's
    // 12 × 12 piece — its footprint eroded by the tool radius and the 2 mm inset — does not.
    const g = generate(tl, tapedJob({ cutOverride: { stepDown: 1 }, shapes: [STAR], cutouts: [STAR_CUT] }));
    expect(g.ok).toBe(false);
    expect(g.stage).toBe('findings');
    const f = g.findings.filter((x) => x.code === 'tape-hold-piece');
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe('error');
    expect(f[0]!.message).toMatch(/^“Star” is cut free as a 12 × 12 mm piece; the tape under it cannot hold it/);
    expect(f[0]!.message).toMatch(/needed at 100 × the cutter’s bite\.\)$/);
    // The stock's own tape is ample and says nothing.
    expect(g.findings.some((x) => x.code === 'tape-hold-stock')).toBe(false);
  });

  it('the same piece with two tabs is not cut free, so the tape rule does not judge it', () => {
    const tabbed: EngraveCutout = { ...STAR_CUT, tabs: { count: 2, width: 4, height: 1 } };
    const g = generate(tl, tapedJob({ cutOverride: { stepDown: 1 }, shapes: [STAR], cutouts: [tabbed] }));
    expect(g.ok, `${g.stage} ${JSON.stringify(g.errors)}`).toBe(true);
    expect(g.findings.some((x) => x.code === 'tape-hold-piece')).toBe(false);
  });

  it('a VISE job is not judged by the tape rule at all', () => {
    const g = generate(tl, { ...tapedJob({ cutOverride: { stepDown: 1 }, shapes: [STAR], cutouts: [STAR_CUT] }), workholding: defaultEngraveJob().workholding });
    expect(g.findings.some((x) => x.code.startsWith('tape-'))).toBe(false);
  });

  it('a taped block taller than its narrowest width is warned, not blocked', () => {
    const base = defaultEngraveJob();
    const label = { ...base.labels[0]!, text: 'A', size: 4, depth: 0.5, position: { x: 12.5, y: 15 } };
    const tall: EngraveJob = {
      ...tapedJob({ stock: { ...base.stock, length: 25, width: 30, thickness: 30 } }),
      labels: [label],
    };
    const g = generate(tl, tall);
    // The note is a WARNING: the job still generates.
    expect(g.ok, `${g.stage} ${JSON.stringify(g.errors)}`).toBe(true);
    expect(g.findings.find((f) => f.code === 'tape-tall-stock')?.severity).toBe('warning');
  });
});

describe('#711 the settings are the shop’s, with provenance', () => {
  it('tape.holdRatio is 100 and tape.insetMm 2 mm, labelled chosen-not-measured', () => {
    const ratio = readDefault(null, 'tape.holdRatio');
    expect(ratio.value).toBe(100);
    expect(ratio.source).toBe('fallback');
    expect(readDefault(null, 'tape.insetMm')).toEqual({ value: 2, source: 'fallback' });
    // The design's wording says the ratio is Case Maker's until the bench's tape coupon measures it.
    expect(KNOWN_DEFAULTS['tape.holdRatio']!.label).toMatch(/chosen, not measured/);
    expect(KNOWN_DEFAULTS['tape.holdRatio']!.unit).toBe('x');
    expect(KNOWN_DEFAULTS['tape.insetMm']!.unit).toBe('mm');
  });
});
