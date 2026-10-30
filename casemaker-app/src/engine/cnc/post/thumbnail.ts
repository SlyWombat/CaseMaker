/**
 * #771 — THE PART'S PICTURE INSIDE THE POSTED `.nc`.
 *
 * Studio writes a base64 PNG after the program's `M02`, inside a comment block, so the file
 * carries its own thumbnail into Makera's controller and its job list. `Z1/TopClamp.nc` (the
 * `1.4.6_sample` release of MakeraInc/CarveraProfiles, fetched by `scripts/fetch-reference-gcode.mjs`)
 * is the witness. Its bytes are exactly:
 *
 *     M02\r\n
 *     ;(thumbnail_image_begin)\r\n         24 characters
 *     ;iVBORw0KGgo…Jggg==\r\n              40,713 bytes including the leading `;`
 *     ;(thumbnail_image_end)\r\n           22 characters
 *
 * The payload is ONE line: `;` followed by the PNG's standard base64 (no wrapping), and the
 * decoded image is 800 × 600, 8-bit RGBA, 30,532 bytes. There is no trailing record after the
 * end marker — the file stops there. The block is written AFTER `M02`, not before it, and the
 * markers are comments, so every reader in this app must — and does — ignore it.
 *
 * WHY THIS MODULE IS PURE AND LIVES IN `engine/`, NOT A COMPONENT. The picture has to be produced
 * where the cut geometry already exists: an engrave program is generated in a worker with no DOM,
 * no canvas and no WebGL, so the app's `PartThumbnail` (three.js) and the CLI's `svgToPng`
 * (Playwright) are both unusable there. What exists in that realm is the same data the preview
 * draws: `engraveRegions`' `cuts` (`CutRegion[]`) and, after a rest-pair sweep, the simulator's
 * own `NodeMeshOutput`. This module renders exactly those — it does not re-plan a cut, re-measure
 * a region, or read the job document. The design view is the plan view `engravePreviewSvg`
 * draws (stock, opened cut polygons, the stock's own frame, page y = −job y); the simulated view
 * is a true top view of the result mesh (a z-buffered heightmap), which is what "the top view of
 * the simulated result" means when the only renderer available has no GPU.
 *
 * THE CAP. `THUMBNAIL_MAX_BYTES` is 20,000 bytes of PNG (the brief's 20 kB; stricter than 20 KiB),
 * so the base64 line stays at or below 26,669 characters including its leading `;` (the payload is
 * at most 26,668) — well under Studio's 40,713 and the controller's reader. Both renderers start
 * at a 480-pixel long side, and if the encoded PNG is over the cap they render again at 80 % steps
 * down to 160 pixels. If even the smallest render is over the cap there is NO block: a job that
 * cannot afford a picture writes no picture and says nothing false (the same rule as a job whose
 * geometry produced nothing to draw).
 *
 * PNG ENCODING. Colour type 2 (8-bit RGB), non-interlaced, one filter-0 byte per row, zlib at
 * level 9 through fflate (`zlibSync`) — the one compressor this app already ships to both realms.
 * No alpha: both pictures are flat on white. The palette is deliberately tiny (three inks for the
 * design view, a twelve-step ramp for the simulated one), which is what keeps a 480-pixel picture
 * far under the cap without throwing pixels away.
 *
 * NOT A SECOND PREVIEW. The 3D preview (`engravePreview`) and the CLI's SVG both consume the same
 * `cuts` this design view does; the pixels are new because no engine-realm rasteriser existed, not
 * because the plan is new. If `engravePreviewSvg`'s orientation or stock frame ever changes, this
 * view must change with it — `postThumbnail.spec.ts` pins the frame and the ink so the pair cannot
 * drift silently.
 */

import { zlibSync } from 'fflate';

/** The opening marker, exactly as Studio writes it (24 characters). */
export const THUMBNAIL_BEGIN = ';(thumbnail_image_begin)';
/** The closing marker, exactly as Studio writes it (22 characters). */
export const THUMBNAIL_END = ';(thumbnail_image_end)';

/** The hard cap on the PNG, in bytes. 20 kB, not 20 KiB — the smaller of the two readings. */
export const THUMBNAIL_MAX_BYTES = 20_000;

/**
 * Long-side pixel sizes tried in order. 480 is the useful size on a job-list tile; each later
 * size is about 80 % of the one before, so a pathological picture loses resolution rather than
 * losing the thumbnail or breaking the cap.
 */
const LONG_SIDES = [480, 384, 307, 246, 197, 160] as const;

const MARGIN_FRACTION = 0.03;

type Rgb = readonly [number, number, number];

/** White page and ink values; the first three are `engravePreviewSvg`'s palette. */
const PAGE: Rgb = [255, 255, 255];
const STOCK_INK: Rgb = [251, 252, 253]; // #fbfcfd
const STOCK_EDGE: Rgb = [154, 163, 173]; // #9aa3ad
/** `#1b232c` at the preview's 0.82 opacity over `#fbfcfd`, resolved once so it stays three inks. */
const CUT_INK: Rgb = [67, 74, 82];
/** Twelve steps from the stock's top face to the deepest visible cut. */
const SIM_RAMP: readonly Rgb[] = ramp(STOCK_INK, [27, 35, 44], 12);

/** The stock frame the design view is drawn in; mm, X to the right and Y from front to back. */
export interface ThumbnailStock {
  length: number;
  width: number;
}

/**
 * The part of a `CutRegion` this view reads. Structural, so `CutRegion` (which also carries the
 * item id, depth and the V-carve's three outlines) is assignable without an import from a worker.
 * The polygons are the CUTTER'S OWN OPENED REGION in the stock frame, outer CCW and holes CW —
 * the same rings `engravePreviewSvg` paints.
 */
export interface ThumbnailCut {
  polygons: readonly (readonly (readonly [number, number])[])[];
}

/**
 * The part of the simulator's `NodeMeshOutput` this view reads. Only the triangles and the bbox:
 * a top view is a heightmap, so the mesh's normals, components and provenance are irrelevant.
 */
export interface ThumbnailMesh {
  positions: Float32Array;
  indices: Uint32Array;
  bbox: { min: readonly [number, number, number]; max: readonly [number, number, number] };
}

/**
 * The part of `GoalHeightfield` (`cam/surface3d`) this view reads: a top-Z per grid cell, its
 * work-frame origin and pitch, and the covered mask. Structural for the same reason as the mesh
 * type — the engine module must not depend on the CAM's full shape to draw its picture.
 */
export interface ThumbnailHeightfield {
  nx: number;
  ny: number;
  /** Work X/Y of cell (0, 0)'s centre, mm. */
  x0: number;
  y0: number;
  /** Square cell pitch, mm. */
  pitch: number;
  /** Work Z of the stock top, and the lowest covered top-Z. */
  topZ: number;
  minZ: number;
  /** Top-Z per cell, row-major `z[j * nx + i]`. */
  z: Float32Array;
  /** 1 where the goal covers the cell, else 0. */
  covered: Uint8Array;
  coveredCount: number;
}

/* ------------------------------------------------------------------ the block */

/**
 * The block that follows `M02`: opening marker, ONE `;`-prefixed base64 line, closing marker.
 *
 * Returns null when the bytes are not a PNG, when the PNG is over the cap, or when its header
 * cannot be read. A caller that gets null writes no block; it never writes a partial or
 * oversized one. `newline` follows the file's own ending (our post uses LF; Studio's sample uses
 * CRLF, so replacing a block in a foreign file keeps its line endings).
 */
export function thumbnailBlock(png: Uint8Array, newline = '\n'): string | null {
  if (png.length > THUMBNAIL_MAX_BYTES) return null;
  if (pngSize(png) === null) return null;
  const base64 = encodeBase64(png);
  return `${THUMBNAIL_BEGIN}${newline};${base64}${newline}${THUMBNAIL_END}${newline}`;
}

/**
 * Remove the thumbnail block from a posted file, preserving every other byte. Used before
 * replacing a design-preview picture with the simulated one, and by the tests that prove the
 * block is inert. A malformed block (an opening marker with no closing marker) is left alone
 * rather than cut in half: a reader must not be handed a file this function damaged.
 */
export function stripThumbnail(nc: string): string {
  let out = nc;
  for (;;) {
    const begin = out.indexOf(THUMBNAIL_BEGIN);
    if (begin < 0) return out;
    const end = out.indexOf(THUMBNAIL_END, begin + THUMBNAIL_BEGIN.length);
    if (end < 0) return out;
    let after = end + THUMBNAIL_END.length;
    if (out.startsWith('\r\n', after)) after += 2;
    else if (out[after] === '\n' || out[after] === '\r') after += 1;
    out = out.slice(0, begin) + out.slice(after);
  }
}

/**
 * Append (or replace) the block after the file's final `M02`.
 *
 * Returns null — and does not touch `nc` — when the PNG is unusable, over the cap, or when the
 * text does not end in an `M02` line. That last condition is the dialect boundary: Studio's
 * evidence is a flat Z1 file that ends `M05 / G28 / M02`, and this module will not staple a
 * thumbnail onto a rotary file's `M30` on the strength of a format nobody has seen there.
 */
export function appendThumbnail(nc: string, png: Uint8Array): string | null {
  const base = stripThumbnail(nc);
  const last = lastNonEmptyLine(base);
  if (last === null || last.trim() !== 'M02') return null;
  const newline = base.includes('\r\n') ? '\r\n' : '\n';
  const block = thumbnailBlock(png, newline);
  if (block === null) return null;
  const separator = base.endsWith('\n') || base.endsWith('\r') ? '' : newline;
  return base + separator + block;
}

function lastNonEmptyLine(text: string): string | null {
  const lines = text.split(/\r\n|\n|\r/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line !== undefined && line.trim() !== '') return line;
  }
  return null;
}

/* ------------------------------------------------------------------ the pictures */

/**
 * A plan view of the PROGRAM'S OWN CUTS: the stock, its opened cut polygons, in the stock frame,
 * page y = −job y, exactly as `engravePreviewSvg` draws it. This is the design preview — the
 * picture the job asked for, taken from the same `cuts` list the 3D preview and the oracle use.
 *
 * Null when there is no stock and no cut, and null when even the smallest render cannot fit the
 * cap. A facing pass has no cuts and therefore no design picture; that is an honest "nothing to
 * show", not a blank rectangle labelled as the part.
 */
export function planViewPng(stock: ThumbnailStock, cuts: readonly ThumbnailCut[]): Uint8Array | null {
  if (!(stock.length > 0) || !(stock.width > 0) || cuts.length === 0) return null;
  for (const longSide of LONG_SIDES) {
    const image = renderPlanView(stock, cuts, longSide);
    const png = encodeRgbPng(image);
    if (png.length <= THUMBNAIL_MAX_BYTES) return png;
  }
  return null;
}

/**
 * A true top view of a simulation's RESULT mesh: every triangle is rasterised into a z-buffer,
 * then the visible height is mapped through a short ramp — the top face reads as the stock's
 * own light grey, a deeper floor reads darker. Holes (a cut-out that went through) have no
 * triangle over them and stay the page's white, which is what the eye reads as "gone".
 *
 * The ramp is normalised to the range the TOP SURFACE actually covers (not the bbox, whose
 * minimum is the stock's BOTTOM face and would make a 0.5 mm engraving almost white). The
 * exponent leans the ramp towards the shallow end, so a 0.4 mm stroke and a 3 mm pocket are
 * still distinguishable in a 480-pixel tile.
 */
export function simulationTopViewPng(mesh: ThumbnailMesh): Uint8Array | null {
  const min = mesh.bbox.min;
  const max = mesh.bbox.max;
  const xSpan = max[0] - min[0];
  const ySpan = max[1] - min[1];
  if (!(xSpan > 0) || !(ySpan > 0) || mesh.indices.length < 3) return null;
  for (const longSide of LONG_SIDES) {
    const image = renderSimulation(mesh, longSide);
    if (image === null) continue;
    const png = encodeRgbPng(image);
    if (png.length <= THUMBNAIL_MAX_BYTES) return png;
  }
  return null;
}

/**
 * A top view of a 3D GOAL's design heightfield — the surfacing job's design preview, drawn in
 * the BLANK's frame so the operator sees where on the stock the part sits. Each pixel samples
 * the nearest grid cell (the grid is already at or below the cutter's step-over, #755); a cell
 * the goal does not cover stays the stock's light grey, and a covered cell is shaded by its
 * height between `topZ` and `minZ` with the same ramp the simulated view uses.
 *
 * Null for no stock, no covered cell, or a grid that does not overlap the stock. This is not a
 * second sampler: the heightfield is `sampleGoalHeightfield`'s own output, the one the toolpath
 * was generated from.
 */
export function heightfieldTopViewPng(
  stock: ThumbnailStock,
  field: ThumbnailHeightfield,
): Uint8Array | null {
  if (
    !(stock.length > 0) ||
    !(stock.width > 0) ||
    !(field.pitch > 0) ||
    field.nx <= 0 ||
    field.ny <= 0 ||
    field.coveredCount <= 0
  ) {
    return null;
  }
  for (const longSide of LONG_SIDES) {
    const image = renderHeightfield(stock, field, longSide);
    if (image === null) continue;
    const png = encodeRgbPng(image);
    if (png.length <= THUMBNAIL_MAX_BYTES) return png;
  }
  return null;
}

/* ------------------------------------------------------------------ the design view */

interface Frame {
  /** Image size, margin included. */
  width: number;
  height: number;
  margin: number;
  /** The stock rectangle's pixel bounds. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Pixels per millimetre. */
  scale: number;
}

interface RgbImage {
  width: number;
  height: number;
  /** Row-major RGB, `width * height * 3` bytes. */
  data: Uint8Array;
}

function frameFor(xSpan: number, ySpan: number, longSide: number): Frame {
  const margin = Math.max(2, Math.round(longSide * MARGIN_FRACTION));
  const content = Math.max(1, longSide - 2 * margin);
  const scale = content / Math.max(xSpan, ySpan);
  const x0 = margin;
  const y0 = margin;
  const x1 = margin + Math.max(1, Math.round(xSpan * scale));
  const y1 = margin + Math.max(1, Math.round(ySpan * scale));
  return { width: x1 + margin, height: y1 + margin, margin, x0, y0, x1, y1, scale };
}

function renderPlanView(stock: ThumbnailStock, cuts: readonly ThumbnailCut[], longSide: number): RgbImage {
  const frame = frameFor(stock.length, stock.width, longSide);
  const image = newImage(frame.width, frame.height);
  fillRect(image, frame.x0, frame.y0, frame.x1, frame.y1, STOCK_INK);
  for (const cut of cuts) fillPolygons(image, frame, cut.polygons, stock.width);
  // The stock's own edge, last, so a cut touching it cannot paint over the boundary.
  strokeRect(image, frame.x0, frame.y0, frame.x1, frame.y1, STOCK_EDGE);
  return image;
}

/**
 * Fill one cut's rings with the NONZERO rule. The rings arrive outer-CCW and holes-CW
 * (`CutRegion.polygons`), and the page y flip reverses their sign; nonzero is invariant to that
 * sign, so a hole still subtracts and a nested outer still fills.
 *
 * ALL rings of the cut are accumulated into ONE crossing list per row — the same thing SVG's
 * `fill-rule="nonzero"` does for one `<path>` with several subpaths, which is how
 * `engravePreviewSvg` draws a cut. Filling each ring on its own would paint a hole as ink: a lone
 * CW ring's winding never reaches zero inside it, so the letter counters and pocket islands would
 * come out solid. Overlapping cuts are still painted one at a time; they share one ink.
 */
function fillPolygons(
  image: RgbImage,
  frame: Frame,
  polygons: ThumbnailCut['polygons'],
  stockWidth: number,
): void {
  const crossings: { x: number; dir: number }[] = [];
  for (let py = frame.y0; py < frame.y1; py++) {
    // Job Y at the pixel's centre. Row 0 is the BACK of the stock: page y = −job y.
    const y = stockWidth - (py + 0.5 - frame.y0) / frame.scale;
    crossings.length = 0;
    for (const ring of polygons) {
      if (ring.length < 3) continue;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[j];
        const b = ring[i];
        if (a === undefined || b === undefined) continue;
        const ay = a[1];
        const by = b[1];
        if ((ay > y) === (by > y)) continue;
        const ax = a[0];
        const bx = b[0];
        crossings.push({
          x: frame.x0 + (ax + ((y - ay) * (bx - ax)) / (by - ay)) * frame.scale,
          dir: by > ay ? 1 : -1,
        });
      }
    }
    if (crossings.length < 2) continue;
    crossings.sort((a, b) => a.x - b.x);
    let winding = 0;
    let start = 0;
    for (const crossing of crossings) {
      const before = winding;
      winding += crossing.dir;
      if (before === 0 && winding !== 0) start = crossing.x;
      else if (before !== 0 && winding === 0) {
        fillSpan(image, py, start, crossing.x, frame, CUT_INK);
      }
    }
  }
}

/** Fill the pixel centres between two page-x positions, clipped to the stock rectangle. */
function fillSpan(image: RgbImage, row: number, from: number, to: number, frame: Frame, ink: Rgb): void {
  const a = Math.max(frame.x0, Math.ceil(from - 0.5));
  const b = Math.min(frame.x1, Math.floor(to - 0.5) + 1);
  for (let x = a; x < b; x++) putPixel(image, x, row, ink);
}

/* ------------------------------------------------------------------ the simulated view */

function renderSimulation(mesh: ThumbnailMesh, longSide: number): RgbImage | null {
  const min = mesh.bbox.min;
  const max = mesh.bbox.max;
  const xSpan = max[0] - min[0];
  const ySpan = max[1] - min[1];
  const frame = frameFor(xSpan, ySpan, longSide);
  const z = new Float32Array(frame.width * frame.height).fill(-Infinity);
  const { positions, indices } = mesh;

  for (let t = 0; t + 2 < indices.length; t += 3) {
    const ia = indices[t]!;
    const ib = indices[t + 1]!;
    const ic = indices[t + 2]!;
    const ax = positions[ia * 3]!;
    const ay = positions[ia * 3 + 1]!;
    const az = positions[ia * 3 + 2]!;
    const bx = positions[ib * 3]!;
    const by = positions[ib * 3 + 1]!;
    const bz = positions[ib * 3 + 2]!;
    const cx = positions[ic * 3]!;
    const cy = positions[ic * 3 + 1]!;
    const cz = positions[ic * 3 + 2]!;

    // Page coordinates. Y is flipped once, here, so every later comparison is in pixels.
    const pax = frame.x0 + (ax - min[0]) * frame.scale;
    const pay = frame.y0 + (max[1] - ay) * frame.scale;
    const pbx = frame.x0 + (bx - min[0]) * frame.scale;
    const pby = frame.y0 + (max[1] - by) * frame.scale;
    const pcx = frame.x0 + (cx - min[0]) * frame.scale;
    const pcy = frame.y0 + (max[1] - cy) * frame.scale;
    const area2 = (pbx - pax) * (pcy - pay) - (pby - pay) * (pcx - pax);
    if (Math.abs(area2) < 1e-9) continue; // edge-on in the top view: no pixel to write

    const xFrom = Math.max(0, Math.floor(Math.min(pax, pbx, pcx) - 0.5));
    const xTo = Math.min(frame.width - 1, Math.ceil(Math.max(pax, pbx, pcx) + 0.5));
    const yFrom = Math.max(0, Math.floor(Math.min(pay, pby, pcy) - 0.5));
    const yTo = Math.min(frame.height - 1, Math.ceil(Math.max(pay, pby, pcy) + 0.5));

    for (let py = yFrom; py <= yTo; py++) {
      const y = py + 0.5;
      for (let px = xFrom; px <= xTo; px++) {
        const x = px + 0.5;
        // Barycentric weights; all three are non-negative inside the triangle, whatever its sign.
        const wc = ((pbx - pax) * (y - pay) - (pby - pay) * (x - pax)) / area2;
        const wb = ((x - pax) * (pcy - pay) - (y - pay) * (pcx - pax)) / area2;
        const wa = 1 - wb - wc;
        if (wa < 0 || wb < 0 || wc < 0) continue;
        const height = wa * az + wb * bz + wc * cz;
        const at = py * frame.width + px;
        if (height > z[at]!) z[at] = height;
      }
    }
  }

  let top = -Infinity;
  let bottom = Infinity;
  for (let i = 0; i < z.length; i++) {
    const value = z[i]!;
    if (value === -Infinity) continue;
    if (value > top) top = value;
    if (value < bottom) bottom = value;
  }
  if (!Number.isFinite(top)) return null; // the bbox is a lie or the mesh is edge-on: nothing true to draw

  const image = newImage(frame.width, frame.height);
  const range = top - bottom;
  for (let py = frame.y0; py < frame.y1; py++) {
    for (let px = frame.x0; px < frame.x1; px++) {
      const value = z[py * frame.width + px]!;
      if (value === -Infinity) continue; // a through hole: the white page shows through
      if (!Number.isFinite(value)) continue; // NaN has no shade; drawing it is not a picture
      const t = range > 1e-9 ? (top - value) / range : 0;
      putPixel(image, px, py, SIM_RAMP[rampStep(t)]!);
    }
  }
  strokeRect(image, frame.x0, frame.y0, frame.x1, frame.y1, STOCK_EDGE);
  return image;
}

function renderHeightfield(
  stock: ThumbnailStock,
  field: ThumbnailHeightfield,
  longSide: number,
): RgbImage | null {  const frame = frameFor(stock.length, stock.width, longSide);
  const image = newImage(frame.width, frame.height);
  fillRect(image, frame.x0, frame.y0, frame.x1, frame.y1, STOCK_INK);
  const range = field.topZ - field.minZ;
  let painted = false;
  for (let py = frame.y0; py < frame.y1; py++) {
    // Page y = −job y, exactly as the design view: row 0 is the back of the stock.
    const y = stock.width - (py + 0.5 - frame.y0) / frame.scale;
    const j = Math.round((y - field.y0) / field.pitch);
    if (j < 0 || j >= field.ny) continue;
    for (let px = frame.x0; px < frame.x1; px++) {
      const x = (px + 0.5 - frame.x0) / frame.scale;
      const i = Math.round((x - field.x0) / field.pitch);
      if (i < 0 || i >= field.nx) continue;
      const at = j * field.nx + i;
      if (field.covered[at] !== 1) continue;
      const t = range > 1e-9 ? (field.topZ - field.z[at]!) / range : 0;
      putPixel(image, px, py, SIM_RAMP[rampStep(t)]!);
      painted = true;
    }
  }
  if (!painted) return null; // the grid never lands on the blank: no true picture to draw
  strokeRect(image, frame.x0, frame.y0, frame.x1, frame.y1, STOCK_EDGE);
  return image;
}

/* ------------------------------------------------------------------ raster primitives */

/**
 * The shade index for a normalised height `t` (0 = the field's bottom, 1 = its top), CLAMPED into
 * the ramp (#785). A covered heightfield cell can sit a hair above the field's own top by float
 * noise, which makes `t` a hair negative — and `Math.pow` of a negative fraction is `NaN`, whose
 * `SIM_RAMP[NaN]` is `undefined` and used to take the whole generation down at the thumbnail (the
 * long-ball plan on the mouse shell was the first to reach it). A thumbnail is a picture; it must
 * never be the thing that refuses a program.
 */
function rampStep(t: number): number {
  if (!Number.isFinite(t)) return 0;
  const clamped = Math.min(1, Math.max(0, t));
  return Math.min(SIM_RAMP.length - 1, Math.round(Math.pow(clamped, 0.55) * (SIM_RAMP.length - 1)));
}

function newImage(width: number, height: number): RgbImage {
  const data = new Uint8Array(width * height * 3);
  for (let i = 0; i < data.length; i += 3) {
    data[i] = PAGE[0];
    data[i + 1] = PAGE[1];
    data[i + 2] = PAGE[2];
  }
  return { width, height, data };
}

function putPixel(image: RgbImage, x: number, y: number, ink: Rgb): void {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
  const at = (y * image.width + x) * 3;
  image.data[at] = ink[0];
  image.data[at + 1] = ink[1];
  image.data[at + 2] = ink[2];
}

function fillRect(image: RgbImage, x0: number, y0: number, x1: number, y1: number, ink: Rgb): void {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) putPixel(image, x, y, ink);
}

/** A one-pixel rectangle outline — at these sizes the preview's 0.25 mm stroke rounds to 1 px. */
function strokeRect(image: RgbImage, x0: number, y0: number, x1: number, y1: number, ink: Rgb): void {
  fillRect(image, x0, y0, x1, y0 + 1, ink);
  fillRect(image, x0, y1 - 1, x1, y1, ink);
  fillRect(image, x0, y0 + 1, x0 + 1, y1 - 1, ink);
  fillRect(image, x1 - 1, y0 + 1, x1, y1 - 1, ink);
}

/* ------------------------------------------------------------------ PNG encoder */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u32(out: Uint8Array, at: number, value: number): void {
  out[at] = (value >>> 24) & 0xff;
  out[at + 1] = (value >>> 16) & 0xff;
  out[at + 2] = (value >>> 8) & 0xff;
  out[at + 3] = value & 0xff;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const body = new Uint8Array(4 + data.length);
  for (let i = 0; i < 4; i++) body[i] = type.charCodeAt(i);
  body.set(data, 4);
  const out = new Uint8Array(12 + data.length);
  u32(out, 0, data.length);
  out.set(body, 4);
  u32(out, 8 + data.length, crc32(body));
  return out;
}

/** A complete PNG: signature, IHDR (8-bit RGB), one IDAT of filter-0 rows, IEND. */
function encodeRgbPng(image: RgbImage): Uint8Array {
  const stride = image.width * 3;
  const raw = new Uint8Array((stride + 1) * image.height);
  for (let y = 0; y < image.height; y++) {
    const row = y * (stride + 1);
    raw[row] = 0; // filter: none
    raw.set(image.data.subarray(y * stride, (y + 1) * stride), row + 1);
  }
  const ihdr = new Uint8Array(13);
  u32(ihdr, 0, image.width);
  u32(ihdr, 4, image.height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter: adaptive
  ihdr[12] = 0; // interlace: none
  return concat([
    Uint8Array.from(PNG_SIGNATURE),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/** Width and height from a PNG's IHDR, or null when these bytes are not a well-formed PNG. */
function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 33) return null;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) if (bytes[i] !== PNG_SIGNATURE[i]) return null;
  if (String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!) !== 'IHDR') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width === 0 || height === 0) return null;
  return { width, height };
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Standard base64, unwrapped. `btoa` is a DOM global and absent in a plain Node test; this is
 * eighteen lines and runs in both realms, which is the same reason the PNG encoder uses fflate.
 */
function encodeBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    out += BASE64[(a >>> 2) & 63]!;
    out += BASE64[((a & 3) << 4) | ((b >>> 4) & 15)]!;
    out += i + 1 < bytes.length ? BASE64[((b & 15) << 2) | ((c >>> 6) & 3)]! : '=';
    out += i + 2 < bytes.length ? BASE64[c & 63]! : '=';
  }
  return out;
}

function ramp(from: Rgb, to: Rgb, steps: number): Rgb[] {
  const out: Rgb[] = [];
  for (let i = 0; i < steps; i++) {
    const t = steps === 1 ? 0 : i / (steps - 1);
    out.push([
      Math.round(from[0] + (to[0] - from[0]) * t),
      Math.round(from[1] + (to[1] - from[1]) * t),
      Math.round(from[2] + (to[2] - from[2]) * t),
    ]);
  }
  return out;
}
