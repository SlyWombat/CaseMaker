/**
 * #1146 — THE CLEANING PASS AND THE AIR WALK, AS FILES (the maintainer's ruling, 2026-11-09).
 *
 * "After each program a cleaning pass should be default, and before the first cut an air walk over
 * the outside (laser on if available). Selectable if not desired, but default."
 *
 * Both are MOTION FILES: generated here as a `ToolpathIR`, posted and verified by the same
 * `postFor`/`verifyProgram` pair every program goes through, then uploaded and run — never console
 * lines. A burst of console lines froze the controller with an RX-error alarm (#1123 item 43).
 *
 * THE CLEARANCE IS THE JOB'S OWN FIXTURES'. The sweep runs at
 * `max(the stock top (work Z 0), every mount obstacle's topZ) + clean.clearanceMm`, where the
 * obstacles are `jobMountObstacles(job)` — the same boxes the verifier and the sweep read — so it
 * can never sit below a clamp's or bracket's top. The three numbers (clearance, row spacing, feed)
 * are SHOP DEFAULTS, seeded from the bench's own pass (5 mm, 12 mm, F1500), never constants here.
 *
 * Outputs: the CLEAN file carries the DIRECT spindle-air pair `M811` on at its first move and
 * `M812` off at its end (0f proved M331/M331.1 are spindle-following auto modes). It carries NO
 * vacuum words: inside a run it rides the job's span (the run's own M851/M852 are #1123 item 41's
 * business); after a Stop it is its own span, and the run layer brackets it. The AIR WALK carries
 * no accessory words at all on a Z1 (its dot is the probe's; there is no laser) — the move alone.
 */
import { estimateCycleSeconds, toolNumberFor, type CamMove, type RapidEstimate, type ToolpathIR } from '@/engine/cnc/cam/ir';
import type { Tool } from '@/engine/cnc/tool';

/** The two shop defaults the walks read (both seeded; nothing else is a number here). */
export interface CleanWalkSettings {
  /** Above the highest fixture (or the stock top), mm. */
  clearanceMm: number;
  /** The raster's row pitch over the stock footprint, mm. */
  rowSpacingMm: number;
}

/** The boxes the sweep must clear — `MountObstacle`'s own geometry, structural so this module needs no mount import. */
export interface CleanWalkObstacle {
  min: [number, number];
  max: [number, number];
  /** Its highest point, work Z. */
  topZ: number;
}

export interface CleanWalkInput {
  /** The stock footprint, work XY from (0, 0). */
  stock: { length: number; width: number };
  obstacles: readonly CleanWalkObstacle[];
  /**
   * The machine's travel height in the WORK frame, mm — the caller converts the machine's own
   * clearance Z by the setup's G54 Z. Null when the setup has no registration to convert with:
   * the move is generated and the release says the height was not checked.
   */
  travelWorkZMm: number | null;
  settings: CleanWalkSettings;
  /** The job's cutter — the post's header names one, and the air walk is not a tool change. */
  tool: Tool;
  /** The machine's rapid estimate, so the file's own cycle is stated like every program's. */
  rapid: RapidEstimate;
}

export type CleanWalkMode = 'clean' | 'airwalk';

/**
 * #1202 field 5 — the walk's STRUCTURAL steps, in order. The generator's own vocabulary, so a
 * routine's identity is the sequence and never the geometry: a raster over any blank is one
 * `raster` step, and the cleaning pass's direct-air pair is stated as the words the file carries.
 */
export type CleanWalkStep = 'M811' | 'raster' | 'M812' | 'outline';

export type CleanWalkResult =
  | {
      ok: true;
      ir: ToolpathIR;
      sweepZ: number;
      rows: number;
      estimatedSeconds: number;
      /** #1202 — the routine's structural sequence, the identity's only input. */
      steps: readonly CleanWalkStep[];
    }
  | { ok: false; reason: string };

/** THE SWEEP'S Z: the highest fixture (or the stock top) plus the shop's clearance. */
export function cleanSweepZ(obstacles: readonly CleanWalkObstacle[], clearanceMm: number): number {
  let highest = 0; // the stock top is the work datum
  for (const obstacle of obstacles) if (obstacle.topZ > highest) highest = obstacle.topZ;
  return highest + clearanceMm;
}

/**
 * The walk as an IR. CLEAN: a boustrophedon raster over the stock footprint at the sweep Z. AIR
 * WALK: the stock outline traced once at the same Z.
 *
 * THE SWEEP MOVES AT RAPID (G0). The bench's pass was spoken as F1500, but the Z1's own X/Y rate
 * ceiling is 1200 mm/min (the config read 2026-10-07, `rapidEstimate.xyMmPerMin`) and the post
 * refuses any feed above `maxCutFeed` — a file cannot state F1500. A G0 runs at the controller's
 * seek rate, which IS that 1200: the bench's 10 rows over the 160 × 126 blank took ~100 s, and
 * the estimate below (the same rapid model) says ~90 s. There is no feed setting: the shop record
 * states only the two numbers the walk reads (the clearance and the row pitch), because a setting
 * nothing commands would be a false statement in it (the manager's ruling, 2026-11-10).
 */
export function cleanWalkFile(input: CleanWalkInput, mode: CleanWalkMode): CleanWalkResult {
  const sweepZ = cleanSweepZ(input.obstacles, input.settings.clearanceMm);
  const label = mode === 'clean' ? 'cleaning pass' : 'air walk';
  if (input.travelWorkZMm !== null && sweepZ > input.travelWorkZMm) {
    return {
      ok: false,
      reason:
        `the ${label} would run at work Z ${sweepZ.toFixed(2)}, above the machine's travel height ` +
        `(${input.travelWorkZMm.toFixed(2)} in the work frame) — lower clean.clearanceMm or the fixtures set the floor`,
    };
  }
  const { length, width } = input.stock;
  if (!(length > 0 && width > 0)) return { ok: false, reason: `the ${label} needs a stock footprint` };
  const rapid = (x: number, y: number): CamMove => ({ kind: 'rapid', x, y, z: sweepZ });
  const moves: CamMove[] = [];
  let rows = 0;
  if (mode === 'clean') {
    const spacing = Math.max(1, input.settings.rowSpacingMm);
    for (let y = spacing / 2; y < width; y += spacing) {
      const leftToRight = rows % 2 === 0;
      moves.push(rapid(leftToRight ? 0 : length, y));
      moves.push(rapid(leftToRight ? length : 0, y));
      rows++;
    }
  } else {
    moves.push(rapid(0, 0), rapid(length, 0), rapid(length, width), rapid(0, width), rapid(0, 0));
    rows = 1;
  }
  const ir: ToolpathIR = {
    frame: 'flat',
    tool: input.tool,
    toolNumber: toolNumberFor(input.tool),
    // The pass moves air; the spindle is never commanded (the post's `noSpindle` skips the word).
    spindleRpm: 0,
    // No vacuum words of its own — inside a run the span owns them.
    air: false,
    safeZ: sweepZ,
    hopZ: sweepZ,
    operations: [
      {
        number: 1,
        name: mode === 'clean' ? 'Cleaning pass' : 'Air walk',
        labelId: '',
        depth: 0,
        moves,
        estimatedSeconds: estimateCycleSeconds(moves, input.rapid),
      },
    ],
  };
  // #1202 — the routine's shape, in the generator's own step vocabulary. The cleaning pass's
  // direct-air pair is part of the sequence (the FILE carries M811/M812); the air walk is the one
  // closed outline. Geometry (rows, footprint, sweep Z) is deliberately absent.
  const steps: readonly CleanWalkStep[] = mode === 'clean' ? ['M811', 'raster', 'M812'] : ['outline'];
  return { ok: true, ir, sweepZ, rows, estimatedSeconds: ir.operations[0]!.estimatedSeconds, steps };
}
