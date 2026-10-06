/**
 * Plunge-drilled holes (#220), end to end: the peck cycle in `cam/drill.ts`, the region the
 * region builder opens for a drill, and the whole generate → verify → simulate chain.
 *
 * Real Manifold, real sweep, plain Node — the same harness `engraveCombinedSim.spec.ts` uses.
 * The peck's re-entry rapid is the case that produced false positives before
 * (`/Simulation.md` §10 step 6): a rapid back down an already-drilled hole of the same diameter
 * is in air, and the simulator must agree. That one is checked against the REAL `load()`.
 */

import { describe, it, expect } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { createSimSession, type SimLoadOk, type SimSession } from '@/workers/sim/session';
import { engraveGenerate, engraveRegions } from '@/workers/sim/engraveGenerate';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { jobTool, toSetup, validateJob } from '@/engine/cnc/engrave/jobSetup';
import { feedsFor } from '@/engine/cnc/feeds';
import { Z1 } from '@/engine/cnc/machine';
import { flatEndMill } from '@/engine/cnc/tool';
import { generateEngrave } from '@/engine/cnc/cam/engraveJob';
import { orderHolesNearest, peckDepths } from '@/engine/cnc/cam/drill';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import type { EngraveDrill, EngraveJob } from '@/types/engraveJob';
import type { NodeMeshOutput } from '@/workers/geometry/meshOutput';

/** The tool the drill specs use: a 3.175 mm flat end mill, the shank every sample tool uses. */
const TOOL_KEY = 'flat-3.175x12-metal';

/** A job whose only work is the given drills, on the default 100 × 60 × 12 softwood blank. */
function drillJob(drills: EngraveDrill[], cutOverride?: EngraveJob['cutOverride']): EngraveJob {
  const base = defaultEngraveJob();
  return { ...base, labels: [], shapes: [], toolKey: TOOL_KEY, drills, cutOverride };
}

/** One drill at (50, 30), depth 4, pecked 1 mm at a time. */
function singleHole(): EngraveJob {
  const hole: EngraveDrill = {
    id: 'port',
    kind: 'drill',
    name: 'port',
    position: { x: 50, y: 30 },
    rotation: 0,
    depth: 4,
    enabled: true,
    through: false,
  };
  return drillJob([hole], { peck: 1 });
}

/** The toolpath IR for a drill job, off the SAME regions the app would generate. */
function drillIr(job: EngraveJob) {
  const { regions, tool } = engraveRegions(tl, job);
  if (tool === null) throw new Error(`${TOOL_KEY} is not in the tool library`);
  const feeds = feedsFor(job.stock.material, tool, Z1, job.cutOverride);
  if (!feeds.ok) throw new Error(feeds.reason);
  return generateEngrave(tl, regions, tool, feeds.params);
}

/** Rebuild a solid from a meshed sweep result so its volume can be read. */
function meshSolid(mesh: NodeMeshOutput) {
  return new tl.Manifold(new tl.Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices }));
}

describe('drill CAM (#220)', () => {
  it('pecks a 4 mm hole four times, every move pure-Z, the last exactly on −4', () => {
    expect(peckDepths(4, 1)).toEqual([-1, -2, -3, -4]);
    const ir = drillIr(singleHole());
    expect(ir.operations).toHaveLength(1);
    const op = ir.operations[0]!;
    const cuts = op.moves.filter((m) => m.kind === 'feed');
    expect(cuts).toHaveLength(4);
    expect(cuts.map((m) => m.z)).toEqual([-1, -2, -3, -4]);
    // EVERY move — feed and rapid — repeats the hole's X and Y, so rule 9 (#174) sees no XY
    // motion below the rapid floor and the re-entry is a pure-Z retract/replunge.
    for (const m of op.moves) {
      expect(m.x).toBe(50);
      expect(m.y).toBe(30);
    }
  });

  it('posts no canned cycle: no G81, G82 or G83 anywhere in the file', () => {
    const g = engraveGenerate(tl, singleHole());
    expect(g.errors).toEqual([]);
    expect(g.nc).not.toBeNull();
    expect(/\bG8[123]\b/.test(g.nc as string)).toBe(false);
  });

  it('simulates removal equal to π r² × 4, and the peck re-entries raise no rapid-through-stock', () => {
    const job = singleHole();
    const g = engraveGenerate(tl, job);
    expect(g.errors).toEqual([]);
    expect(g.ok).toBe(true);
    expect(g.verify?.findings.filter((f) => f.severity === 'error')).toEqual([]);
    const tool = jobTool(job);
    if (tool === null) throw new Error(`${TOOL_KEY} is not in the tool library`);
    const radius = 3.175 / 2;
    const session: SimSession = createSimSession(tl);
    try {
      const load: SimLoadOk = (() => {
        const l = session.load(g.nc as string, toSetup(job, Z1), tool, Z1.id);
        if (!l.ok) throw new Error(`simulation refused: ${JSON.stringify(l.diagnostics)}`);
        return l;
      })();
      // The re-entry rapid down an open hole is in air: the gate must not fire.
      expect(load.diagnostics.filter((d) => d.code === 'rapid-through-stock')).toEqual([]);
      expect(load.meshes.removal).not.toBeNull();
      const removed = meshSolid(load.meshes.removal as NodeMeshOutput);
      const volume = removed.volume();
      removed.delete();
      const expected = Math.PI * radius * radius * 4;
      expect(Math.abs(volume - expected) / expected).toBeLessThan(0.02);
      expect(session.oracle(g.predicted).ok).toBe(true);
    } finally {
      session.dispose();
    }
  }, 30_000);

  it('visits a 3 × 2 array at 10 mm pitch in nearest-neighbour order', () => {
    const array: EngraveDrill = {
      id: 'grid',
      kind: 'drill-array',
      name: 'grid',
      position: { x: 50, y: 30 },
      rotation: 0,
      depth: 2,
      enabled: true,
      through: false,
      count: { x: 3, y: 2 },
      pitch: { x: 10, y: 10 },
    };
    const ir = drillIr(drillJob([array], { peck: 1 }));
    expect(ir.operations).toHaveLength(1);
    const op = ir.operations[0]!;
    // Every positioned move, collapsed to the sequence of distinct XY the tool visits.
    const visits: string[] = [];
    let last: string | null = null;
    for (const m of op.moves) {
      if (!Number.isFinite(m.x) || !Number.isFinite(m.y)) continue;
      const key = `${m.x},${m.y}`;
      if (key !== last) visits.push(key);
      last = key;
    }
    // Six holes, nearest-neighbour from the origin. Every step is 10 mm; the ties (a hole's
    // right neighbour and the hole above are equidistant) break on the smaller X, which makes
    // the traversal a serpentine up the first column and across.
    expect(visits).toEqual([
      '50,30',
      '50,40',
      '60,40',
      '60,30',
      '70,30',
      '70,40',
    ]);
    expect(orderHolesNearest([[70, 40], [50, 30], [60, 40]])).toEqual([[50, 30], [60, 40], [70, 40]]);
  });

  it('refuses to drill with a tool that is not a flat end mill, naming the shape', () => {
    const { regions } = engraveRegions(tl, singleHole());
    const ball = flatEndMill(3.175, { shape: 'ball', typeText: 'Ball End' });
    const feeds = feedsFor('softwood', ball, Z1);
    // The feeds table refuses a ball cutter before CAM even runs; the CAM refusal is the belt
    // to that braces and is what the issue's test names.
    expect(feeds.ok).toBe(false);
    expect(() => generateEngrave(tl, regions, ball, {
      rpm: 12000, feed: 500, plungeFeed: 200, stepDown: 1, stepOver: 1, peck: 1, air: false,
    })).toThrow(/flat end mill only/);
  });

  it('round-trips through the schema, and a pre-#220 document keeps no drills key', () => {
    const job = drillJob([
      {
        id: 'port',
        kind: 'drill',
        position: { x: 50, y: 30 },
        rotation: 0,
        depth: 4,
        enabled: true,
        through: false,
      },
      {
        id: 'grid',
        kind: 'drill-array',
        position: { x: 20, y: 20 },
        rotation: 15,
        depth: 2,
        enabled: true,
        through: false,
        count: { x: 3, y: 2 },
        pitch: { x: 10, y: 8 },
      },
    ]);
    const parsed = parseEngraveJob(job);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job.drills).toHaveLength(2);
    expect(parsed.job.drills![1]!.kind).toBe('drill-array');
    // A job with no drills keeps no key at all, so a pre-#220 file round-trips byte-for-byte.
    const plain = parseEngraveJob(defaultEngraveJob());
    expect(plain.ok).toBe(true);
    if (!plain.ok) return;
    expect('drills' in plain.job).toBe(false);
    // A fractional count is refused rather than floored silently.
    const bad = parseEngraveJob({
      ...job,
      drills: [{ ...(job.drills![1]!), count: { x: 1.5, y: 2 } }],
    });
    expect(bad.ok).toBe(false);
  });
});

describe('drill findings (#220)', () => {
  /** The codes `validateJob` raises for a drill job. */
  const codes = (job: EngraveJob) => validateJob(job).map((f) => f.code);

  it('refuses a through hole until #213 and #218 land', () => {
    const job = drillJob([{ ...(singleHole().drills![0]!), through: true }]);
    expect(codes(job)).toContain('drill-through-unavailable');
  });

  it('flags a hole whose rim runs off the blank', () => {
    const job = drillJob([{ ...(singleHole().drills![0]!), position: { x: 1, y: 30 } }]);
    expect(codes(job)).toContain('drill-outside-stock');
  });

  it('warns that an unrecorded cutter is not proven centre-cutting', () => {
    const job: EngraveJob = { ...singleHole(), toolKey: 'flat-1.0' }; // centreCutting is null
    expect(defaultEngraveJob().toolKey).toBe('flat-1.0');
    const f = validateJob(job).find((x) => x.code === 'plunge-unproven');
    expect(f?.severity).toBe('warning');
  });

  it('refuses a hole deeper than the cutter flute', () => {
    const base = drillJob([{ ...(singleHole().drills![0]!), depth: 13 }]);
    const job: EngraveJob = { ...base, stock: { ...base.stock, thickness: 30 } };
    expect(codes(job)).toContain('drill-too-deep');
  });
});
