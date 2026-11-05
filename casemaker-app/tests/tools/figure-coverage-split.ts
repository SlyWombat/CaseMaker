/**
 * #966 — THE THREE-WAY SPLIT OF A FIGURE'S UNCOVERED GOAL SURFACE, so the Manager can tell apart
 * three different reasons the elephant/panther sit below #965's 95 % whole-surface line:
 *
 *   1. CELLS A SECOND SETUP WOULD REACH — run the real `buildSetupSpecs`/`planModelCam` with a
 *      top+bottom `ModelPlanInput.setups` and find goal area that becomes covered by the UNION of
 *      both setups' actual output that was NOT covered by a single top-only plan (TODAY's actual
 *      plan, per `figureAcceptance965.spec.ts`'s own hardcoded single setup).
 *   2. CELLS NO SETUP REACHES — a HARD geometric reach limit: for every remaining uncovered cell,
 *      neither the top NOR the bottom orientation's house cutters can touch it at all (an undercut
 *      no cutter/orientation can enter), checked with `dropcutter.ts`'s raw, per-point contact
 *      primitive — independent of what was actually planned.
 *   3. CELLS A SETUP REACHES BUT NO STAGE CUT — the remainder: some setup+cutter combination CAN
 *      reach the surface (per category 2's own test), but nothing in the actual planned op
 *      sequence cut it. Attributed, approximately, to the stage (rough/rest/finish/pencil/
 *      contour/pocket) and cutter whose own posted path's bounding box covers the point but whose
 *      sweep missed it — see "CATEGORY 3'S ATTRIBUTION IS APPROXIMATE" below.
 *
 * NOT A SPEC: a tool, run via `tests/tools/goal-engine-breadth.ts`'s own CLI conventions (arg
 * parsing, `--out FILE`, an env-gated mesh path). This file's own `figureCoverageSplit` is the
 * pure, importable core (job + mesh bytes + options in, a plain result out); `main()` below is a
 * thin CLI wrapper around it, guarded so importing this module (the spec test does) never runs it.
 *
 * Run (mesh path env-gated, matching `CM_ELEPHANT_STL`/`CM_PANTHER_STL`'s own convention):
 *
 *   CM_FIGURE_STL=/path/to/lfs_elephant.stl \
 *   npx tsx --tsconfig tsconfig.scripts.json tests/tools/figure-coverage-split.ts \
 *     --job docs/bench/2026-10-28-z1-real-jobs/jobs/j29-elephant-stick.json \
 *     --out /tmp/elephant-cellmap.json
 *
 * CATEGORY 1'S CROSS-SETUP COMPARISON — A DELIBERATE DEPARTURE FROM `wholeSurfaceTop`'S PATTERN.
 * `figureAcceptance965.spec.ts`'s own `wholeSurfaceTop` stamps every setup's posted program onto
 * ONE SHARED `GoalHeightfield`, in the WORLD frame, taking the per-cell MIN across every program —
 * correct for a single top setup (today's only setup that function has ever actually been
 * exercised against: #965's acceptance spec hardcodes one setup; `USE_MODEL_CAM_ENGINE` is false
 * everywhere else). It is NOT obviously correct once a second, FLIPPED setup's own program joins
 * the same shared field for two reasons this tool's own validation (`figureCoverageSplit966.spec.ts`)
 * found stated nowhere else:
 *
 *   (a) a flipped setup's posted Z is MACHINE-relative to THAT setup's own probed top face
 *       (`setups.ts`'s own `documentXY` doc: "Z is never part of this map ... never a world
 *       coordinate"), not a world Z — so comparing/MIN-ing it directly against the top setup's
 *       world-aligned Z on one shared field silently assumes the two are the same reference frame,
 *       which they are not, by an offset of roughly the stock's own thickness;
 *   (b) a genuinely 3-D goal (not just a relief) can have TWO real surfaces at the SAME world XY
 *       column — e.g. the top of a cantilevered arm and, underneath it with open air between, the
 *       arm's own underside — which a SINGLE shared heightfield (one Z per column, by
 *       construction) cannot represent at all, flipped setup or not.
 *
 * This tool instead scores each setup's OWN contribution in ITS OWN frame: the goal mesh and a
 * freshly-sampled field BOTH rotated into that setup's frame (`rotatedGeometryFor`,
 * `sampleCoverageField` — the same per-side rotation `goalFlipPlan`'s own scoring already uses),
 * and that setup's OWN posted programs with their XY UN-mapped back to that frame (the exact
 * inverse of `mapIRToDocument`, which is self-inverse for the stated top/bottom scope once the
 * registration offset `registerSetupOrigin` found is subtracted first) before the SAME
 * `parseGcode`/`buildTimeline`/`exactSweptField` round trip #965's own pattern uses. A triangle is
 * "reached by setup N" when that setup's own result, at the point mapped into ITS OWN local frame,
 * is within `reachedMm` of THAT TRIANGLE'S OWN local Z — never a shared column's value, which
 * sidesteps (b) by construction. This is the single setup's own `goalCoverage` convention
 * ("mesh/goal/resultTop all in the SAME frame"), generalised to actually having two.
 *
 * CATEGORY 3'S ATTRIBUTION IS APPROXIMATE, STATED, NOT HIDDEN. `SetupPlan.notes`/`unreachable` are
 * free-text sentences, not structured records a tool can reliably parse back into "this exact
 * point, this exact stage" — and `PlannedOp.region.bounds` is an axis-aligned BOUNDING BOX, coarser
 * than the op's own actual cleared boundary. This tool's attribution is therefore: the smallest
 * (most specific) planned op, across every setup, whose OWN posted path's bounding box (feed moves
 * only, already in document/world XY) contains the point — named by its `kind` and cutter — with
 * an explicit `unattributed` bucket, and the setup's own `notes`, for a point no planned op's own
 * swept bounding box comes anywhere near. A point this names is NOT a proof that stage definitely
 * should have cut it, only that its own planned work happened nearby; see the header above and
 * this tool's own `caveats` output field.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseStl, type ParsedMesh } from '@/engine/import/stlParser';
import { placeTarget } from '@/engine/cnc/engrave/targetPlace';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { Z1 } from '@/engine/cnc/machine';
import { postZ1, type PostContext } from '@/engine/cnc/post/z1';
import type { ToolpathIR } from '@/engine/cnc/cam/ir';
import { jobVise, viseEnvelope } from '@/engine/cnc/fixture';
import { parseGcode, setupFromHeader, stubSetup } from '@/engine/cnc';
import { jobMount } from '@/engine/cnc/engrave/jobSetup';
import { buildTimeline } from '@/engine/cnc/emulator/timeline';
import { exactSweptField } from '@/workers/sim/sweptPoint';
import { sampleGoalHeightfield, type GoalHeightfield } from '@/engine/cnc/engrave/goalHeightfield';
import {
  goalTopAt,
  sampleCoverageField,
  type CoverageMesh,
  type CoverageOptions,
  type ResultTop,
  COVERAGE_DEFAULTS,
} from '@/engine/cnc/engrave/goalCoverage';
import { dropCutterHeight, profileOf, type CutterProfile, type DropCutterMesh } from '@/engine/cnc/cam/model/dropcutter';
import { planModelCam, type ModelPlanInput, type ModelPlanOutput, type SetupPlan, type SetupSpec } from '@/engine/cnc/cam/model/plan';
import { buildSetupSpecs, documentXY, registerSetupOrigin, rotatedGeometryFor } from '@/engine/cnc/cam/model/setups';
import type { FeatureSource, SetupFrame } from '@/engine/cnc/cam/model/features';
import type { MountSpec } from '@/engine/cnc/setups/types';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE HOUSE — matches `figureAcceptance965.spec.ts`'s own HOUSE exactly, so a run against the
// real meshes is apples-to-apples with that spec's own acceptance numbers.
// ─────────────────────────────────────────────────────────────────────────────────────────────
const FLAT6: Tool = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6' });
const FLAT3175: Tool = flatEndMill(3.175, { number: 2, id: 'flat-3.175', name: 'flat-3.175' });
const BALL2: Tool = { ...flatEndMill(2, { number: 3, id: 'ball-2', name: 'ball-2' }), typeText: 'Ball Nose', shape: 'ball' };
const BALL05: Tool = { ...flatEndMill(0.5, { number: 4, id: 'ball-0.5', name: 'ball-0.5' }), typeText: 'Ball Nose', shape: 'ball' };
export const DEFAULT_HOUSE: readonly Tool[] = [FLAT6, FLAT3175, BALL2, BALL05];

/** `--plan-cutters id1,id2,...` — restrict what `planModelCam` is GIVEN to plan with, while the
 * category-2 reachability probe always uses the FULL `house` list. Pure, so a unit test can check
 * it directly without a mesh. */
export function restrictHouse(house: readonly Tool[], ids: readonly string[] | null): Tool[] {
  if (ids === null) return [...house];
  const wanted = new Set(ids);
  return house.filter((t) => t.id !== null && wanted.has(t.id));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// PLACEMENT / FIELD — the same doors `figureAcceptance965.spec.ts` uses.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The job's target as the goal's own door (the mesh bytes are the local file, injected by sha). */
function targetOf(job: EngraveJob, bytes: Buffer, fileName: string): EngraveTargetObject {
  const t = job.targetObject!;
  return { ...t, format: 'stl', data: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex'), name: fileName };
}

/** The job's placed mesh, as a `FeatureSource` for `planModelCam`/`buildSetupSpecs`. */
function placedMesh(job: EngraveJob, bytes: Buffer): { source: FeatureSource } {
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
  const mesh: ParsedMesh = { positions, indices: local.indices, triangleCount: local.triangleCount, bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] } };
  return { source: { triangles: mesh } };
}

function goalField(job: EngraveJob, bytes: Buffer, fileName: string, pitchMm: number): GoalHeightfield {
  return sampleGoalHeightfield(targetOf(job, bytes, fileName), { pitchMm, stockTopZ: 0 });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// PLANNING INPUTS
// ─────────────────────────────────────────────────────────────────────────────────────────────

function fixtureOf(job: EngraveJob): ModelPlanInput['fixture'] {
  return {
    mount: job.workholding.kind === 'vise' ? 'vise' : 'tape',
    envelope: job.workholding.kind === 'vise' ? viseEnvelope(job.stock, jobVise(job), job.sacrificial) : null,
  };
}

function baseInput(job: EngraveJob, source: FeatureSource, planHouse: readonly Tool[], setups: SetupSpec[]): ModelPlanInput {
  return {
    geometry: source,
    setups,
    stock: { length: job.stock.length, width: job.stock.width, thickness: job.stock.thickness, material: job.stock.material },
    fixture: fixtureOf(job),
    cutters: { house: [...planHouse], catalogue: [] },
    tolerances: { finishMm: 0.01 },
    edgeBreak: { legMm: 0 },
  };
}

/** TODAY's actual plan: a single top setup — `figureAcceptance965.spec.ts`'s own hardcoded shape,
 * except `underside` is the SAME choice the two-setup comparison uses (see this file's header on
 * why: `flatOnStockBottom` makes `buildSetupSpecs` refuse a bottom candidate by design, #898,
 * which would make category 1 structurally zero for every run — stated, not silently assumed). */
function singleSetupInput(job: EngraveJob, source: FeatureSource, planHouse: readonly Tool[], underside: SetupSpec['underside']): ModelPlanInput {
  return baseInput(job, source, planHouse, [{ frame: { up: [0, 0, 1], stockTop: 0, stockBottom: -job.stock.thickness }, underside }]);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// POSTING + WHOLE-SURFACE STAMPING — `figureAcceptance965.spec.ts`'s own `wholeSurfaceTop`
// pattern, generalised to take any field (the world field for the baseline, a per-setup ROTATED
// field for category 1 — see this file's header).
// ─────────────────────────────────────────────────────────────────────────────────────────────

function postContextFor(job: EngraveJob, label: string): PostContext {
  return {
    jobName: `${label}-966`,
    stock: { length: job.stock.length, width: job.stock.width, thickness: job.stock.thickness },
    materialName: job.stock.material,
    zDatum: 'probed-top-face',
    origin: 'topFrontLeft',
    camVersion: '966-figure-coverage-split',
    toolKey: 'multi',
  };
}

async function postAll(programs: readonly ToolpathIR[], job: EngraveJob, label: string): Promise<{ ir: ToolpathIR; text: string }[]> {
  const ctx = postContextFor(job, label);
  const out: { ir: ToolpathIR; text: string }[] = [];
  for (const ir of programs) {
    const posted = postZ1(ir, ctx, Z1);
    if (!posted.ok) throw new Error(`figure-coverage-split: postZ1 refused a program (${label}): ${posted.errors.join('; ')}`);
    out.push({ ir, text: posted.text });
  }
  return out;
}

/** The lower envelope of every posted program's cutter at each `field` cell — #965's
 * `wholeSurfaceTop`, verbatim in shape (that function is a local test helper, not exported; this
 * is a deliberate duplication, not an import, per this file's own header). `null` (not a throw)
 * when nothing posted — this tool reports that as a finding, never crashes on it. */
function wholeSurfaceTop(programs: readonly { ir: ToolpathIR; text: string }[], field: GoalHeightfield): ResultTop {
  let acc: Float32Array | null = null;
  for (const program of programs) {
    const parsed = parseGcode(program.text);
    const part = setupFromHeader(parsed.header).patch.part;
    if (part === undefined || part.kind !== 'prism' || part.outline.kind !== 'p-rect') {
      throw new Error('figure-coverage-split: a posted program carries no rectangular stock header');
    }
    const setup = stubSetup(part, { kind: 'tape-down', contact: part.outline }, { startingTool: 1 }, Z1);
    const stamp = exactSweptField(field, buildTimeline(parsed, setup, Z1), program.ir.tool);
    if (stamp === null) continue;
    if (acc === null) acc = Float32Array.from(stamp);
    else for (let k = 0; k < acc.length; k++) if (stamp[k]! < acc[k]!) acc[k] = stamp[k]!;
  }
  if (acc === null) return () => null;
  const top = acc;
  return (x, y) => {
    const i = Math.round((x - field.x0) / field.pitch);
    const j = Math.round((y - field.y0) / field.pitch);
    if (i < 0 || j < 0 || i >= field.nx || j >= field.ny) return null;
    return top[j * field.nx + i]!;
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// PER-SETUP (ROTATED-FRAME) RESULT — category 1, the corrected generalisation (see header).
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `documentXY`'s own forward map, applied to every FEED move's XY of `programs` — i.e. the
 * inverse un-map back to a setup's LOCAL frame, since `documentXY` is self-inverse for the stated
 * top/bottom scope once `offsetMm` is subtracted first (this file's header derives this). */
function unmapToLocal(programs: readonly ToolpathIR[], frame: SetupFrame, offsetMm: readonly [number, number]): ToolpathIR[] {
  if (frame.up[2] === 1 && offsetMm[0] === 0 && offsetMm[1] === 0) return [...programs];
  return programs.map((ir) => ({
    ...ir,
    operations: ir.operations.map((op) => ({
      ...op,
      moves: op.moves.map((m) => {
        const [lx, ly] = documentXY(frame, m.x - offsetMm[0], m.y - offsetMm[1]);
        return { ...m, x: lx, y: ly };
      }),
    })),
  }));
}

/** Setup `i`'s OWN registration offset against setup 0 — `[0, 0]` for setup 0 itself (the
 * reference). Reuses `registerSetupOrigin` on the SAME `FeatureTree`s `planModelCam` already
 * computed (`SetupPlan.features`), so this is exactly the offset that run actually used, not a
 * re-derivation that could disagree with it. */
function registrationOffsetFor(perSetup: readonly SetupPlan[], setupIndex: number): [number, number] {
  if (setupIndex === 0) return [0, 0];
  return registerSetupOrigin(perSetup[0]!.features, perSetup[setupIndex]!.features).offsetMm;
}

/** Setup `i`'s own result, in ITS OWN (rotated) local frame: the rotated goal mesh's own field,
 * and that setup's posted programs un-mapped back to local XY before the G-code round trip. */
async function setupOwnResultTop(
  job: EngraveJob,
  source: FeatureSource,
  setup: SetupPlan,
  offsetMm: readonly [number, number],
  pitchMm: number,
  label: string,
): Promise<{ field: GoalHeightfield; resultTop: ResultTop }> {
  const frame = setup.features.frame;
  const rotated = rotatedGeometryFor(source, frame);
  const field = sampleCoverageField({ positions: rotated.triangles.positions, indices: rotated.triangles.indices }, pitchMm, frame.stockTop);
  if (setup.programs.length === 0) return { field, resultTop: () => null };
  const local = unmapToLocal(setup.programs, frame, offsetMm);
  const posted = await postAll(local, job, `${label}-setup${setup.setupIndex}`);
  return { field, resultTop: wholeSurfaceTop(posted, field) };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CATEGORY 2/3 — RAW REACHABILITY, via `dropcutter.ts`'s own primitive, independent of any plan.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `frameForFace`'s own formula (`cam/model/setups.ts`), reconstructed directly rather than
 * imported: category 2 asks "could EITHER orientation reach this at all", which must hold
 * regardless of whether `buildSetupSpecs`/`goalFlipPlan`'s own scoring happened to propose the
 * bottom setup for THIS run's `underside` choice — importing `buildSetupSpecs`'s own decision
 * here would wrongly gate raw reachability on a planning heuristic. */
function topFrameOf(stockTopZ: number, thicknessMm: number): SetupFrame {
  return { up: [0, 0, 1], stockTop: stockTopZ, stockBottom: stockTopZ - thicknessMm };
}
function bottomFrameOf(stockTopZ: number, thicknessMm: number): SetupFrame {
  return { up: [0, 0, -1], stockTop: thicknessMm - stockTopZ, stockBottom: -stockTopZ };
}

/** Whether ANY cutter in `profiles`, approached from `frame`, reaches `goalTop` (world Z) within
 * `reachedMm` at world `(wx, wy)` — `dropcutter.ts`'s raw primitive, rotated into `frame`. */
function frameReaches(
  frame: SetupFrame,
  localMesh: DropCutterMesh,
  profiles: readonly CutterProfile[],
  wx: number,
  wy: number,
  goalTop: number,
  reachedMm: number,
): boolean {
  const [lx, ly] = documentXY(frame, wx, wy);
  for (const profile of profiles) {
    const localZ = dropCutterHeight(profile, localMesh, lx, ly);
    if (localZ === null) continue;
    const worldZ = frame.up[2] === 1 ? localZ : -localZ;
    if (Math.abs(worldZ - goalTop) <= reachedMm) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CATEGORY 3 ATTRIBUTION — bounding boxes of each op's OWN posted (document-XY) feed moves.
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface OpFootprint {
  setupIndex: number;
  kind: string;
  cutter: string;
  regionId: string;
  minX: number; maxX: number; minY: number; maxY: number;
  areaMm2: number;
}

function footprintsOf(perSetup: readonly SetupPlan[]): OpFootprint[] {
  const out: OpFootprint[] = [];
  for (const setup of perSetup) {
    for (const op of setup.ops) {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const operation of op.outcome.ir.operations) {
        for (const m of operation.moves) {
          if (m.kind === 'rapid') continue;
          if (m.x < minX) minX = m.x;
          if (m.x > maxX) maxX = m.x;
          if (m.y < minY) minY = m.y;
          if (m.y > maxY) maxY = m.y;
        }
      }
      if (!(maxX >= minX) || !(maxY >= minY)) continue;
      out.push({
        setupIndex: setup.setupIndex,
        kind: op.kind,
        cutter: op.outcome.cutter,
        regionId: op.region.id,
        minX, maxX, minY, maxY,
        areaMm2: Math.max(1e-6, maxX - minX) * Math.max(1e-6, maxY - minY),
      });
    }
  }
  return out;
}

function attribute(footprints: readonly OpFootprint[], x: number, y: number): OpFootprint | null {
  let best: OpFootprint | null = null;
  for (const f of footprints) {
    if (x < f.minX || x > f.maxX || y < f.minY || y > f.maxY) continue;
    if (best === null || f.areaMm2 < best.areaMm2) best = f;
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// TRIANGLE-LEVEL AREA ACCOUNTING — #966 (Manager, 2026-11-04 ruling): the whole-surface basis is
// the mesh's OWN triangle area (every face), and a triangle that straddles a category boundary
// (part of it covered today, part not; part cat2, part cat3; …) must be CLIPPED, not whole-
// assigned by a single sample. True polygon clipping against an arbitrary per-point classifier
// (dropcutter reach, a cross-setup field, a bounding-box attribution — none of which are simple
// half-plane tests) is not tractable in general; this tool instead recursively QUARTERS a
// triangle (the standard edge-midpoint "triforce" split — 4 congruent, co-planar children per
// level) until its own longest edge is at or below the goal field's own pitch (the resolution
// every per-point test below already reads at), capped at MAX_SUBDIVIDE_DEPTH levels so one
// large triangle costs at most 4**MAX_SUBDIVIDE_DEPTH leaf classifications — bounded, not exact:
// a triangle larger than pitch * 2**MAX_SUBDIVIDE_DEPTH is approximated by that many flat pieces,
// a stated precision/complexity tradeoff (this file's own `caveats`), not an infinite refinement.
// Each LEAF is classified independently at its own centroid and contributes its OWN (exact,
// summed-from-the-parent) area to exactly one of covered/cat1/cat2/cat3 — no triangle or
// triangle-piece is ever double-counted or left unassigned (point 1 of the ruling), which is what
// makes `covered + cat1 + cat2 + cat3 === totals.totalAreaMm2` an EXACT identity (point 2),
// asserted in `figureCoverageSplit966.spec.ts`.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const MAX_SUBDIVIDE_DEPTH = 3; // caps one mesh triangle at 4**3 = 64 leaf pieces

interface Tri9 {
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
  cx: number; cy: number; cz: number;
}

/** One mesh triangle's own vertices, by index — `CoverageMesh`'s own layout. */
function triangleVertsAt(mesh: CoverageMesh, t: number): Tri9 {
  const p = mesh.positions;
  const ia = mesh.indices[t * 3]! * 3;
  const ib = mesh.indices[t * 3 + 1]! * 3;
  const ic = mesh.indices[t * 3 + 2]! * 3;
  return {
    ax: p[ia]!, ay: p[ia + 1]!, az: p[ia + 2]!,
    bx: p[ib]!, by: p[ib + 1]!, bz: p[ib + 2]!,
    cx: p[ic]!, cy: p[ic + 1]!, cz: p[ic + 2]!,
  };
}

/** Area, unit-normal Z, and the plane's own rise-per-cell slope — `goalCoverage.ts`'s
 * `areaAndNormalZ`, reproduced here (module-private there) for a LEAF triangle, not just a mesh
 * one; the formula is identical. */
function triAreaNormal(t: Tri9): { areaMm2: number; nz: number; slope: number } {
  const ux = t.bx - t.ax, uy = t.by - t.ay, uz = t.bz - t.az;
  const vx = t.cx - t.ax, vy = t.cy - t.ay, vz = t.cz - t.az;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  if (len === 0) return { areaMm2: 0, nz: 0, slope: 0 };
  const nzUnit = nz / len;
  const horizontal = Math.hypot(nx, ny) / len;
  const slope = Math.abs(nzUnit) > 1e-9 ? horizontal / Math.abs(nzUnit) : Infinity;
  return { areaMm2: len / 2, nz: nzUnit, slope };
}

function triCentre(t: Tri9): [number, number, number] {
  return [(t.ax + t.bx + t.cx) / 3, (t.ay + t.by + t.cy) / 3, (t.az + t.bz + t.cz) / 3];
}

function triMaxEdgeMm(t: Tri9): number {
  const d = (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number): number =>
    Math.hypot(x2 - x1, y2 - y1, z2 - z1);
  return Math.max(
    d(t.ax, t.ay, t.az, t.bx, t.by, t.bz),
    d(t.bx, t.by, t.bz, t.cx, t.cy, t.cz),
    d(t.cx, t.cy, t.cz, t.ax, t.ay, t.az),
  );
}

/** The standard "triforce" split: 3 edge midpoints make 4 congruent, co-planar, same-winding
 * children — exact (no approximation at this step; the approximation is only in STOPPING before
 * the true per-point boundary is reached). */
function quarter(t: Tri9): Tri9[] {
  const mab: [number, number, number] = [(t.ax + t.bx) / 2, (t.ay + t.by) / 2, (t.az + t.bz) / 2];
  const mbc: [number, number, number] = [(t.bx + t.cx) / 2, (t.by + t.cy) / 2, (t.bz + t.cz) / 2];
  const mca: [number, number, number] = [(t.cx + t.ax) / 2, (t.cy + t.ay) / 2, (t.cz + t.az) / 2];
  return [
    { ax: t.ax, ay: t.ay, az: t.az, bx: mab[0], by: mab[1], bz: mab[2], cx: mca[0], cy: mca[1], cz: mca[2] },
    { ax: mab[0], ay: mab[1], az: mab[2], bx: t.bx, by: t.by, bz: t.bz, cx: mbc[0], cy: mbc[1], cz: mbc[2] },
    { ax: mca[0], ay: mca[1], az: mca[2], bx: mbc[0], by: mbc[1], bz: mbc[2], cx: t.cx, cy: t.cy, cz: t.cz },
    { ax: mab[0], ay: mab[1], az: mab[2], bx: mbc[0], by: mbc[1], bz: mbc[2], cx: mca[0], cy: mca[1], cz: mca[2] },
  ];
}

/** Quarter `t` until its own longest edge is at/below `targetMm`, capped at
 * `MAX_SUBDIVIDE_DEPTH` levels — see this section's own header. `targetMm <= 0` (a degenerate
 * field) never subdivides. */
function subdivideForTarget(t: Tri9, targetMm: number): Tri9[] {
  if (!(targetMm > 0)) return [t];
  let pieces: Tri9[] = [t];
  let edge = triMaxEdgeMm(t);
  let depth = 0;
  while (edge > targetMm && depth < MAX_SUBDIVIDE_DEPTH) {
    pieces = pieces.flatMap(quarter);
    edge /= 2;
    depth++;
  }
  return pieces;
}

interface LeafFacts {
  areaMm2: number;
  centre: [number, number, number];
  goalTop: number | null;
  cls: 'facingAway' | 'shadowed' | 'visible';
}

/** One LEAF piece's own class — `goalCoverage.ts`'s `coverageTriangles` body, reproduced at leaf
 * granularity (that function only ever samples a WHOLE mesh triangle's one centroid; this tool
 * needs the same decision per sub-piece, so a parent triangle straddling facing-away/shadowed/
 * visible is clipped the same way a reachability boundary is — see this section's own header). */
function classifyLeaf(leaf: Tri9, field: GoalHeightfield, facingDeg: number, shadowMm: number): LeafFacts {
  const { areaMm2, nz, slope } = triAreaNormal(leaf);
  const centre = triCentre(leaf);
  const goalTop = goalTopAt(field, centre[0], centre[1]);
  if (!(areaMm2 > 0)) return { areaMm2: 0, centre, goalTop, cls: 'facingAway' };
  const facingDown = -Math.sin((facingDeg * Math.PI) / 180);
  if (nz < facingDown) return { areaMm2, centre, goalTop, cls: 'facingAway' };
  const high = Math.max(leaf.az, leaf.bz, leaf.cz) + (Number.isFinite(slope) ? slope * field.pitch : 0);
  if (goalTop !== null && goalTop > high + shadowMm) return { areaMm2, centre, goalTop, cls: 'shadowed' };
  return { areaMm2, centre, goalTop, cls: 'visible' };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE CELL MAP — a structured grid, not an image (no image-encoding dependency this tool would
// otherwise need; the grid is exact, diffable, and machine-readable as-is). One character per
// cell: '0' covered today, '1'/'2'/'3' this triangle's category, '.' no triangle centroid landed
// there at this pitch. Ties (more than one triangle centroid rounds to the same cell) resolve to
// the MORE SEVERE category (2 > 3 > 1 > 0), stated so the map is reproducible.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const SEVERITY: Record<string, number> = { '0': 0, '1': 1, '3': 2, '2': 3 };

class CellMap {
  readonly nx: number;
  readonly ny: number;
  readonly x0: number;
  readonly y0: number;
  readonly pitch: number;
  private readonly grid: Uint8Array;
  constructor(nx: number, ny: number, x0: number, y0: number, pitch: number) {
    this.nx = nx;
    this.ny = ny;
    this.x0 = x0;
    this.y0 = y0;
    this.pitch = pitch;
    this.grid = new Uint8Array(nx * ny).fill(255);
  }
  mark(x: number, y: number, code: '0' | '1' | '2' | '3'): void {
    const i = Math.round((x - this.x0) / this.pitch);
    const j = Math.round((y - this.y0) / this.pitch);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) return;
    const k = j * this.nx + i;
    const codeNum = code.charCodeAt(0) - 48;
    if (this.grid[k] === 255 || SEVERITY[code]! > SEVERITY[String(this.grid[k])]!) this.grid[k] = codeNum;
  }
  toJSON(): { nx: number; ny: number; x0: number; y0: number; pitch: number; legend: Record<string, string>; rows: string[] } {
    const rows: string[] = [];
    for (let j = 0; j < this.ny; j++) {
      let row = '';
      for (let i = 0; i < this.nx; i++) {
        const v = this.grid[j * this.nx + i]!;
        row += v === 255 ? '.' : String(v);
      }
      rows.push(row);
    }
    return {
      nx: this.nx,
      ny: this.ny,
      x0: this.x0,
      y0: this.y0,
      pitch: this.pitch,
      legend: { '0': 'covered today', '1': 'a second setup reaches it', '2': 'no setup reaches it', '3': 'reachable, not cut', '.': 'no triangle centroid at this pitch' },
      rows,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE CORE — pure (besides the planner's own async work), importable without a CLI.
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface FigureCoverageSplitOptions {
  job: EngraveJob;
  meshBytes: Buffer;
  meshFileName: string;
  label: string;
  underside?: SetupSpec['underside'];
  house?: readonly Tool[];
  planCutterIds?: readonly string[] | null;
  pitchMm?: number;
  coverage?: CoverageOptions;
  targetFraction?: number;
}

export interface CategoryTotals {
  areaMm2: number;
  /**
   * #966 (Manager, 2026-11-04) — against `totals.totalAreaMm2`, the WHOLE-SURFACE triangle-area
   * basis (every mesh face, underside included, minus the stock-bottom exclusion when it
   * applies — see `totals`' own doc). `covered + cat1 + cat2 + cat3` sum to EXACTLY this total;
   * `totals.columnBasedAreaMm2`/`coveredTodayColumnBasedPct` are a DIFFERENT basis entirely and
   * must never be combined with this one (see those fields' own doc).
   */
  pct: number;
}

export interface AttributionBucket {
  setupIndex: number;
  kind: string;
  cutter: string;
  areaMm2: number;
  triangleCount: number;
  exampleRegionIds: string[];
}

export interface FigureCoverageSplitResult {
  job: string;
  config: {
    underside: SetupSpec['underside'];
    pitchMm: number;
    coverage: Required<CoverageOptions>;
    planCutterIds: readonly string[] | null;
    setupsPlanned: number;
  };
  totals: {
    /**
     * #966 (Manager, 2026-11-04 REWORK) — THE WHOLE-SURFACE TRIANGLE-AREA BASIS: every mesh
     * triangle's own area (every face, underside included — clipped into leaf pieces across a
     * category boundary, see the "TRIANGLE-LEVEL AREA ACCOUNTING" section above), MINUS
     * `stockBottomFaceAreaMm2` on the run where that exclusion applies (see that field's own
     * doc). `coveredTodayAreaMm2 + category1.areaMm2 + category2.areaMm2 + category3.areaMm2`
     * sum to EXACTLY this — asserted in `figureCoverageSplit966.spec.ts` as the primary
     * correctness bar for this rework. Every `.pct` field in this result (here and in
     * category1/2/3) is against THIS total.
     */
    totalAreaMm2: number;
    /** Every mesh triangle's own area, NO exclusion at all — `totalAreaMm2 +
     * stockBottomFaceAreaMm2`. Printed for cross-checking only; never a `.pct` denominator. */
    meshTriangleAreaMm2: number;
    /**
     * #966 (Manager, 2026-11-04, point 4) — THE STOCK-BOTTOM-PLANE EXCLUSION: the area of mesh
     * triangles lying EXACTLY in the stock's own bottom plane (every vertex within 1e-4 mm of
     * `stockTopZ − job.stock.thickness`, facing down) that were excluded from classification
     * because they physically cannot be cut — ONLY true when `config.underside ===
     * 'flatOnStockBottom'` (#898: that face is pressed flush against the stock). On every other
     * underside choice this is 0 and `stockBottomExcluded` is false: such a face is counted and
     * classified as any other face, per the ruling's default. Never folded into a category or
     * silently dropped — always printed here, as its own figure.
     */
    stockBottomFaceAreaMm2: number;
    /** Whether the exclusion above actually ran (`config.underside === 'flatOnStockBottom'` AND
     * at least one triangle qualified). */
    stockBottomExcluded: boolean;
    coveredTodayAreaMm2: number;
    coveredTodayPct: number;
    gapAreaMm2: number;
    gapPct: number;
    /**
     * #966 (Manager, 2026-11-04, point 3) — A DIFFERENT, NOT-TO-BE-MIXED BASIS, kept verbatim
     * from the previous pass: `field.coveredCount * pitch²`, the SAME count checkGoalCutInto's
     * own `n` counts (designCheck.ts:1022) off the SAME GoalHeightfield
     * figureAcceptance965.spec.ts's own `goalField()` builds — this is the denominator F's own
     * quoted 89.61 %/73.17 % figures are measured against. NEVER add this into `totalAreaMm2`
     * or any `.pct` above it — see `coveredTodayColumnBasedPct`'s own doc and this function's
     * `caveats`.
     */
    columnBasedAreaMm2: number;
    /**
     * #966 (Manager, 2026-11-04, point 3) — THE NUMBER COMPARABLE TO F's QUOTED FIGURES: the
     * (triangle-based) `coveredTodayAreaMm2` divided by the (column-based) `columnBasedAreaMm2`
     * above — an INTENTIONALLY MIXED-BASIS ratio, kept as ONE separate, clearly-labeled line
     * ONLY because it is the number F's 89.61 %/73.17 % are comparable to. This is NOT one of
     * the four categories that sum to 100 % of `totalAreaMm2` and must never be treated as one.
     */
    coveredTodayColumnBasedPct: number;
  };
  /**
   * #966 (Manager, 2026-11-04) — reported BOTH ways, never merged: `plannableAreaMm2` is what a
   * real, registered 2-setup `planModelCam` run actually produces (0 when `registration.ok` is
   * false, i.e. `registerSetupOrigin` refused for lack of a usable locating datum);
   * `geometricReachAreaMm2` is the raw bottom-orientation reach (`dropcutter.ts`), independent of
   * registration/planning — the Manager's "is it physically reachable from a second setup".
   * `areaMm2`/`pct` alias `plannableAreaMm2`/`plannablePct` (the conservative default a caller
   * reading only those two fields gets). `realistic` names which number is actually achievable
   * TODAY for this part.
   */
  category1: CategoryTotals & {
    plannableAreaMm2: number;
    plannablePct: number;
    geometricReachAreaMm2: number;
    geometricReachPct: number;
    registration: { ok: true } | { ok: false; reason: string };
    realistic: 'plannable' | 'geometric-only';
  };
  category2: CategoryTotals;
  /**
   * #966 (Manager, 2026-11-04) — STATED PLAINLY, NOT BURIED: `attributions` names the smallest
   * planned op whose own posted BOUNDING BOX contains the point — the smallest matching box
   * wins. This is NOT proof that stage/cutter was responsible for missing this exact point, only
   * that its own planned work happened nearby; a box is coarser than the op's actual cleared
   * boundary. See `caveats` (this is also stated there) and this file's own header.
   */
  category3: CategoryTotals & { attributions: AttributionBucket[]; unattributedAreaMm2: number; attributionCaveat: string };
  caveats: string[];
  cellMap: { kind: 'structured-grid-json'; reason: string } & ReturnType<CellMap['toJSON']>;
}

export async function figureCoverageSplit(opts: FigureCoverageSplitOptions): Promise<FigureCoverageSplitResult> {
  const job = opts.job;
  const sha = createHash('sha256').update(opts.meshBytes).digest('hex');
  if (job.targetObject?.sha256 !== undefined && sha !== job.targetObject.sha256) {
    throw new Error(`figure-coverage-split: the mesh file does not match the job's own sha256 (got ${sha.slice(0, 12)}…, job wants ${job.targetObject.sha256.slice(0, 12)}…)`);
  }
  const underside = opts.underside ?? 'flippedTabs';
  const pitchMm = opts.pitchMm ?? 0.1;
  const coverage: Required<CoverageOptions> = { ...COVERAGE_DEFAULTS, ...opts.coverage };
  const houseFull = opts.house ?? DEFAULT_HOUSE;
  const planHouse = restrictHouse(houseFull, opts.planCutterIds ?? null);
  const caveats: string[] = [
    '#966 (Manager, 2026-11-04 REWORK) — THE WHOLE-SURFACE BASIS: every `.pct` field below, and ' +
      'each of covered/category1/category2/category3, is now against `totals.totalAreaMm2` — the ' +
      "mesh's OWN triangle area (every face, underside included), minus `totals.stockBottomFaceAreaMm2` " +
      'on the run where that exclusion applies (see its own doc). A mesh triangle that straddles a ' +
      'category boundary is recursively quartered (edge-midpoint "triforce" subdivision) until its own ' +
      'longest edge is at/below the goal field\'s own pitch, capped at 4**3 = 64 leaf pieces per mesh ' +
      'triangle (this file\'s own "TRIANGLE-LEVEL AREA ACCOUNTING" section) — each leaf contributes its ' +
      'own exact area to EXACTLY ONE bucket, so `coveredTodayAreaMm2 + category1.areaMm2 + ' +
      'category2.areaMm2 + category3.areaMm2 === totals.totalAreaMm2` is an EXACT identity (not merely ' +
      'within tolerance), asserted directly in figureCoverageSplit966.spec.ts. The previous pass\'s ' +
      '`pctPlain`/`plainTotalAreaMm2` fields are GONE: there is now only one basis for these four, and ' +
      "it is this one.",
    '#966 (Manager, 2026-11-04, point 3) — `totals.columnBasedAreaMm2`/`coveredTodayColumnBasedPct` ' +
      'are a SEPARATE, INTENTIONALLY MIXED-BASIS pair, kept ONLY because they are the numbers ' +
      "comparable to F's own quoted figures (89.61 %/73.17 %): `columnBasedAreaMm2` is " +
      "`field.coveredCount * pitch²`, the SAME count checkGoalCutInto's own `n` counts " +
      '(designCheck.ts:1022) off the SAME GoalHeightfield figureAcceptance965.spec.ts\'s own ' +
      "goalField() builds; `coveredTodayColumnBasedPct` divides the TRIANGLE-based " +
      'coveredTodayAreaMm2 by that COLUMN-based count. NEVER add either of these into `totalAreaMm2` ' +
      "or any `.pct` above — that mixing is exactly what the previous pass (6ebf823c) got wrong " +
      '(confirmed ~275 % on this tool\'s own synthetic fixture), which is why this rework exists.',
    '#966 (Manager, 2026-11-04, point 4) — THE STOCK-BOTTOM-PLANE EXCLUSION: by default, a face ' +
      "pressed against the stock's own bottom is counted and classified like any other face — it is " +
      "excluded from `totals.totalAreaMm2`/classification ONLY when `config.underside === " +
      "'flatOnStockBottom'` (#898), and only the mesh triangles whose own vertices lie EXACTLY in the " +
      "stock's bottom plane. Its area is always printed, as `totals.stockBottomFaceAreaMm2`, never " +
      'folded into a category or dropped.',
    `"today's actual" in this run means a single TOP setup with underside = '${underside}' (the SAME choice the two-setup comparison ` +
      "uses), not necessarily the real job's own stated/default underside — flatOnStockBottom would make buildSetupSpecs refuse a " +
      'bottom candidate by design (#898) and category 1 would be structurally zero; pass --underside to change this.',
    "category 3's stage/cutter attribution is a BOUNDING-BOX match against each op's own posted feed-move path (document XY), the " +
      "smallest matching box winning — coarser than the op's actual cleared boundary; a name here is not proof that stage should have " +
      'cut this exact point, only that its own planned work happened nearby. See this tool\'s own header for the full statement.',
  ];

  const { source } = placedMesh(job, opts.meshBytes);
  const field = goalField(job, opts.meshBytes, opts.meshFileName, pitchMm);
  const mesh: CoverageMesh = { positions: source.triangles.positions, indices: source.triangles.indices };
  // #966 (Manager, 2026-11-04, point 3) — THE COLUMN-BASED NUMBER, KEPT SEPARATE (never this run's
  // `.pct` denominator — see `caveats` above). `field` here is built by the EXACT same call
  // (`goalField`'s own `sampleGoalHeightfield`, same pitchMm/stockTopZ) that
  // `figureAcceptance965.spec.ts`'s own `goalField` makes before handing it to `checkGoalCutInto`
  // (designCheck.ts:948) — whose own denominator `n` (designCheck.ts:1022) is a count of
  // `goal.covered[k] === 1` cells off that SAME field: `field.coveredCount * pitch²`.
  const columnBasedAreaMm2 = field.coveredCount * field.pitch * field.pitch;

  // TODAY — a single top setup.
  const todayOutput = await planModelCam(singleSetupInput(job, source, planHouse, underside));
  const todayPrograms = await postAll(todayOutput.perSetup.flatMap((s) => s.programs), job, `${opts.label}-today`);
  const top1 = wholeSurfaceTop(todayPrograms, field);

  // TWO SETUPS — the real `buildSetupSpecs` decision.
  const stockSize = { x: job.stock.length, y: job.stock.width, z: job.stock.thickness };
  const mount: MountSpec = { kind: jobMount(job) };
  const { setups: setups2 } = buildSetupSpecs({
    geometry: source,
    underside,
    mount,
    stockSize,
    ...(opts.targetFraction === undefined ? {} : { targetFraction: opts.targetFraction }),
  });
  // #966 (Manager, 2026-11-04): `registerSetupOrigin` (called INSIDE `planModelCam`, for every
  // setup past 0) REFUSES BY NAME when the part carries no usable locating datum — no two
  // through-holes >= 10 mm apart, no straight outline edge >= 15 mm (`setups.ts`'s own stated
  // thresholds). An organic figure with no stick/fixture built into its own geometry may have
  // neither, even when the bottom face is geometrically reachable — so the 2-setup `planModelCam`
  // call below is NOT assumed to succeed; a refusal is caught, stated, and the run falls back to
  // a TOP-ONLY `output2` (identical to "today") rather than crashing this tool. Category 1 is
  // reported in TWO numbers below for exactly this reason — see `category1`'s own fields.
  let output2: ModelPlanOutput;
  let registrationFailure: string | null = null;
  try {
    output2 = await planModelCam(baseInput(job, source, planHouse, setups2));
  } catch (e) {
    registrationFailure = e instanceof Error ? e.message : String(e);
    output2 = setups2.length < 2 ? { perSetup: [] } : await planModelCam(baseInput(job, source, planHouse, [setups2[0]!]));
  }

  // Category-1, PLANNABLE: each setup beyond 0's OWN result, in ITS OWN rotated frame, from the
  // REAL (registered) multi-setup plan above — empty when that plan refused/fell back.
  const secondSetups: { setup: SetupPlan; offsetMm: [number, number]; resultTop: ResultTop }[] = [];
  for (let i = 1; i < output2.perSetup.length; i++) {
    const setup = output2.perSetup[i]!;
    const offsetMm = registrationOffsetFor(output2.perSetup, i);
    const { resultTop } = await setupOwnResultTop(job, source, setup, offsetMm, pitchMm, opts.label);
    secondSetups.push({ setup, offsetMm, resultTop });
  }

  // Category-2/3 machinery: raw reachability, both orientations, the FULL house.
  const stockTopZ = 0;
  const topFrame = topFrameOf(stockTopZ, job.stock.thickness);
  const bottomFrame = bottomFrameOf(stockTopZ, job.stock.thickness);
  const bottomMesh = rotatedGeometryFor(source, bottomFrame).triangles;
  const probeProfiles = houseFull.map(profileOf).filter((p): p is CutterProfile => p !== null);

  const footprints = footprintsOf(output2.perSetup);
  const attributionMap = new Map<string, AttributionBucket>();
  let unattributedAreaMm2 = 0;

  const cellMap = new CellMap(field.nx, field.ny, field.x0, field.y0, field.pitch);

  // #966 (Manager, 2026-11-04, point 4) — THE STOCK-BOTTOM-PLANE EXCLUSION. World Z, matching
  // `singleSetupInput`'s own top frame (`stockTop: stockTopZ`, `stockBottom: stockTopZ -
  // job.stock.thickness`) and `goalField`'s own `stockTopZ: 0` placement convention — `stockTopZ`
  // itself is declared just above, by the category-2/3 machinery.
  const stockBottomZ = stockTopZ - job.stock.thickness;
  const STOCK_BOTTOM_PLANE_EPS_MM = 1e-4;
  const liesInStockBottomPlane = (t: Tri9): boolean =>
    Math.abs(t.az - stockBottomZ) <= STOCK_BOTTOM_PLANE_EPS_MM &&
    Math.abs(t.bz - stockBottomZ) <= STOCK_BOTTOM_PLANE_EPS_MM &&
    Math.abs(t.cz - stockBottomZ) <= STOCK_BOTTOM_PLANE_EPS_MM &&
    triAreaNormal(t).nz < -0.999;

  let meshTriangleAreaMm2 = 0;
  let stockBottomFaceAreaMm2 = 0;
  let totalAreaMm2 = 0;
  let coveredTodayAreaMm2 = 0;
  let cat1 = 0;
  let cat2 = 0;
  let cat3 = 0;
  // Category-1, GEOMETRIC — of every not-covered-today leaf, how much is reachable from the
  // BOTTOM orientation alone (`dropcutter.ts`'s raw probe), computed INDEPENDENTLY of whether a
  // real plan exists at all (#966, Manager, 2026-11-04: "is it physically reachable from a second
  // setup", reported separately from, and never silently merged into, the realistic/plannable
  // number). When registration succeeds, this and `cat1` (plannable) largely agree (the same
  // area is both reachable and actually reached); when it refuses, `cat1` is 0 and this is what
  // is left to report instead — it is NOT, in that case, a strict subset of category 3 below;
  // rather, whatever this overlay already counts is excluded from category 3's own total only by
  // virtue of also being plannable (`cat1 > 0`) — when `cat1 = 0`, a bottom-reachable leaf
  // still falls into category 3 (not category 2), so the two numbers remain easy to reconcile.
  let cat1Geometric = 0;

  const subdivideTargetMm = field.pitch;
  const triangleCount = mesh.indices.length / 3;
  for (let t = 0; t < triangleCount; t++) {
    const triVerts = triangleVertsAt(mesh, t);
    const { areaMm2: parentAreaMm2 } = triAreaNormal(triVerts);
    if (!(parentAreaMm2 > 0)) continue;
    meshTriangleAreaMm2 += parentAreaMm2;

    if (underside === 'flatOnStockBottom' && liesInStockBottomPlane(triVerts)) {
      stockBottomFaceAreaMm2 += parentAreaMm2;
      continue;
    }
    totalAreaMm2 += parentAreaMm2;

    // #966 (Manager, 2026-11-04, point 1) — a triangle whose own footprint straddles a category
    // boundary is clipped into leaf pieces here (this file's own "TRIANGLE-LEVEL AREA ACCOUNTING"
    // section); each leaf below is classified and bucketed independently, on its own area.
    for (const leaf of subdivideForTarget(triVerts, subdivideTargetMm)) {
      const facet = classifyLeaf(leaf, field, coverage.facingDeg, coverage.shadowMm);
      if (!(facet.areaMm2 > 0)) continue;
      const [cx, cy, cz] = facet.centre;

      const coveredToday =
        facet.cls === 'visible' &&
        ((): boolean => {
          const r = top1(cx, cy);
          return r !== null && Math.abs(r - (facet.goalTop ?? cz)) <= coverage.reachedMm;
        })();
      if (coveredToday) {
        coveredTodayAreaMm2 += facet.areaMm2;
        cellMap.mark(cx, cy, '0');
        continue;
      }

      // Category-1 GEOMETRIC — computed for EVERY not-covered-today leaf, UNCONDITIONALLY (never
      // gated on whether a real plan exists), so it stands as a genuinely independent, parallel
      // number next to the plannable one below — never a subset computed only from whatever
      // plannable left over, which would silently understate it the moment registration succeeds
      // and plannable already claims the same area.
      //
      // The target is THIS LEAF'S OWN z (`cz`), never `facet.goalTop` — `goalTop` is the field's
      // column MAX, a DIFFERENT surface's height for a facingAway/shadowed leaf (e.g. an arm's
      // underside sitting below that same column's top): comparing a cutter's reach against the
      // wrong surface's height would silently mis-score every such leaf as unreached.
      const topReachable = frameReaches(topFrame, source.triangles, probeProfiles, cx, cy, cz, coverage.reachedMm);
      const bottomReachable = frameReaches(bottomFrame, bottomMesh, probeProfiles, cx, cy, cz, coverage.reachedMm);
      if (bottomReachable) cat1Geometric += facet.areaMm2;

      const reachedByUnion = secondSetups.some(({ setup, offsetMm, resultTop }) => {
        const frame = setup.features.frame;
        const [lx, ly] = documentXY(frame, cx - offsetMm[0], cy - offsetMm[1]);
        const localZ = frame.up[2] === 1 ? cz : -cz;
        const r = resultTop(lx, ly);
        if (r === null) return false;
        // `postContextFor`'s `zDatum: 'probed-top-face'` means the posted G-code's Z — and so
        // `resultTop`'s own return, which stamps that same G-code — is MACHINE Z: 0 at THIS setup's
        // own probed top face, negative descending into the part. `localZ` above is setup-LOCAL Z
        // (the rotated mesh's own coordinate, matching `frame.stockTop`/`stockBottom`), so the
        // machine reading needs `+ frame.stockTop` to land in that same frame before comparing —
        // a no-op for the top setup (`stockTop = 0`, which is why the ORIGINAL single-setup
        // `wholeSurfaceTop` pattern never needed this) but NOT for a flipped one (`stockTop` is the
        // stock thickness there) — found by this tool's own validation spec reading a flipped
        // setup's result 1x stock-thickness off from the un-rebased comparison.
        const setupLocalZ = r + frame.stockTop;
        return Math.abs(setupLocalZ - localZ) <= coverage.reachedMm;
      });
      if (reachedByUnion) {
        cat1 += facet.areaMm2;
        cellMap.mark(cx, cy, '1');
        continue;
      }

      if (!topReachable && !bottomReachable) {
        cat2 += facet.areaMm2;
        cellMap.mark(cx, cy, '2');
        continue;
      }

      cat3 += facet.areaMm2;
      cellMap.mark(cx, cy, '3');
      const hit = attribute(footprints, cx, cy);
      if (hit === null) {
        unattributedAreaMm2 += facet.areaMm2;
      } else {
        const key = `${hit.setupIndex}:${hit.kind}:${hit.cutter}`;
        const bucket = attributionMap.get(key) ?? { setupIndex: hit.setupIndex, kind: hit.kind, cutter: hit.cutter, areaMm2: 0, triangleCount: 0, exampleRegionIds: [] };
        bucket.areaMm2 += facet.areaMm2;
        bucket.triangleCount += 1;
        if (bucket.exampleRegionIds.length < 5 && !bucket.exampleRegionIds.includes(hit.regionId)) bucket.exampleRegionIds.push(hit.regionId);
        attributionMap.set(key, bucket);
      }
    }
  }

  if (registrationFailure !== null) {
    caveats.push(
      `registerSetupOrigin refused the second setup — "${registrationFailure}". category1.plannableAreaMm2 is therefore 0: a real ` +
        "2-setup plan for THIS part cannot be produced today. category1.geometricReachAreaMm2 (below) is what WOULD close if #965 " +
        "gave this figure a usable locating datum (e.g. a stick/fixture with two dowel holes or a long straight edge) — it is NOT " +
        'achievable in practice today, and the two numbers must not be reported as one.',
    );
  } else if (setups2.length < 2) {
    caveats.push(
      `buildSetupSpecs returned only 1 setup for underside = '${underside}' on this mesh — category1.plannableAreaMm2 is necessarily ` +
        '0 for this run (no second setup was even proposed); try a different --underside or --target-fraction. ' +
        'category1.geometricReachAreaMm2 still reports raw bottom-orientation reachability, independent of that decision.',
    );
  }

  // #966 (Manager, 2026-11-04) — THE ONE BASIS: `pct` is against `totalAreaMm2`, the whole-surface
  // triangle-area total (point 1/2 of the ruling). `columnBasedAreaMm2`/
  // `coveredTodayColumnBasedPct` are a SEPARATE, never-merged pair (point 3) — see `caveats`.
  const pct = (a: number): number => (totalAreaMm2 > 0 ? (a / totalAreaMm2) * 100 : 0);
  const gapAreaMm2 = totalAreaMm2 - coveredTodayAreaMm2;
  const coveredTodayColumnBasedPct = columnBasedAreaMm2 > 0 ? (coveredTodayAreaMm2 / columnBasedAreaMm2) * 100 : 0;
  const attributionCaveat =
    "category 3's stage/cutter attribution is APPROXIMATE: a bounding-box match against each op's own " +
    "posted feed-move path (document XY), the smallest matching box winning — it is NOT proof that this " +
    "stage/cutter was responsible for missing the point, only that its own planned work happened nearby.";

  return {
    job: job.name ?? opts.label,
    config: { underside, pitchMm, coverage, planCutterIds: opts.planCutterIds ?? null, setupsPlanned: output2.perSetup.length },
    totals: {
      totalAreaMm2,
      meshTriangleAreaMm2,
      stockBottomFaceAreaMm2,
      stockBottomExcluded: stockBottomFaceAreaMm2 > 0,
      coveredTodayAreaMm2,
      coveredTodayPct: pct(coveredTodayAreaMm2),
      gapAreaMm2,
      gapPct: pct(gapAreaMm2),
      columnBasedAreaMm2,
      coveredTodayColumnBasedPct,
    },
    category1: {
      // Backward-compatible alias — ALWAYS the realistic/plannable number, never the geometric
      // one, so a caller reading only `category1.areaMm2` gets the conservative/achievable figure.
      areaMm2: cat1,
      pct: pct(cat1),
      plannableAreaMm2: cat1,
      plannablePct: pct(cat1),
      geometricReachAreaMm2: cat1Geometric,
      geometricReachPct: pct(cat1Geometric),
      registration: registrationFailure === null ? { ok: true as const } : { ok: false as const, reason: registrationFailure },
      realistic: registrationFailure === null && setups2.length >= 2 ? ('plannable' as const) : ('geometric-only' as const),
    },
    category2: { areaMm2: cat2, pct: pct(cat2) },
    category3: {
      areaMm2: cat3,
      pct: pct(cat3),
      unattributedAreaMm2,
      attributions: [...attributionMap.values()].sort((a, b) => b.areaMm2 - a.areaMm2),
      attributionCaveat,
    },
    caveats,
    cellMap: { kind: 'structured-grid-json', reason: 'a per-cell category grid, not an image — zero extra image-encoding dependency, exact, diffable', ...cellMap.toJSON() },
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CLI — `tests/tools/goal-engine-breadth.ts`'s own conventions (indexOf-parsed flags, an env-
// gated mesh path, `--out FILE`).
// ─────────────────────────────────────────────────────────────────────────────────────────────

function flag(args: readonly string[], name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? null) : null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const jobPath = flag(args, '--job');
  if (jobPath === null) {
    process.stderr.write('figure-coverage-split: --job FILE is required (an EngraveJob with a goal targetObject)\n');
    process.exitCode = 1;
    return;
  }
  const meshPath = flag(args, '--mesh') ?? process.env['CM_FIGURE_STL'] ?? null;
  if (meshPath === null || !existsSync(meshPath)) {
    process.stderr.write(`figure-coverage-split: no mesh found — set CM_FIGURE_STL or pass --mesh FILE${meshPath === null ? '' : ` (missing ${meshPath})`}\n`);
    process.exitCode = 1;
    return;
  }
  const outPath = flag(args, '--out');
  const underside = (flag(args, '--underside') ?? 'flippedTabs') as SetupSpec['underside'];
  const pitchMm = Number(flag(args, '--pitch-mm') ?? '0.1');
  const reachedMm = flag(args, '--reached-mm');
  const shadowMm = flag(args, '--shadow-mm');
  const facingDeg = flag(args, '--facing-deg');
  const targetFraction = flag(args, '--target-fraction');
  const planCuttersRaw = flag(args, '--plan-cutters');

  const job = parseEngraveJob(JSON.parse(readFileSync(jobPath, 'utf8')));
  if (!job.ok) {
    process.stderr.write(`figure-coverage-split: ${jobPath} does not parse as an EngraveJob: ${job.errors.join('; ')}\n`);
    process.exitCode = 1;
    return;
  }
  const meshBytes = readFileSync(meshPath);
  const label = job.job.name?.replace(/\W+/g, '-').toLowerCase() || 'figure';

  const result = await figureCoverageSplit({
    job: job.job,
    meshBytes,
    meshFileName: meshPath.split(/[\\/]/).pop()!,
    label,
    underside,
    pitchMm,
    coverage: {
      ...(reachedMm === null ? {} : { reachedMm: Number(reachedMm) }),
      ...(shadowMm === null ? {} : { shadowMm: Number(shadowMm) }),
      ...(facingDeg === null ? {} : { facingDeg: Number(facingDeg) }),
    },
    ...(targetFraction === null ? {} : { targetFraction: Number(targetFraction) }),
    planCutterIds: planCuttersRaw === null ? null : planCuttersRaw.split(',').map((s) => s.trim()).filter((s) => s.length > 0),
  });

  const { cellMap, ...summary } = result;
  process.stdout.write(JSON.stringify(summary) + '\n');
  if (outPath !== null) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify({ ...summary, cellMap }, null, 1));
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await main();
