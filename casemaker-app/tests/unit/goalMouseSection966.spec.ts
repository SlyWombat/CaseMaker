/**
 * #966 blocker (c) — the mouse shell (j27) plans through the rebuilt engine.
 *
 * The job's goal mesh is a SHELL: an open surface whose bottom boundary sits at z = 0, with 96
 * zero-area triangles and float32-duplicate vertices. `solidOf` (features/tree.ts) handed it
 * straight to `new Manifold(...)`, which refuses an open mesh — `ManifoldError: Not manifold`.
 * The old heightfield engine never needed a watertight solid, so j27 planned there.
 *
 * This spec is the red-first pin: the plan must be produced, not refused.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseStl, type ParsedMesh } from '@/engine/import/stlParser';
import { placeTarget } from '@/engine/cnc/engrave/targetPlace';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { jobVise, viseEnvelope } from '@/engine/cnc/fixture';
import { planModelCam, type ModelPlanInput } from '@/engine/cnc/cam/model/plan';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import type { EngraveJob } from '@/types/engraveJob';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JOB = path.join(HERE, '..', '..', '..', 'docs', 'bench', '2026-10-28-z1-real-jobs', 'jobs', 'j27-mouse-shell-side1.json');

/** The job's own ball-nose class and flat; the mesh repair is cutter-independent. */
const FLAT6: Tool = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6' });
const BALL3175: Tool = { ...flatEndMill(3.175, { number: 2, id: 'ball-3.175', name: 'ball-3.175' }), typeText: 'Ball Nose', shape: 'ball' };

function readJob(): EngraveJob {
  const parsed = parseEngraveJob(JSON.parse(fs.readFileSync(JOB, 'utf8')));
  if (!parsed.ok) throw new Error(`j27 does not parse: ${parsed.errors.join('; ')}`);
  return parsed.job;
}

/** The job's placed goal mesh, as `planModelCam`'s `FeatureSource`. */
function placedMesh(job: EngraveJob): { triangles: ParsedMesh } {
  const target = job.targetObject!;
  const bytes = Buffer.from(target.data!, 'base64');
  const local = parseStl(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const { place } = placeTarget(target, local);
  const positions = new Float32Array(local.positions.length);
  for (let i = 0; i < local.positions.length; i += 3) {
    const [x, y, z] = place(local.positions[i]!, local.positions[i + 1]!, local.positions[i + 2]!);
    positions[i] = x;
    positions[i + 1] = y;
    positions[i + 2] = z;
  }
  return { triangles: { ...local, positions } };
}

/**
 * A 10 × 10 × 4 box (top at z = 4) with its bottom face omitted: a small open shell. With
 * `tear` the front face's second triangle is also removed, which leaves one boundary vertex with
 * two outgoing edges — a hole the loop chaining cannot close.
 */
function box(tear: boolean): { triangles: ParsedMesh } {
  const positions = new Float32Array([
    0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0,
    0, 0, 4, 10, 0, 4, 10, 10, 4, 0, 10, 4,
  ]);
  const indices = [
    // front (−Y), right (+X), back (+Y), left (−X), top (+Z); no bottom
    0, 1, 5, 0, 5, 4,
    1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6,
    3, 0, 4, 3, 4, 7,
    4, 5, 6, 4, 6, 7,
  ];
  if (tear) indices.splice(3, 3); // the (0, 5, 4) triangle
  return {
    triangles: {
      positions,
      indices: Uint32Array.from(indices),
      triangleCount: indices.length / 3,
      bbox: { min: [0, 0, 0], max: [10, 10, 4] },
    },
  };
}

function boxInput(geometry: { triangles: ParsedMesh }): ModelPlanInput {
  return {
    geometry,
    setups: [{ frame: { up: [0, 0, 1], stockTop: 4, stockBottom: -6 }, underside: 'flatOnStockBottom' }],
    stock: { length: 20, width: 20, thickness: 10, material: 'pla' },
    fixture: { mount: 'tape', envelope: null },
    cutters: { house: [FLAT6], catalogue: [] },
    tolerances: { finishMm: 0.3 },
    edgeBreak: { legMm: 0 },
  };
}

describe('#966 the mouse shell sections at all', () => {
  it('plans j27 through planModelCam instead of refusing the open mesh', async () => {
    const job = readJob();
    const input: ModelPlanInput = {
      geometry: placedMesh(job),
      setups: [{ frame: { up: [0, 0, 1], stockTop: 0, stockBottom: -job.stock.thickness }, underside: 'flatOnStockBottom' }],
      stock: { length: job.stock.length, width: job.stock.width, thickness: job.stock.thickness, material: job.stock.material },
      fixture: {
        mount: job.workholding.kind === 'vise' ? 'vise' : 'tape',
        envelope: job.workholding.kind === 'vise' ? viseEnvelope(job.stock, jobVise(job), job.sacrificial) : null,
      },
      cutters: { house: [FLAT6, BALL3175], catalogue: [] },
      tolerances: { finishMm: job.targetObject?.surface?.finishStepOverMm ?? 0.3 },
      edgeBreak: { legMm: 0 },
    };
    const output = await planModelCam(input);
    expect(output.perSetup).toHaveLength(1);
    // The shell's whole outer face is one curved remainder: it must survive sectioning, not be
    // silently dropped, and the plan must post at least one program.
    expect(output.perSetup[0]!.features.remainder.length).toBeGreaterThan(0);
    expect(output.perSetup[0]!.programs.length).toBeGreaterThan(0);
  }, 300_000);

  it('states the open edges it closed in the plan notes', async () => {
    const output = await planModelCam(boxInput(box(false)));
    const notes = output.perSetup[0]!.notes.join('\n');
    expect(notes).toMatch(/the goal mesh had 4 open edge\(s\) and 0 degenerate triangle\(s\); the holes were closed before planning/);
  });

  it('refuses by name when a hole cannot be closed', async () => {
    await expect(planModelCam(boxInput(box(true)))).rejects.toThrow(
      /cam\/model\/features: the goal mesh has 7 open edge\(s\) and 0 degenerate triangle\(s\) that could not be closed into a solid/,
    );
  });
});
