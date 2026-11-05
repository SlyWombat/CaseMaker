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
 * (`frame.up = [0, 0, 1]`), the design mesh's own highest point reachable by the cutter's WIDEST
 * body radius (`max(cutting radius, shank radius)` — `shankAwareProfile` below; a flat cylinder at
 * that one constant radius the whole length of the tool is a stated, deliberately conservative
 * stand-in for the real tapered/shouldered body: it can only ever flag MORE of a collision than
 * the true shape has, never fewer) must sit at or above `z`, within a small numerical margin. This
 * is the SAME `dropCutterHeight` (#957) ground truth `rough()`/`oppositeSurfaceSafeDepthMm`/this
 * branch's own pocket-shadow fix already read off this mesh — not a second, divergent source.
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
 * This tool's OWN widest body radius, cutting edge or shank, whichever is larger — a single
 * constant-radius flat cylinder standing in for the tool's real tapered/shouldered body (stated
 * simplification, this file's own header: conservative, never an under-count). `null` only when
 * the cutter has no drop-cutter profile at all (`profileOf`'s own stated scope: flat/ball/bull/V).
 */
function shankAwareProfile(tool: Tool): CutterProfile | null {
  const base = profileOf(tool);
  if (base === null) return null;
  const shankRadius = tool.handleDiameter !== null && tool.handleDiameter > 0 ? tool.handleDiameter / 2 : 0;
  const radiusMm = Math.max(base.radiusMm, shankRadius);
  return { radiusMm, flatRadiusMm: radiusMm, kind: 'flat' };
}

interface Collision {
  toolName: string;
  x: number;
  y: number;
  z: number;
  surfaceZ: number;
  penetrationMm: number;
}

/**
 * Every `feed` move of every posted program whose own cutter body (shank-aware) reaches BELOW the
 * mesh's real surface at that (x, y), beyond `marginMm`. `stockTopZ` converts a move's own
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
  const profileCache = new Map<string, CutterProfile | null>();
  for (const program of programs) {
    const tool = program.ir.tool;
    const cacheKey = program.toolKey;
    let profile = profileCache.get(cacheKey);
    if (profile === undefined) {
      profile = shankAwareProfile(tool);
      profileCache.set(cacheKey, profile);
    }
    if (profile === null) continue; // stated by `profileOf`'s own scope, not silently skipped: no shape this check covers
    for (const operation of program.ir.operations) {
      for (const m of operation.moves) {
        if (m.kind !== 'feed') continue;
        const absZ = m.z + stockTopZ;
        const surfaceZ = dropCutterHeight(profile, mesh, m.x, m.y);
        if (surfaceZ === null) continue; // nothing of the mesh within this cutter's reach here — open air, not a finding
        if (surfaceZ > absZ + marginMm) {
          bad.push({ toolName: tool.name || tool.shape, x: m.x, y: m.y, z: absZ, surfaceZ, penetrationMm: surfaceZ - absZ });
        }
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

      const marginMm = 0.01; // the job's own finish tolerance (`tolerances.finishMm` above) — numerical slack, not a new tuned number
      const findings: Collision[] = [];
      for (const setup of output.perSetup) {
        const [ux, uy, uz] = setup.features.frame.up;
        if (!(ux === 0 && uy === 0 && uz === 1)) continue; // #970's own stated scope: top setups only
        const programs = setup.programs.map((ir, i) => ({ toolKey: setup.sequence[i]?.cutterKey ?? ir.tool.name, ir }));
        findings.push(...shankCollisions(programs, mesh, setup.features.frame.stockTop, marginMm));
      }

      expect(
        findings,
        findings
          .slice(0, 20)
          .map((f) => `${f.toolName} at (${f.x.toFixed(2)}, ${f.y.toFixed(2)}): posted z ${f.z.toFixed(3)} is ${f.penetrationMm.toFixed(3)} mm below the real surface (${f.surfaceZ.toFixed(3)})`)
          .join('\n') + (findings.length > 20 ? `\n...and ${findings.length - 20} more` : ''),
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
