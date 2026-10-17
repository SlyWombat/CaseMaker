/**
 * §5.4/§5.7 — the REGISTRATION BAND the preview draws: how far the stock may sit from where the
 * job expects it, as a translucent strip along every edge or feature the registration references.
 *
 * THE BAND IS THE APPROVED PLAN'S, not a re-derivation. A setup that has been registered carries
 * `JobSetupRegistration.plan` — the choreography frozen when the operator approved it — and its
 * `scans` name the stock edges; its `references` name features cut in an earlier setup and the
 * scans that read their walls. This module reads those names and nothing else, so a plan whose
 * settings have since moved still draws the band it was approved with.
 *
 * A SINGLE-SETUP JOB HAS NO PLAN. Nothing was planned, so the band would be an invented choreography
 * if this re-planned one. What the fixture ALREADY holds is a fact, though: the vise's fixed jaw
 * fixes X and rotation on the left edge, an anchor bracket's corner fixes XY, and tape fixes
 * nothing. Those datum bands are drawn with the same `ProbeResiduals` the planner uses, and the
 * front edge the vise leaves open is deliberately NOT drawn — `probePlan` has to touch it, but
 * drawing a touch the job has not approved would put a step on screen that nobody approved.
 *
 * THE RESIDUALS COME FROM THE CALLER. `probeResiduals` resolves the shop's five numbers where a
 * location is visible; a worker realm has no location, so the preview worker is handed them the
 * same way it is handed margins and shop defaults. Omitted, it gets the labelled no-service
 * fallbacks — the same numbers a fresh location is seeded with, never an invented tolerance.
 *
 * Pure: plain job data in, plain rectangles out. No Manifold, no store, no worker globals.
 */

import type { EngraveJob } from '@/types/engraveJob';
import type { Edge, Mount, RegistrationPlan } from '@/engine/cnc/registration/plan';
import { probeResiduals, type ProbeResiduals } from '@/engine/cnc/probePlan';
import { SIDE_WORDS } from '@/engine/cnc/engrave/registration';

/** Where a band's number comes from, so the picture never hides a default behind a measurement. */
export type RegistrationBandSource = 'plan' | 'datum' | 'feature';

/**
 * One translucent strip on the top face. The rectangle is the strip ITSELF — `expected ± the
 * residual` — not the edge it annotates, so the viewport can draw it without knowing which axis
 * the band runs along or what an uncertainty means.
 */
export interface EngravePreviewRegistrationBand {
  id: string;
  /** The stock edge the band annotates, or null for a reference feature's wall. */
  edge: Edge | null;
  /** The strip in the work frame, mm. It may sit partly outside the stock: that is the point. */
  min: [number, number];
  max: [number, number];
  /** The ± value the strip is wide by, mm (its full width is twice this). */
  uncertainty: number;
  source: RegistrationBandSource;
  /**
   * The band's words when it carries a label, else null. A reference feature has several strips
   * and one label, so only the first strip names it.
   */
  label: string | null;
  /** Where that label hangs, work XY, when `label` is set. */
  labelAt: [number, number] | null;
  /** The reference item, when `source` is `'feature'`. */
  itemId?: string;
}

/** The stock rectangle a plan refers to, in its own work frame. */
interface Rect {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

const jobRect = (job: EngraveJob): Rect => ({
  xMin: 0,
  yMin: 0,
  xMax: job.stock.length,
  yMax: job.stock.width,
});

/** Whether a plan's stock is the same footprint as the job's, within a micron. */
function sameFootprint(a: Rect, b: Rect): boolean {
  return (
    Math.abs(a.xMin - b.xMin) < 1e-6 &&
    Math.abs(a.yMin - b.yMin) < 1e-6 &&
    Math.abs(a.xMax - b.xMax) < 1e-6 &&
    Math.abs(a.yMax - b.yMax) < 1e-6
  );
}

/**
 * One stock edge's strip. `at` is where the registration expects the edge on the band's own axis;
 * an approved plan carries it in `expectedAt`, while a datum is the stock's own edge.
 */
function edgeBand(
  edge: Edge,
  at: number,
  stock: Rect,
  uncertainty: number,
  source: RegistrationBandSource,
  label: string | null,
): EngravePreviewRegistrationBand {
  const across = edge === 'left' || edge === 'right';
  const min: [number, number] = across
    ? [at - uncertainty, stock.yMin]
    : [stock.xMin, at - uncertainty];
  const max: [number, number] = across
    ? [at + uncertainty, stock.yMax]
    : [stock.xMax, at + uncertainty];
  const labelAt: [number, number] | null = label
    ? across
      ? [at, (stock.yMin + stock.yMax) / 2]
      : [(stock.xMin + stock.xMax) / 2, at]
    : null;
  return {
    id: `registration-${source}-${edge}${label === null ? `-${at}` : ''}`,
    edge,
    min,
    max,
    uncertainty,
    source,
    label,
    labelAt,
  };
}

/**
 * The edges the mount holds before any touch. These mirror `probePlan`'s `datumOf` for the three
 * mounts an engrave setup can state; a mount not listed holds nothing, and no band is drawn for
 * it.
 */
function datumBands(mount: Mount, stock: Rect, residuals: ProbeResiduals): EngravePreviewRegistrationBand[] {
  if (mount === 'vise') {
    // The fixed jaw is the LEFT jaw (#191): X and rotation are held there. Y is free, so the
    // front edge is not a datum and is not drawn.
    return [edgeBand('left', stock.xMin, stock, residuals.viseJaw, 'datum', SIDE_WORDS.left.name)];
  }
  if (mount === 'bracket') {
    // Seated against both faces of the L: XY and squareness are the bracket's.
    return [
      edgeBand('left', stock.xMin, stock, residuals.anchorBracket, 'datum', SIDE_WORDS.left.name),
      edgeBand('front', stock.yMin, stock, residuals.anchorBracket, 'datum', SIDE_WORDS.front.name),
    ];
  }
  return [];
}

/** The residual a plan's scan leaves: the fixed jaw's datum, the bracket's repeat, or a touch. */
function scanResidual(plan: RegistrationPlan, edge: Edge, residuals: ProbeResiduals): number {
  if (plan.mount === 'vise' && edge === 'left') return residuals.viseJaw;
  if (plan.mount === 'bracket') return residuals.anchorBracket;
  return residuals.probe;
}

/** The bands an approved plan references: its stock edges first, then its earlier-cut features. */
function planBands(plan: RegistrationPlan, residuals: ProbeResiduals): EngravePreviewRegistrationBand[] {
  const referenceScans = new Set((plan.references ?? []).flatMap((r) => [...r.xScans, ...r.yScans]));
  const stock: Rect = { ...plan.stock };
  const bands: EngravePreviewRegistrationBand[] = [];
  const seenEdges = new Set<Edge>();

  // Stock edges. A tape plan scans the left edge twice (position and rotation); one strip is the
  // right drawing for both, so the edge is deduplicated.
  plan.scans.forEach((scan, index) => {
    if (referenceScans.has(index) || seenEdges.has(scan.edge)) return;
    seenEdges.add(scan.edge);
    bands.push(
      edgeBand(
        scan.edge,
        scan.expectedAt,
        stock,
        scanResidual(plan, scan.edge, residuals),
        'plan',
        SIDE_WORDS[scan.edge].name,
      ),
    );
  });

  // A bracket plan fixes the origin at its corner; the left and front edges are datums even when
  // the plan scans only the right and back to confirm the stock is pushed home.
  if (plan.mount === 'bracket') {
    for (const band of datumBands('bracket', stock, residuals)) {
      if (!seenEdges.has(band.edge!)) bands.push(band);
    }
  }

  // Reference features (#429): each strip follows one scanned wall, with the feature's own extent
  // along the wall. One strip carries the feature's label so a four-wall frame does not print four.
  for (const entry of plan.references ?? []) {
    let labelled = false;
    const add = (scanIndex: number, axis: 'x' | 'y') => {
      const scan = plan.scans[scanIndex];
      if (!scan) return;
      const halfX = entry.size.x / 2;
      const halfY = entry.size.y / 2;
      const min: [number, number] =
        axis === 'x'
          ? [scan.expectedAt - residuals.probe, entry.centre.y - halfY]
          : [entry.centre.x - halfX, scan.expectedAt - residuals.probe];
      const max: [number, number] =
        axis === 'x'
          ? [scan.expectedAt + residuals.probe, entry.centre.y + halfY]
          : [entry.centre.x + halfX, scan.expectedAt + residuals.probe];
      bands.push({
        id: `registration-feature-${entry.itemId}-${scanIndex}`,
        edge: null,
        min,
        max,
        uncertainty: residuals.probe,
        source: 'feature',
        label: labelled ? null : entry.name,
        labelAt: labelled ? null : [entry.centre.x, entry.centre.y],
        itemId: entry.itemId,
      });
      labelled = true;
    };
    entry.xScans.forEach((index) => add(index, 'x'));
    entry.yScans.forEach((index) => add(index, 'y'));
  }

  return bands;
}

/**
 * The registration bands for a job's FIRST setup.
 *
 * The preview draws one stock in one work frame, and the first setup is the one that stock is in;
 * a later setup's plan is written in that setup's own re-mounted frame, so projecting it onto this
 * stock would be a different claim. Jobs saved before `setups[]` existed (and jobs whose first
 * setup has not been registered) show the datum bands their mount already holds.
 */
export function registrationBandsFor(
  job: EngraveJob,
  residuals: ProbeResiduals = probeResiduals(),
): EngravePreviewRegistrationBand[] {
  const setup = job.setups?.[0];
  const plan = setup?.registration?.plan;
  // A plan is written in the work frame of the stock AS MOUNTED. The preview draws the job's own
  // top-up frame, so only a plan for a stock of the same footprint can be projected onto it; a
  // first setup that stands the stock on an edge gets its mount's datum edges instead of a band
  // drawn on the wrong face. (The preview does not yet re-orient the stock per setup.)
  if (plan !== undefined && sameFootprint(plan.stock, jobRect(job))) return planBands(plan, residuals);

  const mount: Mount = setup?.mount.kind ?? job.workholding.kind;
  return datumBands(mount, jobRect(job), residuals);
}
