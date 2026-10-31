// #783/#778 — the stock's orientation as ONE model for every form: a hold is the permutation of
// the part's own axes into the job frame, the holds each form offers, the suggestion that is never
// a rule, the face the items are on when the part is turned, and the curved-top depth loss.

import { describe, expect, it } from 'vitest';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import {
  DEFAULT_HOLD,
  blockHolds,
  curvatureLossMm,
  discHolds,
  formHolds,
  holdBox,
  holdCutFaceWords,
  holdSentence,
  holdWords,
  holdWordsFor,
  isStockHold,
  itemsFaceWords,
  itemsOnTop,
  jobDimOf,
  jobHold,
  moveItemToTopFace,
  partDimsFor,
  partDimsOf,
  rodHolds,
  suggestedHold,
} from '@/engine/cnc/engrave/stockHold';

const PART = { length: 100, width: 60, thickness: 12 };

describe('#783 the hold is a permutation of the part into the job frame', () => {
  it('maps the part axes into the job box and back for every block hold', () => {
    expect(holdBox(PART, DEFAULT_HOLD)).toEqual({ length: 100, width: 60, thickness: 12 });
    const standing = { x: 'width', y: 'thickness', z: 'length' } as const;
    expect(holdBox(PART, standing)).toEqual({ length: 60, width: 12, thickness: 100 });
    for (const hold of blockHolds()) {
      expect(partDimsOf(holdBox(PART, hold), hold)).toEqual(PART);
    }
  });

  it('knows a permutation from a muddle', () => {
    expect(isStockHold(DEFAULT_HOLD)).toBe(true);
    expect(isStockHold({ x: 'length', y: 'length', z: 'thickness' })).toBe(false);
    expect(isStockHold({ x: 'length', y: 'width', z: 'depth' })).toBe(false);
    expect(isStockHold(null)).toBe(false);
  });

  it('names the job dimension a part axis lands on', () => {
    const hold = { x: 'thickness', y: 'width', z: 'length' } as const;
    expect(jobDimOf(hold, 'thickness')).toBe('length');
    expect(jobDimOf(hold, 'width')).toBe('width');
    expect(jobDimOf(hold, 'length')).toBe('thickness');
  });
});

describe('#783 the holds each form offers', () => {
  it('a block has six: T up first, then W, then L, and the two runs between the jaws', () => {
    const holds = blockHolds();
    expect(holds).toHaveLength(6);
    expect(holds[0]).toEqual(DEFAULT_HOLD);
    expect(new Set(holds.map((h) => JSON.stringify(h))).size).toBe(6);
    // Each dimension is up exactly twice.
    for (const axis of ['length', 'width', 'thickness'] as const) {
      expect(holds.filter((h) => h.z === axis)).toHaveLength(2);
    }
  });

  it('a rod has the three, in the step\'s order, and their boxes are the ones #778 names', () => {
    const [ends, standing, across] = rodHolds();
    const rod = { length: 120, width: 20, thickness: 20 };
    expect(holdBox(rod, ends!)).toEqual({ length: 120, width: 20, thickness: 20 }); // L × D × D
    expect(holdBox(rod, standing!)).toEqual({ length: 20, width: 20, thickness: 120 }); // D × D × L
    expect(holdBox(rod, across!)).toEqual({ length: 20, width: 120, thickness: 20 }); // D × L × D
  });

  it('a disc has flat side up, and on edge', () => {
    const [flat, edge] = discHolds();
    const disc = { length: 55, width: 55, thickness: 10 };
    expect(holdBox(disc, flat!)).toEqual({ length: 55, width: 55, thickness: 10 });
    expect(holdBox(disc, edge!)).toEqual({ length: 55, width: 10, thickness: 55 });
    expect(formHolds('disc')).toEqual(discHolds());
    expect(formHolds('rod')).toEqual(rodHolds());
    expect(formHolds('plate')).toEqual(blockHolds());
  });

  it('builds the part from the form\'s own fields (a disc and a rod carry their ⌀ twice)', () => {
    expect(partDimsFor('disc', { diameter: 55, thickness: 10 })).toEqual({ length: 55, width: 55, thickness: 10 });
    expect(partDimsFor('rod', { diameter: 20, length: 120 })).toEqual({ length: 120, width: 20, thickness: 20 });
    expect(partDimsFor('plate', { length: 100, width: 60, thickness: 12 })).toEqual(PART);
    expect(partDimsFor('plate', { length: 100, width: null, thickness: 12 })).toBeNull();
  });
});

describe('#783 the suggestion is offered, never enforced', () => {
  it('a plate suggests its largest face up, the longest dimension between the jaws', () => {
    expect(suggestedHold({ form: 'plate', part: PART })).toEqual(DEFAULT_HOLD);
    // A 70 mm opening cannot take the 100 mm length: the 60 mm width goes between the jaws.
    expect(suggestedHold({ form: 'plate', part: PART, openingMm: 70 })).toEqual({
      x: 'width',
      y: 'length',
      z: 'thickness',
    });
  });

  it('a rod suggests ends-in-the-jaws when it fits, standing when short and fat', () => {
    const rod = { length: 120, width: 20, thickness: 20 };
    expect(suggestedHold({ form: 'rod', part: rod, openingMm: 150 })).toEqual(rodHolds()[0]);
    // Too long for the opening, and short/fat → standing.
    const stubby = { length: 30, width: 20, thickness: 20 };
    expect(suggestedHold({ form: 'rod', part: stubby, openingMm: 20 })).toEqual(rodHolds()[1]);
  });

  it('a disc suggests its flat face', () => {
    const disc = { length: 55, width: 55, thickness: 10 };
    expect(suggestedHold({ form: 'disc', part: disc })).toEqual(discHolds()[0]);
  });
});

describe('#783 the items stay on the part\'s face', () => {
  it('states where the items\' face points when it is not the top', () => {
    expect(itemsOnTop(DEFAULT_HOLD)).toBe(true);
    expect(itemsFaceWords(DEFAULT_HOLD)).toBeNull();
    // Width up: the part's +thickness face turns to a side — here the job's +X.
    const widthUp = { x: 'thickness', y: 'length', z: 'width' } as const;
    expect(itemsOnTop(widthUp)).toBe(false);
    expect(itemsFaceWords(widthUp)).toBe('now facing the moving jaw');
    const lengthUp = { x: 'width', y: 'thickness', z: 'length' } as const;
    expect(itemsFaceWords(lengthUp)).toBe('now facing the back of the machine');
  });

  it('moves an item to the new top face, keeping the shared axis\'s offset', () => {
    // A label at (10, 20) on the 100 × 60 top. Turn the width up: the new top is 100 × 12.
    const widthUp = { x: 'length', y: 'thickness', z: 'width' } as const;
    const moved = moveItemToTopFace({ x: 10, y: 20 }, DEFAULT_HOLD, widthUp, PART);
    // The length offset (−40) is kept; the width offset has no place on the new face → centre.
    expect(moved.point.x).toBe(10);
    expect(moved.point.y).toBe(6); // 12 / 2
    expect(moved.turnDeg).toBe(0);
  });

  it('turns an item when the face\'s in-plane axes swap', () => {
    const swapped = { x: 'width', y: 'length', z: 'thickness' } as const;
    const moved = moveItemToTopFace({ x: 10, y: 20 }, DEFAULT_HOLD, swapped, PART);
    expect(moved.turnDeg).toBe(90);
    expect(moved.point).toEqual({ x: 20, y: 10 });
  });
});

describe('#778 the curved top\'s depth loss', () => {
  it('is R − √(R² − (w/2)²): a 6 mm label on a ⌀20 rod loses 0.45 mm, a 2 mm one 0.05', () => {
    expect(curvatureLossMm(10, 6)).toBeCloseTo(0.461, 3);
    expect(curvatureLossMm(10, 2)).toBeCloseTo(0.05, 3);
    expect(curvatureLossMm(10, 10)).toBeCloseTo(1.34, 2);
    // Wider than the diameter clamps at the full radius (the cut no longer meets the stock).
    expect(curvatureLossMm(10, 30)).toBeCloseTo(10, 9);
    expect(curvatureLossMm(0, 6)).toBe(0);
  });
});

describe('#783 the job document', () => {
  it('keeps a pre-#783 job without a hold byte-for-byte, and reads it as the shipped orientation', () => {
    const job = defaultEngraveJob();
    delete job.hold;
    const parsed = parseEngraveJob(JSON.parse(JSON.stringify(job)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job.hold).toBeUndefined();
    expect(jobHold(parsed.job)).toEqual(DEFAULT_HOLD);
  });

  it('stores a chosen hold and reads it back', () => {
    const job = defaultEngraveJob();
    const hold = { x: 'width', y: 'length', z: 'thickness' } as const;
    const parsed = parseEngraveJob(JSON.parse(JSON.stringify({ ...job, hold })));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job.hold).toEqual(hold);
    expect(jobHold(parsed.job)).toEqual(hold);
  });

  it('refuses a hold that names an axis twice — that is not a way round', () => {
    const job = defaultEngraveJob();
    const parsed = parseEngraveJob(
      JSON.parse(JSON.stringify({ ...job, hold: { x: 'length', y: 'length', z: 'thickness' } })),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.join(' ')).toContain('exactly once');
  });
});

describe('#783 the words', () => {
  it('names the hold and its cut face in the operator\'s terms', () => {
    expect(holdWords(DEFAULT_HOLD, PART)).toBe('12 mm up · 100 mm between the jaws (60 mm along them)');
    expect(holdWordsFor('plate', DEFAULT_HOLD, PART)).toBe('12 mm up · 100 mm between the jaws (60 mm along them)');
    const rod = { length: 120, width: 20, thickness: 20 };
    expect(holdWordsFor('rod', rodHolds()[0]!, rod)).toBe('flat ends against the jaws');
    expect(holdWordsFor('rod', rodHolds()[1]!, rod)).toBe('standing on its end');
    expect(holdWordsFor('rod', rodHolds()[2]!, rod)).toBe('lying across, gripped on the curve');
    const disc = { length: 55, width: 55, thickness: 10 };
    expect(holdWordsFor('disc', discHolds()[0]!, disc)).toBe('flat side up');
    expect(holdWordsFor('disc', discHolds()[1]!, disc)).toBe('on its edge');
    expect(holdSentence(DEFAULT_HOLD)).toBe(
      'The part\'s thickness is up, its length runs between the jaws, and its width runs along them.',
    );
    expect(holdCutFaceWords('rod', rodHolds()[0]!)).toContain('curved side');
    expect(holdCutFaceWords('rod', rodHolds()[1]!)).toContain('⌀ end face');
    expect(holdCutFaceWords('disc', discHolds()[1]!)).toContain('edge');
  });
});

// #783 — a frozen package remembers the hold it was frozen in, so a turn is NAMED.
describe('#783 the frozen package names a stock turn', () => {
  it('says "the stock was turned" when only the hold moved', async () => {
    const { freezePackage, packageStaleness } = await import('@/engine/cnc/engrave/package');
    const job = defaultEngraveJob();
    // A minimal program input: freezePackage hashes the text; the profile's shapes do not matter.
    const frozen = freezePackage(
      job,
      [{ setupIndex: 0, setupId: 'setup-1', toolKey: 'flat-1.0', nc: 'G0 X0 Y0\n', programHash: 'p1', frameNc: null }],
      '2026-10-31T12:00:00.000Z',
    );
    expect(frozen.ok).toBe(true);
    if (!frozen.ok) return;
    expect(frozen.package.hold).toEqual(jobHold(job));
    expect(packageStaleness(frozen.package, job).stale).toBe(false);

    const turned = {
      ...job,
      hold: { x: 'width', y: 'length', z: 'thickness' } as const,
      stock: { ...job.stock, length: job.stock.width, width: job.stock.length },
    };
    expect(packageStaleness(frozen.package, turned)).toEqual({
      stale: true,
      reason: 'the stock was turned since it was frozen',
    });
  });
});
