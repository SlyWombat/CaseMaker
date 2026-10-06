/**
 * The emulator's input: a part, how it is held, and where it sits (#182, `/Simulation.md` §1.1).
 *
 * THE DECISION THIS FILE EXISTS FOR: placement is an INPUT, not a problem to solve.
 * Registration — probing, the camera, a vise's known geometry — produces transforms, and the
 * emulator consumes them without caring how they were obtained. So they are stubbed: type
 * the number in and the emulator runs. When real registration lands it fills the same
 * fields (`source`, `uncertainty`) and nothing downstream changes.
 *
 * Two corrections to the first sketch of this type, both from the design reviews:
 *
 *  1. ONE TRANSFORM IS NOT ENOUGH. Studio's probing produces the G54 WORK OFFSET, and the
 *     `.nc` carries no `G10`, so the file's coordinates relate to the machine through
 *     machine state the file cannot supply (`/Z1-Firmware-Dialect.md` §3: it lives in the
 *     controller's EEPROM). Stock subtraction happens in work coordinates; a `G53` move and
 *     the envelope check need machine coordinates. So `Setup` carries TWO transforms:
 *     `placement` (part → machine) and `wcs` (work → machine).
 *  2. `uncertainty` belongs on the WCS, not the part. The registration residual is the
 *     work origin's error relative to the part, which is what a probe or a fixture
 *     actually resolves. The part's position on the bed is not what anyone measures.
 *
 * Everything here is plain serialisable data so it crosses the geometry-worker boundary.
 * (The first sketch put a live `Manifold` in `part`, which cannot be posted to a worker.)
 */

import { aabbOfProfile, type Profile } from '@/engine/compiler/profile';
import type { Mm, Vec2, Vec3 } from '@/types/units';
import type { Sacrificial } from '@/types/engraveJob';
import type { AxisRange, MillProfile } from './machine';

export type Degrees = number;

/**
 * Where a registration number came from. A stub is typed in, not measured; a `header` value was
 * read from an UNTRUSTED `;@MKR` header (`setupFromHeader`) and only ever prefills a form.
 */
export type RegistrationSource = 'stub' | 'fixture' | 'probe' | 'camera' | 'header';

/** The workpiece, in its own authored frame (`/Simulation.md` §2). */
export type PartSpec =
  | {
      kind: 'prism';
      /** Outline in the model XY plane, bbox-min near the origin. */
      outline: Profile;
      /**
       * Thickness. The model frame has z = 0 at the BACK face and the engraved face at
       * z = thickness: the work origin is anchored at the engraved face, never at z = 0,
       * because the back face carries all the print's thickness error (decision 24).
       */
      thickness: Mm;
      /** Height of the colour change above the back face, if the part is two-colour. */
      colourSplit?: Mm;
    }
  | { kind: 'cylinder'; diameter: Mm; length: Mm }
  /** A compiled BuildPlan node, resolved by the caller. */
  | { kind: 'node'; id: string };

export interface Plane {
  origin: Vec3;
  normal: Vec3;
}

/**
 * How the part is held. Each variant must answer the same four questions
 * (`/Fabrication.md` §7.3): what is reachable, what is obstructed, what datum it already
 * supplies, and the residual uncertainty. The vacuum bed is deliberately absent: it is
 * hardware nobody has, and building a variant for it is speculative infrastructure.
 */
export type Workholding =
  | { kind: 'anchor-bracket'; anchor: 1 | 2; offset: Vec2 }
  | { kind: 'top-clamps'; clamps: { at: Vec2; footprint: Profile }[] }
  | { kind: 'vise'; jawFaces: [Plane, Plane]; jawHeight: Mm }
  | { kind: 'rotary-chuck'; jawDiameter: Mm; stickout: Mm }
  | { kind: 'tape-down'; contact: Profile; shim?: Profile }
  | { kind: 'printed-nest'; nest: string; seatClearance: Mm };

/**
 * A datum source is anything that reduces what the probe must resolve. The camera is one,
 * with a coarse uncertainty and no Z at all (`/Fabrication.md` §7.3).
 */
export interface DatumSource {
  fixes: ('x' | 'y' | 'rotation' | 'z')[];
  uncertainty: Mm;
}

/** The part's pose in MACHINE coordinates: a rotation about Z, then a translation. */
export interface Placement {
  /** The part's model origin (its back-face origin corner) in machine coordinates. */
  origin: Vec3;
  /** Counter-clockwise about +Z, viewed from above. */
  rotationZ: Degrees;
  source: RegistrationSource;
}

/**
 * The G54 work offset: the work origin's position in machine coordinates. A translation
 * only; the controller applies no rotation to a work offset.
 */
export interface WorkOffset {
  origin: Vec3;
  source: RegistrationSource;
  /**
   * The registration residual, in mm: how far the work origin may be from where it is
   * assumed to be relative to the part. This is the band the UI draws, and the quantity a
   * real probe or fixture actually resolves.
   */
  uncertainty: Mm;
}

/**
 * The tool in the spindle when the program starts. `M6` to the already-active tool does
 * NOTHING on the Z1 — no change and no length calibration — and a program cannot know the
 * machine's starting tool, so the first `T1 M6` of a file is only simulable if it is stated.
 * `-1` is an empty spindle (the firmware's `active_tool`), `'unknown'` is "do not guess".
 */
export type StartingTool = number | 'unknown';

/**
 * An axis-aligned box the tool must not enter, in the WORK frame, mm (#203). The work frame
 * is the job frame: origin at the stock's top-front-left corner, +X to the right along the
 * jaws' clamping direction, +Y away from the operator, Z = 0 on the top face.
 */
export interface ObstacleBox {
  /** Stable id, e.g. 'vise-fixed-jaw'. */
  id: string;
  /** Human label, shown in the viewport and in diagnostics. */
  label: string;
  min: Vec3;
  max: Vec3;
}

/**
 * The fixture as solids the tool must not hit (#203, decision 28). This is NOT `Workholding`:
 * `Workholding` says *how* the part is held; the envelope says *what is in the way*. It is an
 * INPUT with provenance — a shipped default, a saved measurement, or a fresh measurement —
 * never a catalogue lookup presented as truth.
 */
export interface FixtureEnvelope {
  boxes: ObstacleBox[];
  /** Where the dimensions came from. A default is NOT a measurement. */
  source: 'default' | 'saved' | 'measured';
  /** Every box is grown by this much on every side before any check, mm. */
  uncertainty: Mm;
  /** ISO date of the measurement, when source is 'saved' or 'measured'. */
  measuredAt?: string;
}

export interface Setup {
  part: PartSpec;
  workholding: Workholding;
  placement: Placement;
  wcs: WorkOffset;
  startingTool: StartingTool;
  /**
   * The obstacle envelope, when the fixture is modelled. Optional (#203): an absent fixture
   * means "not modelled", which the sweep reports as its `fixture-unchecked` diagnostic, and
   * every existing `stubSetup` caller keeps working unchanged.
   */
  fixture?: FixtureEnvelope;
  /**
   * The sacrificial material under/beside the part (#213), carried from the job so the sweep
   * can model it as a SECOND body — the material the cutter may leave the part onto. Plain data
   * (`sacrificialBoxes` turns it into work-frame boxes). Optional: absent means none, which is
   * every pre-#213 caller and every job that does not use it.
   */
  sacrificial?: Sacrificial;
}

/**
 * The part's XY bounding box in its own model frame, when the geometry is known here. Only the
 * prism states its XY outline; a cylinder's axis and a compiled node are not resolvable without
 * the compiler, so those fall back to the origin-at-centre stub (below).
 */
function modelBounds(part: PartSpec): { min: Vec2; max: Vec2 } | null {
  return part.kind === 'prism' ? aabbOfProfile(part.outline) : null;
}

/**
 * Where the stub places a part on a machine (#196 decision (a)). The first version pinned the
 * model ORIGIN at the envelope's centre, which is only right for a part whose origin is its
 * centre: a `rectProfile` part has its origin at its front-left corner, so half of it (and any
 * program written against that corner) hangs off the envelope's +X/+Y faces. This fits the
 * part's own work-frame EXTENT — its bounding box — inside the envelope instead: the box's
 * centre goes to the envelope's centre, so the origin lands half an extent below/left of it.
 *
 * Fitting is not the same as suppressing the check (`insideEnvelope` still runs): a part, or a
 * program reaching past it, that is genuinely larger than the envelope still reports
 * `outside-envelope`.
 */
function machinePlacement(part: PartSpec, machine: MillProfile, zTop: Mm): Vec3 {
  const centre = (r: AxisRange): Mm => (r.min + r.max) / 2;
  const b = modelBounds(part);
  const x = b ? centre(machine.envelope.x) - (b.min[0] + b.max[0]) / 2 : centre(machine.envelope.x);
  const y = b ? centre(machine.envelope.y) - (b.min[1] + b.max[1]) / 2 : centre(machine.envelope.y);
  // The top face goes to the profile's safe Z — a height that is, by the firmware's own
  // definition, above any work. The XY placement is the stub that #196 decision (a) fixes.
  return [x, y, machine.toolChange.safeZ - zTop];
}

/**
 * The reference setup for a part that sits with its model origin at the machine origin and
 * is registered exactly: the simplest valid stub, and what tests start from.
 *
 * THE WORK ORIGIN'S Z DIFFERS BY PART KIND (#237, `/Rotary.md` R6). For a prism it is the top
 * face directly above the model origin, as Studio's `topFrontLeft` does. For a CYLINDER it is on
 * the AXIS, not the top face: the firmware computes rotary feed from `√(Y_wcs² + Z_wcs²)`, so work
 * Z in a rotary job IS the radius from the axis, and a WCS on the top face makes the machine
 * compute the wrong surface speed on every move. The model origin already sits on the axis (the
 * top is `diameter / 2` above it, which is what `machinePlacement` fits to the safe height), so
 * the cylinder's origin Z is the axis Z. Y ≡ 0 on the axis is the same statement in Y, and the
 * placed `at[1]` is already it.
 */
export function stubSetup(part: PartSpec, workholding: Workholding, overrides: Partial<Setup> = {}, machine?: MillProfile): Setup {
  const zTop = part.kind === 'prism' ? part.thickness : part.kind === 'cylinder' ? part.diameter / 2 : 0;
  // Without a machine the stub sits at the machine origin, which is fine for the frame
  // maths and useless on a real Z1, whose origin is the far top corner of a NEGATIVE
  // envelope (every +X move would leave it). With one, the part's extent is fitted inside the
  // envelope (see `machinePlacement`). It is still a stub: a real placement comes from probing
  // (decisions 26 and 28).
  const at: Vec3 = machine ? machinePlacement(part, machine, zTop) : [0, 0, 0];
  return {
    part,
    workholding,
    placement: { origin: at, rotationZ: 0, source: 'stub' },
    // The work origin: on the axis for a cylinder (#237), on the top face for a prism.
    wcs: {
      origin: [at[0], at[1], part.kind === 'cylinder' ? at[2] : at[2] + zTop],
      source: 'stub',
      uncertainty: 0.05,
    },
    startingTool: 'unknown',
    ...overrides,
  };
}
