// @vitest-environment jsdom
// #519 item 1 — the live readings: the executor's four `TouchKind`s mapped to the design's three
// verdicts (one mapping, so the dot's colour and the table's word cannot disagree), and the
// session store the runner fills as each touch lands.

import { describe, it, expect, beforeEach } from 'vitest';
import { touchVerdict, type LiveTouch } from '@/engine/cnc/registration/liveTouch';
import { resetRegistrationTouchesStore, useRegistrationTouchesStore } from '@/store/registrationTouchesStore';

const touch = (over: Partial<LiveTouch> = {}): LiveTouch => ({
  seq: 1,
  source: 'edge',
  label: 'the left edge',
  x: 1,
  y: 2,
  z: -56.17,
  touched: true,
  kind: 'stock',
  ...over,
});

beforeEach(() => {
  resetRegistrationTouchesStore();
});

describe('#519 item 1 — the verdict mapping', () => {
  it('maps the four executor kinds to the three words the viewport and the dock print', () => {
    expect(touchVerdict(touch({ kind: 'stock' }))).toBe('stock');
    expect(touchVerdict(touch({ kind: 'above' }))).toBe('off-band');
    expect(touchVerdict(touch({ kind: 'below' }))).toBe('miss');
    expect(touchVerdict(touch({ kind: 'miss', touched: false }))).toBe('miss');
  });

  it('a surface or extent reading (no kind) is stock when it touched and a miss when it did not', () => {
    expect(touchVerdict(touch({ source: 'surface', kind: null, touched: true }))).toBe('stock');
    expect(touchVerdict(touch({ source: 'surface', kind: null, touched: false }))).toBe('miss');
  });
});

describe('#519 item 1 — the registration touches store', () => {
  it('keeps each reading in the order it landed', () => {
    const s = useRegistrationTouchesStore.getState();
    s.add(touch({ seq: 1, source: 'surface' }));
    s.add(touch({ seq: 2 }));
    expect(useRegistrationTouchesStore.getState().touches.map((t) => t.seq)).toEqual([1, 2]);
  });

  it('reset starts a new run: no readings, no spread sentence, no step, and this job’s stamp', () => {
    const s = useRegistrationTouchesStore.getState();
    s.add(touch());
    s.setSpreadSentence('spread 0.1 mm');
    s.setStep('touching the left edge');
    s.reset('job-42');
    const after = useRegistrationTouchesStore.getState();
    expect(after.touches).toEqual([]);
    expect(after.spreadSentence).toBeNull();
    expect(after.step).toBeNull();
    // The stamp is what stops a layer left from another job being drawn as this job's.
    expect(after.jobId).toBe('job-42');
    s.reset();
    expect(useRegistrationTouchesStore.getState().jobId).toBeNull();
  });

  it('carries the runner step and the spread sentence for the strip and the dock', () => {
    const s = useRegistrationTouchesStore.getState();
    s.setStep('as low as machine Z -57.2 (the surface seek)');
    s.setSpreadSentence('Surface spread 0.2 mm against the 0.2 mm band — within it.');
    expect(useRegistrationTouchesStore.getState().step).toContain('surface seek');
    expect(useRegistrationTouchesStore.getState().spreadSentence).toContain('0.2 mm band');
  });
});
