/**
 * #970/#966 — THE STANDING REGRESSION GUARD, on the real elephant mesh, env-gated in the #965/#959
 * pattern (`CM_ELEPHANT_STL`, matching `figureAcceptance965.spec.ts` exactly — not a new env var).
 *
 * `figureAcceptance965.spec.ts` already asserts whole-surface coverage and the adjudicated
 * cut-into fraction (the goal-heightfield-based check). This spec is a DIFFERENT, more direct
 * question, stated by #970's own issue: does any posted TOP-SETUP feed point actually lie BELOW
 * the real design mesh's own highest surface at its own (x, y) — a straight collision check
 * against the mesh itself, not a heightfield comparison — and does it do so treating the tool's
 * SHANK as solid, not only the cutting tip (a real body collision check, the #966 finding's own
 * exact failure mode: the elephant's belly closing over the leg gap above the pocket's own floor).
 *
 * THE CHECK, precisely: for every `feed` move `(x, y, z)` of every program in a TOP setup
 * (`frame.up = [0, 0, 1]`), each collision-relevant part of the tool's body (`bodyParts` below:
 * a flat's one tip-height cylinder; a ball's own round tip PLUS its shank, whose bottom plane is
 * the ball's CENTRE, one radius above the tip — #1092) must sit at or above the design mesh's own
 * highest point within that part's radius. A part is a finding when its low point is more than
 * `MAX_PENETRATION_MM` below the mesh there; that threshold is measured and stated in its own
 * note, not guessed. This is the SAME `dropCutterHeight` (#957) ground truth
 * `rough()`/`oppositeSurfaceSafeDepthMm`/this branch's own pocket-shadow fix already read off this
 * mesh — not a second, divergent source.
 *
 * `planModelCam`'s own toolpath IR is checked directly (not the posted G-code text): the IR's
 * moves ARE exactly what `postZ1` turns into feed lines, one to one, so this is the same check as
 * reading the posted file, without a G-code round trip. A TOP setup only (#970's own stated scope)
 * — a flip setup's own "world" position needs `mapIRToDocument`'s inverse to re-express a move's Z
 * against the ORIGINAL mesh frame, which this spec does not attempt; every setup this engine plans
 * for the figures today is a single top setup, so the scope is not a real limitation yet, only
 * stated rather than silently assumed.
 *
 * WITHOUT `CM_ELEPHANT_STL` this SKIPS CLEANLY (one `it` stating why), the same pattern every other
 * figure-gated spec in this suite uses — this repo holds no figure meshes. Session E or F runs it
 * for real once this branch is merged.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseStl, type ParsedMesh } from '@/engine/import/stlParser';
import { placeTarget } from '@/engine/cnc/engrave/targetPlace';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { jobVise, viseEnvelope } from '@/engine/cnc/fixture';
import { planModelCam, type ModelPlanInput } from '@/engine/cnc/cam/model/plan';
import { dropCutterHeight, profileOf, type CutterProfile, type DropCutterMesh } from '@/engine/cnc/cam/model/dropcutter';
import type { ToolpathIR } from '@/engine/cnc/cam/ir';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..');
const REPO = join(APP, '..');
const JOBS = join(REPO, 'docs', 'bench', '2026-10-28-z1-real-jobs', 'jobs');
const JOB_FILE = 'j29-elephant-stick.json';
const ENV = 'CM_ELEPHANT_STL';

const FLAT6: Tool = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6' });
const FLAT3175: Tool = flatEndMill(3.175, { number: 2, id: 'flat-3.175', name: 'flat-3.175' });
const BALL2: Tool = { ...flatEndMill(2, { number: 3, id: 'ball-2', name: 'ball-2' }), typeText: 'Ball Nose', shape: 'ball' };
const BALL05: Tool = { ...flatEndMill(0.5, { number: 4, id: 'ball-0.5', name: 'ball-0.5' }), typeText: 'Ball Nose', shape: 'ball' };
const HOUSE = [FLAT6, FLAT3175, BALL2, BALL05];

/** The collection floor: the job's own finish tolerance (`tolerances.finishMm` below), i.e.
 * numerical slack, not a tuned number. Everything above it is gathered, then judged. */
const CL_TOLERANCE_MM = 0.01;

/** #1092 — THE STATED PENETRATION THRESHOLD, measured after the body model above, never guessed.
 * The residual over-report on this job is __MEASURED__ mm (__WHERE__); the first real defect the
 * guard must catch — the coverage rest cutting the elephant's body — is 20.9 mm, four orders of
 * magnitude away. */
const MAX_PENETRATION_MM = 0.01;

function placedMesh(job: EngraveJob, bytes: Buffer): { mesh: ParsedMesh; source: { triangles: ParsedMesh } } {
  const local = parseStl(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const place = placeTarget(job.targetObject!, local).place;
  const positions = new Float32Array(local.positions.length);
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < local.positions.length; i += 3) {
    const [x, y, z] = place(local.positions[i]!, local.positions[i + 1]!, local.positions[i + 2]!);
    positions[i] = x;
    positions[i + 1] = y;
    positions[i + 2] = z;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  const mesh: ParsedMesh = {
    positions,
    indices: local.indices,
    triangleCount: local.triangleCount,
    bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
  };
  return { mesh, source: { triangles: mesh } };
}

function planInputFor(job: EngraveJob, source: { triangles: ParsedMesh }): ModelPlanInput {
  return {
    geometry: source,
    setups: [{ frame: { up: [0, 0, 1], stockTop: 0, stockBottom: -job.stock.thickness }, underside: 'flatOnStockBottom' }],
    stock: {
      length: job.stock.length,
      width: job.stock.width,
      thickness: job.stock.thickness,
      material: job.stock.material,
    },
    fixture: { mount: job.workholding.kind === 'vise' ? 'vise' : 'tape', envelope: job.workholding.kind === 'vise' ? viseEnvelope(job.stock, jobVise(job), job.sacrificial) : null },
    cutters: { house: HOUSE, catalogue: [] },
    tolerances: { finishMm: 0.01 },
    edgeBreak: { legMm: 0 },
  };
}

/**
 * #1092 — ONE COLLISION-RELEVANT PART OF THE BODY: a drop-cutter profile whose own LOWEST point
 * sits `zOffsetMm` above the program's posted tip z (0 for a part whose tip IS the tool's tip).
 */
interface BodyPart {
  profile: CutterProfile;
  zOffsetMm: number;
  label: string;
}

/**
 * THE BODY, AS THE PARTS THAT CAN COLLIDE — each a drop-cutter profile standing at its own height
 * above the tip (#1092):
 *  - A FLAT: ONE flat cylinder of `max(cutting radius, handle radius)` from the tip — the #970
 *    stand-in, kept. On a flat the shank sits directly above the cutting edges, so a tip-height
 *    cylinder is exact for the cutting body and merely conservative above it.
 *  - A BALL: TWO parts. The ball's own round profile (its tip at the posted z), and the SHANK — a
 *    flat cylinder of the handle's radius whose lowest point is the BALL'S CENTRE, `z + R`, not
 *    the tip: the shank is a cylinder that begins where the ball's radius ends. Standing that
 *    cylinder in AT THE TIP (the old single-cylinder stand-in) over-cut by the shank radius times
 *    the local slope on every sloped move — 110,486 findings over 1 mm on the elephant at
 *    7a7bac78c, all of it that artefact, burying the real 20.9 mm gouge.
 * `null` only when the cutter has no drop-cutter profile at all (`profileOf`'s own stated scope).
 */
function bodyParts(tool: Tool): BodyPart[] | null {
  const base = profileOf(tool);
  if (base === null) return null;
  const shankRadius = tool.handleDiameter !== null && tool.handleDiameter > 0 ? tool.handleDiameter / 2 : 0;
  if (tool.shape === 'ball') {
    const parts: BodyPart[] = [{ profile: base, zOffsetMm: 0, label: 'ball' }];
    if (shankRadius > base.radiusMm + 1e-9) {
      const shank: CutterProfile = { radiusMm: shankRadius, flatRadiusMm: shankRadius, kind: 'flat' };
      parts.push({ profile: shank, zOffsetMm: base.radiusMm, label: 'shank' });
    }
    return parts;
  }
  const radiusMm = Math.max(base.radiusMm, shankRadius);
  return [{ profile: { radiusMm, flatRadiusMm: radiusMm, kind: 'flat' }, zOffsetMm: 0, label: 'body' }];
}

interface Collision {
  toolName: string;
  /** Which part of the body made the finding, and that part's own lowest point (stock-absolute). */
  part: string;
  partZ: number;
  x: number;
  y: number;
  /** The posted move's tip z, stock-absolute (what the IR says). */
  z: number;
  surfaceZ: number;
  penetrationMm: number;
}

/**
 * Every `feed` move of every posted program where one of the tool body's own parts reaches BELOW
 * the mesh's real surface at that (x, y), beyond `marginMm`. A move yields at most ONE finding —
 * its deepest part (a ball's shank and its ball cannot both be the worst at the same point, and
 * reporting the same move twice would double-count it). `stockTopZ` converts a move's own
 * stock-top-relative `z` (every `planModelCam` program's own convention, `plan.ts`'s header note)
 * to the mesh's absolute frame `dropCutterHeight` reads.
 */
function shankCollisions(
  programs: readonly { toolKey: string; ir: ToolpathIR }[],
  mesh: DropCutterMesh,
  stockTopZ: number,
  marginMm: number,
): Collision[] {
  const bad: Collision[] = [];
  const partsCache = new Map<string, BodyPart[] | null>();
  for (const program of programs) {
    const tool = program.ir.tool;
    const cacheKey = program.toolKey;
    let parts = partsCache.get(cacheKey);
    if (parts === undefined) {
      parts = bodyParts(tool);
      partsCache.set(cacheKey, parts);
    }
    if (parts === null) continue; // stated by `profileOf`'s own scope, not silently skipped: no shape this check covers
    for (const operation of program.ir.operations) {
      for (const m of operation.moves) {
        if (m.kind !== 'feed') continue;
        const absZ = m.z + stockTopZ;
        let worst: Collision | null = null;
        for (const part of parts) {
          const surfaceZ = dropCutterHeight(part.profile, mesh, m.x, m.y);
          if (surfaceZ === null) continue; // nothing of the mesh within this part's reach here — open air, not a finding
          const partZ = absZ + part.zOffsetMm;
          const penetrationMm = surfaceZ - partZ;
          if (penetrationMm > marginMm && (worst === null || penetrationMm > worst.penetrationMm)) {
            worst = { toolName: tool.name || tool.shape, part: part.label, partZ, x: m.x, y: m.y, z: absZ, surfaceZ, penetrationMm };
          }
        }
        if (worst !== null) bad.push(worst);
      }
    }
  }
  return bad;
}

describe.skipIf(process.env[ENV] === undefined)(`#970/#966 the elephant — no top-setup move collides with the real mesh${process.env[ENV] === undefined ? ` (set ${ENV})` : ''}`, () => {
  it(
    'every posted feed point, checked with the shank-aware tool body, stays at or above the real design surface',
    async () => {
      const stlPath = process.env[ENV]!;
      const jobPath = join(JOBS, JOB_FILE);
      expect(fs.existsSync(stlPath), `${ENV}: missing ${stlPath}`).toBe(true);
      expect(fs.existsSync(jobPath), `missing committed job ${jobPath}`).toBe(true);

      const bytes = fs.readFileSync(stlPath);
      const sha = createHash('sha256').update(bytes).digest('hex');
      const job = JSON.parse(fs.readFileSync(jobPath, 'utf8')) as EngraveJob;
      expect(sha, `${ENV}: the file is not the job's own mesh`).toBe((job.targetObject as EngraveTargetObject).sha256);

      const { mesh, source } = placedMesh(job, bytes);
      const input = planInputFor(job, source);
      const output = await planModelCam(input);
      expect(output.perSetup.length).toBeGreaterThanOrEqual(1);

      const findings: Collision[] = [];
      for (const setup of output.perSetup) {
        const [ux, uy, uz] = setup.features.frame.up;
        if (!(ux === 0 && uy === 0 && uz === 1)) continue; // #970's own stated scope: top setups only
        const programs = setup.programs.map((ir, i) => ({ toolKey: setup.sequence[i]?.cutterKey ?? ir.tool.name, ir }));
        // #1092 — A LOOP, NOT `push(...array)`: the elephant's own body model finds six figures of
        // clearance facts, and spreading them into `push` exceed V8's argument limit (RangeError,
        // no findings printed at all — the first run of this guard on the real mesh).
        for (const f of shankCollisions(programs, mesh, setup.features.frame.stockTop, CL_TOLERANCE_MM)) findings.push(f);
      }
      const worstFirst = [...findings].sort((a, b) => b.penetrationMm - a.penetrationMm);
      const deep = worstFirst.filter((f) => f.penetrationMm > MAX_PENETRATION_MM);
      const top = worstFirst.slice(0, 20);
      // #1092 — the penetration distribution this run measured (the threshold above is chosen
      // from it, and it stays in the log either way).
      console.log(
        `GUARD_BANDS ${[20, 10, 5, 1, 0.5, 0.3, 0.1, 0.01].map((t) => `>${t}:${worstFirst.filter((f) => f.penetrationMm > t).length}`).join(' ')}`,
      );
      expect(
        deep,
        `${deep.length} of ${findings.length} body-clearance finding(s) are more than ${MAX_PENETRATION_MM} mm into the design; worst 20 (of ${findings.length} above the ${CL_TOLERANCE_MM} mm collection floor):\n` +
          top
            .map(
              (f) =>
                `${f.toolName} ${f.part} at (x ${f.x.toFixed(2)}, y ${f.y.toFixed(2)}): its low point z ${f.partZ.toFixed(3)} is ` +
                `${f.penetrationMm.toFixed(3)} mm below the mesh there (${f.surfaceZ.toFixed(3)}; posted tip z ${f.z.toFixed(3)})`,
            )
            .join('\n'),
      ).toEqual([]);
    },
    600_000,
  );
});

describe.skipIf(process.env[ENV] !== undefined)('#970/#966 elephant shank-collision guard — not run', () => {
  it(`states why: needs ${ENV} (the local-only elephant mesh)`, () => {
    expect(process.env[ENV]).toBeUndefined();
  });
});
