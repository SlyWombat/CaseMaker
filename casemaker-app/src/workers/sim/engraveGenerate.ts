/**
 * Generate → verify, headless (#206). Turns an `EngraveJob` into the exact `.nc` text that will
 * be saved, running every gate the pipeline has BEFORE the text exists:
 *
 *   findings (#200/#201/#203)  → the job as data, the vise, and the tool-opened geometry
 *   feeds    (#202)            → the cutting parameters for the material and the cutter
 *   cam      (#172)            → the toolpath IR, off the SAME opened polygons stage 1 measured
 *   post     (#173)            → the `.nc` text
 *   verify   (#174)            → the text, re-parsed and checked against the depth limit
 *
 * Each stage stops the pipeline on an error and reports which stage stopped it. What gets
 * verified is the TEXT, never the IR (`/Simulation.md` §1.2): `verifyProgram` parses the bytes
 * the machine would read, so a post-processor bug cannot hide behind a clean IR.
 *
 * Headless — it takes the Manifold toplevel like `session.ts` and `engravePreview.ts` do, so it
 * runs (and is tested) in plain Node, and `sim.worker.ts` is a thin Comlink shell over it.
 * Pure given `(tl, job)`: the same job produces byte-identical `nc`.
 *
 * The result carries two fields the issue's interface did not name, both because the main thread
 * cannot recompute them without wasm:
 *   - `predicted`: the opened regions per item, which the oracle (#206 §3) compares the
 *     simulation against. `session.oracle` needs them and only this module has the polygons.
 *   - `errors`: the stage failure MESSAGES. The issue's interface has room for `feeds`/`verify`
 *     but not for a CAM or POST refusal, and a refusal with no reason is useless in the panel.
 */

import type { EngraveItem, EngraveJob } from '@/types/engraveJob';
import { Z1 } from '@/engine/cnc/machine';
import { feedsFor, type FeedsResult } from '@/engine/cnc/feeds';
import { cuttingRadiusForSweep, type Tool } from '@/engine/cnc/tool';
import { toPartPlan, labelProfile } from '@/engine/cnc/engrave/partPlan';
import { jobTool, toSetup, validateJob, type JobFinding } from '@/engine/cnc/engrave/jobSetup';
import { validateVise } from '@/engine/cnc/fixture';
import { generateEngrave, type EngraveRegion } from '@/engine/cnc/cam/engraveJob';
import { postZ1, type PostContext } from '@/engine/cnc/post/z1';
import { stockDepthLimit, verifyProgram, type VerifyReport } from '@/engine/cnc/verify';
import type { ManifoldToplevel } from '@/workers/geometry/evaluateOp';
import {
  engravabilityFindings,
  measureLabels,
  type LabelEngravability,
  type LabelRatioAt,
  type PerCharGlyph,
} from './engraveGeometry';
import type { OraclePredicted } from '@/engine/cnc/engrave/oracle';

/**
 * package.json version for the post's header. Vite defines `__APP_VERSION__` at build time;
 * a Node spec has no such define, so `typeof` guards the reference (which never throws for an
 * undeclared global) and the header carries `dev` instead of failing the whole run.
 */
const CAM_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';

/** The stage that stopped the pipeline, or `done` when everything passed. */
export type EngraveStage = 'findings' | 'feeds' | 'cam' | 'post' | 'verify' | 'done';

/** A stage refusal with its reason, so the panel can list it under the right row. */
export interface EngraveFailure {
  stage: EngraveStage;
  message: string;
}

/** The CAM's own counts, for the panel's "Toolpath generated" row. */
export interface EngraveCamSummary {
  operations: number;
  cuttingMoves: number;
  estimatedSeconds: number;
  passes: number;
}

export interface EngraveGenerated {
  /** False as soon as any stage reports an error. */
  ok: boolean;
  /** The stage that stopped it, or `done`. */
  stage: EngraveStage;
  /** #200, #201, #203. */
  findings: JobFinding[];
  /** #202. */
  feeds: FeedsResult | null;
  cam: EngraveCamSummary | null;
  /** The exact text to be saved. */
  nc: string | null;
  /** #174. */
  verify: VerifyReport | null;
  /** The opened regions the CAM cut and the oracle must match (#206 §3). */
  predicted: OraclePredicted[];
  /** Stage refusals, in stage order. Empty on a clean run. */
  errors: EngraveFailure[];
}

/** `perChar` for a job: one single-character glyph profile per character, in text order. */
function perCharFor(job: EngraveJob): (labelId: string) => PerCharGlyph[] {
  return (labelId) => {
    const label = job.labels.find((l) => l.id === labelId);
    if (!label) return [];
    return [...label.text].map((char) => ({
      char,
      profile: labelProfile({ ...label, text: char }, job.customFonts),
    }));
  };
}

/**
 * `ratioAt` for a job at a given cutter radius: re-typeset one label at a candidate cap height
 * and re-measure only that label (#201/#205). Copied from `engravePreview.ts` because that
 * helper is private to its module and this file must not edit it.
 */
function ratioAtFor(tl: ManifoldToplevel, job: EngraveJob, radius: number): LabelRatioAt {
  return (labelId, size) => {
    const label = job.labels.find((l) => l.id === labelId);
    if (!label) return 0;
    const probe: EngraveJob = { ...job, shapes: [], labels: [{ ...label, size }] };
    return measureLabels(tl, toPartPlan(probe), radius, job.edgeMargin, perCharFor(probe))[0]?.ratio ?? 0;
  };
}

/** `validateJob` + `validateVise` + `engravabilityFindings`, with byte-identical duplicates dropped. */
function dedupeFindings(findings: readonly JobFinding[]): JobFinding[] {
  const seen = new Set<string>();
  const out: JobFinding[] = [];
  for (const f of findings) {
    const key = `${f.severity}|${f.code}|${f.labelId ?? ''}|${f.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

/** The text an engrave region pockets: a label's text, empty for a shape. */
function regionText(item: EngraveItem | undefined): string {
  return item && !('kind' in item) ? item.text : '';
}

/**
 * The measured opening of a job: the plan, its engravability measurements and the ready-to-cut
 * regions. Exported so `engraveOracle.spec.ts` can build a bad-step-over toolpath off the SAME
 * polygons `engraveGenerate` would have cut, without re-deriving them.
 */
export interface EngraveRegions {
  plan: ReturnType<typeof toPartPlan>;
  measured: LabelEngravability[];
  regions: EngraveRegion[];
  predicted: OraclePredicted[];
  tool: Tool | null;
  radius: number | null;
  findings: JobFinding[];
}

export function engraveRegions(tl: ManifoldToplevel, job: EngraveJob): EngraveRegions {
  const plan = toPartPlan(job);
  const perChar = perCharFor(job);
  const tool = jobTool(job);
  const r = tool ? cuttingRadiusForSweep(tool) : null;
  const radius = r && r.ok ? r.radius : null;

  const measured = radius === null ? [] : measureLabels(tl, plan, radius, job.edgeMargin, perChar);
  const engFindings = radius === null ? [] : engravabilityFindings(job, measured, ratioAtFor(tl, job, radius));

  const findings = dedupeFindings([...validateJob(job), ...validateVise(job.stock, job.workholding.vise), ...engFindings]);

  const byId = new Map(measured.map((m) => [m.labelId, m] as const));
  const itemById = new Map<string, EngraveItem>();
  for (const l of job.labels) itemById.set(l.id, l);
  for (const s of job.shapes) itemById.set(s.id, s);

  const regions: EngraveRegion[] = plan.engraves.map((e) => ({
    id: e.id,
    text: regionText(itemById.get(e.id)),
    name: e.name,
    depth: e.depth,
    polygons: byId.get(e.id)?.polygons ?? [],
  }));

  const predicted: OraclePredicted[] = regions.map((r2) => ({ depth: r2.depth, polygons: r2.polygons }));

  return { plan, measured, regions, predicted, tool, radius, findings };
}

/** Count what the panel reports: operations, cutting moves, estimated seconds, depth passes. */
function summarize(ir: ReturnType<typeof generateEngrave>): EngraveCamSummary {
  let cuttingMoves = 0;
  let passes = 0;
  let estimatedSeconds = 0;
  for (const op of ir.operations) {
    estimatedSeconds += op.estimatedSeconds;
    const zs = new Set<number>();
    for (const m of op.moves) {
      if (m.kind !== 'feed') continue;
      cuttingMoves++;
      zs.add(m.z);
    }
    passes += zs.size;
  }
  return { operations: ir.operations.length, cuttingMoves, estimatedSeconds, passes };
}

export function engraveGenerate(tl: ManifoldToplevel, job: EngraveJob): EngraveGenerated {
  const { regions, predicted, tool, radius, findings } = engraveRegions(tl, job);
  const errors: EngraveFailure[] = [];

  const stop = (stage: EngraveStage, extra?: { feeds?: FeedsResult | null; message?: string }): EngraveGenerated => {
    if (extra?.message !== undefined) errors.push({ stage, message: extra.message });
    return {
      ok: false,
      stage,
      findings,
      feeds: extra?.feeds ?? null,
      cam: null,
      nc: null,
      verify: null,
      predicted,
      errors,
    };
  };

  // 1. findings (#200/#201/#203). Any error stops before feeds are even resolved.
  if (findings.some((f) => f.severity === 'error')) return stop('findings');

  // 2. feeds (#202). A tool the library cannot resolve reads as `tool-missing` above; a tool with
  // no row, or a step-over past the radius (#191), refuses here.
  if (tool === null || radius === null) {
    return stop('feeds', { message: radius === null && tool !== null ? 'the job tool is not a flat end mill V1 can sweep' : 'the job has no usable cutter' });
  }
  const feeds = feedsFor(job.stock.material, tool, Z1, job.cutOverride);
  if (!feeds.ok) return stop('feeds', { feeds, message: feeds.reason });

  // 3. the CAM core (#172), on the SAME opened polygons stage 1 measured.
  let ir: ReturnType<typeof generateEngrave>;
  try {
    ir = generateEngrave(tl, regions, tool, feeds.params);
  } catch (e) {
    return stop('cam', { feeds, message: e instanceof Error ? e.message : String(e) });
  }
  const cam = summarize(ir);

  // 4. the post-processor (#173).
  const ctx: PostContext = {
    jobName: job.name,
    stock: { length: job.stock.length, width: job.stock.width, thickness: job.stock.thickness },
    materialName: job.stock.material,
    zDatum: 'probed-top-face',
    origin: 'topFrontLeft',
    camVersion: CAM_VERSION,
  };
  let nc: string;
  try {
    const posted = postZ1(ir, ctx, Z1);
    if (!posted.ok) return stop('post', { feeds, message: posted.errors.join('; ') });
    nc = posted.text;
  } catch (e) {
    return stop('post', { feeds, message: e instanceof Error ? e.message : String(e) });
  }

  // 5. the verifier (#174) on the TEXT, with the CNC-2 depth limit.
  const limit = stockDepthLimit(
    { length: job.stock.length, width: job.stock.width, thickness: job.stock.thickness },
    job.minFloor,
  );
  const verify = verifyProgram(nc, {
    setup: toSetup(job, Z1),
    machine: Z1,
    tool,
    depthLimit: limit,
    minRapidZ: ir.hopZ,
  });
  if (verify.findings.some((f) => f.severity === 'error')) {
    errors.push({ stage: 'verify', message: `${verify.findings.filter((f) => f.severity === 'error').length} verifier error(s)` });
    return { ok: false, stage: 'verify', findings, feeds, cam, nc, verify, predicted, errors };
  }

  return { ok: true, stage: 'done', findings, feeds, cam, nc, verify, predicted, errors };
}
