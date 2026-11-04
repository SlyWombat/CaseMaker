/**
 * E's measurement harness (#959, temporary, not committed): the FULL tray through
 * `planTreePrograms` — pockets + the curved remainder + rims, the same call
 * `opsAcceptance959.spec.ts`'s "plans pockets, the curved remainder and rims together" case makes —
 * with every posted program written as an NC so the page's own goal_check.py can score the ball
 * finish the facts-level acceptance path does not include.
 *
 * Kept in the acceptance worktree only; the committed spec owns the product check.
 */
import fs from 'node:fs';

import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { stepToMesh } from '@/engine/import/stepMesh';
import { recogniseFeatures } from '@/engine/cnc/cam/model/features';
import { makeClipperOffset } from '@/engine/cnc/cam/engraveJob';
import { flatEndMill } from '@/engine/cnc/tool';
import { postZ1, type PostContext } from '@/engine/cnc/post/z1';
import { Z1 } from '@/engine/cnc/machine';
import { TOOL_CHANGE_SECONDS } from '@/engine/cnc/engrave/smartPick';
import { planTreePrograms } from '@/engine/cnc/cam/model/plan';

const TRAY = '/mnt/c/projects/Case Maker/.scratch/makerables/dl/modular-stackable-tool-trays/70mm_Tool_Tray-msgtf7oi.step';
const OUT = '/tmp/e965-tray-curved';

describe('#959 E harness — the full tray, curved pipeline', () => {
  it('plans and posts the whole tree', async () => {
    const bytes = fs.readFileSync(TRAY);
    const read = await stepToMesh(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, 'recognition');
    const stock: [number, number] = [110, 140];
    const modelTop = -1.2;
    const { min, max } = read.mesh.bbox;
    const dx = stock[0] / 2 - (min[0] + max[0]) / 2;
    const dy = stock[1] / 2 - (min[1] + max[1]) / 2;
    const dz = modelTop - max[2];
    const positions = Float32Array.from(read.mesh.positions);
    for (let i = 0; i < positions.length; i += 3) {
      positions[i] = positions[i]! + dx;
      positions[i + 1] = positions[i + 1]! + dy;
      positions[i + 2] = positions[i + 2]! + dz;
    }
    const mesh = { positions, indices: read.mesh.indices };
    const tree = recogniseFeatures({ triangles: mesh, faceId: read.faceId }, { up: [0, 0, 1], stockTop: 0 }, tl);
    let mn: [number, number, number] = [Infinity, Infinity, Infinity];
    let mx: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let v = 0; v < positions.length; v += 3) {
      for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a]!, positions[v + a] as number); mx[a] = Math.max(mx[a]!, positions[v + a] as number); }
    }
    const geometry = { triangles: { positions, indices: read.mesh.indices, triangleCount: read.mesh.indices.length / 3, bbox: { min: mn, max: mx } } };
    const flat = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6' });
    const ball = flatEndMill(6, { number: 2, id: 'ball-6', name: 'ball-6', shape: 'ball', typeText: 'Ball End' });
    const vbit = flatEndMill(3.175, { number: 3, id: 'v90', name: '91 chamfer', shape: 'chamfer', typeText: 'Chamfer', angle: 90, halfAngle: 45, tipDiameter: 0.1 });
    const smallFlat = flatEndMill(3.175, { number: 4, id: 'flat-3.175', name: 'flat-3.175' });
    // THE ACCEPTANCE'S OWN POCKET CONFIG (opsAcceptance959's planTray): VENDOR_SET as the house
    // set and maxCutters = its length + 1 — so the only difference from the facts-level run is
    // the curved pipeline this harness adds.
    const VENDOR_SET = [flat, smallFlat, ball, vbit];
    const result = planTreePrograms(tree, {
      offset: makeClipperOffset(tl),
      pockets: {
        houseFlats: VENDOR_SET,
        stepDownMm: 1.5,
        feeds: { feedMmPerMin: 1000, plungeFeedMmPerMin: 300 },
        rapid: Z1.rapidEstimate,
        toolChangeSeconds: TOOL_CHANGE_SECONDS,
        spindleRpm: 12000,
        air: true,
        maxCutters: VENDOR_SET.length + 1,
      },
      curved: {
        geometry, flat, ball, vbit,
        stepDownMm: 1.5, bandMm: 0.3, stepOverMm: 3,
        feeds: { feedMmPerMin: 1000, plungeFeedMmPerMin: 300 },
        rapid: Z1.rapidEstimate, spindleRpm: 12000, air: true,
        edgeBreak: { legMm: 0.5 },
        toolNumberFor: (t: { number?: number }) => t.number ?? 1,
      },
    });
    console.log(`ops: ${result.ops.map((o) => o.kind).join(',')} | programs: ${result.programs.size} | unreachable: ${result.unreachable.length}`);
    expect(result.programs.size).toBeGreaterThan(0);
    fs.mkdirSync(OUT, { recursive: true });
    const ctx: PostContext = {
      jobName: 'tray-curved',
      stock: { length: 110, width: 140, thickness: 27.2 },
      materialName: 'hardwood', zDatum: 'probed-top-face', origin: 'topFrontLeft',
      camVersion: 'cand', toolKey: 'multi',
    };
    let n = 0;
    for (const [key, ir] of result.programs) {
      const posted = postZ1(ir, ctx, Z1);
      expect(posted.ok, `${key}: ${posted.ok ? '' : posted.errors.join('; ')}`).toBe(true);
      if (!posted.ok) continue;
      const file = `${OUT}/trayC-${String(++n).padStart(2, '0')}-${key}.nc`;
      fs.writeFileSync(file, posted.text);
      console.log(`${key}: ${posted.text.split('\n').length} lines -> ${file}`);
    }
  }, 900_000);
});
