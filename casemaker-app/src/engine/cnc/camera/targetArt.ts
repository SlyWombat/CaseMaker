/**
 * The printable half of the camera target (#189): a `CameraTargetSpec` as an SVG sheet.
 *
 * SVG rather than PDF because a vector page is what a printer honours at 1:1, it is text (so it
 * diffs, hashes and needs no dependency), and nothing in the repo writes PDF. The page is
 * dimensioned in MILLIMETRES (`width="160mm"`), so "print at 100 %" is the whole instruction.
 *
 * ## Orientation, stated once
 *
 * The sheet frame is the work frame (`/Simulation.md` §1.1): origin at the FRONT-LEFT corner, +X to
 * the right along the jaws, +Y away from the operator. On paper that is the view looking down at
 * the sheet from the operator's side, so **+Y runs UP the page** while SVG's own y runs down. Every
 * coordinate here goes through `toPage` for that reason, and the page carries a FRONT EDGE label so
 * a sheet cannot be laid down the wrong way round — a mirrored target calibrates a mirrored
 * camera, and nothing downstream would notice.
 *
 * ## Why the art prints NO mark for the cut
 *
 * The pattern is printed and the crosses are then milled at commanded positions *through* it
 * (#189 refinement 2), so the obvious thing to do is draw the crosses in. That is the one thing
 * this art must not do: a printed cross is high-contrast ink lying exactly where the machine is
 * about to cut, so a detector would lock onto the drawn mark before the cut, or onto the drawn mark
 * where a cut was missed — measuring the printer, which is the error the whole method exists to
 * avoid. It would also engrave the ink into the groove.
 *
 * What the art does instead is leave the pattern OFF around each cross, which says "cut here" in
 * the same breath: the operator centres the cutter in the pocket, and a mis-scaled print shows up
 * as a cross cut visibly off-centre in its pocket. The pocket and the cross's index come from
 * `cameraTargetFiducialZones`, so the milled position and the drawn pocket cannot drift apart.
 */

import { cameraTargetCheckerSquares, cameraTargetFiducialZones, type CameraTargetSpec } from './targetSpec';

/** `160 mm` for 160, `1.5` for 1.5 — at most three decimals, trailing zeros trimmed. */
function fmt(n: number): string {
  return String(Number(n.toFixed(3)));
}

/** XML-escape a caption string. The only free text here is the spec's title. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * The painted extent of the art: the caption strip, the sheet, and the front-edge band, mm. The
 * page is taller than the sheet on both ends, so the labels that say which end is which have paper
 * to live on — a label drawn past the viewBox is silently clipped away, which is how the first
 * version of this file shipped a page claiming a front edge it never showed.
 */
export function cameraTargetPage(spec: CameraTargetSpec): { width: number; height: number } {
  return { width: spec.sheet.width, height: CAMERA_CAPTION_STRIP + spec.sheet.depth + CAMERA_FRONT_STRIP };
}

/**
 * Height of the caption strip above the sheet, mm. CHOSEN: five lines of a 2.2 mm monospace face —
 * the spec's numbers, at a size that does not compete with the pattern. It sits at the page's top,
 * which by `toPage` is the sheet's BACK edge (away from the operator), like a title block.
 */
export const CAMERA_CAPTION_STRIP = 30;

/**
 * Height of the band below the sheet, mm, carrying the FRONT EDGE label. On the page, below the
 * sheet, is the only place that label can be unambiguous: drawn inside the sheet it would sit on
 * the pattern, and drawn above it, it would be next to the back edge.
 */
export const CAMERA_FRONT_STRIP = 9;

/** A sheet point → a page point. The ONLY place the y flip lives. */
function toPage(spec: CameraTargetSpec, at: [number, number]): [number, number] {
  return [at[0], CAMERA_CAPTION_STRIP + (spec.sheet.depth - at[1])];
}

/**
 * The target as an SVG document. Pure: the same spec always produces the same bytes, so the script
 * can hash it the way `runSheet` hashes its own render.
 */
export function cameraTargetSvg(spec: CameraTargetSpec): string {
  const page = cameraTargetPage(spec);
  const lines: string[] = [];
  lines.push(`<svg xmlns="http://www.w3.org/2000/svg" version="1.1"`);
  lines.push(`     width="${fmt(page.width)}mm" height="${fmt(page.height)}mm"`);
  lines.push(`     viewBox="0 0 ${fmt(page.width)} ${fmt(page.height)}">`);
  lines.push(`  <title>${esc(spec.title)}</title>`);
  lines.push(`  <desc>Print at 100% (no fit-to-page). The printed scale is NOT trusted — the machine measures every distance by moving.</desc>`);

  // The sheet itself, white, so the light squares of the board are the paper.
  lines.push(`  <rect x="0" y="${fmt(CAMERA_CAPTION_STRIP)}" width="${fmt(spec.sheet.width)}" height="${fmt(spec.sheet.depth)}" fill="#ffffff" stroke="#000000" stroke-width="0.2"/>`);

  // The checkerboard's dark squares (#189 refinement 2: the fine pattern comes from the print).
  lines.push(`  <g fill="#000000" shape-rendering="crispEdges">`);
  for (const s of cameraTargetCheckerSquares(spec)) {
    const [px, py] = toPage(spec, [s.at[0], s.at[1] + s.size]); // the square's UPPER-left on the page
    lines.push(`    <rect x="${fmt(px)}" y="${fmt(py)}" width="${fmt(s.size)}" height="${fmt(s.size)}"/>`);
  }
  lines.push(`  </g>`);

  // Each cut zone's index, printed in the pocket's upper-left corner: the only ink inside a pocket,
  // and clear of the cross's own footprint so the groove does not cut through it. x is not flipped
  // by `toPage`, so the zone's own x stands; y is, so the baseline is placed from the zone's TOP
  // edge downward on the page.
  lines.push(`  <g font-family="monospace" font-size="2.4" fill="#000000">`);
  for (const zone of cameraTargetFiducialZones(spec)) {
    const [, yTop] = toPage(spec, [0, zone.at[1] + zone.depth]);
    lines.push(`    <text x="${fmt(zone.at[0] + 1.4)}" y="${fmt(yTop + 2.8)}">${zone.fiducial}</text>`);
  }
  lines.push(`  </g>`);

  // The FRONT edge, labelled, in the band below the sheet (sheet y = 0 is the page's bottom edge).
  const frontY = CAMERA_CAPTION_STRIP + spec.sheet.depth;
  lines.push(`  <text x="${fmt(spec.sheet.width / 2)}" y="${fmt(frontY + 6)}" font-family="monospace" font-size="3" text-anchor="middle" fill="#000000">FRONT EDGE ← operator side → +Y runs up this page, +X right</text>`);

  // The caption: the spec's own numbers, so a printed sheet says which target it is.
  const extent = spec.checker;
  const f = spec.fiducials;
  const caption = [
    `${spec.title}  (${spec.id})`,
    `sheet ${fmt(spec.sheet.width)} x ${fmt(spec.sheet.depth)} mm   fiducials ${f.count.x}x${f.count.y} @ ${fmt(f.pitch.x)}/${fmt(f.pitch.y)} mm pitch, first at (${fmt(f.origin.x)}, ${fmt(f.origin.y)})`,
    `cross arm ${fmt(f.arm)} mm, stroke ${fmt(f.stroke)} mm, milled ${fmt(f.depth)} mm deep   checker ${fmt(extent.square)} mm squares`,
    `Clear pockets = cut zones: mill each cross centred in its zone. The sheet prints no cut mark.`,
    `Print at 100%. The printed scale is NOT trusted: the machine measures distance by moving.`,
  ];
  lines.push(`  <g font-family="monospace" font-size="2.2" fill="#000000">`);
  caption.forEach((line, i) => lines.push(`    <text x="0" y="${fmt(4 + i * 5)}">${esc(line)}</text>`));
  lines.push(`  </g>`);

  lines.push(`</svg>`);
  return lines.join('\n') + '\n';
}

/** File name for the art, from the spec's id. Same shape as `runSheetFileName`'s `.nc` stem. */
export function cameraTargetSvgFileName(spec: CameraTargetSpec): string {
  return `${spec.id.replace(/[^A-Za-z0-9._-]+/g, '-')}.svg`;
}
