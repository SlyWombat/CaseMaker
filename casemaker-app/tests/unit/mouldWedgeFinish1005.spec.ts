/**
 * #1005 / #1014 — THE WEDGE MOULD: the cavity's SAFETY is a plain test; the slope's unfinished
 * state is a named `it.fails`.
 *
 * Safety (plain `it`): the plan posts a finish op and the swept top never goes below the mould
 * solid — a failure there is never masked.
 *
 * Finish (plain `it` now that #1014 lands): before the fix the wedge's slope came off the plan as
 * the ROUGH's 0.3 mm terraces (29.43 % of the cavity within the 0.1 mm band) because the finish's
 * item-4a mask (`plan.ts`'s `leftoverAbove` → `finishMask.ts`'s `maskCellsExact`) admitted a
 * point only where the ROUGH CUTTER'S CL stood more than the finish band above the design — and
 * under the #982 no-flat fallback the rough cutter is the BALL, whose CL hugs a 5.7° slope
 * (0.0025 mm, under the 0.027 mm band). #1014 makes the mask read what the rough LEFT
 * (`roughLeftAbove`), and this test was `it.fails` until it landed.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { closeOpenSheet } from '@/engine/cnc/engrave/closeSheet';
import { mouldSolidOf } from '@/engine/cnc/engrave/mouldSolid';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { clearTargetObjectMeshCache } from '@/engine/import/targetObject';
import { flatEndMill } from '@/engine/cnc/tool';
import { generateGoalProgram } from '@/workers/sim/engraveGenerate';
import { createSimSession } from '@/workers/sim/session';
import { stubSetup } from '@/engine/cnc/setup';
import { Z1 } from '@/engine/cnc/machine';
import { rectProfile } from '@/engine/compiler/profile';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import type { FlatField } from '@/workers/geometry/carriedField';
import type { ParsedMesh } from '@/engine/import/stlParser';
import { tl } from './helpers/manifoldExec';
import { stl } from './helpers/meshes';

afterEach(() => {
  clearTargetObjectMeshCache();
});

type V = [number, number, number];
type Tri = [V, V, V];

/** The wedge over [0,20]², z = −0.1·y — the #1005 fixture, 5.7° of slope. */
function wedgeTris(): Tri[] {
  const p = (x: number, y: number): V => [x, y, -0.1 * y];
  return [
    [p(0, 0), p(20, 0), p(20, 20)],
    [p(0, 0), p(20, 20), p(0, 20)],
  ];
}

/** The topmost Z of a mesh under (x, y) — the mould solid's own surface, as the seam builds it. */
function topZAt(mesh: ParsedMesh, x: number, y: number): number {
  let best = -Infinity;
  const p = mesh.positions;
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const a = mesh.indices[t]! * 3;
    const b = mesh.indices[t + 1]! * 3;
    const c = mesh.indices[t + 2]! * 3;
    const ax = p[a]!, ay = p[a + 1]!, az = p[a + 2]!;
    const bx = p[b]!, by = p[b + 1]!, bz = p[b + 2]!;
    const cx = p[c]!, cy = p[c + 1]!, cz = p[c + 2]!;
    const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(den) < 1e-12) continue;
    const wa = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / den;
    const wb = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / den;
    const wc = 1 - wa - wb;
    if (wa < -1e-9 || wb < -1e-9 || wc < -1e-9) continue;
    const z = wa * az + wb * bz + wc * cz;
    if (z > best) best = z;
  }
  return best;
}

function topAt(f: FlatField, x: number, y: number): number {
  const i = Math.min(f.nu - 1, Math.max(0, Math.round((x - f.u0) / f.du)));
  const j = Math.min(f.nv - 1, Math.max(0, Math.round((y - f.v0) / f.dv)));
  return f.top[j * f.nu + i] as number;
}

interface WedgeMeasurement {
  /** Finish ops the plan posted (must be > 0 — the safety test's own check). */
  finishOps: number;
  /** Cavity cells at the sweep's 0.1 mm grid. */
  cells: number;
  /** Cells whose swept top is within 0.1 mm of the design. */
  covered: number;
  /** Cells farther than the ball's radius from a cavity wall. */
  reachable: number;
  /** Max leftover over the REACHABLE cells (mm). */
  maxLeftover: number;
  /** Cells cut below the design by more than 0.05 mm (must be 0). */
  cutInto: number;
}

/** One plan + sweep + measure, shared by the safety test and the #1014 finish test. */
let shared: Promise<WedgeMeasurement> | null = null;
function measureWedge(): Promise<WedgeMeasurement> {
  shared ??= (async (): Promise<WedgeMeasurement> => {
    const goal: EngraveTargetObject = {
      id: 'goal-1',
      name: 'wedge.stl',
      format: 'stl',
      sha256: 'e'.repeat(64),
      data: stl(wedgeTris()),
      size: { x: 20, y: 20, z: 2 },
      position: { x: 30, y: 20, z: 0 },
      rotation: 0,
      enabled: true,
      role: 'goal',
      goalMode: 'mold',
    };
    const base = defaultEngraveJob();
    const job: EngraveJob = { ...base, labels: [], shapes: [], targetObject: goal };
    const tool = flatEndMill(1, { shape: 'ball' });
    const out = await generateGoalProgram(job, goal, tool, null, { shop: {} });
    expect(out.ok, out.errors.map((e) => e.message).join('; ')).toBe(true);
    const finishOps = (out.plan?.perSetup ?? []).flatMap((s) => s.ops.filter((o) => o.kind === 'finish')).length;

    const setup = stubSetup(
      { kind: 'prism', outline: rectProfile(job.stock.length, job.stock.width), thickness: job.stock.thickness },
      { kind: 'tape-down', contact: rectProfile(job.stock.length, job.stock.width) },
    );
    const session = createSimSession(tl);
    let field: FlatField | null = null;
    try {
      for (const program of out.programs) {
        const r = session.load(program.nc, setup, tool, Z1.id);
        expect(r.ok, r.ok ? '' : JSON.stringify(r.diagnostics).slice(0, 300)).toBe(true);
        if (!r.ok) throw new Error('sweep refused');
        const f = r.flatField!;
        if (field === null) field = f;
        else for (let k = 0; k < field.top.length; k++) if ((f.top[k] as number) < (field.top[k] as number)) field.top[k] = f.top[k] as number;
      }
    } finally {
      session.dispose();
    }
    expect(field).not.toBeNull();
    if (field === null) throw new Error('no field');

    // The mould solid, built exactly as the seam builds it.
    const positions = new Float32Array(wedgeTris().length * 9);
    let k = 0;
    for (const t of wedgeTris()) for (const v of t) {
      positions[k * 3] = v[0] + goal.position.x - 10;
      positions[k * 3 + 1] = v[1] + goal.position.y - 10;
      positions[k * 3 + 2] = v[2];
      k++;
    }
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
      minX = Math.min(minX, positions[i]!); maxX = Math.max(maxX, positions[i]!);
      minY = Math.min(minY, positions[i + 1]!); maxY = Math.max(maxY, positions[i + 1]!);
      minZ = Math.min(minZ, positions[i + 2]!); maxZ = Math.max(maxZ, positions[i + 2]!);
    }
    const placed: ParsedMesh = {
      positions,
      indices: new Uint32Array(wedgeTris().length * 3),
      triangleCount: wedgeTris().length,
      bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
    };
    for (let i = 0; i < placed.indices.length; i++) placed.indices[i] = i;
    const closed = closeOpenSheet(tl, placed, { skirtTo: 'lowestBoundary' });
    const solid = mouldSolidOf(tl, closed.mesh, { stock: job.stock, centreY: goal.position.y, stockTopZ: 0 });

    // The cavity, cell by cell (the sweep's own 0.1 mm grid).
    const nu = field.nu;
    const nv = field.nv;
    const inside = new Uint8Array(nu * nv);
    const design = new Float32Array(nu * nv);
    for (let jy = 0; jy < nv; jy++) {
      for (let ix = 0; ix < nu; ix++) {
        const x = field.u0 + ix * field.du;
        const y = field.v0 + jy * field.dv;
        const s = topZAt(solid.mesh, x, y);
        if (Number.isFinite(s) && s < -1e-6) {
          inside[jy * nu + ix] = 1;
          design[jy * nu + ix] = s;
        }
      }
    }
    // #1014's acceptance: coverage counts EVERY cavity cell (the ball's own 0.5 mm wall fillet is
    // geometry, not a defect, and only ~4 % of the cells), while the MAX LEFTOVER is judged only
    // where a ⌀1 ball can reach: cells farther than its radius from a cavity WALL. A wall cell is
    // inside the cavity, has a 4-neighbour outside it, and stands at least 0.05 mm below the rim
    // (the wedge's flush y = 10 edge is not a wall). The two-wall corner (39.9, 29.9) is
    // unreachable by any ⌀1 ball and stays a fact on both sides of #1014.
    const R = 0.5;
    const wall = new Uint8Array(nu * nv);
    for (let jy = 0; jy < nv; jy++) {
      for (let ix = 0; ix < nu; ix++) {
        if (inside[jy * nu + ix] !== 1) continue;
        const s = design[jy * nu + ix]!;
        if (Math.abs(s) < 0.05) continue;
        const nbrOutside =
          ix === 0 || jy === 0 || ix === nu - 1 || jy === nv - 1
            ? false
            : inside[jy * nu + ix - 1] !== 1 || inside[jy * nu + ix + 1] !== 1 || inside[(jy - 1) * nu + ix] !== 1 || inside[(jy + 1) * nu + ix] !== 1;
        if (nbrOutside) wall[jy * nu + ix] = 1;
      }
    }
    const reach = Math.ceil(R / Math.max(field.du, field.dv));
    const nearWall = new Uint8Array(nu * nv);
    for (let jy = 0; jy < nv; jy++) {
      for (let ix = 0; ix < nu; ix++) {
        if (wall[jy * nu + ix] !== 1) continue;
        for (let dj = -reach; dj <= reach; dj++) {
          for (let di = -reach; di <= reach; di++) {
            const j2 = jy + dj;
            const i2 = ix + di;
            if (i2 < 0 || j2 < 0 || i2 >= nu || j2 >= nv) continue;
            if (Math.hypot(di * field.du, dj * field.dv) <= R + 1e-9) nearWall[j2 * nu + i2] = 1;
          }
        }
      }
    }
    let cells = 0;
    let covered = 0;
    let reachable = 0;
    let maxLeftover = 0;
    let cutInto = 0;
    for (let jy = 0; jy < nv; jy++) {
      for (let ix = 0; ix < nu; ix++) {
        if (inside[jy * nu + ix] !== 1) continue;
        cells++;
        const swept = topAt(field, field.u0 + ix * field.du, field.v0 + jy * field.dv);
        const leftover = swept - design[jy * nu + ix]!;
        if (leftover <= 0.1) covered++;
        if (-leftover > 0.05) cutInto++;
        if (nearWall[jy * nu + ix] === 1) continue;
        reachable++;
        if (leftover > maxLeftover) maxLeftover = leftover;
      }
    }
    return { finishOps, cells, covered, reachable, maxLeftover, cutInto };
  })();
  return shared;
}

describe('#1005 — the wedge mould through the model engine', () => {
  it('is SAFE: the plan posts a finish op, and the sweep never cuts below the mould solid', async () => {
    const m = await measureWedge();
    expect(m.finishOps).toBeGreaterThan(0);
    expect(m.cutInto, 'cells cut more than 0.05 mm below the design').toBe(0);
  }, 300_000);

  it(
    '#1014 — the wedge’s slope is FINISHED: ≥ 90 % of the cavity within 0.1 mm, and ≤ 0.1 mm leftover everywhere a ⌀1 ball can reach',
    async () => {
      const m = await measureWedge();
      expect(m.cells).toBeGreaterThan(1000);
      expect(m.reachable, 'cells a ⌀1 ball can reach (outside the wall fillet)').toBeGreaterThan(0.9 * m.cells);
      const pct = (100 * m.covered) / m.cells;
      console.log(
        `#1014 wedge: covered ${pct.toFixed(2)} % of ${m.cells} cells within 0.1 mm; max leftover ${m.maxLeftover.toFixed(3)} mm over ${m.reachable} reachable cells; cut-into ${m.cutInto}`,
      );
      expect(
        pct,
        `covered ${pct.toFixed(2)} % of ${m.cells} cells within 0.1 mm; max leftover ${m.maxLeftover.toFixed(3)} mm over the ${m.reachable} reachable cells — #1014’s finish mask must admit the slope`,
      ).toBeGreaterThanOrEqual(90);
      expect(m.maxLeftover, 'max leftover where the ball can reach, mm').toBeLessThanOrEqual(0.1);
    },
    300_000,
  );
});
