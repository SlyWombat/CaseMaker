import type { CaseParameters, BoardProfile, HatPlacement, HatProfile } from '@/types';
import type { TextLabel, CustomFont } from '@/types/textLabel';
import type { DisplayPlacement, DisplayProfile } from '@/types/display';
import {
  aabbOfProfile,
  extrude,
  pRotate,
  pTranslate,
  rotate,
  translate,
  type BuildOp,
  type Profile,
} from './buildPlan';
import { glyphProfile } from './glyphs';
import { resolveFont } from '@/engine/fonts/registry';
import { computeShellDims } from './caseShell';
import { computeLidDims } from './lid';
import { faceFrame, placeOnFace, type FaceFrame } from '@/engine/coords';
import type { Vec3 } from '@/types';

type DisplayResolver = (id: string) => DisplayProfile | undefined;
const NO_RESOLVE_DISPLAY: DisplayResolver = () => undefined;

/**
 * Text labels are real glyph outlines (issue #169): the label is typeset by
 * `glyphProfile` from a registry font, extruded `depth` mm, then rotated onto the
 * face. Engraved labels are cut INTO the wall, embossed ones stand proud of it.
 *
 * Issue #179 — `+z` labels are split out because the lid is a SEPARATE
 * top-level node built by `buildLid`, and its outer top surface is not at the
 * shell's `outerZ`. A `+z` engrave must be subtracted from the lid op and a
 * `+z` emboss unioned into it, or the label lands in the gap between shell and
 * lid (cutting nothing / floating free). Follows the `buildHingeOps` split.
 */

export interface TextLabelOpGroups {
  /** Ops for the case SHELL node, in WORLD coordinates. */
  additive: BuildOp[];
  subtractive: BuildOp[];
  /**
   * Ops for the LID node, in LID-LOCAL coordinates. ProjectCompiler applies
   * the `translate([0, 0, lidDims.zPosition], lidOp)` lift AFTER unioning /
   * differencing these, so they must be expressed relative to the lid's own
   * origin (whose outer top face is at `computeLidDims(...).z`).
   */
  lidAdditive: BuildOp[];
  lidSubtractive: BuildOp[];
}

/** Overshoot past the face on engraves so the cut is never coplanar with the wall. */
const ENGRAVE_BREAKOUT_MM = 0.05;

/**
 * How far an EMBOSS sinks below the face plane (mm). A raised label whose base
 * sits exactly ON the surface is a zero-thickness coplanar contact; Manifold's
 * union can leave it as a separate component (the same trap the hinge fairing
 * and #121 document). Sinking the base a hair gives the union a volumetric
 * overlap, so the letters fuse to the wall/lid in every lid mode. The visible
 * protrusion is unchanged — the embedded sliver is inside the parent solid.
 */
const EMBOSS_EMBED_MM = 0.2;

/**
 * Rotation (innermost first) taking the extrude frame (x = text right, y = text
 * up, z = outward) onto a face, so every label reads correctly seen from OUTSIDE.
 *
 * `faceFrame`'s (u, v) is chosen for layout, not handedness; on -z, +y and -x
 * the pair is left-handed about the outward normal, so mapping text-right to +u
 * would print it mirrored. On those faces text therefore reads along -u.
 */
function faceRotations(face: TextLabel['face']): Vec3[] {
  switch (face) {
    case '+z':
      return [];
    case '-z':
      return [[0, 180, 0]];
    case '-y':
      return [[90, 0, 0]];
    case '+y':
      return [[90, 0, 180]];
    case '+x':
      return [[0, 0, 90], [0, 90, 0]];
    case '-x':
      return [[0, 0, 90], [0, 90, 0], [0, 0, 180]];
  }
}

function generateLabelOps(
  label: TextLabel,
  frame: FaceFrame,
  customFonts: readonly CustomFont[],
): BuildOp[] {
  const font = resolveFont(label.font, label.weight, customFonts);
  const glyphs = glyphProfile(label.text, font, label.size);
  const box = aabbOfProfile(glyphs);
  if (!box) return []; // whitespace only
  // Centre the ink horizontally on the label position, and centre the CAP-height
  // box vertically on it (so v is the middle of a capital letter).
  const cx = (box.min[0] + box.max[0]) / 2;
  let outline: Profile = pTranslate([-cx, -label.size / 2], glyphs);
  if (label.rotation) outline = pRotate(label.rotation, outline);

  const engrave = label.mode === 'engrave';
  const height = engrave ? label.depth + ENGRAVE_BREAKOUT_MM : label.depth + EMBOSS_EMBED_MM;
  let op: BuildOp = extrude(outline, height);
  // Engraves are pushed outward past the surface (breakout); embosses are
  // pushed inward (embed) so both booleans overlap the parent volumetrically.
  if (engrave) op = translate([0, 0, -label.depth], op);
  else op = translate([0, 0, -EMBOSS_EMBED_MM], op);
  for (const r of faceRotations(label.face)) op = rotate(r, op);
  const at = placeOnFace(frame, label.position.u, label.position.v);
  return [translate(at, op)];
}

export function buildTextLabelOps(
  labels: TextLabel[] | undefined,
  board: BoardProfile,
  params: CaseParameters,
  hats: HatPlacement[] = [],
  resolveHat: (id: string) => HatProfile | undefined = () => undefined,
  display: DisplayPlacement | null | undefined = null,
  resolveDisplay: DisplayResolver = NO_RESOLVE_DISPLAY,
  customFonts: readonly CustomFont[] = [],
): TextLabelOpGroups {
  const out: TextLabelOpGroups = {
    additive: [],
    subtractive: [],
    lidAdditive: [],
    lidSubtractive: [],
  };
  if (!labels || labels.length === 0) return out;
  const dims = computeShellDims(board, params, hats, resolveHat, display, resolveDisplay);
  // Issue #179 — a `+z` label belongs to the lid's OUTER TOP surface, whose
  // Z is the lid body's top in lid-LOCAL coords (`lidDims.z`), not the shell
  // envelope's `outerZ`. The lid node is never translated in X/Y (only lifted
  // in Z by `zPosition`), and buildLid already places a recessed plate at its
  // world X/Y origin in lid-local coords, so the same (u, v) frame maps to the
  // same world XY on the lid.
  const lidTopLocalZ = computeLidDims(board, params, hats, resolveHat, display, resolveDisplay).z;
  for (const label of labels) {
    if (!label.enabled) continue;
    if (!label.text || label.text.length === 0) continue;
    const onLid = label.face === '+z';
    const frame = faceFrame(
      label.face,
      dims.outerX,
      dims.outerY,
      onLid ? lidTopLocalZ : dims.outerZ,
    );
    const ops = generateLabelOps(label, frame, customFonts);
    const engrave = label.mode === 'engrave';
    if (onLid) {
      if (engrave) out.lidSubtractive.push(...ops);
      else out.lidAdditive.push(...ops);
    } else if (engrave) {
      out.subtractive.push(...ops);
    } else {
      out.additive.push(...ops);
    }
  }
  return out;
}
