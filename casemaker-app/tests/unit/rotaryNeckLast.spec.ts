// #849 — A MIXED ROTARY JOB WITH A PARTING NECK: the map items, then the faces, then the neck.
//
// The neck is the wrapped CAM's last operations; a face program cut after it would leave the part
// held only by the neck. So the wrapped program's IR is split at the neck into an items file and a
// neck-only file, each posted and verified with its own predictions, and the run plays them items,
// faces, neck. A face cut that reaches into the neck's section is the one refusal left.

import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { toSetup } from '@/engine/cnc/engrave/jobSetup';
import { buildRunSheet } from '@/engine/cnc/engrave/runSheet';
import { Z1 } from '@/engine/cnc/machine';
import { flatEndMill } from '@/engine/cnc/tool';
import { buildTimeline, parseGcode } from '@/engine/cnc';
import { createSimSession } from '@/workers/sim/session';
import { engraveGenerate, type EngraveGenerated } from '@/workers/sim/engraveGenerate';
import type { EngraveFaceOp, EngraveJob, JobSetup, RotaryNeck } from '@/types/engraveJob';

const TOOL = flatEndMill(3.175, { name: '3.175 mm flat end', handleDiameter: 3.175 });

/** ⌀20 PLA in the chuck, 40 mm out, one ⌀8 circle pocket on the map at X 20 mm. */
function rod(faces: EngraveFaceOp[], neck?: RotaryNeck): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    name: 'neck last',
    stock: { length: 100, width: 20, thickness: 20, material: 'pla', shape: 'cylinder', diameter: 20 },
    workholding: {
      kind: 'rotary-chuck',
      rotary: {
        stickout: 40,
        gripDiameter: null,
        jawMode: 'reverse-inner',
        tailstock: false,
        source: 'test',
        ...(neck === undefined ? {} : { neck }),
      },
    },
    labels: [],
    shapes: [
      { id: 's1', kind: 'circle', position: { x: 20, y: Math.PI * 10 }, rotation: 0, depth: 0.5, enabled: true, diameter: 8 },
    ],
    toolKey: 'flat-3.175x12-metal',
    faces,
  };
}

const withSetup = (job: EngraveJob): EngraveJob => ({
  ...job,
  setups: [
    {
      id: 'set-1',
      orientation: { up: '+z', front: '+y' },
      mount: { kind: 'rotary-chuck' },
      itemIds: ['s1'],
      tools: [job.toolKey],
    } as unknown as JobSetup,
  ],
});

const FLAT: EngraveFaceOp = { id: 'f', kind: 'flat', a: 30, depth: 1 };
/** A ⌀7 mm neck on the chuck side, 6 mm long: X 3–9 mm, its floor 6.5 mm below the surface. */
const NECK: RotaryNeck = { end: 'chuck', diameter: 7, length: 6 };

function hashes(g: EngraveGenerated): string[] {
  return g.programs.map((p) => p.programHash);
}

/** Every program's oracle, each judged on fresh stock against its own predictions. */
function judgeEach(job: EngraveJob, g: EngraveGenerated): void {
  for (const [i, program] of g.programs.entries()) {
    expect(program.predicted, `program ${i + 1} carries its own predictions`).toBeDefined();
    const session = createSimSession(tl);
    try {
      const loaded = session.load(program.nc, toSetup(job, Z1), TOOL, Z1.id);
      expect(loaded.ok, `program ${i + 1} loads`).toBe(true);
      if (!loaded.ok) return;
      const report = session.oracle([...program.predicted!]);
      expect(report.ok, `program ${i + 1}: ${JSON.stringify(report.levels)}`).toBe(true);
      expect(report.levels.length, `program ${i + 1} is judged at some level`).toBeGreaterThan(0);
      for (const level of report.levels) {
        expect(level.underCut, `program ${i + 1} level ${level.z}`).toBe(0);
        expect(level.overCut, `program ${i + 1} level ${level.z}`).toBe(0);
      }
    } finally {
      session.dispose();
    }
  }
}

function expectItemsFacesNeck(job: EngraveJob, g: EngraveGenerated): void {
  expect(g.errors, JSON.stringify(g.findings.filter((f) => f.severity === 'error'))).toEqual([]);
  expect(g.ok).toBe(true);
  expect(g.programs).toHaveLength(3);
  // Items (wrapped), then the faces (indexed), then the neck alone (wrapped).
  const classes = g.programs.map((p) => buildTimeline(parseGcode(p.nc), toSetup(job, Z1)).summary.rotaryClass);
  expect(classes).toEqual(['wrapped', 'indexed', 'wrapped']);
  // Each file verified, and only the last one carries the neck.
  for (const p of g.programs) expect(p.verify?.findings.filter((f) => f.severity === 'error')).toEqual([]);
  expect(g.programs.map((p) => p.neck != null)).toEqual([false, false, true]);
  expect(g.programs[2]!.neckOnly).toBe(true);
  expect(g.programs[2]!.cam?.operations).toBe(1);
  // The order is stated in one line.
  const order = g.findings.find((f) => f.code === 'neck-after-faces');
  expect(order?.severity).toBe('info');
  expect(g.findings.some((f) => f.code === 'face-cuts-neck')).toBe(false);
}

describe('#849 — a mixed job with a neck cuts items, faces, then the neck', () => {
  it('a legacy document posts three programs, each verified and each passing its own oracle', async () => {
    const job = rod([FLAT], NECK);
    const g = await engraveGenerate(tl, job, TOOL, [], null);
    expectItemsFacesNeck(job, g);
    // The wrapped CAM is unchanged: the items file's cuts followed by the neck file's are exactly
    // the cuts of the same job without its faces, whose one file ends on the neck.
    const cuts = (nc: string): string[] => nc.split('\n').filter((line) => /^G1\b/.test(line));
    const whole = await engraveGenerate(tl, rod([], NECK), TOOL, [], null);
    expect(whole.programs).toHaveLength(1);
    expect([...cuts(g.programs[0]!.nc), ...cuts(g.programs[2]!.nc)]).toEqual(cuts(whole.programs[0]!.nc));
    judgeEach(job, g);

    const sheet = buildRunSheet(job, g, null);
    const neckSection = sheet.sections.find((s) => s.id === 'cut-3')!;
    expect(neckSection.title).toMatch(/the neck for parting/);
    expect(neckSection.steps[0]!.text).toMatch(/^Program 3 is [\s\S]*the neck for parting alone/);
    expect(neckSection.steps.at(-1)!.text).toMatch(/^Saw the part off at X 6 mm \(the neck\)/);
    const cut1 = sheet.sections.find((s) => s.id === 'cut')!;
    expect(cut1.steps.some((step) => /Saw the part off/.test(step.text))).toBe(false);
  }, 600_000);

  it('a setup’d document posts the same three files', async () => {
    const job = withSetup(rod([FLAT], NECK));
    const g = await engraveGenerate(tl, job, TOOL, [], null);
    expectItemsFacesNeck(job, g);
    const legacy = await engraveGenerate(tl, rod([FLAT], NECK), TOOL, [], null);
    expect(g.programs.map((p) => p.programHash)).toEqual(legacy.programs.map((p) => p.programHash));
  }, 600_000);
});

describe('#849 — a face cut into the neck’s section is refused by name', () => {
  it('a flat deeper than the neck’s floor', async () => {
    // The neck's floor is 6.5 mm below the surface; a 7 mm flat leaves less than ⌀7 mm through it.
    const job = rod([{ id: 'deep', kind: 'flat', a: 0, depth: 7 }], NECK);
    for (const doc of [job, withSetup(job)]) {
      const g = await engraveGenerate(tl, doc, TOOL, [], null);
      expect(g.ok).toBe(false);
      expect(g.programs).toEqual([]);
      const f = g.findings.find((x) => x.code === 'face-cuts-neck');
      expect(f?.severity).toBe('error');
      expect(f?.labelId).toBe('deep');
      expect(f?.message).toContain('7 mm below the surface between X 3 and X 9 mm');
      expect(f?.message).toContain('⌀7 mm');
    }
  });

  it('a cross-hole through the neck’s span', async () => {
    const g = await engraveGenerate(tl, rod([FLAT, { id: 'x', kind: 'cross-hole', a: 0, diameter: 3.175, atX: 6 }], NECK), TOOL, [], null);
    expect(g.ok).toBe(false);
    const f = g.findings.find((x) => x.code === 'face-cuts-neck');
    expect(f?.labelId).toBe('x');
    expect(f?.message).toMatch(/^The cross-hole at A 0° cuts into the neck for parting/);
  });

  it('a cross-hole clear of the neck is not refused by it', async () => {
    const g = await engraveGenerate(tl, rod([{ id: 'x', kind: 'cross-hole', a: 0, diameter: 3.175, atX: 30 }], NECK), TOOL, [], null);
    expect(g.findings.some((x) => x.code === 'face-cuts-neck')).toBe(false);
    expect(g.ok, JSON.stringify(g.findings.filter((f) => f.severity === 'error'))).toBe(true);
    expect(g.programs).toHaveLength(3);
  }, 600_000);
});

describe('#849 — a job without faces, or without a neck, posts exactly what it did', () => {
  // Hashes taken on main at 0e0e7939, before the neck could be posted apart.
  const cases: [string, () => EngraveJob, string[]][] = [
    ['mixed, no neck', () => rod([FLAT]), ['a70a4532', '7b385ff6']],
    ['mixed, no neck, setups', () => withSetup(rod([FLAT])), ['a70a4532', '7b385ff6']],
    ['neck, no faces', () => rod([], NECK), ['a25333d7']],
    ['neck, no faces, setups', () => withSetup(rod([], NECK)), ['a25333d7']],
  ];
  for (const [name, make, want] of cases) {
    it(name, async () => {
      const g = await engraveGenerate(tl, make(), TOOL, [], null);
      expect(g.ok).toBe(true);
      expect(hashes(g)).toEqual(want);
      // #844 gives every program its own `predicted` on main, so only the neck flag is pinned absent.
      expect(g.programs.every((p) => p.neckOnly === undefined)).toBe(true);
      expect(g.findings.some((f) => f.code === 'neck-after-faces')).toBe(false);
    }, 300_000);
  }
});
