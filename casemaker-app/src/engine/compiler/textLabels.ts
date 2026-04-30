import type { CaseParameters, BoardProfile, HatPlacement, HatProfile } from '@/types';
import type { TextLabel } from '@/types/textLabel';
import { cube, translate, type BuildOp } from './buildPlan';
import { computeShellDims } from './caseShell';
import { faceFrame, type FaceFrame } from '@/engine/coords';

/**
 * Phase 1 text-label implementation: each character becomes a single
 * rectangular block (a "block-letter" placeholder). This is intentionally
 * minimal — full TTF/glyph extraction via opentype.js is a follow-up.
 *
 * The block layout still produces visible engraved/embossed text suitable
 * for short labels like "USB-C" or "POWER" on the case wall.
 */

export interface TextLabelOpGroups {
  additive: BuildOp[];
  subtractive: BuildOp[];
}

function generateLabelOps(label: TextLabel, frame: FaceFrame): BuildOp[] {
  // Block-letter: each character is a small rectangle of cap height × (size * 0.6) wide.
  // Whitespace/space characters render as a gap. Tunable via labelOps cwidth scale.
  const charWidth = label.size * 0.7;
  const charSpacing = label.size * 0.15;
  const totalWidth = label.text.length * charWidth + (label.text.length - 1) * charSpacing;
  const ops: BuildOp[] = [];
  for (let i = 0; i < label.text.length; i++) {
    const ch = label.text[i]!;
    if (ch === ' ' || ch === '\t') continue;
    const charU = -totalWidth / 2 + i * (charWidth + charSpacing);
    // Build a small block in face-local (u, v, depth) coords, then map to world.
    const u0 = label.position.u + charU;
    const v0 = label.position.v - label.size / 2;
    const blockUWidth = charWidth;
    const blockVHeight = label.size;
    // Map face-local rectangle (u0..u0+blockUWidth, v0..v0+blockVHeight) into world.
    const worldOrigin: [number, number, number] = [
      frame.origin[0] + frame.uAxis[0] * u0 + frame.vAxis[0] * v0,
      frame.origin[1] + frame.uAxis[1] * u0 + frame.vAxis[1] * v0,
      frame.origin[2] + frame.uAxis[2] * u0 + frame.vAxis[2] * v0,
    ];
    // Block size in world coords — depth extends along the outward axis.
    const sizeX =
      Math.abs(frame.uAxis[0] * blockUWidth + frame.vAxis[0] * blockVHeight) +
      (frame.outwardLetter === 'x' ? label.depth : 0);
    const sizeY =
      Math.abs(frame.uAxis[1] * blockUWidth + frame.vAxis[1] * blockVHeight) +
      (frame.outwardLetter === 'y' ? label.depth : 0);
    const sizeZ =
      Math.abs(frame.uAxis[2] * blockUWidth + frame.vAxis[2] * blockVHeight) +
      (frame.outwardLetter === 'z' ? label.depth : 0);
    // For engrave: pull the block inward by `depth` on the outward axis.
    // For emboss: keep at face plane, extending outward by `depth`.
    const offset: [number, number, number] = [0, 0, 0];
    if (label.mode === 'engrave') {
      if (frame.outwardLetter === 'z') offset[2] = -label.depth * frame.outwardSign;
      else if (frame.outwardLetter === 'y') offset[1] = -label.depth * frame.outwardSign;
      else offset[0] = -label.depth * frame.outwardSign;
    }
    const blockPos: [number, number, number] = [
      worldOrigin[0] + offset[0],
      worldOrigin[1] + offset[1],
      worldOrigin[2] + offset[2],
    ];
    ops.push(translate(blockPos, cube([Math.abs(sizeX), Math.abs(sizeY), Math.abs(sizeZ)], false)));
  }
  return ops;
}

export function buildTextLabelOps(
  labels: TextLabel[] | undefined,
  board: BoardProfile,
  params: CaseParameters,
  hats: HatPlacement[] = [],
  resolveHat: (id: string) => HatProfile | undefined = () => undefined,
): TextLabelOpGroups {
  const out: TextLabelOpGroups = { additive: [], subtractive: [] };
  if (!labels || labels.length === 0) return out;
  const dims = computeShellDims(board, params, hats, resolveHat);
  for (const label of labels) {
    if (!label.enabled) continue;
    if (!label.text || label.text.length === 0) continue;
    const frame = faceFrame(label.face, dims.outerX, dims.outerY, dims.outerZ);
    const ops = generateLabelOps(label, frame);
    if (label.mode === 'engrave') out.subtractive.push(...ops);
    else out.additive.push(...ops);
  }
  return out;
}
