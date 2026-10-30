/**
 * #785 — the reach check: refused only on a KNOWN short reach, informed when none is recorded, and
 * turnable into a safe top-band cut with one choice.
 */
import { afterEach, describe, expect, it } from 'vitest';

// A localStorage shim, as the store barrel may be pulled in transitively by the dispatch path.
const backing = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => backing.get(k) ?? null,
  setItem: (k: string, v: string) => void backing.set(k, String(v)),
  removeItem: (k: string) => void backing.delete(k),
  clear: () => backing.clear(),
  key: (i: number) => [...backing.keys()][i] ?? null,
  get length() {
    return backing.size;
  },
} as Storage;

import { GOAL_BAND_CLEARANCE_MM, goalReachFindings, longestKnownReach, knownReach } from '@/engine/cnc/engrave/goalReach';
import { generateGoalProgram } from '@/workers/sim/engraveGenerate';
import type { EngraveProgress } from '@/workers/sim/engraveGenerate';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { clearTargetObjectMeshCache } from '@/engine/import/targetObject';
import { flatEndMill } from '@/engine/cnc/tool';
import type { Tool } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';

afterEach(() => clearTargetObjectMeshCache());

const flat = (over: Partial<Tool> = {}): Tool => flatEndMill(3, { name: 'flat', ...over });
const catEntry = (id: string, flute: number): ToolLibraryEntry => ({
  key: `cat:${id}`,
  tool: flat({ id, name: `Makera ⌀3 flat (${id})`, fluteLength: flute }),
  provenance: 'test catalogue row',
});

let serial = 0;
function goal(depth: number, over: Partial<EngraveTargetObject> = {}): EngraveTargetObject {
  return {
    id: `g-${serial}`,
    name: 'tall.stl',
    format: 'stl',
    sha256: String(serial++).padStart(64, 'a'),
    data: 'AAAA',
    size: { x: 10, y: 10, z: depth },
    position: { x: 25, y: 25, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
    ...over,
  };
}

/** A binary STL ramp over 20×20 mm, its top falling to −K·20 in Z. */
type Tri = [[number, number, number], [number, number, number], [number, number, number]];
function binaryStl(tris: Tri[]): ArrayBuffer {
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  let off = 84;
  for (const t of tris) {
    off += 12;
    for (const v of t) {
      dv.setFloat32(off, v[0], true);
      dv.setFloat32(off + 4, v[1], true);
      dv.setFloat32(off + 8, v[2], true);
      off += 12;
    }
    off += 2;
  }
  return buf;
}
const DEPTH_MM = 30;
function rampTris(depthMm = DEPTH_MM): Tri[] {
  const k = depthMm / 20;
  const p = (x: number, y: number): [number, number, number] => [x, y, -k * x];
  return [
    [p(0, 0), p(20, 0), p(20, 20)],
    [p(0, 0), p(20, 20), p(0, 20)],
  ];
}
function rampGoal(over: Partial<EngraveTargetObject> = {}, depthMm = DEPTH_MM): EngraveTargetObject {
  return goal(depthMm, {
    data: Buffer.from(new Uint8Array(binaryStl(rampTris(depthMm)))).toString('base64'),
    size: { x: 20, y: 20, z: depthMm },
    position: { x: 25, y: 25, z: 0 },
    ...over,
  });
}

function tallJob(target: EngraveTargetObject): EngraveJob {
  return {
    ...defaultEngraveJob(),
    labels: [],
    shapes: [],
    stock: { ...defaultEngraveJob().stock, length: 50, width: 50, thickness: 150 },
    targetObject: target,
  };
}

describe('#785 — which reach is known', () => {
  it('a stated flute is the cutter’s own reach', () => {
    expect(knownReach(flat({ fluteLength: 22 }), [])).toEqual({ mm: 22, source: 'stated', catalogueName: null });
  });

  it('the shoulder governs when stated — the engine’s one reach rule — and the flute is the fallback', () => {
    expect(knownReach(flat({ fluteLength: 12, shoulderLength: 40 }), [])?.mm).toBe(40);
    expect(knownReach(flat({ fluteLength: 12, shoulderLength: null }), [])?.mm).toBe(12);
  });

  it('an unstated flute takes Makera’s catalogue number for the SAME cutter id, with its provenance', () => {
    const copy = flat({ id: '112111313812', name: 'owned copy', fluteLength: null });
    const reach = knownReach(copy, [catEntry('112111313812', 12)]);
    expect(reach?.mm).toBe(12);
    expect(reach?.source).toBe('catalogue');
  });

  it('an unstated flute with no catalogue row — or no id to match one by — has no reach', () => {
    expect(knownReach(flat({ fluteLength: null, id: null }), [catEntry('112', 12)])).toBeNull();
    expect(knownReach(flat({ fluteLength: null, id: '999' }), [catEntry('112', 12)])).toBeNull();
    // A non-catalogue tier is not the vendor's number.
    expect(knownReach(flat({ fluteLength: null, id: '112' }), [{ ...catEntry('112', 12), key: 'user:112' }])).toBeNull();
  });

  it('longestKnownReach ranks only the known ones and ignores the unknowns', () => {
    const best = longestKnownReach(
      [flat({ fluteLength: null }), flat({ fluteLength: 22 }), flat({ fluteLength: 12 })],
      [],
    );
    expect(best?.reach.mm).toBe(22);
    expect(longestKnownReach([flat({ fluteLength: null })], [])).toBeNull();
  });
});

describe('#785 — the findings', () => {
  it('a known short reach REFUSES with the numbers and the four fixes', () => {
    const [f] = goalReachFindings(goal(112), flat({ fluteLength: 22 }), [flat({ fluteLength: 22 })], []);
    expect(f?.severity).toBe('error');
    expect(f?.code).toBe('goal-reach-short');
    expect(f?.targetId).toBe('g-0');
    expect(f?.goalBandMm).toBe(21);
    expect(f?.message).toContain('112 mm deep');
    expect(f?.message).toContain('your longest reach is 22 mm');
    expect(f?.message).toContain('Scale the goal to 22 mm or less');
    expect(f?.message).toContain('cut it from both sides');
    expect(f?.message).toContain('choose a longer cutter');
    expect(f?.message).toContain('cut just the top 21 mm');
  });

  it('names the catalogue as the source, and the house’s longer cutter when the chosen one is not it', () => {
    const copy = flat({ id: '112', fluteLength: null });
    const [f] = goalReachFindings(goal(112), copy, [copy, flat({ fluteLength: 50 })], [catEntry('112', 12)]);
    expect(f?.message).toContain("this cutter reaches 12 mm (Makera's catalogue)");
    expect(f?.message).toContain('your longest reach is 50 mm');
  });

  it('cutWithinReach turns the refusal into the stated top-band cut', () => {
    const findings = goalReachFindings(goal(112, { cutWithinReach: true }), flat({ fluteLength: 22 }), [], []);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('warning');
    expect(findings[0]?.code).toBe('goal-cut-top-band');
    expect(findings[0]?.message).toContain("only the stock's top 21 mm is cut");
    expect(findings[0]?.message).toContain('remaining 91 mm');
    expect(findings.some((f) => f.severity === 'error')).toBe(false);
  });

  it('an unrecorded reach is an INFO with the assumption stated, never a block', () => {
    const findings = goalReachFindings(goal(112), flat({ fluteLength: null, id: null }), [], []);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('info');
    expect(findings[0]?.code).toBe('goal-reach-unrecorded');
    expect(findings[0]?.message).toContain("This cutter's reach is not recorded");
    expect(findings[0]?.message).toContain('the depth it can reach is unchecked');
    expect(findings[0]?.message).toContain('record its flute in Manage › Tools');
  });

  it('a goal sunk into the blank is judged by its LOWEST surface, and the sentence says both numbers', () => {
    // 30 mm tall, its top 20 mm below the stock top: the cutter must go 50 mm down, not 30.
    const sunk = goal(30, { position: { x: 25, y: 25, z: -20 } });
    const [f] = goalReachFindings(sunk, flat({ fluteLength: 40 }), [], []);
    expect(f?.severity).toBe('error');
    expect(f?.message).toContain('30 mm deep');
    expect(f?.message).toContain('its lowest surface 50 mm below the stock top');
    // A goal entirely ABOVE the blank needs nothing from this check.
    expect(goalReachFindings(goal(30, { position: { x: 25, y: 25, z: 40 } }), flat({ fluteLength: 4 }), [], [])).toEqual([]);
  });

  it('a goal within reach, a reference, a picture, a disabled target or no cutter posts nothing', () => {
    expect(goalReachFindings(goal(20), flat({ fluteLength: 22 }), [], [])).toEqual([]);
    // Exactly at the reach is within it.
    expect(goalReachFindings(goal(22), flat({ fluteLength: 22 }), [], [])).toEqual([]);
    expect(goalReachFindings(goal(112, { role: 'reference' }), flat({ fluteLength: 22 }), [], [])).toEqual([]);
    expect(goalReachFindings(goal(112, { format: 'png' }), flat({ fluteLength: 22 }), [], [])).toEqual([]);
    expect(goalReachFindings(goal(112, { enabled: false }), flat({ fluteLength: 22 }), [], [])).toEqual([]);
    expect(goalReachFindings(goal(112), null, [], [])).toEqual([]);
  });

  it('the band clearance is the 1 mm the sentence and the sampler share', () => {
    expect(GOAL_BAND_CLEARANCE_MM).toBe(1);
  });
});

describe('#785 — Generate', () => {
  it('refuses a known-short reach EARLY: the sentence, no CAM, no program', () => {
    const target = rampGoal();
    const out = generateGoalProgram(tallJob(target), target, flat({ fluteLength: 12 }), [], null, {});
    expect(out.ok).toBe(false);
    expect(out.stage).toBe('findings');
    const refusal = out.findings.find((f) => f.code === 'goal-reach-short');
    expect(refusal?.severity).toBe('error');
    expect(refusal?.message).toContain('30 mm deep');
    expect(out.nc).toBeNull();
    expect(out.cam).toBeNull();
    expect(out.programs).toEqual([]);
  }, 120_000);

  it('cutWithinReach cuts the stock’s top band and says what is left', () => {
    const target = rampGoal({ cutWithinReach: true });
    const tool = flat({ fluteLength: 12 });
    const out = generateGoalProgram(tallJob(target), target, tool, [], null, {});
    expect(out.ok, out.errors.map((e) => e.message).join('; ')).toBe(true);
    expect(out.nc).not.toBeNull();
    const warning = out.findings.find((f) => f.code === 'goal-cut-top-band');
    expect(warning?.severity).toBe('warning');
    expect(warning?.message).toContain("only the stock's top 11 mm is cut");
    // The program never goes deeper than the band: 12 mm reach − 1 mm clearance.
    const zs = [...(out.nc ?? '').matchAll(/Z(-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
    expect(Math.min(...zs)).toBeGreaterThanOrEqual(-11.001);
    expect(Math.min(...zs)).toBeLessThanOrEqual(-10.5);
    // The sheet states the floor and what it leaves.
    expect(out.surface3d?.notes.some((n) => n.includes("Cut only the stock's top 11 mm"))).toBe(true);
  }, 120_000);

  it('an unrecorded reach does not stop Generate — the assumption is stated, the cut proceeds', () => {
    const target = rampGoal();
    const out = generateGoalProgram(tallJob(target), target, flat({ fluteLength: null, id: null }), [], null, {});
    expect(out.ok, out.errors.map((e) => e.message).join('; ')).toBe(true);
    expect(out.nc).not.toBeNull();
    const note = out.findings.find((f) => f.code === 'goal-reach-unrecorded');
    expect(note?.severity).toBe('info');
    expect(out.findings.some((f) => f.code === 'goal-reach-short')).toBe(false);
  }, 120_000);

  it('#785 the goal CAM reports its stages, and the level and row counts reach the end', () => {
    const target = rampGoal({}, 8);
    const events: EngraveProgress[] = [];
    const out = generateGoalProgram(tallJob(target), target, flat({ fluteLength: 12 }), [], null, {}, (p) => events.push(p));
    expect(out.ok).toBe(true);
    const stages = events.map((e) => e.stage);
    // `prepare` is the top-level `engraveGenerate`'s first event; the goal program itself starts
    // at the sampling it owns.
    for (const stage of ['sample', 'rough', 'finish', 'post', 'done'] as const) {
      expect(stages, `the run must report ${stage}`).toContain(stage);
    }
    const rough = events.filter((e) => e.stage === 'rough');
    expect(rough.length).toBeGreaterThan(1);
    expect(rough.at(-1)?.done).toBe(rough.at(-1)?.total);
    expect(rough.at(-1)?.label).toMatch(/^roughing level \d+ of \d+$/);
    const finish = events.filter((e) => e.stage === 'finish');
    expect(finish.at(-1)?.done).toBe(finish.at(-1)?.total);
    expect(finish.at(-1)?.label).toMatch(/^finishing row \d+ of \d+$/);
  });

  it('a goal within reach generates with no reach finding at all', () => {
    const target = rampGoal({}, 8);
    const out = generateGoalProgram(tallJob(target), target, flat({ fluteLength: 12 }), [], null, {});
    expect(out.ok).toBe(true);
    expect(out.findings.some((f) => f.code.startsWith('goal-reach') || f.code === 'goal-cut-top-band')).toBe(false);
  }, 120_000);
});
