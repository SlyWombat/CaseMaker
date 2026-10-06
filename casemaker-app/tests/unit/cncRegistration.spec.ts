// The registration plan for an engrave job (#272 — the caller slice of #188 / decision 26).
// Pure: an `EngraveJob` in, a `ProbeResult` and the run sheet's words for it out. No wasm.

import { describe, it, expect } from 'vitest';
import {
  describeTouch,
  PROBE_SPEC,
  probePartFor,
  readsWord,
  registrationFor,
} from '@/engine/cnc/engrave/registration';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { toSetup, workholdingFor } from '@/engine/cnc/engrave/jobSetup';
import { presetJawStrips } from '@/engine/cnc/sacrificial';
import { Z1 } from '@/engine/cnc';
import { aabbOfProfile } from '@/engine/compiler/profile';
import type { ProbeTouch } from '@/engine/cnc/probePlan';
import type { Vec2 } from '@/types/units';

/** A touch the planner could have emitted, for the phrasing tests: nothing else is read. */
function touch(edge: [Vec2, Vec2], at: Vec2, reads: 'x' | 'y', fixes: ProbeTouch['fixes']): ProbeTouch {
  return {
    edge,
    edgeLength: Math.hypot(edge[1][0] - edge[0][0], edge[1][1] - edge[0][1]),
    at,
    reads,
    fixes,
    reason: '',
  };
}

describe('registrationFor (#272)', () => {
  it('reads the blank’s rectangle — the stock, which is all the job document carries', () => {
    // `EngraveJob` has no outline field, so the plan sees the blank's bounding rectangle: 100 × 60
    // for the shipped default job. A printed corner radius is therefore not represented, which
    // makes a datum edge read LONGER than the part's, never shorter.
    expect(aabbOfProfile(probePartFor(defaultEngraveJob()).outline)).toEqual({ min: [0, 0], max: [100, 60] });
  });

  it('states the vise’s datum and resolves every axis it leaves open', () => {
    const plan = registrationFor(defaultEngraveJob());
    expect('refuse' in plan).toBe(false);
    if ('refuse' in plan) return;
    // The fixed (left) jaw is the datum; across the jaws the residual is jaw squareness.
    expect(plan.datums).toEqual([{ fixes: ['x', 'rotation'], uncertainty: 0.05 }]);
    expect(plan.probeZ).toBe(true);
    // No XY tolerance is stated, so nothing is skipped: a pair for position + rotation, then the
    // closing touch on a perpendicular edge.
    expect(plan.touches).toHaveLength(3);
    expect(plan.touches.map((t) => t.fixes)).toEqual([['y', 'rotation'], ['rotation'], ['x']]);
    expect(plan.residual).toBeCloseTo(0.02, 12);
    expect(plan.rotationResidual).toBeGreaterThan(0);
    // The two caveats the sheet has to carry: the file cannot compensate rotation, and Z is the
    // one datum no fixture supplies.
    expect(plan.notes.join(' ')).toContain('a static .nc cannot compensate it');
    expect(plan.notes.join(' ')).toContain('Z is always probed on the engraved face');
  });

  it('is §7.3’s V1 sequence when the job says the jaws are good enough', () => {
    // With a stated tolerance of the vise's own ±0.05 mm, X and rotation are already held well
    // enough, so the whole sequence is the one Y touch §7.3's V1 table calls for. That is the
    // consequence of `PROBE_SPEC` leaving `toleranceMm` out — recorded here so the extra two
    // touches are a decision someone can see, not an accident.
    expect(PROBE_SPEC.toleranceMm).toBeUndefined();
    const plan = registrationFor(defaultEngraveJob(), { ...PROBE_SPEC, toleranceMm: 0.05 });
    expect('refuse' in plan).toBe(false);
    if ('refuse' in plan) return;
    expect(plan.touches).toHaveLength(1);
    expect(plan.touches[0]!.reads).toBe('y');
    expect(plan.notes.join(' ')).toContain('rotation is fixed mechanically by the fixture');
  });

  it('refuses a blank with no edge the probe can use, rather than inventing a touch', () => {
    const job = defaultEngraveJob();
    job.stock = { ...job.stock, length: 1, width: 1 };
    const plan = registrationFor(job);
    expect('refuse' in plan).toBe(true);
    if (!('refuse' in plan)) return;
    // 1 mm sides are under the planner's 2× tip-diameter minimum, so no axis can be resolved.
    expect(plan.code).toBe('no-reachable-edge');
  });
});

describe('the workholding the plan is given (#272)', () => {
  it('is the same object the emulator gets — one authority for the jaw faces', () => {
    const job = defaultEngraveJob();
    expect(workholdingFor(job)).toEqual(toSetup(job, Z1).workholding);
  });

  it('carries the sacrificial shift the jaws actually close on (#213 §2)', () => {
    const job = defaultEngraveJob();
    job.sacrificial = presetJawStrips(); // 6 mm strips both sides
    const wh = workholdingFor(job);
    if (wh.kind !== 'vise') throw new Error('expected the vise');
    expect(wh.jawFaces[0]!.origin[0]).toBe(-6);
    expect(wh.jawFaces[1]!.origin[0]).toBe(100 + 6);
    // The datum faces moved with the material; the axes they reference did not.
    const plan = registrationFor(job);
    if ('refuse' in plan) throw new Error('refused');
    expect(plan.datums).toEqual([{ fixes: ['x', 'rotation'], uncertainty: 0.05 }]);
  });
});

describe('the touch, in the operator’s words (#272)', () => {
  // The part frame IS the work frame: front-left at the origin, +X to the right, +Y away from the
  // operator. So a side names itself, and it names the jaw it faces.
  it('names the back edge and how far along it, from the left end', () => {
    const words = describeTouch(touch([[0, 60], [100, 60]], [25, 60], 'y', ['y', 'rotation']), 100, 60);
    expect(words.edge).toBe('the back edge — the one furthest from you');
    expect(words.where).toBe('about 25 mm along it from the left end');
  });

  it('names the left edge — the one against the fixed jaw — and its middle', () => {
    const words = describeTouch(touch([[0, 0], [0, 60]], [0, 30], 'x', ['x']), 100, 60);
    expect(words.edge).toBe('the left edge — the one against the fixed jaw');
    expect(words.where).toBe('at about its middle, 30 mm from the front end');
  });

  it('gives the same words whichever way round the planner’s edge runs', () => {
    // `straightEdges` may walk a ring either way, so the fraction has to be flipped with it or the
    // sheet would send the operator to the wrong end.
    const forward = describeTouch(touch([[0, 60], [100, 60]], [25, 60], 'y', ['y']), 100, 60);
    const backward = describeTouch(touch([[100, 60], [0, 60]], [25, 60], 'y', ['y']), 100, 60);
    expect(backward).toEqual(forward);
    const front = describeTouch(touch([[0, 0], [0, 60]], [0, 10], 'x', ['x']), 100, 60);
    const reversed = describeTouch(touch([[0, 60], [0, 0]], [0, 10], 'x', ['x']), 100, 60);
    expect(reversed).toEqual(front);
    expect(front.where).toBe('about 10 mm along it from the front end');
  });

  it('says which axis a touch resolves, including the pair that closes rotation', () => {
    expect(readsWord(touch([[0, 60], [100, 60]], [25, 60], 'y', ['y', 'rotation']))).toBe('position and rotation');
    expect(readsWord(touch([[0, 60], [100, 60]], [75, 60], 'y', ['rotation']))).toBe('rotation');
    expect(readsWord(touch([[100, 0], [100, 60]], [100, 30], 'x', ['x']))).toBe('X');
    expect(readsWord(touch([[0, 60], [100, 60]], [50, 60], 'y', ['y']))).toBe('Y');
  });
});
