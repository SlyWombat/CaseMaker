/**
 * #965 — THE FIGURES' ACCEPTANCE ON THE REBUILT ENGINE.
 *
 * The elephant and the panther at STICK SCALE, planned through `cam/model/plan.ts` and judged on
 * the maintainer's line (#965): whole-surface coverage ≥ 95 % after the setups the app proposes
 * (the elephant's underside on the stock bottom excluded), zero cut-into beyond the edge-break
 * allowance — plus the seven lines' program facts from the posted files.
 *
 * ENV-GATED on the local-only meshes, in the #959 pattern:
 *
 *   CM_ELEPHANT_STL=…/samples/3d/lfs_elephant.stl \
 *   CM_PANTHER_STL=…/samples/3d/nude_pantherv2-final.stl \
 *   CM_965_OUT=…/965-acceptance/ \
 *   npx vitest run tests/unit/figureAcceptance965.spec.ts
 *
 * The jobs are the committed demo jobs (`j29-elephant-stick.json`, `j28-panther-stick.json`): the
 * 36 × 100 × 36 mm hardwood stick, the figure placed at the job's own scale/turn/position, in the
 * job's vise. The meshes are shop-owned local inputs — the job carries their sha256, never their
 * bytes — so each spec verifies the file against the job's hash and SKIPS on a machine without it.
 *
 * IT FAILS TODAY, FOR A STATED REASON: `planModelCam` (and `rough()`) are stubs on this branch
 * (#956 skeleton; C is building rough). The first call raises that named error, so the run is red
 * with the reason in the message, not a crash in the harness. When the plan lands, the same spec
 * posts every program with the Z1 post, verifies the texts against the machine, stamps the goal
 * heightfield with each program's Tool-record cutter (accumulated across programs and, when the
 * plan returns more than one setup, unioned across setups), and scores the seven lines. A single
 * top setup states top = whole: there is no second side to union.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { parseStl, type ParsedMesh } from '@/engine/import/stlParser';
import { placeTarget } from '@/engine/cnc/engrave/targetPlace';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { Z1 } from '@/engine/cnc/machine';
import { postZ1, type PostContext } from '@/engine/cnc/post/z1';
import { HOP_Z, type ToolpathIR } from '@/engine/cnc/cam/ir';
import { stockDepthLimit, verifyProgram } from '@/engine/cnc/verify';
import { jobVise, viseEnvelope } from '@/engine/cnc/fixture';
import { toSetup } from '@/engine/cnc/engrave/jobSetup';
import { parseGcode, setupFromHeader, stubSetup } from '@/engine/cnc';
import { buildTimeline } from '@/engine/cnc/emulator/timeline';
import { exactSweptField } from '@/workers/sim/sweptPoint';
import { sampleGoalHeightfield, type GoalHeightfield } from '@/engine/cnc/engrave/goalHeightfield';
import { checkGoalCutInto, type GoalCutIntoOptions } from '@/engine/cnc/engrave/designCheck';
import { vToolAllowance } from '@/engine/cnc/engrave/edgeBreak';
import { planModelCam, type ModelPlanInput } from '@/engine/cnc/cam/model/plan';
import { measurePostedProgram, combinePostedFacts } from '../tools/postedFacts';
import { scoreSevenLines, type CutIntoScore, type ProgramScore } from '../tools/sevenLines';
import { clearMakeraCatalogue, installMakeraCatalogue } from '../tools/makeraCatalogue';
import { feedRowsFor } from '../tools/feedRows';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import type { ResultTop } from '@/engine/cnc/engrave/goalCoverage';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..');
const REPO = join(APP, '..');
const JOBS = join(REPO, 'docs', 'bench', '2026-10-28-z1-real-jobs', 'jobs');

// #964 ruling (2026-11-04): the gate plans on the FULL Makera catalogue, so the ⌀6 flat and the
// balls are fed from the vendor's own rows, not the compiled table's largest-covered fallback.
// Local-only data; without it the figure cases skip with the reason rather than measuring a
// conservative placeholder as the product.
const CATALOGUE = installMakeraCatalogue();
afterAll(() => clearMakeraCatalogue());

interface FigureCase {
  name: string;
  jobFile: string;
  env: 'CM_ELEPHANT_STL' | 'CM_PANTHER_STL';
}

const FIGURES: FigureCase[] = [
  { name: 'elephant', jobFile: 'j29-elephant-stick.json', env: 'CM_ELEPHANT_STL' },
  { name: 'panther', jobFile: 'j28-panther-stick.json', env: 'CM_PANTHER_STL' },
];

/** The house's cutters for the stick: two flats for the rough/rest and two balls for the finish. */
// Makera catalogue ids for the cutters the catalogue carries; the 0.5 mm ball has no row and keeps
// the largest-covered-row fallback (stated in the plan's notes), as the ruling allows.
const FLAT6: Tool = flatEndMill(6, { number: 1, id: '111031606032', name: 'flat-6' });
const FLAT3175: Tool = flatEndMill(3.175, { number: 2, id: '111011313825', name: 'flat-3.175' });
const BALL2: Tool = { ...flatEndMill(2, { number: 3, id: '131012203812', name: 'ball-2' }), typeText: 'Ball Nose', shape: 'ball' };
const BALL05: Tool = { ...flatEndMill(0.5, { number: 4, id: 'ball-0.5', name: 'ball-0.5' }), typeText: 'Ball Nose', shape: 'ball' };
const HOUSE = [FLAT6, FLAT3175, BALL2, BALL05];

/** The job's target as the goal's own door (the mesh bytes are the local file, injected by sha). */
function targetOf(job: EngraveJob, bytes: Buffer, filePath: string): EngraveTargetObject {
  const t = job.targetObject!;
  return {
    ...t,
    format: 'stl',
    data: bytes.toString('base64'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    name: path.basename(filePath),
  };
}

/** The job's placed mesh, as a `FeatureSource` for `planModelCam`. */
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

/** The edge-break allowance from the job's stated break and the chamfer Tool record (A's R3);
 * none stated for the figures, so the allowance is absent and cut-into is judged at the floor. */
function allowance(job: EngraveJob): Pick<GoalCutIntoOptions, 'edgeBreak' | 'wallShadowRadiusMm'> {
  const chamfer = job.targetObject as EngraveTargetObject & { edgeBreak?: { toolKey?: string } };
  if (chamfer.edgeBreak === undefined) return { wallShadowRadiusMm: Math.max(...HOUSE.map((t) => (t.tipDiameter ?? 0) / 2)) };
  const tool = HOUSE.find((t) => t.id === chamfer.edgeBreak?.toolKey);
  const allowance = tool === undefined ? null : vToolAllowance(tool);
  return {
    ...(allowance === null ? {} : { edgeBreak: allowance }),
    wallShadowRadiusMm: Math.max(...HOUSE.map((t) => (t.tipDiameter ?? 0) / 2)),
  };
}

/** The goal heightfield of the placed figure, sampled through the app's own door. */
function goalField(job: EngraveJob, bytes: Buffer, filePath: string): GoalHeightfield {
  return sampleGoalHeightfield(targetOf(job, bytes, filePath), { pitchMm: 0.1, stockTopZ: 0 });
}

/** The consumed programme's jobs. */
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

function postContextFor(job: EngraveJob, name: string): PostContext {
  return {
    jobName: `${name}-965`,
    stock: { length: job.stock.length, width: job.stock.width, thickness: job.stock.thickness },
    materialName: job.stock.material,
    zDatum: 'probed-top-face',
    origin: 'topFrontLeft',
    camVersion: 'test-965',
    toolKey: 'multi',
  };
}

/** The lower envelope of every posted program's cutter at each goal cell, accumulated across
 * programs and unioned across setups (a single top setup is its own union). */
function wholeSurfaceTop(programs: readonly { ir: ToolpathIR; text: string }[], field: GoalHeightfield): ResultTop {
  let acc: Float32Array | null = null;
  for (const program of programs) {
    const parsed = parseGcode(program.text);
    const part = setupFromHeader(parsed.header).patch.part;
    if (part === undefined || part.kind !== 'prism' || part.outline.kind !== 'p-rect') {
      throw new Error('#965: a posted program carries no rectangular stock header');
    }
    const setup = stubSetup(part, { kind: 'tape-down', contact: part.outline }, { startingTool: 1 }, Z1);
    const stamp = exactSweptField(field, buildTimeline(parsed, setup, Z1), program.ir.tool);
    if (stamp === null) continue;
    if (acc === null) acc = Float32Array.from(stamp);
    else for (let k = 0; k < acc.length; k++) if (stamp[k]! < acc[k]!) acc[k] = stamp[k]!;
  }
  if (acc === null) throw new Error('#965: no posted program removed anything');
  const top = acc;
  return (x, y) => {
    const i = Math.round((x - field.x0) / field.pitch);
    const j = Math.round((y - field.y0) / field.pitch);
    if (i < 0 || j < 0 || i >= field.nx || j >= field.ny) return null;
    return top[j * field.nx + i]!;
  };
}

for (const figure of FIGURES) {
  const stlPath = process.env[figure.env];
  const jobPath = join(JOBS, figure.jobFile);
  const have = stlPath !== undefined && fs.existsSync(stlPath) && fs.existsSync(jobPath) && (CATALOGUE.installed || CATALOGUE.optedOut);
  const reason =
    stlPath === undefined
      ? ` — set ${figure.env} to the local mesh`
      : !fs.existsSync(stlPath)
        ? ` — missing ${stlPath}`
        : !CATALOGUE.installed && !CATALOGUE.optedOut
          ? ` — no Makera catalogue and no opt-out (${CATALOGUE.note})`
          : '';

  describe.skipIf(!have)(`#965 the ${figure.name} at stick scale${reason}`, () => {
    it('plans, posts, verifies and scores the whole surface through cam/model', async () => {
      const bytes = fs.readFileSync(stlPath!);
      const sha = createHash('sha256').update(bytes).digest('hex');
      const job = JSON.parse(fs.readFileSync(jobPath, 'utf8')) as EngraveJob;
      // The mesh is local-only; the job carries only its sha256. Refuse a stale copy.
      expect(sha, `${figure.env}: the file is not the job's mesh`).toBe(job.targetObject?.sha256);

      const { source } = placedMesh(job, bytes);
      const input = planInputFor(job, source);
      // RED TODAY: planModelCam (and its rough op) is a named stub — the failure must say so.
      const output = await planModelCam(input);
      expect(output.perSetup.length).toBeGreaterThanOrEqual(1);

      const ctx = postContextFor(job, figure.name);
      const programs: { ir: ToolpathIR; text: string }[] = [];
      for (const setup of output.perSetup) {
        for (const ir of setup.programs) {
          const posted = postZ1(ir, ctx, Z1);
          expect(posted.ok, `#965 ${figure.name}: postZ1 refused — ${posted.ok ? '' : posted.errors.join('; ')}`).toBe(true);
          if (!posted.ok) return;
          const verify = verifyProgram(posted.text, {
            setup: toSetup(job, Z1),
            machine: Z1,
            tool: ir.tool,
            depthLimit: stockDepthLimit(job.stock, job.minFloor ?? 1),
            minRapidZ: HOP_Z,
          });
          expect(
            verify.findings.filter((f) => f.severity === 'error'),
            `#965 ${figure.name}: verifier errors:\n${verify.findings.map((f) => `${f.code}: ${f.message}`).join('\n')}`,
          ).toEqual([]);
          programs.push({ ir, text: posted.text });
        }
      }
      expect(programs.length, `#965 ${figure.name}: the plan posted no program`).toBeGreaterThan(0);

      const field = goalField(job, bytes, stlPath!);
      const top = wholeSurfaceTop(programs, field);
      const report = checkGoalCutInto(field, top, {
        passCoverage: 0.95, // the maintainer's whole-surface line (#965)
        ...allowance(job),
      });
      const coverage = 1 - (report.leftoverFractions[0] ?? 0);
      const cutInto: CutIntoScore = {
        adjudicatedFraction: report.adjudicatedFraction,
        edgeBreakFraction: report.edgeBreakFraction,
        wallNotScoredFraction: report.wallNotScoredFraction,
        shadowNotScoredFraction: report.shadowNotScoredFraction,
        rawFraction: report.cutIntoFraction,
        maxMm: report.maxCutIntoMm,
      };
      const facts = combinePostedFacts(programs.map((p) => measurePostedProgram(p.text)));
      const ours: ProgramScore = {
        label: figure.name,
        coverage,
        cutInto,
        cycleSeconds: facts.cycleSeconds,
        // One manual bit change between consecutive posted runs; each run here is one cutter.
        toolChanges: Math.max(0, programs.length - 1),
        headerTimeSeconds: null,
        // C2 — which row fed each cutter, and the door's own state (installed, or opted out).
        feedRows: feedRowsFor(HOUSE, job.stock.material),
        catalogueStatus: { used: CATALOGUE.installed, note: CATALOGUE.note },
        airFraction: facts.airFraction,
        rapidsPer1000FeedLines: facts.rapidsPer1000FeedLines,
        cutters: facts.cutters.length,
        cuttersOwned: true,
        // #943 — 'posts as filed' means the VISE with jaw clearance. A figure is scored on its own
        // job's holding: a vise figure states the vise and claims the line; a tape figure says
        // 'tape' and states it cannot claim it. Never 'as filed' in the tape's own words.
        postsAsFiled:
          job.workholding.kind === 'vise'
            ? {
                ok: true,
                holding:
                  `vise — Z1 low-profile, stock ${job.stock.length} × ${job.stock.width} × ${job.stock.thickness} mm, ` +
                  `${jobVise(job).stockProud} mm proud of the jaw tops (jaws at x = 0 / ${job.stock.length} mm)`,
                pitchMm: 0.1,
              }
            : {
                ok: false,
                holding: 'tape',
                pitchMm: 0.1,
                note: "'posts as filed' means the vise with jaw clearance (#943); this figure's job is held on tape and cannot claim the line",
              },
      };
      // The figures have no vendor program for the stick; the maintainer's whole-surface line is
      // the pass rule, and the card prints the other lines' facts beside it.
      const scored = scoreSevenLines({ card: figure.name, ours, vendor: null });

      const out = process.env.CM_965_OUT;
      if (out !== undefined) {
        fs.mkdirSync(out, { recursive: true });
        fs.writeFileSync(join(out, `${figure.name}-posted-facts.json`), JSON.stringify({ coverage, cutInto, scored, ours, programs: programs.map((p) => p.ir.tool.name) }, null, 1));
        // #964 — the standing picture set's inputs: the plan's own programs and the goal target /
        // frame / gate options this run measured.
        fs.writeFileSync(join(out, `${figure.name}-plan.json`), JSON.stringify({ perSetup: output.perSetup.map((setup) => ({ programs: setup.programs })) }, null, 1));
        fs.writeFileSync(join(out, `${figure.name}-pics.json`), JSON.stringify({
          card: figure.name,
          target: targetOf(job, bytes, stlPath!),
          stock: job.stock,
          frame: { stockTop: 0, partBottom: -job.stock.thickness },
          cutIntoOptions: { passCoverage: 0.95, ...allowance(job) },
          post: ctx,
        }, null, 1));
      }

      // THE MAINTAINER'S LINE (#965).
      expect(coverage, `#965 ${figure.name}: whole-surface coverage ${(coverage * 100).toFixed(2)} % — the line is 95 %`).toBeGreaterThanOrEqual(0.95);
      expect(cutInto.adjudicatedFraction, `#965 ${figure.name}: cut-into beyond the allowance`).toBe(0);
      expect(scored.lines.find((l) => l.key === 'coverage')?.oursValue).toBeCloseTo(coverage, 9);

    }, 600_000);
  });
}

describe.skipIf(CATALOGUE.installed || CATALOGUE.optedOut)('#964 — the catalogue default (the maintainer’s 11-05 order)', () => {
  it('FAILS when a figure mesh is set and the full catalogue is missing with no opt-out', () => {
    const anyMesh = process.env.CM_ELEPHANT_STL !== undefined || process.env.CM_PANTHER_STL !== undefined;
    if (!anyMesh) return; // no mesh set: the figure cases cannot run anyway
    throw new Error(
      `the figure acceptance did not run: no full Makera catalogue was found and no opt-out was stated — ${CATALOGUE.note}`,
    );
  });
});

describe.skipIf(process.env.CM_ELEPHANT_STL !== undefined || process.env.CM_PANTHER_STL !== undefined)(
  '#965 acceptance — not run',
  () => {
    it('states why: needs CM_ELEPHANT_STL / CM_PANTHER_STL (the local-only figure meshes)', () => {
      expect(process.env.CM_ELEPHANT_STL ?? process.env.CM_PANTHER_STL).toBeUndefined();
    });
  },
);
