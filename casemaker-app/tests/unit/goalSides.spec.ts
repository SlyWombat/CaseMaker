/**
 * #723 P2-1b — the sides list: one goal per setup, one program per side.
 *
 * A job cut from several sides carries `targetObjects[]`, each goal naming the setup that cuts it
 * (a goal with no `setupId` belongs to the first setup). `goalSides` is the reading every consumer
 * shares; `engraveGenerate` walks it and posts one surface program per side, in setup order, with
 * that setup's index and id on the program. The one-goal `targetObject` form is unchanged.
 */
import { describe, expect, it } from 'vitest';

import { engraveGenerate } from '@/workers/sim/engraveGenerate';
import { tl } from './helpers/manifoldExec';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { goalSides, jobHasItems, jobSetups, jobTargetObjects } from '@/engine/cnc/engrave/jobSetup';
import { flatEndMill } from '@/engine/cnc/tool';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';

type V = [number, number, number];
type Tri = [V, V, V];

function binaryStl(tris: Tri[]): string {
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
  return Buffer.from(new Uint8Array(buf)).toString('base64');
}

function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): Tri[] {
  const c: V[] = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const q = (a: number, b: number, d: number, e: number): Tri[] => [
    [c[a]!, c[b]!, c[d]!],
    [c[a]!, c[d]!, c[e]!],
  ];
  return [...q(4, 5, 6, 7), ...q(0, 3, 2, 1), ...q(0, 1, 5, 4), ...q(2, 3, 7, 6), ...q(1, 2, 6, 5), ...q(3, 0, 4, 7)];
}

let serial = 0;
function goal(id: string, height: number, over: Partial<EngraveTargetObject> = {}): EngraveTargetObject {
  return {
    id,
    name: `${id}.stl`,
    format: 'stl',
    sha256: (serial++).toString(16).padStart(64, 'd'),
    data: binaryStl(box(0, 20, 0, 20, 0, height)),
    size: { x: 20, y: 20, z: height },
    position: { x: 40, y: 25, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
    ...over,
  };
}

const BALL = flatEndMill(3, { shape: 'ball', name: '3 mm ball nose' });

/** A job with two saved setups and one goal per side (the second naming its setup). */
function twoSideJob(): EngraveJob {
  const job = defaultEngraveJob();
  job.stock = { ...job.stock, length: 80, width: 50, thickness: 26 };
  job.labels = [];
  job.shapes = [];
  // A real registry key: a saved setup's tool list cannot be empty, and the goal CAM resolves the
  // feeds through the tool passed to `engraveGenerate`.
  job.toolKey = 'flat-3.175x12-metal';
  job.tool = BALL;
  const base = jobSetups(job)[0]!;
  job.setups = [
    { ...base, id: 'setup-1', orientation: { ...base.orientation }, itemIds: [], tools: [job.toolKey] },
    { ...base, id: 'setup-2', orientation: { ...base.orientation }, itemIds: [], tools: [job.toolKey] },
  ];
  job.targetObjects = [goal('goal-out', 10), goal('goal-in', 8, { setupId: 'setup-2' })];
  return job;
}

function parsed(job: EngraveJob): ReturnType<typeof parseEngraveJob> {
  return parseEngraveJob(JSON.parse(JSON.stringify(job)));
}

describe('#723 P2-1b — the sides reading', () => {
  it('returns the goals in setup order, the unassigned goal on the first setup', () => {
    const job = twoSideJob();
    const sides = goalSides(job);
    expect(sides.map((s) => [s.setupIndex, s.setup.id, s.goal.id])).toEqual([
      [0, 'setup-1', 'goal-out'],
      [1, 'setup-2', 'goal-in'],
    ]);
  });

  it('a job with no saved setups has no sides: the single-goal path is its own', () => {
    const job = defaultEngraveJob();
    job.targetObject = goal('solo', 10);
    expect(jobTargetObjects(job).map((t) => t.id)).toEqual(['solo']);
    expect(goalSides(job)).toEqual([]);
  });

  it('references and disabled targets are not sides', () => {
    const job = twoSideJob();
    job.targetObjects = [
      goal('goal-out', 10, { role: 'reference' }),
      goal('goal-in', 8, { setupId: 'setup-2' }),
      goal('goal-off', 6, { enabled: false }),
    ];
    expect(goalSides(job).map((s) => s.goal.id)).toEqual(['goal-in']);
  });

  it('the document refuses both forms, an unknown setup, two goals on one setup, and two unassigned goals', () => {
    const job = twoSideJob();
    const first = parsed(job);
    expect(first.ok, first.ok ? '' : first.errors.join('; ')).toBe(true);

    expect(parsed({ ...job, targetObject: goal('solo', 10) }).ok).toBe(false);
    expect(parsed({ ...job, targetObjects: [goal('a', 10, { setupId: 'nope' })] }).ok).toBe(false);
    expect(parsed({ ...job, targetObjects: [goal('a', 10, { setupId: 'setup-2' }), goal('b', 8, { setupId: 'setup-2' })] }).ok).toBe(false);
    expect(parsed({ ...job, targetObjects: [goal('a', 10), goal('b', 8)] }).ok).toBe(false);
    expect(parsed({ ...job, targetObjects: [goal('a', 10), goal('a', 8, { setupId: 'setup-2' })] }).ok).toBe(false);
    // One unassigned plus one assigned is the normal two-side shape.
    const normal = parsed(job);
    expect(normal.ok, normal.ok ? '' : normal.errors.join('; ')).toBe(true);
  });

  it('a job that states no turn gains no key; the list round-trips as written', () => {
    const job = twoSideJob();
    const again = parsed(job);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.job.targetObjects?.map((t) => [t.id, t.setupId ?? null])).toEqual([
      ['goal-out', null],
      ['goal-in', 'setup-2'],
    ]);
    expect('rotationX' in (again.job.targetObjects?.[1] ?? {})).toBe(false);
  });
});

describe('#723 P2-1b — one program per side', () => {
  it('generates a surface program for each side, in setup order, with its setup on the program', () => {
    const job = twoSideJob();
    expect(jobHasItems(job), 'the fixture must be a pure-goal job').toBe(false);
    expect(goalSides(job)).toHaveLength(2);
    const out = engraveGenerate(tl, job, BALL, [], null, undefined, {});
    expect(out.errors).toEqual([]);
    expect(out.ok).toBe(true);
    expect(out.programs).toHaveLength(2);
    expect(out.programs.map((p) => [p.setupIndex, p.setupId])).toEqual([
      [1, 'setup-1'],
      [2, 'setup-2'],
    ]);
    expect(out.programs[0]!.toolKey).toBe(job.toolKey);
    // The top-level fields are the FIRST program's, as every multi-program result reads.
    expect(out.nc).toBe(out.programs[0]!.nc);
    expect(out.programs[1]!.nc).not.toBe(out.programs[0]!.nc);
    // The first goal is surfaced from its own placement (20 × 20 centred on 40,25).
    expect(out.programs[0]!.nc).toContain('X');
  }, 120_000);

  it('a single goal on a job with setups is cut in the first setup — the one-goal compatibility path', () => {
    const job = twoSideJob();
    job.targetObjects = [goal('goal-out', 10)];
    const out = engraveGenerate(tl, job, BALL, [], null, undefined, {});
    expect(out.ok, out.errors.map((e) => e.message).join('; ')).toBe(true);
    expect(out.programs).toHaveLength(1);
    expect(out.programs[0]!.setupId).toBe('setup-1');
  }, 120_000);
});
