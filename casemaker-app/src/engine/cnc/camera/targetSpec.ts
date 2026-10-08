/**
 * The camera calibration target, as geometry in mm (#189, the half that needs no machine).
 *
 * ## What this is for
 *
 * #189 calibrates the Z1's integrated camera so coarse visual positioning becomes a datum source
 * rather than a picture. Its central idea is that **the machine is the length standard, not the
 * paper**: commanding a 50 mm move and measuring the image content's pixel shift gives mm-per-pixel
 * from a ruler accurate to the machine's positioning, rather than from a desktop printer whose
 * scale is 0.2–0.5 % out and moves with the paper's humidity. So the target only has to supply
 * *detectable features*; every distance is measured by moving.
 *
 * That splits the target in two, and the split is the design:
 *
 *  - **milled fiducials** — crosses cut into the sacrificial sheet at COMMANDED positions. Their
 *    position in machine coordinates is known by construction, and their geometry carries machine
 *    accuracy rather than print accuracy. They also close the one number the grid alone cannot
 *    give: the vector from the image centre to a milled feature, scaled, is the camera-to-spindle
 *    offset, because the cutter put the feature at the spindle's true position (#189 refinement 1).
 *  - **a printed checkerboard** — a fine regular pattern on a sheet laid over the fiducials.
 *    Printed features detect better than milled ones for sub-pixel corner finding; the fine grid
 *    supplies the corners, the milled crosses supply the frame. The pattern is omitted in a small
 *    hole around each cross (`cameraTargetFiducialZones`), so no groove is ever cut across a
 *    checker edge — the one thing that would blur the corners the method depends on.
 *
 * ## What is deliberately absent, and why
 *
 * **Identity markers (ArUco/ChArUco) are not generated here.** #189 refinement 4 wants them so a
 * snapshot can tell *which* part of the target it is seeing. That needs the marker dictionary's bit
 * patterns, and those are DATA (the standard 4×4/5×5 code tables), not something to invent: a
 * fabricated bit pattern draws something that *looks* like an ArUco marker and that no detector
 * will ever find, which is a silent wrong answer rather than a missing feature. Sourcing a
 * dictionary is its own small decision — ours, or OpenCV's — and it is recorded on #189 rather than
 * guessed at here. A checkerboard plus milled fiducials is detectable as it stands, so the
 * machine-free half does not wait on it.
 *
 * ## Provisional numbers
 *
 * The numbers below are CHOSEN, and none has been cut or photographed. They are marked where they
 * are set, the way `FIT_CLEAR` and the `LUG_*` family are: a calibration that uses them records its
 * own measured values, and the first real pass at the machine replaces them. `cameraTargetProblem`
 * checks only what is checkable without the camera — that everything lands on the sheet.
 */

import { Z1, type MillProfile } from '@/engine/cnc/machine';
import type { Mm, Vec2 } from '@/types/units';

/**
 * How far inside the machine's envelope the target sheet is assumed to sit, on every side, mm.
 *
 * CHOSEN, not measured. The envelope is the machine's full travel; the sheet has to be small
 * enough to be held — the fiducials are milled, so the sheet goes in the vise or on the bed with
 * its workholding around it — and large enough that the camera's grid covers the area it will
 * actually work over. 20 mm a side leaves the vise jaws, the anchor brackets and the tool setter
 * clear of the cut.
 */
export const CAMERA_TARGET_MARGIN: Mm = 20;

/**
 * Fiducial pitch, mm. CHOSEN. The grid exists to sample the field across the sheet: too wide and
 * distortion between points is unmeasured, too fine and the crosses stop being separable when the
 * camera is at its widest Z. 40 mm puts 4 crosses across a 160 mm sheet, which is the coarsest
 * spacing that still samples a corner, an edge and the centre of the travel.
 */
export const CAMERA_FIDUCIAL_PITCH: Mm = 40;

/**
 * Arm length (the cross's overall span) and stroke width, mm. CHOSEN. 8 mm of arm is several
 * cutters wide, so the crossing point is unambiguous in a small image; the 1.2 mm stroke is just
 * over the ⌀1.0 mm flat end that cuts it (`TOOL_LIBRARY`'s only small cutter), so the pocket has
 * wall clearance for the cutter to reach the corner. A stroke narrower than the cutter would be
 * widened to the cutter's own diameter anyway, and the cross's shape would stop being the tip's
 * shape.
 */
export const CAMERA_FIDUCIAL_ARM: Mm = 8;
export const CAMERA_FIDUCIAL_STROKE: Mm = 1.2;

/** Fiducial cut depth into the sheet, mm. CHOSEN: shallow, so the sheet survives and can be re-cut. */
export const CAMERA_FIDUCIAL_DEPTH: Mm = 0.5;

/**
 * Checkerboard square size, mm. CHOSEN, and the one number that really wants the camera: a square
 * has to cover enough pixels to find its corners sub-pixel, which depends on the resolution and the
 * field of view at working Z. Neither is characterised — `ws_video` is still an unverified guess
 * (`/Fabrication.md` §5.7, #181). 5 mm is a common printed-target pitch and is the first thing to
 * change when the camera is measured.
 */
export const CAMERA_CHECKER_SQUARE: Mm = 5;

/**
 * The gap left between the checkerboard and the sheet's edge, mm. The pattern is clipped to whole
 * squares inside it, so the board never runs off the paper.
 */
export const CAMERA_CHECKER_MARGIN: Mm = CAMERA_FIDUCIAL_ARM / 2;

/**
 * How much clear zone a fiducial needs beyond the cross's own half-span, mm. CHOSEN: the index
 * label printed in the hole's corner is 2.4 mm tall and sits inside it, so the zone has to be wider
 * than the cross by more than the label. This is what `cameraTargetProblem` checks, so a spec can
 * never ask for a hole the label would spill out of.
 */
export const CAMERA_FIDUCIAL_CLEAR_PAD: Mm = 4;

/**
 * How far the printed pattern stays clear of every fiducial's centre, mm. Derived from the arm so
 * it tracks it: half the arm (the cross has to fit) plus the pad above.
 *
 * The cross is milled THROUGH the pattern, and a groove crossing a checker edge is lit against two
 * backgrounds — its arm-ends stop being the crisp corners the whole method measures. So the pattern
 * is omitted around each fiducial, which also leaves the operator an unmistakable pocket to cut
 * into: with no ink where the cut goes, a mis-scaled print shows up as a visibly off-centre cross.
 *
 * The hole snaps OUTWARD to whole squares (`cameraTargetFiducialZones`), so it is this radius or
 * more — never less — and the printed pattern and `cameraTargetCheckerSquares` agree exactly.
 */
export const CAMERA_FIDUCIAL_CLEAR: Mm = CAMERA_FIDUCIAL_ARM / 2 + CAMERA_FIDUCIAL_CLEAR_PAD;

/** How many fiducials a target carries, per axis. CHOSEN (see `CAMERA_FIDUCIAL_PITCH`). */
export const CAMERA_FIDUCIAL_COUNT = 4;

export interface CameraTargetSpec {
  /** File-stem id for the programs and art this spec produces, e.g. `camera-target`. */
  id: string;
  /** Human title, used in file names and the script's receipt. */
  title: string;
  /** The material the target is made on: the sheet the fiducials are milled into, then covered. */
  sheet: { width: Mm; depth: Mm };
  /** Mill the crosses into the sheet. */
  fiducials: {
    count: { x: number; y: number };
    /** Centre-to-centre pitch along X and Y, mm. */
    pitch: { x: Mm; y: Mm };
    /** Centre of the FIRST (lower-left) fiducial, mm from the sheet's front-left corner. */
    origin: { x: Mm; y: Mm };
    /** Overall span of the cross, mm. */
    arm: Mm;
    /** Width of each arm, mm. */
    stroke: Mm;
    /** Depth of the cut below the sheet's top face, mm. Positive. */
    depth: Mm;
  };
  /** Cover the fiducials with a printed fine pattern for sub-pixel corner finding. */
  checker: {
    /** Square size, mm. */
    square: Mm;
    /** Clearance kept between the grid and the sheet's edge, mm. */
    margin: Mm;
    /** How far the pattern stays clear of every fiducial's centre, mm. See `CAMERA_FIDUCIAL_CLEAR`. */
    clear: Mm;
  };
}

/**
 * The target for a machine, derived from its envelope rather than typed. The grid is CENTRED on the
 * sheet: the sheet's frame is what `origin` measures from, so a centred grid is the one that leaves
 * the same margin on all four sides, and an off-centre default would silently bias which part of
 * the travel the camera samples.
 */
export function cameraTargetFor(machine: MillProfile = Z1, overrides: Partial<CameraTargetSpec> = {}): CameraTargetSpec {
  const width = machine.envelope.x.max - machine.envelope.x.min - 2 * CAMERA_TARGET_MARGIN;
  const depth = machine.envelope.y.max - machine.envelope.y.min - 2 * CAMERA_TARGET_MARGIN;
  const count = { x: CAMERA_FIDUCIAL_COUNT, y: CAMERA_FIDUCIAL_COUNT };
  const pitch = { x: CAMERA_FIDUCIAL_PITCH, y: CAMERA_FIDUCIAL_PITCH };
  return {
    id: 'camera-target',
    title: `Camera target (${machine.name})`,
    sheet: { width, depth },
    fiducials: {
      count,
      pitch,
      // Centred: the first centre sits half the grid's own span in from the sheet's edge.
      origin: {
        x: (width - (count.x - 1) * pitch.x) / 2,
        y: (depth - (count.y - 1) * pitch.y) / 2,
      },
      arm: CAMERA_FIDUCIAL_ARM,
      stroke: CAMERA_FIDUCIAL_STROKE,
      depth: CAMERA_FIDUCIAL_DEPTH,
    },
    checker: { square: CAMERA_CHECKER_SQUARE, margin: CAMERA_CHECKER_MARGIN, clear: CAMERA_FIDUCIAL_CLEAR },
    ...overrides,
  };
}

/**
 * Every fiducial's centre, in SHEET coordinates (mm from the sheet's front-left corner), row-major
 * from the lower-left: index `i = row * count.x + col`. Pure, and the ONE place the grid's
 * arithmetic lives — the `.nc`, the SVG and any test all read this, so the milled position and the
 * printed pocket cannot drift apart.
 */
export function cameraTargetFiducials(spec: CameraTargetSpec): Vec2[] {
  const { count, pitch, origin } = spec.fiducials;
  const out: Vec2[] = [];
  for (let row = 0; row < count.y; row++) {
    for (let col = 0; col < count.x; col++) {
      out.push([origin.x + col * pitch.x, origin.y + row * pitch.y]);
    }
  }
  return out;
}

/** One square of the printed pattern, in sheet coordinates: its lower-left corner and its size. */
export interface CheckerSquare {
  /** Lower-left corner, mm from the sheet's front-left corner. */
  at: Vec2;
  size: Mm;
}

/**
 * The grid the pattern is laid out on: how many whole squares fit with `margin` to spare, and where
 * the grid's lower-left corner falls. Centred, so a remainder is split between two sides rather
 * than all landing on one edge. The one place the grid's origin and extent are computed.
 */
function checkerGrid(spec: CameraTargetSpec): { cols: number; rows: number; x0: Mm; y0: Mm } {
  const { square, margin } = spec.checker;
  const cols = Math.floor((spec.sheet.width - 2 * margin) / square);
  const rows = Math.floor((spec.sheet.depth - 2 * margin) / square);
  return { cols, rows, x0: (spec.sheet.width - cols * square) / 2, y0: (spec.sheet.depth - rows * square) / 2 };
}

/** A hole in the printed pattern: the clear zone around one fiducial, in sheet coordinates. */
export interface CheckerHole {
  /** Which fiducial the hole belongs to: an index into `cameraTargetFiducials`. */
  fiducial: number;
  /** Lower-left corner, mm from the sheet's front-left corner. */
  at: Vec2;
  width: Mm;
  depth: Mm;
}

/**
 * The pattern's holes, one per fiducial that the pattern actually reaches, in sheet coordinates.
 *
 * A hole is every whole square that meets the `clear` box around a fiducial's centre — snapped
 * OUTWARD, so the hole always contains that box, and so the art has nothing to draw and the pattern
 * has nothing to omit beyond this list. That is why `cameraTargetCheckerSquares` reads it too: the
 * printed pattern and this module's account of it cannot disagree, which matters as soon as
 * anything generates an expected pattern to match an image against.
 *
 * A fiducial the pattern does not reach has NO hole. `cameraTargetProblem` treats that as an error
 * rather than an empty hole: a cross with no pattern around it is one the camera cannot locate.
 */
export function cameraTargetFiducialZones(spec: CameraTargetSpec): CheckerHole[] {
  const { square, clear } = spec.checker;
  const { cols, rows, x0, y0 } = checkerGrid(spec);
  if (!(clear > 0) || cols < 1 || rows < 1) return [];
  const out: CheckerHole[] = [];
  cameraTargetFiducials(spec).forEach(([cx, cy], fiducial) => {
    // The first and last square whose span meets [c - clear, c + clear], clamped to the pattern.
    const c0 = Math.max(0, Math.floor((cx - clear - x0) / square));
    const c1 = Math.min(cols - 1, Math.ceil((cx + clear - x0) / square) - 1);
    const r0 = Math.max(0, Math.floor((cy - clear - y0) / square));
    const r1 = Math.min(rows - 1, Math.ceil((cy + clear - y0) / square) - 1);
    if (c1 < c0 || r1 < r0) return; // the clamps crossed: the fiducial is clear of the pattern.
    out.push({
      fiducial,
      at: [x0 + c0 * square, y0 + r0 * square],
      width: (c1 - c0 + 1) * square,
      depth: (r1 - r0 + 1) * square,
    });
  });
  return out;
}

/**
 * The checkerboard's squares, in sheet coordinates: the whole squares that fit inside the sheet
 * with `margin` to spare on every side, numbered from the lower-left, with `(col + row)` odd —
 * which is what makes them a board rather than a solid block — and minus the squares that fall in a
 * fiducial's hole. Pure, and clipped to whole squares so the pattern never runs off the paper or
 * over a cross.
 */
export function cameraTargetCheckerSquares(spec: CameraTargetSpec): CheckerSquare[] {
  const { square } = spec.checker;
  const { cols, rows, x0, y0 } = checkerGrid(spec);
  const holes = cameraTargetFiducialZones(spec);
  const inHole = ([x, y]: Vec2): boolean =>
    holes.some((h) => x < h.at[0] + h.width && x + square > h.at[0] && y < h.at[1] + h.depth && y + square > h.at[1]);
  const out: CheckerSquare[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if ((col + row) % 2 === 0) continue; // the dark squares only; the paper is the light ones.
      const at: Vec2 = [x0 + col * square, y0 + row * square];
      if (inHole(at)) continue;
      out.push({ at, size: square });
    }
  }
  return out;
}

/**
 * The area the printed grid covers, mm: `{ width, depth }` of whole squares, centred on the sheet.
 * The holes are *inside* this extent, so it is the same number with or without them.
 */
export function cameraTargetCheckerExtent(spec: CameraTargetSpec): { width: Mm; depth: Mm } {
  const { square } = spec.checker;
  const { cols, rows } = checkerGrid(spec);
  return { width: cols * square, depth: rows * square };
}

/**
 * Everything that can be checked about a target WITHOUT the camera, or `null` when it is sound.
 * These are the ways a spec is a mis-typed instruction rather than a target: a sheet that does not
 * exist, a grid that runs off it, a stroke the cutter cannot cut, a pattern with no squares, a
 * cross the camera could not find because the pattern does not reach it.
 */
export function cameraTargetProblem(spec: CameraTargetSpec): string | null {
  const { sheet, fiducials: f, checker } = spec;
  if (!(sheet.width > 0) || !(sheet.depth > 0)) return 'the sheet must have a positive width and depth';
  if (!Number.isInteger(f.count.x) || !Number.isInteger(f.count.y) || f.count.x < 1 || f.count.y < 1) {
    return 'the fiducial count must be whole numbers of at least 1 on each axis';
  }
  if (!(f.pitch.x > 0) || !(f.pitch.y > 0)) return 'the fiducial pitch must be positive';
  if (!(f.arm > 0) || !(f.stroke > 0)) return 'the fiducial arm and stroke must be positive';
  if (f.stroke > f.arm) return `the fiducial stroke (${f.stroke} mm) is wider than its arm (${f.arm} mm)`;
  if (!(f.depth > 0)) return 'the fiducial depth must be positive';

  // Every cross, with its arms, has to lie wholly on the sheet: a fiducial the cutter cannot reach
  // is a grid position that is silently missing from the calibration.
  const half = f.arm / 2;
  for (const [x, y] of cameraTargetFiducials(spec)) {
    if (x - half < 0 || x + half > sheet.width || y - half < 0 || y + half > sheet.depth) {
      return `the fiducial at (${x}, ${y}) mm reaches past the sheet's edge; move the grid in or shrink its arm`;
    }
  }

  if (!(checker.square > 0)) return 'the checker square size must be positive';
  if (!(checker.margin >= 0)) return 'the checker margin cannot be negative';
  if (!(checker.clear >= half + CAMERA_FIDUCIAL_CLEAR_PAD)) {
    return (
      `a ${checker.clear} mm clear zone around each fiducial leaves less than ${CAMERA_FIDUCIAL_CLEAR_PAD} mm ` +
      `beyond the cross's ${f.arm} mm arms, so the cut would cross printed squares and run through the ` +
      `fiducial's label; widen the clear zone or shorten the arm`
    );
  }
  const extent = cameraTargetCheckerExtent(spec);
  if (extent.width < checker.square || extent.depth < checker.square) {
    return (
      `a ${checker.square} mm checker square does not fit a ${sheet.width} × ${sheet.depth} mm sheet ` +
      `with a ${checker.margin} mm margin; shrink the square, the margin or grow the sheet`
    );
  }

  // Every cross needs pattern around it to be found BY, and a hole that holds its whole clear zone:
  // the hole snaps outward to the grid, so a cross near the pattern's edge gets a clipped one, and
  // the cut would run through printed squares on that side.
  const holes = new Map(cameraTargetFiducialZones(spec).map((h) => [h.fiducial, h]));
  for (const [i, [x, y]] of cameraTargetFiducials(spec).entries()) {
    const hole = holes.get(i);
    if (hole === undefined) {
      return (
        `the fiducial at (${x}, ${y}) mm is outside the printed pattern, so the camera has nothing to ` +
        `find it against; move the grid inside the pattern or grow the pattern`
      );
    }
    if (
      hole.at[0] > x - checker.clear ||
      hole.at[0] + hole.width < x + checker.clear ||
      hole.at[1] > y - checker.clear ||
      hole.at[1] + hole.depth < y + checker.clear
    ) {
      return (
        `the fiducial at (${x}, ${y}) mm is too close to the pattern's edge for a ${checker.clear} mm ` +
        `clear zone: its hole is only ${hole.width} × ${hole.depth} mm, so the cut would cross printed squares`
      );
    }
  }
  return null;
}
