/**
 * The engrave preview (#205): the stock with every enabled label's OPENED region cut to its
 * own depth, the floor of each pocket, the vise jaws and the sacrificial material (#213) —
 * evaluated in the sim worker.
 *
 * Why the sim worker and not the geometry worker (`/Simulation.md`, #205): the preview needs
 * Manifold (profile evaluation, extrusion) and it is driven on a 150 ms debounce by the panel,
 * but the geometry worker's `currentGeneration` guard is the CASE rebuild's own — a preview
 * build queued there would either block a case rebuild or be cancelled by it. The sim worker
 * is per-CNC-work and disposable, so it is the right home. This module is HEADLESS — no
 * Comlink, no worker globals — so it is tested in plain Node like `session.ts`, and
 * `sim.worker.ts` is a thin shell over it.
 *
 * The preview is the OPENED region, never the ideal glyph: with a flat end mill of radius r
 * the cutter reaches `offset(offset(G, -r), +r)`, which rounds every inside corner and drops
 * any stroke thinner than 2r (#201, `/Fabrication.md` §7.5). `measureLabels` already computes
 * that region and its polygons; the preview reuses those polygons so the drawn cut and the
 * findings can never disagree about which cutter was measured.
 *
 * Ownership: every `CrossSection` and `Manifold` created here is `.delete()`d exactly once,
 * following `sweep.ts`. The only things that leave are `NodeMeshOutput` buffers and plain data.
 */

import type { EngraveJob } from '@/types/engraveJob';
import type { Mm } from '@/types/units';
import { toPartPlan, keepOutLimit, keepOutMembrane, labelProfile } from '@/engine/cnc/engrave/partPlan';
import { jobTool, validateJob, type JobFinding } from '@/engine/cnc/engrave/jobSetup';
import { viseEnvelope, validateVise } from '@/engine/cnc/fixture';
import { sacrificialBoxes, type SacrificialBox } from '@/engine/cnc/sacrificial';
import { cuttingRadiusForSweep } from '@/engine/cnc/tool';
import { TOOL_LIBRARY } from '@/engine/cnc/toolLibrary';
import { recommendTool, type ToolRecommendation } from '@/engine/cnc/engrave/recommendTool';
import { executeProfile, type ManifoldToplevel } from '@/workers/geometry/evaluateOp';
import { boxSolid, OVERSHOOT_MM } from '@/workers/geometry/sweep';
import { meshOutputOf, type NodeMeshOutput } from '@/workers/geometry/meshOutput';
import {
  engraveCutRegions,
  engravabilityFindings,
  keepOutFindings,
  measureLabels,
  suggestCapHeight,
  type LabelEngravability,
  type LabelRatioAt,
  type PerCharGlyph,
} from './engraveGeometry';

type ManifoldInstance = InstanceType<ManifoldToplevel['Manifold']>;

/**
 * How tall each floor mesh is, mm (the issue's 0.02). A floor is the pocket floor made
 * visible: the opened region extruded by a sliver and sat at Z = `−depth`, so the viewport can
 * colour it by depth without the sliver ever reading as a solid.
 */
export const FLOOR_THICKNESS_MM = 0.02;

/** Words for each sacrificial piece (#213), so the viewport can name what it draws. */
const SACRIFICIAL_LABEL: Record<SacrificialBox['id'], string> = {
  under: 'Sacrificial board under the part',
  left: 'Sacrificial strip (left)',
  right: 'Sacrificial strip (right)',
  front: 'Sacrificial strip (front)',
  back: 'Sacrificial strip (back)',
};

/** One label's pocket floor, for colouring by depth. Work frame. */
export interface EngravePreviewFloor {
  labelId: string;
  /** Depth of the floor below the top face, mm. Positive. */
  depth: number;
  mesh: NodeMeshOutput;
}

/** One vise jaw, drawn where the user SAID it is (un-inflated), from `viseEnvelope`. */
export interface EngravePreviewFixture {
  id: string;
  label: string;
  mesh: NodeMeshOutput;
}

/**
 * One piece of sacrificial material (#213), drawn where the user SAID it is: the board under the
 * part or a strip beside it, from `sacrificialBoxes`. The `id` is the box id prefixed
 * `sacrificial-` so it can never collide with a jaw id, and `label` names the piece in words.
 */
export interface EngravePreviewSacrificial {
  id: string;
  label: string;
  mesh: NodeMeshOutput;
}

/**
 * One declared under-surface void (#271): its footprint as plain rings, plus the two numbers the
 * panel and the viewport state about it.
 *
 * The rings are traced ON THE TOP FACE, not at the void's ceiling: the ceiling is interior to
 * solid material, so a contour drawn there would be inside the stock mesh and invisible. What the
 * user needs to see is where on the face the void lies — the thing a label must be placed clear
 * of — and the label says how deep a cut may go there. The rings ARE the footprint, so a body
 * drawn at the ceiling and this outline can never disagree about where the void is.
 */
export interface EngravePreviewVoid {
  id: string;
  name: string;
  /** The void's ceiling, mm from the blank's BOTTOM face (the `EngraveKeepOut` datum). */
  zCeiling: Mm;
  /** `keepOutMembrane(job, zCeiling)`: solid left above it, mm. */
  membrane: Mm;
  /** `keepOutLimit(job, membrane)`: the deepest cut over it that keeps `minFloor`, mm. */
  limit: Mm;
  /** Footprint contours in the work frame, one entry per ring (a hole is its own ring). */
  rings: [number, number][][];
}

/** Everything the panel and the viewport need for one job, as plain data + mesh buffers. */
export interface EngravePreview {
  /** The stock with every enabled, error-free label's opened region cut to its depth. Work frame. */
  stock: NodeMeshOutput;
  /** One mesh per cut label: the floor of its pocket. */
  floors: EngravePreviewFloor[];
  /** The vise jaws (un-inflated), from `viseEnvelope`. */
  fixture: EngravePreviewFixture[];
  /** The sacrificial material (#213), from `sacrificialBoxes`; empty when the job has none. */
  sacrificial: EngravePreviewSacrificial[];
  /** The declared under-surface voids (#271), enabled ones only; empty when the job has none. */
  voids: EngravePreviewVoid[];
  /** Per-label measurements, without the (large) polygons: the findings carry the rest. */
  engravability: Omit<LabelEngravability, 'polygons'>[];
  /** `validateJob` + `validateVise` + `engravabilityFindings`, concatenated. */
  findings: JobFinding[];
  /** #211's cutter recommendation, with the compromise message completed here (see below). */
  recommendation: ToolRecommendation;
}

/** The preview worker, one per worker. Mirrors `SimSession`'s shape. */
export interface EngravePreviewer {
  /**
   * Build the preview for `job`, or `null` when `gen` is older than one already seen
   * (the same stale-generation rule as `frameAt` in `session.ts`).
   */
  engravePreview(job: EngraveJob, gen: number): EngravePreview | null;
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
 * and re-measure only that label. Injected into `engravabilityFindings` so a finding's
 * measurement and its message name the same cutter (#201 review, #211).
 */
function ratioAtFor(
  tl: ManifoldToplevel,
  job: EngraveJob,
  radius: number,
): LabelRatioAt {
  return (labelId, size) => {
    const label = job.labels.find((l) => l.id === labelId);
    if (!label) return 0;
    // `shapes: []` — the probe re-typesets ONE label at a candidate cap height; carrying the
    // job's shapes would make every probe re-measure every shape too. The answer is unchanged
    // (`[0]` is the label) but the work is not (#205 review).
    const probe: EngraveJob = { ...job, shapes: [], labels: [{ ...label, size }] };
    return (
      measureLabels(tl, toPartPlan(probe), radius, job.edgeMargin, perCharFor(probe))[0]?.ratio ?? 0
    );
  };
}

/**
 * Drop exact duplicate findings. `validateJob` and `validateVise` both raise `vise-default`
 * for an unmeasured vise, and the issue asks for both validators' output concatenated: the
 * job-level list is the union, not every validator's copy. Distinct messages (even with the
 * same code) are kept — only byte-identical findings collapse.
 */
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

/**
 * #211's `recommendTool` deliberately left the size suggestion out of its compromise message
 * (it has no way to re-measure at a larger cap height). The worker can: compose #201's
 * `suggestCapHeight` for the worst label with the recommended cutter's radius and append
 * "Try N mm or more" — or "Choose a smaller cutter." when no tried size reaches the ratio.
 * No other path computes a size (#211 review).
 */
function completeCompromiseReason(tl: ManifoldToplevel, job: EngraveJob, rec: ToolRecommendation): string {
  if (!rec.compromise || rec.key === null) return rec.reason;
  const pick = rec.candidates.find((c) => c.key === rec.key);
  const worst = pick?.worst;
  if (!worst) return rec.reason;
  const label = job.labels.find((l) => l.id === worst.labelId);
  const entry = TOOL_LIBRARY.find((e) => e.key === rec.key);
  if (!label || !entry) return rec.reason;
  const r = cuttingRadiusForSweep(entry.tool);
  if (!r.ok) return rec.reason;
  const ratioAt = ratioAtFor(tl, job, r.radius);
  const suggested = suggestCapHeight((size) => ratioAt(worst.labelId, size), label.size);
  const hint = suggested === null ? 'Choose a smaller cutter.' : `Try ${suggested} mm or more.`;
  return `${rec.reason} ${hint}`;
}

export function createEngravePreviewer(tl: ManifoldToplevel): EngravePreviewer {
  let latestGen = Number.NEGATIVE_INFINITY;

  const engravePreview = (job: EngraveJob, gen: number): EngravePreview | null => {
    if (gen < latestGen) return null;
    latestGen = gen;

    const plan = toPartPlan(job);
    const perChar = perCharFor(job);
    const tool = jobTool(job);
    const radius = tool ? cuttingRadiusForSweep(tool) : null;
    // Measure with `jobTool(job)`'s radius and nothing else (#201), so a finding's message and
    // its measurement can never name different cutters. A job with no usable cutter measures
    // nothing and still returns a preview (with `tool-missing` among the findings).
    const measured =
      radius && radius.ok ? measureLabels(tl, plan, radius.radius, job.edgeMargin, perChar) : [];

    const engFindings =
      radius && radius.ok
        ? engravabilityFindings(job, measured, ratioAtFor(tl, job, radius.radius))
        : [];

    const findings = dedupeFindings([
      ...validateJob(job),
      ...validateVise(job.stock, job.workholding.vise, job.sacrificial),
      ...engFindings,
      // #171 — the same warning the run raises, off the same shared region builder, so the
      // panel shows it while the label is being placed rather than only after Generate. The
      // radius goes in so a trace's swept region can be built too (#270); it is null-safe.
      ...keepOutFindings(tl, job, plan, engraveCutRegions(plan, measured), radius?.ok ? radius.radius : null),
    ]);

    // A label whose findings include an error is left out of the cut — the stock is drawn
    // uncut there — but its row and findings are still reported (the issue's rule).
    const errored = new Set(
      findings.filter((f) => f.severity === 'error' && f.labelId !== undefined).map((f) => f.labelId as string),
    );

    const stockCS = executeProfile(tl, plan.stock.outline);
    const stockBody = tl.Manifold.extrude(stockCS, job.stock.thickness);
    stockCS.delete();
    // The prism extrudes from z = 0 up; translate so the TOP face is at Z = 0 (cuts at −Z).
    const placedStock = stockBody.translate([0, 0, -job.stock.thickness]);
    stockBody.delete();

    const byId = new Map(measured.map((m) => [m.labelId, m] as const));
    const cuts: ManifoldInstance[] = [];
    const floors: EngravePreviewFloor[] = [];

    for (const engrave of plan.engraves) {
      const row = byId.get(engrave.id);
      if (!row || row.polygons.length === 0) continue;
      if (errored.has(engrave.id)) continue;

      const openedCS = executeProfile(tl, { kind: 'p-poly', contours: row.polygons });

      // The cut: the opened region from −depth up PAST the top face (OVERSHOOT_MM, `sweep.ts`),
      // so the subtraction never has a coplanar face at Z = 0 to fight with.
      const cutBody = tl.Manifold.extrude(openedCS, engrave.depth + OVERSHOOT_MM);
      cuts.push(cutBody.translate([0, 0, -engrave.depth]));
      cutBody.delete();

      // The floor: the same opened region as a sliver sitting at the pocket floor.
      const floorBody = tl.Manifold.extrude(openedCS, FLOOR_THICKNESS_MM);
      const floorSolid = floorBody.translate([0, 0, -engrave.depth]);
      floorBody.delete();
      floors.push({ labelId: engrave.id, depth: engrave.depth, mesh: meshOutputOf(floorSolid) });
      floorSolid.delete();

      openedCS.delete();
    }

    let stock: ManifoldInstance;
    if (cuts.length > 0) {
      stock = tl.Manifold.difference([placedStock, ...cuts]);
      placedStock.delete();
      for (const c of cuts) c.delete();
    } else {
      stock = placedStock;
    }
    const stockMesh = meshOutputOf(stock);
    stock.delete();

    const fixture: EngravePreviewFixture[] = viseEnvelope(job.stock, job.workholding.vise, job.sacrificial).boxes.map(
      (box) => {
        const solid = boxSolid(tl, box);
        const mesh = meshOutputOf(solid);
        solid.delete();
        return { id: box.id, label: box.label, mesh };
      },
    );

    // The sacrificial material (#213), one mesh per box, from the same `sacrificialBoxes` the
    // sweep and the verifier consume — never hand-computed here. Each box is an axis-aligned
    // solid, so `boxSolid` (the sweep's own builder) is the right constructor and there is no
    // union to materialise (no ONE MANIFOLD TRAP path).
    const sacrificial: EngravePreviewSacrificial[] = sacrificialBoxes(job.stock, job.sacrificial).map(
      (box) => {
        const solid = boxSolid(tl, { id: box.id, label: SACRIFICIAL_LABEL[box.id], min: box.min, max: box.max });
        const mesh = meshOutputOf(solid);
        solid.delete();
        return { id: `sacrificial-${box.id}`, label: SACRIFICIAL_LABEL[box.id], mesh };
      },
    );

    // The declared under-surface voids (#271). `plan.stock.keepOuts` already drops the disabled
    // ones, so what is drawn is exactly what `jobDepthLimit` reserves — a void the user switched
    // off is not in this list and not in the limit either. Each footprint is evaluated once here;
    // `keepOutFindings` evaluates its own copy for the warning, and both come from the same
    // `keepOutProfile`, so the outline and the warning name the same region.
    const voids: EngravePreviewVoid[] = plan.stock.keepOuts.map((ko) => {
      const footprintCS = executeProfile(tl, ko.footprint);
      const rings = footprintCS.toPolygons() as [number, number][][];
      footprintCS.delete();
      const membrane = keepOutMembrane(job, ko.zCeiling);
      return {
        id: ko.id,
        name: ko.name,
        zCeiling: ko.zCeiling,
        membrane,
        limit: keepOutLimit(job, membrane),
        rings,
      };
    });

    // #211's rule, measured with each candidate's OWN radius. `TOOL_LIBRARY` is two cutters, so
    // the "early stop for long lists" rule (measure in ascending diameter, stop after the first
    // failure that follows a pass) does not apply yet: until the list is long, measure them all.
    const recommendation = recommendTool(job, TOOL_LIBRARY, (key) => {
      const entry = TOOL_LIBRARY.find((e) => e.key === key);
      if (!entry) return [];
      const r = cuttingRadiusForSweep(entry.tool);
      return r.ok ? measureLabels(tl, plan, r.radius, job.edgeMargin, perChar) : [];
    });

    return {
      stock: stockMesh,
      floors,
      fixture,
      sacrificial,
      voids,
      engravability: measured.map(({ polygons: _polygons, ...rest }) => rest),
      findings,
      recommendation: {
        ...recommendation,
        reason: completeCompromiseReason(tl, job, recommendation),
      },
    };
  };

  return { engravePreview };
}
