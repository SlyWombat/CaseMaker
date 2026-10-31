/**
 * #743 P-5 — THE ISOLATION'S OWN TWO MEASUREMENTS, on the profile the CAM cuts.
 *
 * A board's isolation is a frame around the copper: `offset(copper, width) − offset(copper, 0)`.
 * Where two pieces of copper are closer than the frame's own two offsets, the band between them
 * is simply the gap. Whether the V-bit can OPEN that gap is a measurement of the band, not a rule
 * about its width: the CAM pockets the band's region eroded by the cutter's PLANE radius
 * (`pocketLoops(region, planeRadius, …)`), so a band narrower than `2 × planeRadius` is not cut at
 * all, and the two pieces of copper come out joined. That is `isolation-short` — an ERROR, because
 * a short is a broken board (design principle 18), where a thinned letter would only be cosmetic.
 *
 * The second measurement is the thin trace: the same flank that opens the band also moves into the
 * copper by `planeRadius` at the top face, and the job's own Z budget moves it further. A trace
 * that is already finer than the cutter's tip after that budget is worth knowing before soldering —
 * a warning, because a thin trace is still a trace.
 *
 * PURE PROFILES, ONE WASM EVALUATION EACH: `engravableProfile` is the same morphological opening
 * the CAM and the reachability table read, so the refusal and the cut cannot disagree about where
 * the tool can go.
 */

import { segmentsForRadius } from '@/engine/compiler/arcResolution';
import { engravableProfile } from '@/engine/cnc/engrave/engravable';
import { itemProfile, type PartPlan } from '@/engine/cnc/engrave/partPlan';
import { jobSetups, setupTools, toolItemsFor, type JobFinding } from '@/engine/cnc/engrave/jobSetup';
import { toolForJob } from '@/engine/cnc/toolRegistry';
import type { Tool } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import { vCone, vFluteLength, type VCone } from '@/engine/cnc/vProfile';
import { cuttingDiameter } from '@/engine/cnc/tool';
import type { Profile } from '@/engine/compiler/profile';
import type { EngraveAnyItem, EngraveJob } from '@/types/engraveJob';
import { executeProfile, type ManifoldToplevel } from '@/workers/geometry/evaluateOp';

type CrossSectionInstance = InstanceType<ManifoldToplevel['CrossSection']>;

/** What the measurement reads: the band, the copper it follows, and the cutter that cuts it. */
export interface PcbIsolationInput {
  /** The isolation frame's own profile — the band — in the stock frame. */
  band: Profile;
  /** The copper the band follows, in the stock frame. */
  copper: Profile;
  /** The cutter's cone. */
  cone: VCone;
  /** The isolation's cut depth below the top face, mm. */
  depthMm: number;
  /** The copper's underside below the top face (the colour plane), mm. */
  colourMm: number;
  /** The job's Z budget after registration, mm (`margins.zTolerance`). */
  zToleranceMm: number;
  /** The frame item, for the finding's row. */
  frameId: string;
  /**
   * The owned engravers, tip diameter in mm — how the one-click fix is named. The finest that would
   * open a measured gap at this depth is offered on the finding; empty when the caller has no list.
   */
  engravers?: readonly { key: string; tipMm: number }[];
}

/** Areas below this are clamping dust, mm² — the same floor the oracle uses for a sliver. */
const AREA_FLOOR_MM2 = 1e-3;

/** How many places one refusal lists. */
const PLACES_SHOWN = 5;

/** How far an uncut gap is grown to ask which copper pieces it lies between, mm. */
const TOUCH_EPS_MM = 0.01;

const fmt = (n: number): string => `${Number(n.toFixed(3))}`;

/** A place on the blank, as the operator reads it: `X 41.2 Y 18.7 mm`. */
function place(x: number, y: number): string {
  return `X ${Number(x.toFixed(1))} Y ${Number(y.toFixed(1))} mm`;
}

function bboxOf(cs: CrossSectionInstance): { minX: number; maxX: number; minY: number; maxY: number } {
  const b = cs.bounds();
  return { minX: b.min[0], maxX: b.max[0], minY: b.min[1], maxY: b.max[1] };
}

function centreOf(cs: CrossSectionInstance): { x: number; y: number } {
  const b = bboxOf(cs);
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
}


type Pt = [number, number];
type Rings = number[][][];

/** Squared distance from point p to segment ab. */
function pointSegmentDist2(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  let t = len > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = a[0] + t * dx;
  const qy = a[1] + t * dy;
  return (p[0] - qx) ** 2 + (p[1] - qy) ** 2;
}

/** True when segments ab and cd cross (proper or touching). */
function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const cross = (o: Pt, p: Pt, q: Pt): number => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const d1 = cross(a, b, c);
  const d2 = cross(a, b, d);
  const d3 = cross(c, d, a);
  const d4 = cross(c, d, b);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  const on = (o: Pt, p: Pt, q: Pt, v: number): boolean =>
    v === 0 &&
    Math.min(o[0], p[0]) - 1e-12 <= q[0] &&
    q[0] <= Math.max(o[0], p[0]) + 1e-12 &&
    Math.min(o[1], p[1]) - 1e-12 <= q[1] &&
    q[1] <= Math.max(o[1], p[1]) + 1e-12;
  return on(a, b, c, d1) || on(a, b, d, d2) || on(c, d, a, d3) || on(c, d, b, d4);
}

/** The closest approach between two placed polygon sets, mm — the gap between two copper pieces. */
function closestApproach(a: Rings, b: Rings): number | null {
  let best = Number.POSITIVE_INFINITY;
  for (const ringA of a) {
    for (const ringB of b) {
      for (let i = 0; i < ringA.length; i++) {
        const a1 = ringA[i] as Pt;
        const a2 = ringA[(i + 1) % ringA.length] as Pt;
        for (let j = 0; j < ringB.length; j++) {
          const b1 = ringB[j] as Pt;
          const b2 = ringB[(j + 1) % ringB.length] as Pt;
          if (segmentsCross(a1, a2, b1, b2)) return 0;
          const d = Math.min(
            pointSegmentDist2(a1, b1, b2),
            pointSegmentDist2(a2, b1, b2),
            pointSegmentDist2(b1, a1, a2),
            pointSegmentDist2(b2, a1, a2),
          );
          if (d < best) best = d;
        }
      }
    }
  }
  return Number.isFinite(best) ? Math.sqrt(best) : null;
}

/**
 * The two findings for one isolation frame. Empty for a board whose gaps all open and whose
 * traces all survive the budget.
 */
export function pcbIsolationFindings(tl: ManifoldToplevel, input: PcbIsolationInput): JobFinding[] {
  const CS = tl.CrossSection;
  const { cone, depthMm, colourMm, zToleranceMm } = input;
  // The plane the design stands on: the cutter's centreline reaches the copper's UNDERSIDE, so the
  // band it clears is the band eroded by the cone's radius there. Below the copper the flank widens
  // (the mouth at the top face), and the gap only has to be separated at the copper.
  const planeRadius = Math.max(0, cone.tipRadius + Math.max(0, depthMm - colourMm) * cone.tanHalf);
  const findings: JobFinding[] = [];

  const bandCS = executeProfile(tl, input.band);
  const copperCS = executeProfile(tl, input.copper);
  try {
    // --- isolation-short -------------------------------------------------------------------
    if (planeRadius > 0) {
      const opened = executeProfile(tl, engravableProfile(input.band, planeRadius));
      try {
        const uncut = CS.difference([bandCS, opened]);
        try {
          // The design copper's pieces: one per connected island. A piece with a hole is one piece;
          // `decompose` splits components, which is what "two pieces" means here.
          const pieces = copperCS.decompose();
          try {
            const pieceBoxes = pieces.map(bboxOf);
            const pieceRings = pieces.map((p) => p.toPolygons() as Rings);
            const joins = new Map<string, { pieces: number[]; places: { x: number; y: number }[]; gapMm: number }>();
            for (const part of uncut.decompose()) {
              try {
                if (!(part.area() > AREA_FLOOR_MM2)) continue;
                // The band's inner boundary IS the copper's boundary (gap 0), so the uncut strip
                // only touches a piece along a zero-area line. Grow it by a hair to ask "which
                // pieces is this gap between?" — a geometric adjacency question, not an overlap.
                const reach = part.offset(TOUCH_EPS_MM, 'Round', 2, segmentsForRadius(TOUCH_EPS_MM));
                try {
                  const reachBox = bboxOf(reach);
                  const touched: number[] = [];
                  for (let i = 0; i < pieces.length; i++) {
                    const pb = pieceBoxes[i]!;
                    if (
                      reachBox.maxX < pb.minX ||
                      reachBox.minX > pb.maxX ||
                      reachBox.maxY < pb.minY ||
                      reachBox.minY > pb.maxY
                    ) {
                      continue;
                    }
                    const hit = CS.intersection([reach, pieces[i]!]);
                    try {
                      if (hit.area() > AREA_FLOOR_MM2) touched.push(i);
                    } finally {
                      hit.delete();
                    }
                  }
                  if (touched.length < 2) continue;
                  const key = [...touched].sort((a, b) => a - b).join('-');
                  const entry = joins.get(key) ?? { pieces: touched, places: [], gapMm: -1 };
                  entry.places.push(centreOf(part));
                  // The gap AT THE COPPER: the closest approach between the pieces this band fails
                  // to separate — the exact width the design left between them.
                  if (entry.gapMm < 0) {
                    let gap = Number.POSITIVE_INFINITY;
                    for (let i = 0; i < touched.length; i++) {
                      for (let j = i + 1; j < touched.length; j++) {
                        const d = closestApproach(pieceRings[touched[i]!] ?? [], pieceRings[touched[j]!] ?? []);
                        if (d !== null && d < gap) gap = d;
                      }
                    }
                    entry.gapMm = Number.isFinite(gap) ? gap : 0;
                  }
                  joins.set(key, entry);
                } finally {
                  reach.delete();
                }
              } finally {
                part.delete();
              }
            }
            const cutWidth = 2 * planeRadius;
            for (const join of joins.values()) {
              const places = join.places
                .slice(0, PLACES_SHOWN)
                .map((p) => place(p.x, p.y))
                .join(', ');
              const more = join.places.length > PLACES_SHOWN ? `, and ${join.places.length - PLACES_SHOWN} more` : '';
              // A finer engraver is the one-click fix when the library has one: its tip must satisfy
              // tip/2 + (depth − copper)·tan ≤ gap/2, i.e. tip ≤ gap − 2·(depth − copper)·tan.
              const maxTip = join.gapMm > 0 ? join.gapMm - 2 * Math.max(0, depthMm - colourMm) * cone.tanHalf : 0;
              const finer = (input.engravers ?? [])
                .filter((e) => e.tipMm <= maxTip + 1e-9)
                .sort((a, b) => a.tipMm - b.tipMm)[0];
              const gapWords = join.gapMm > 0 ? `the gap is ${fmt(join.gapMm)} mm across and ` : '';
              findings.push({
                // #743 P-5 review — INFORM, DO NOT REFUSE (the maintainer's 2026-10-29 rule). The board
                // still cuts; the operator may bridge the gap by hand or accept it on a test board.
                severity: 'warning',
                code: 'isolation-short',
                labelId: input.frameId,
                ...(finer === undefined
                  ? {}
                  : { suggestedCutterKey: finer.key, suggestedCutterDiameterMm: finer.tipMm }),
                message:
                  `The isolation cannot open the gap near ${places}${more}: ${gapWords}the cut is ` +
                  `${fmt(cutWidth)} mm wide at the copper, so two pieces of copper stay joined. ` +
                  (finer === undefined
                    ? 'A finer engraver would open it, or widen the gap in the board’s design.'
                    : `A finer engraver opens it, or widen the gap in the board’s design.`),
              });
            }
          } finally {
            for (const p of pieces) p.delete();
          }
        } finally {
          uncut.delete();
        }
      } finally {
        opened.delete();
      }
    }

    // --- a thin trace ----------------------------------------------------------------------
    // The threshold is the cutter's own tip plus the job's Z budget's lateral reach: a trace that
    // is already finer than the tip after the budget is the operator's to check before soldering.
    const thinRadius = cone.tipRadius + zToleranceMm * cone.tanHalf;
    if (thinRadius > 0) {
      const kept = executeProfile(tl, engravableProfile(input.copper, thinRadius));
      try {
        const thin = CS.difference([copperCS, kept]);
        try {
          const parts = thin.decompose();
          try {
            // A component of the difference is a thin TRACE when it is a real strip, and a rounded
            // corner's cap (r × r, area ≈ 0.2 r²) otherwise. The two tests are scale-free: the
            // area floor is (2r)² so a cap can never reach it, and the width is area / the longer
            // extent, which is the strip's own width at any angle. A trace shorter than twice its
            // own width is a blob, and its width is not a number worth a warning.
            const places: { x: number; y: number; width: number }[] = [];
            const areaFloor = Math.max(AREA_FLOOR_MM2, 4 * thinRadius * thinRadius);
            for (const part of parts) {
              const area = part.area();
              if (!(area > areaFloor)) continue;
              const b = bboxOf(part);
              const long = Math.max(b.maxX - b.minX, b.maxY - b.minY);
              if (!(long > 0)) continue;
              places.push({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2, width: area / long });
            }
            if (places.length > 0) {
              places.sort((a, b) => a.width - b.width);
              const first = places[0]!;
              const more = places.length > 1 ? ` (and ${places.length - 1} more)` : '';
              const edge = zToleranceMm * cone.tanHalf;
              findings.push({
                severity: 'warning',
                code: 'thin-trace',
                labelId: input.frameId,
                message:
                  `A trace is ${fmt(first.width)} mm wide at ${place(first.x, first.y)}${more}; the job’s ` +
                  `${fmt(zToleranceMm)} mm surface budget can take ${fmt(edge)} mm from each side of it, ` +
                  `leaving ${fmt(Math.max(0, first.width - 2 * edge))} mm — narrower than the ` +
                  `${fmt(2 * cone.tipRadius)} mm tip of the isolation bit. Check it before soldering.`,
              });
            }
          } finally {
            for (const p of parts) p.delete();
          }
        } finally {
          thin.delete();
        }
      } finally {
        kept.delete();
      }
    }
  } finally {
    bandCS.delete();
    copperCS.delete();
  }
  return findings;
}

/** One isolation frame, resolved from the document: its band, its copper and its cutter. */
export type PcbIsolationSubject = PcbIsolationInput;

/**
 * The isolation frames a job carries, resolved against the job and the plan the CAM builds. Empty
 * for every job without a board's isolation — the check then costs nothing.
 *
 * A frame whose cutter cannot be resolved is skipped: `tool-missing` (or the feeds gate) owns that
 * sentence, and measuring an isolation with no cone would blame the geometry for a missing tool.
 */
export function pcbIsolationSubjects(
  job: EngraveJob,
  plan: PartPlan,
  tools: readonly ToolLibraryEntry[],
  firstTool: Tool | null,
  zToleranceMm: number,
  colourMm: number,
): PcbIsolationSubject[] {
  const out: PcbIsolationSubject[] = [];
  const items: EngraveAnyItem[] = [
    ...job.labels,
    ...job.shapes,
    ...(job.combined ?? []),
    ...(job.vectors ?? []),
  ];
  const byId = new Map(items.map((item) => [item.id, item] as const));
  // The owned engravers, for the one-click fix: a cone with a stated flute and tip.
  const engravers = tools.flatMap((entry) => {
    const tip = cuttingDiameter(entry.tool);
    return vCone(entry.tool) !== null && vFluteLength(entry.tool) !== null && tip !== null && tip > 0
      ? [{ key: entry.key, tipMm: tip }]
      : [];
  });
  for (const item of job.combined ?? []) {
    if (item.kind !== 'frame' || item.isolation !== true || !item.enabled) continue;
    const engrave = plan.engraves.find((e) => e.id === item.id);
    if (engrave === undefined) continue;
    const copperItem = byId.get(item.around);
    if (copperItem === undefined || !('kind' in copperItem) || copperItem.construction !== true) continue;
    // The copper is a plain shape or an imported vector; a reference-following item is not a board.
    const kind = (copperItem as { kind: string }).kind;
    if (kind !== 'vector' && kind !== 'polygon' && kind !== 'rect' && kind !== 'circle') continue;
    const cutter = cutterForItem(job, item.id, tools) ?? firstTool;
    const cone = cutter === null ? null : vCone(cutter);
    if (cone === null) continue;
    out.push({
      band: engrave.profile,
      copper: itemProfile(copperItem, job.customFonts ?? []),
      cone,
      depthMm: engrave.depth,
      colourMm,
      zToleranceMm,
      frameId: item.id,
      engravers,
    });
  }
  return out;
}

/** The cutter the job's setups assign to one item, resolved against the caller's library. */
function cutterForItem(job: EngraveJob, itemId: string, tools: readonly ToolLibraryEntry[]): Tool | null {
  for (const setup of jobSetups(job)) {
    const keys = setupTools(setup, job);
    for (let i = 0; i < keys.length; i++) {
      if (!toolItemsFor(setup, keys[i]!, i).includes(itemId)) continue;
      const entry = tools.find((t) => t.key === keys[i]);
      return entry === undefined ? toolForJob({ toolKey: keys[i]! }, tools) : entry.tool;
    }
  }
  return null;
}
