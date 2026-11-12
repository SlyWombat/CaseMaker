/**
 * #743 P-5 — THE ORACLE FOR A PCB IS TOPOLOGY (design §3.5, D10).
 *
 * A board's cut is right when its copper comes out SEPARATED the way the design separates it. The
 * volumetric check (`computeOracle`) answers "did the file cut what the plan predicted"; it cannot
 * see a SHORT — two nets joined by a bridge of copper — because a bridge is not a missing cut
 * anywhere, it is a piece of material the design never asked to be removed. So a PCB is judged on
 * the copper that is LEFT: the simulated result is sliced at the copper's underside (`capMm`), the
 * remaining material is intersected with the design copper and its isolation band, and that is
 * grouped into connected pieces.
 *
 * Three statements, the design's own:
 *   - every design piece is still there — a piece the cut removed is `matched < designPieces`;
 *   - no two design pieces share a remaining piece — that is a SHORT (two nets, one island);
 *   - no copper is left where the isolation should have cleared it — the band's own remainder,
 *     measured with the oracle's band so a polygon's chord error is not a bridge.
 *
 * It reads the SWEPT SOLID (or the column engine's height field, through the same `sliceAt` seam
 * `computeOracle` uses), never the CAM's prediction, so a CAM bug that posts a shallow program is
 * caught by the same check the plan is not consulted for.
 */

import { segmentsForRadius } from '@/engine/compiler/arcResolution';
import { flatStockOutline, itemProfile } from '@/engine/cnc/engrave/partPlan';
import { rotaryMapOf } from '@/engine/cnc/rotary/wrap';
import { jobSetups, setupTools, toolItemsFor } from '@/engine/cnc/engrave/jobSetup';
import type { Face } from '@/engine/cnc/setups/types';
import type { Profile } from '@/engine/compiler/profile';
import type { EngraveAnyItem, EngraveFrameShape, EngraveJob } from '@/types/engraveJob';
import { executeProfile, type ManifoldToplevel } from '@/workers/geometry/evaluateOp';
import { ORACLE_AREA_FLOOR, ORACLE_SLICE_LIFT_MM, type OracleSliceAt } from '@/engine/cnc/engrave/oracle';
import { liveShopDefaults } from '@/platform/defaultsClient';

type CrossSectionInstance = InstanceType<ManifoldToplevel['CrossSection']>;

/** What the check reads, as plain data — it crosses the worker boundary by structured clone. */
export interface PcbCopperTopologyInput {
  /** The copper cap's thickness, mm — the depth the slice is taken at, from the top face. */
  capMm: number;
  /** The blank's outline in the job frame. */
  stock: Profile;
  /** The design's copper, in the job frame. */
  copper: Profile;
  /** The isolation band around it, in the job frame. */
  band: Profile;
}

/** One face's copper counts. */
export interface CopperTopologyCounts {
  ok: boolean;
  /** Connected pieces the DESIGN states. */
  designPieces: number;
  /** Connected pieces of copper the simulation left on the design (a short merges two). */
  pieces: number;
  /** Design pieces still present in the simulated copper. */
  matched: number;
  /** Pairs of design pieces left joined — a short. */
  shorts: number;
  /** Copper left where the isolation should have cleared it, mm² (only what is wider than the band). */
  bandLeftMm2: number;
}

/** One face's verdict (#743 P-8): the same numbers, tagged with the face the setup cut. */
export interface CopperSideReport extends CopperTopologyCounts {
  face: Face;
}

/** The copper's own verdict, as the run report carries it. */
export interface CopperTopologyReport extends CopperTopologyCounts {
  /** Per-face verdicts, in setup order, when the board has copper on two faces. */
  sides?: readonly CopperSideReport[];
}

/**
 * The job's PCB facts per SETUP, or an empty list for every job without a board: no laminate
 * cap, a rotary job (a board is cut flat), or no isolation frame. Pure — the caller hands it the
 * job it holds.
 *
 * A two-sided board has one isolation frame per setup, each around the copper of THAT setup's
 * work frame (#743 P-8's import). The copper and the band are built from the frame's own `around`,
 * so each side is read in the frame its program was posted in.
 */
export function pcbCopperTopologyInputs(
  job: EngraveJob,
): { setupIndex: number; faceUp: Face; cutterKey: string | null; input: PcbCopperTopologyInput }[] {
  const colour = job.stock.colour;
  const capMm = colour !== undefined && colour.kind === 'laminate' ? colour.capMm : null;
  if (capMm === null || !(capMm > 0)) return [];
  if (rotaryMapOf(job, liveShopDefaults()) !== null) return [];
  const frames = (job.combined ?? []).filter(
    (item): item is EngraveFrameShape => item.kind === 'frame' && item.isolation === true && item.enabled,
  );
  if (frames.length === 0) return [];
  const items: EngraveAnyItem[] = [
    ...job.labels,
    ...job.shapes,
    ...(job.combined ?? []),
    ...(job.vectors ?? []),
  ];
  const stock = flatStockOutline(job.stock);
  const forFrame = (frame: EngraveFrameShape): PcbCopperTopologyInput | null => {
    const copperItem = items.find((item) => item.id === frame.around);
    if (copperItem === undefined || !('kind' in copperItem)) return null;
    const copper = itemProfile(copperItem, job.customFonts ?? []);
    const band = itemProfile(frame, job.customFonts ?? [], {
      stockOutline: stock,
      profileOf: (id) => (id === frame.around ? copper : null),
    });
    return { capMm, stock, copper, band };
  };

  const out: { setupIndex: number; faceUp: Face; cutterKey: string | null; input: PcbCopperTopologyInput }[] = [];
  jobSetups(job).forEach((setup, i) => {
    // A setup owns the isolation frame it cuts; a frame in no setup (a hand-added one on a saved
    // list that predates it) is left to the single-frame fallback below.
    const frame = frames.find((f) => setup.itemIds.includes(f.id));
    if (frame === undefined) return;
    const input = forFrame(frame);
    if (input === null) return;
    // The cutter that cuts THIS isolation: the run's check reads the program that drew the
    // separation, so the caller can find its sweep.
    const keys = setupTools(setup, job);
    const cutterKey = keys.find((key, k) => toolItemsFor(setup, key, k).includes(frame.id)) ?? null;
    out.push({ setupIndex: i + 1, faceUp: setup.orientation.top, cutterKey, input });
  });
  if (out.length === 0) {
    // The document's first isolation frame is the one a job without a saved list states (the
    // single-sided reading, unchanged).
    const input = forFrame(frames[0]!);
    if (input !== null) {
      const setup = jobSetups(job)[0];
      const keys = setup === undefined ? [] : setupTools(setup, job);
      const cutterKey = setup === undefined ? null : (keys.find((key, k) => toolItemsFor(setup, key, k).includes(frames[0]!.id)) ?? null);
      out.push({ setupIndex: 1, faceUp: setup?.orientation.top ?? 'top', cutterKey, input });
    }
  }
  return out;
}

/**
 * The job's PCB facts, or null for every job without a board. The FIRST face's — every caller
 * that knows only one side (the P-6 surface budget's arithmetic, a test fixture) reads this.
 */
export function pcbCopperTopologyInput(job: EngraveJob): PcbCopperTopologyInput | null {
  return pcbCopperTopologyInputs(job)[0]?.input ?? null;
}

/**
 * One report for a board cut on several faces (#743 P-8): the counts summed, `ok` only when every
 * face is, and the per-face verdicts carried for the sentence. A side that was not checked is not
 * in the list, so a run that never swept the second face cannot claim it passed.
 */
export function combineCopperSides(sides: readonly CopperSideReport[]): CopperTopologyReport {
  const sum = (pick: (s: CopperSideReport) => number): number => sides.reduce((n, s) => n + pick(s), 0);
  return {
    ok: sides.length > 0 && sides.every((s) => s.ok),
    designPieces: sum((s) => s.designPieces),
    pieces: sum((s) => s.pieces),
    matched: sum((s) => s.matched),
    shorts: sum((s) => s.shorts),
    bandLeftMm2: sum((s) => s.bandLeftMm2),
    sides: sides.map((s) => ({ ...s })),
  };
}

function bboxOf(cs: CrossSectionInstance): { minX: number; maxX: number; minY: number; maxY: number } {
  const b = cs.bounds();
  return { minX: b.min[0], maxX: b.max[0], minY: b.min[1], maxY: b.max[1] };
}

/**
 * The topology of the copper a run left. `sliceAt` is the SAME seam `computeOracle` is handed —
 * the exact sweeper's removal solid or the column engine's height field — and `bandMm` is the
 * oracle's own band, which is how much a boundary may drift before it is a bridge.
 */
export function computeCopperTopology(
  tl: ManifoldToplevel,
  sliceAt: OracleSliceAt,
  input: PcbCopperTopologyInput,
  bandMm: number,
): CopperTopologyReport {
  const CS = tl.CrossSection;
  const removed = sliceAt(-input.capMm + ORACLE_SLICE_LIFT_MM);
  const stock = executeProfile(tl, input.stock);
  const copper = executeProfile(tl, input.copper);
  const band = executeProfile(tl, input.band);
  try {
    // The copper at its underside is the whole blank's top clad minus whatever the run removed.
    const remaining = removed === null ? stock : CS.difference([stock, removed]);
    try {
      const interest = CS.union([copper, band]);
      const left = CS.intersection([remaining, interest]);
      try {
        const design = copper.decompose();
        try {
          const designBoxes = design.map(bboxOf);
          const leftParts = left.decompose();
          try {
            let pieces = 0;
            let shorts = 0;
            const present = new Set<number>();
            for (const part of leftParts) {
              if (!(part.area() > ORACLE_AREA_FLOOR)) continue;
              pieces += 1;
              const box = bboxOf(part);
              let touching = 0;
              for (let i = 0; i < design.length; i++) {
                const db = designBoxes[i]!;
                if (box.maxX < db.minX || box.minX > db.maxX || box.maxY < db.minY || box.minY > db.maxY) continue;
                const hit = CS.intersection([part, design[i]!]);
                try {
                  if (hit.area() > ORACLE_AREA_FLOOR) {
                    touching += 1;
                    present.add(i);
                  }
                } finally {
                  hit.delete();
                }
              }
              if (touching > 1) shorts += (touching * (touching - 1)) / 2;
            }
            const matched = present.size;
            // Copper left in the band: what remains outside the design, ERODED by the oracle band,
            // so a chord-error sliver along a delivered edge is not read as a bridge.
            const stray = CS.difference([left, copper]);
            let bandLeftMm2 = 0;
            try {
              const serious =
                bandMm > ORACLE_AREA_FLOOR ? stray.offset(-bandMm, 'Round', 2, segmentsForRadius(bandMm)) : stray;
              try {
                bandLeftMm2 = Math.max(0, serious.area());
              } finally {
                if (serious !== stray) serious.delete();
              }
            } finally {
              stray.delete();
            }
            const designPieces = design.length;
            const ok =
              designPieces > 0 && matched === designPieces && shorts === 0 && bandLeftMm2 <= ORACLE_AREA_FLOOR;
            return { ok, designPieces, pieces, matched, shorts, bandLeftMm2 };
          } finally {
            for (const p of leftParts) p.delete();
          }
        } finally {
          for (const p of design) p.delete();
        }
      } finally {
        left.delete();
        interest.delete();
      }
    } finally {
      if (remaining !== stock) remaining.delete();
    }
  } finally {
    stock.delete();
    copper.delete();
    band.delete();
    removed?.delete();
  }
}
