// #753 — THE SPLIT-HELIX FIXTURE'S ONE SOURCE: the two rods' IR and their posted programs.
//
// The bench records the programs as files under docs/bench/2026-10-28-z1-real-jobs/jobs/
// (`j26-split-helix-A.nc`, `-B.nc`). They are written from `splitPosted`, and
// tests/unit/exportSplitHelix.spec.ts asserts the committed files are this generator's exact text,
// so a change to the fixture cannot leave the bench record behind. Regenerate them with:
//
//   CM_EXPORT_SPLIT_HELIX=1 npx vitest run tests/unit/exportSplitHelix.spec.ts
//
// The header's tool key is a REGISTRY key (`flat-3.175x12-metal`), not a fixture name: the app's
// Simulate panel resolves the file's stated cutter by that key when the bench file is opened there.
import path from 'node:path';
import { postZ1, type PostContext } from '@/engine/cnc/post/z1';
import { flatEndMill } from '@/engine/cnc/tool';
import { Z1 } from '@/engine/cnc';
import type { CamMove, ToolpathIR } from '@/engine/cnc/cam/ir';

export const R = 10;
export const L = 30;
export const RT = 1.5875; // ⌀3.175 flat end mill — the vendor's bit
export const TOOL = flatEndMill(3.175);
export const X0 = 5;
export const X1 = 25;
export const TURNS = 1;
export const PITCH = (360 * TURNS) / (X1 - X0); // degrees per mm

/** The post context both bench programs carry. */
export const POST_CTX: PostContext = {
  jobName: 'split-helix column',
  stock: { length: L, width: 2 * R, thickness: 2 * R },
  materialName: 'softwood',
  zDatum: 'rotary-axis',
  origin: 'topFrontLeft',
  camVersion: '1.0.0',
  toolKey: 'flat-3.175x12-metal',
};

/**
 * One rod's helicoid IR: the tool over the axis, its tip at `z`, A linear in X over the cut span.
 * Piece B is the same helix at `offset` 180°.
 */
export function splitIr(offset: number, z: number, pitchDegPerMm: number = PITCH): ToolpathIR {
  const chords = 720;
  const moves: CamMove[] = [{ kind: 'rapid', x: X0, y: 0, z: R + 3, a: offset }];
  for (let i = 0; i <= chords; i++) {
    const t = i / chords;
    moves.push({
      kind: 'feed',
      x: X0 + (X1 - X0) * t,
      y: 0,
      z,
      a: offset + pitchDegPerMm * (X1 - X0) * t,
      f: 500,
    });
  }
  moves.push({ kind: 'rapid', x: X1, y: 0, z: R + 3, a: offset + pitchDegPerMm * (X1 - X0) });
  return {
    frame: 'rotary',
    rotary: { radius: R },
    tool: TOOL,
    toolNumber: 1,
    spindleRpm: 12000,
    air: true,
    safeZ: R + 3,
    hopZ: R + 1,
    operations: [{ number: 1, name: `split helix ${offset}°`, labelId: '', depth: R, estimatedSeconds: 5, moves }],
  };
}

/** One piece's posted program — the exact text the bench .nc files hold. Throws on a post refusal. */
export function splitPosted(offset: number, z = 0): { text: string; ir: ToolpathIR } {
  const ir = splitIr(offset, z);
  const posted = postZ1(ir, POST_CTX, Z1);
  if (!posted.ok) throw new Error(`the post refused the ${offset}° piece: ${posted.errors.join('; ')}`);
  return { text: posted.text, ir };
}

/** The bench folder both .nc records live in (relative to the app's working directory). */
export function splitNcDir(): string {
  return path.join(process.cwd(), '..', 'docs', 'bench', '2026-10-28-z1-real-jobs', 'jobs');
}

export const SPLIT_NC = { A: 'j26-split-helix-A.nc', B: 'j26-split-helix-B.nc' } as const;
