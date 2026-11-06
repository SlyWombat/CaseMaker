/**
 * #1005 / #1014 — THE WEDGE'S SLOPE IS NOT FINISHED, and this pin says so by name.
 *
 * A wedge-shaped cavity on the model engine posts rough → finish → pencil, yet the swept top is a
 * staircase of the ROUGH's 0.3 mm levels (29.43 % of the cavity within the 0.1 mm band). The rule
 * that skips the slope is #1014's: the finish's item-4a mask (`plan.ts`'s `leftoverAbove` →
 * `finishMask.ts`'s `maskCellsExact`) admits a point only where the ROUGH CUTTER'S CL stands more
 * than the finish band above the design; under the #982 no-flat fallback the rough cutter is the
 * BALL, whose CL hugs the design on a 5.7° slope (0.0025 mm) — under the 0.027 mm band — so the
 * whole slope is masked out while the rough leaves its terraces.
 *
 * `it.fails` UNTIL #1014 lands: the fix must take this to ≥ 90 % covered at ≤ 0.1 mm leftover,
 * then flip this test to a plain `it`. The cavity's safety is pinned regardless (cut-into 0).
 */
import { afterEach, describe, expect, it } from 'vitest';

import { setModelCamEnabled } from '@/engine/cnc/cam/model/plan';
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

afterEach(() => {
  setModelCamEnabled(false);
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

function stl(tris: Tri[]): string {
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

describe('#1005 — the wedge mould through the model engine', () => {
  it.fails(
    '#1014 — the wedge’s slope is FINISHED (≥ 90 % within the 0.1 mm band, ≤ 0.1 mm leftover): today the finish mask skips it and leaves the rough’s 0.3 mm terraces',
    async () => {
      setModelCamEnabled(true);
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
      const out = await generateGoalProgram(job, goal, tool, [], null, {});
      expect(out.ok, out.errors.map((e) => e.message).join('; ')).toBe(true);
      // The finish really was planned — this pin is about the mask, not about a missing op.
      const finishOps = (out.plan?.perSetup ?? []).flatMap((s) => s.ops.filter((o) => o.kind === 'finish'));
      expect(finishOps.length).toBeGreaterThan(0);

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
          if (!r.ok) return;
          const f = r.flatField!;
          if (field === null) field = f;
          else for (let k = 0; k < field.top.length; k++) if ((f.top[k] as number) < (field.top[k] as number)) field.top[k] = f.top[k] as number;
        }
      } finally {
        session.dispose();
      }
      expect(field).not.toBeNull();
      if (field === null) return;

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

      let cells = 0;
      let covered = 0;
      let maxLeftover = 0;
      let cutInto = 0;
      for (let jy = 0; jy < field.nv; jy++) {
        for (let ix = 0; ix < field.nu; ix++) {
          const x = field.u0 + ix * field.du;
          const y = field.v0 + jy * field.dv;
          const s = topZAt(solid.mesh, x, y);
          if (!(Number.isFinite(s) && s < -1e-6)) continue; // the cavity only
          const swept = topAt(field, x, y);
          cells++;
          const leftover = swept - s;
          if (leftover <= 0.1) covered++;
          if (leftover > maxLeftover) maxLeftover = leftover;
          if (-leftover > 0.05) cutInto++;
        }
      }
      expect(cells).toBeGreaterThan(1000);
      // Safety first: the cavity is never cut below its design (as measured at 29.43 %).
      expect(cutInto).toBe(0);
      const coveragePct = (100 * covered) / cells;
      expect(
        coveragePct,
        `covered ${coveragePct.toFixed(2)} % of ${cells} cells within 0.1 mm; max leftover ${maxLeftover.toFixed(3)} mm — #1014's finish mask skips the slope`,
      ).toBeGreaterThanOrEqual(90);
      expect(maxLeftover, 'max leftover over the cavity, mm').toBeLessThanOrEqual(0.1);
    },
    300_000,
  );
});
