/**
 * #723 P2-2 — the flip's stated pin reference.
 *
 * The acceptance part's own pins: (4, 25) and (75, 25) on an 80 × 50 blank, on the flip line and at
 * unequal distances from the centre. The reference must say where they are, ask the question that
 * catches a stock spun 180° about Z, and REFUSE to ask when the pins cannot tell that apart
 * (symmetric about the centre) or when they are not on the turn's line.
 */
import { describe, expect, it } from 'vitest';

import { flipAxisOf, pinReference, setupPinReference } from '@/engine/cnc/setups';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { jobSetups } from '@/engine/cnc/engrave/jobSetup';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import type { JobSetup, JobSetupPins } from '@/types/engraveJob';

const STOCK = { x: 80, y: 50 };
const pair = (a: { x: number; y: number }, b: { x: number; y: number }): JobSetupPins => ({ at: [a, b] });
const PINS: JobSetupPins = pair({ x: 4, y: 25 }, { x: 75, y: 25 });

describe('#723 P2-2 — the pins in the operator’s words', () => {
  it('names both pins’ distances and asks which is nearer the edge the line runs along', () => {
    const ref = pinReference(PINS, STOCK, { setupIndex: 0, about: 'x' });
    expect(ref.words).toContain('4 mm and 75 mm from the left edge');
    expect(ref.words).toContain('25 mm and 25 mm from the front edge');
    expect(ref.words).toContain('unmeasured on this unit');
    expect(ref.mirrorCheck).toBeNull();
    expect(ref.confirm).not.toBeNull();
    expect(ref.confirm!.question).toBe('Look at the two pins: which one is nearer the left edge?');
    // The nearer pin is the right answer, and it is not always offered first.
    expect(ref.confirm!.options[ref.confirm!.correct]).toBe('the pin 4 mm from the left edge');
    const second = pinReference(PINS, STOCK, { setupIndex: 1, about: 'x' });
    expect(second.confirm!.options[second.confirm!.correct]).toBe('the pin 4 mm from the left edge');
    expect(ref.confirm!.correct).toBe(0);
    expect(second.confirm!.correct).toBe(1);
  });

  it('asks along Y when the pins’ line runs that way', () => {
    const ref = pinReference(pair({ x: 25, y: 6 }, { x: 25, y: 44 }), STOCK, { about: 'y' });
    expect(ref.confirm!.question).toContain('nearer the front edge');
    expect(ref.confirm!.options[ref.confirm!.correct]).toBe('the pin 6 mm from the front edge');
  });

  it('a symmetric pair cannot tell a 180° spin apart, and says so instead of asking', () => {
    const ref = pinReference(pair({ x: 20, y: 25 }, { x: 60, y: 25 }), STOCK, { about: 'x' });
    expect(ref.confirm).toBeNull();
    expect(ref.mirrorCheck).toContain('symmetrically about the stock’s centre');
    expect(ref.mirrorCheck).toContain('spun 180°');
  });

  it('pins off the flip line are refused, because the turn would not land on them', () => {
    const offLine = pinReference(pair({ x: 4, y: 20 }, { x: 75, y: 30 }), STOCK, { about: 'x' });
    expect(offLine.confirm).toBeNull();
    expect(offLine.mirrorCheck).toContain('not on a line along X');
    const offLineY = pinReference(pair({ x: 20, y: 4 }, { x: 30, y: 44 }), STOCK, { about: 'y' });
    expect(offLineY.confirm).toBeNull();
    expect(offLineY.mirrorCheck).toContain('not on a line along Y');
  });

  it('two pins at one point are not a datum', () => {
    const ref = pinReference(pair({ x: 10, y: 10 }, { x: 10, y: 10 }), STOCK);
    expect(ref.confirm).toBeNull();
    expect(ref.mirrorCheck).toContain('same point');
  });
});

describe('#723 P2-2 — a saved setup’s flip axis and reference', () => {
  function setup(over: Partial<JobSetup> = {}): JobSetup {
    const base = jobSetups(defaultEngraveJob())[0]!;
    return { ...base, id: 'setup-2', orientation: { ...base.orientation }, itemIds: [], tools: [], ...over };
  }
  const BOTTOM = { top: 'bottom', bottom: 'top', left: 'right', right: 'left', front: 'front', back: 'back' } as const;

  it('a bottom-up setup’s axis comes from its mount: the vise turns about X, anything else about Y', () => {
    expect(flipAxisOf(setup({ orientation: BOTTOM, mount: { kind: 'vise', viseOpeningMm: 100 } }))).toBe('x');
    expect(flipAxisOf(setup({ orientation: BOTTOM, mount: { kind: 'tape' } }))).toBe('y');
    expect(flipAxisOf(setup())).toBeNull(); // top up: not a flip
  });

  it('a setup that states pins gets the reference; one that does not gets null', () => {
    expect(setupPinReference(setup(), STOCK)).toBeNull();
    const withPins = setup({ orientation: BOTTOM, mount: { kind: 'vise', viseOpeningMm: 100 }, pins: PINS });
    const ref = setupPinReference(withPins, STOCK, 1);
    expect(ref?.confirm).not.toBeNull();
    // A tape flip asks the Y question instead; these pins are not on Y, so it is refused.
    const onTape = setup({ orientation: BOTTOM, mount: { kind: 'tape' }, pins: PINS });
    expect(setupPinReference(onTape, STOCK)?.mirrorCheck).toContain('not on a line along Y');
  });
});

describe('#723 P2-2 — the document', () => {
  function jobWithPins(): unknown {
    const job = defaultEngraveJob();
    // A saved setup's tool list cannot be empty, and the default job has no cutter picked yet.
    job.toolKey = 'flat-3.175x12-metal';
    const base = jobSetups(job)[0]!;
    return {
      ...job,
      setups: [
        { ...base, id: 'setup-1', orientation: { ...base.orientation }, itemIds: [], tools: [job.toolKey] },
        {
          ...base,
          id: 'setup-2',
          orientation: { top: 'bottom', bottom: 'top', left: 'right', right: 'left', front: 'front', back: 'back' },
          itemIds: [],
          tools: [job.toolKey],
          pins: PINS,
        },
      ],
    };
  }

  it('pins round-trip on a setup, and a setup without them gains no key', () => {
    const parsed = parseEngraveJob(JSON.parse(JSON.stringify(jobWithPins())));
    expect(parsed.ok, parsed.ok ? '' : parsed.errors.join('; ')).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job.setups?.[1]?.pins).toEqual(PINS);
    expect('pins' in (parsed.job.setups?.[0] ?? {})).toBe(false);
  });

  it('a pin list that is not a pair of points is refused', () => {
    const job = jobWithPins() as { setups: Record<string, unknown>[] };
    job.setups[1] = { ...job.setups[1]!, pins: { at: [{ x: 1, y: 2 }] } };
    expect(parseEngraveJob(job).ok).toBe(false);
  });
});
