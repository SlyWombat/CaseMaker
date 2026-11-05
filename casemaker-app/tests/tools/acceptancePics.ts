/**
 * #964 — THE STANDING PICTURE SET. Test-tools, not engine code.
 *
 * Every re-score writes a handful of PNGs beside its numbers so a person can see what the goal
 * check saw: the adjudicated cut-into with the gate's excluded cells in their own colours, the
 * leftover above the band, the posted toolpaths over the goal, and two vertical sections through
 * the worst cut-into and the worst leftover cell.
 *
 * Inputs (written by the acceptance/figure specs when `CM_*_OUT` is set):
 *   --plan  <run>/<card>-plan.json   the plan's perSetup[0].programs (ToolpathIR[])
 *   --pics  <run>/<card>-pics.json   { card, target, stock, frame, cutIntoOptions, post }
 *   --out   <dir>                    where the SVG/PNG files are written
 *
 * CLI:
 *   npx tsx --tsconfig tsconfig.scripts.json tests/tools/acceptancePics.ts \
 *     --plan /tmp/score-x/tray-plan.json --pics /tmp/score-x/tray-pics.json \
 *     --out ~/casemaker-manager/pics/<sha>/tray
 *
 * The goal field, the posted programs' stamp and the cut-into/adjudication classification are the
 * ENGINE'S OWN (sampleGoalHeightfield, postZ1 + exactSweptField, checkGoalCutInto). The cell
 * classes the maps need are not in the report (it carries shares, not cell ids), so this tool
 * re-builds the same masks (`designEdgeCells` / `borderCells` / `dilateCells`, as designCheck.ts
 * defines them) and VERIFIES its cell counts against the report's fractions before drawing — a
 * drift in either side fails the picture run rather than drawing a map that disagrees with the
 * gate.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import path from 'node:path';

import { exactSweptField } from '@/workers/sim/sweptPoint';
import { parseGcode, setupFromHeader, stubSetup } from '@/engine/cnc';
import { buildTimeline } from '@/engine/cnc/emulator/timeline';
import type { CamMove, ToolpathIR } from '@/engine/cnc/cam/ir';
import type { GoalCutIntoOptions, GoalCutIntoReport } from '@/engine/cnc/engrave/designCheck';
import { GOAL_LEFTOVER_BANDS_MM, checkGoalCutInto } from '@/engine/cnc/engrave/designCheck';
import { sampleGoalHeightfield, type GoalHeightfield } from '@/engine/cnc/engrave/goalHeightfield';
import type { ResultTop } from '@/engine/cnc/engrave/goalCoverage';
import { Z1 } from '@/engine/cnc/machine';
import { postZ1, type PostContext } from '@/engine/cnc/post/z1';
import type { EngraveTargetObject } from '@/types/engraveJob';

// ---------------------------------------------------------------------------------------------
// Input document
// ---------------------------------------------------------------------------------------------

interface PicsDoc {
  card: string;
  /** The goal's own door: the placed target the spec sampled (`sampleGoalHeightfield`). */
  target: EngraveTargetObject;
  stock: { length: number; width: number; thickness: number };
  frame: { stockTop: number; partBottom: number };
  /** The gate parameters the spec used — edgeBreak + wall shadow radius (serializable). */
  cutIntoOptions: GoalCutIntoOptions;
  /** The Z1 post context the spec posts with. */
  post: PostContext;
}

interface Args {
  plan: string;
  pics: string;
  out: string;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i]!.replace(/^--/, '')] = argv[i + 1]!;
  const plan = args.plan;
  const pics = args.pics;
  const out = args.out;
  if (plan === undefined || pics === undefined || out === undefined) {
    throw new Error('usage: acceptancePics.ts --plan <plan.json> --pics <pics.json> --out <dir>');
  }
  return { plan, pics, out };
}

// ---------------------------------------------------------------------------------------------
// The engine's read: goal, posted stamp, report
// ---------------------------------------------------------------------------------------------

function goalOf(doc: PicsDoc): GoalHeightfield {
  return sampleGoalHeightfield(doc.target, { pitchMm: 0.1, stockTopZ: 0 });
}

interface PostedRun {
  ir: ToolpathIR;
  text: string;
  cutterKey: string;
}

function postRuns(programs: readonly ToolpathIR[], post: PostContext): PostedRun[] {
  return programs.map((ir, i) => {
    const posted = postZ1(ir, post, Z1);
    if (!posted.ok) throw new Error(`program ${i} (${ir.tool.name}) refused to post: ${posted.errors.join('; ')}`);
    return { ir, text: posted.text, cutterKey: ir.tool.id ?? ir.tool.name ?? `program-${i}` };
  });
}

/** Each posted program stamped at every goal cell centre, accumulated by lowest reach — the same
 * fold `opsAcceptance959`/`figureAcceptance965` use (`stampedTop`/`wholeSurfaceTop`). */
function stampedTop(runs: readonly PostedRun[], goal: GoalHeightfield): ResultTop {
  let acc: Float32Array | null = null;
  for (const run of runs) {
    const parsed = parseGcode(run.text);
    const part = setupFromHeader(parsed.header).patch.part;
    if (part === undefined || part.kind !== 'prism' || part.outline.kind !== 'p-rect') {
      throw new Error(`program "${run.cutterKey}" posted no rectangular stock header`);
    }
    const setup = stubSetup(part, { kind: 'tape-down', contact: part.outline }, { startingTool: 1 }, Z1);
    const timeline = buildTimeline(parsed, setup, Z1);
    const stamp = exactSweptField(goal, timeline, run.ir.tool);
    if (stamp === null) throw new Error(`program "${run.cutterKey}" produced no exact stamp`);
    if (acc === null) acc = Float32Array.from(stamp);
    else for (let k = 0; k < acc.length; k++) if (stamp[k]! < acc[k]!) acc[k] = stamp[k]!;
  }
  if (acc === null) throw new Error('no programs to stamp');
  const field = acc;
  return (x: number, y: number) => {
    const i = Math.round((x - goal.x0) / goal.pitch);
    const j = Math.round((y - goal.y0) / goal.pitch);
    if (i < 0 || j < 0 || i >= goal.nx || j >= goal.ny) return null;
    return field[j * goal.nx + i]!;
  };
}

// ---------------------------------------------------------------------------------------------
// The gate's cell classes. `designCheck.ts` keeps these private; the counts are verified against
// its report before anything is drawn, so a copy that drifts cannot pass as the gate's map.
// ---------------------------------------------------------------------------------------------

const GOAL_EDGE_STEP_MM = 0.2;

function designEdgeCells(goal: GoalHeightfield): Uint8Array {
  const { nx, ny, covered, z } = goal;
  const wall = new Uint8Array(nx * ny);
  const outside = goal.minZ - 1;
  const at = (k: number): number => (covered[k] === 1 ? (z[k] as number) : outside);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (i + 1 < nx && Math.abs(at(k) - at(k + 1)) > GOAL_EDGE_STEP_MM) {
        wall[k] = 1;
        wall[k + 1] = 1;
      }
      if (j + 1 < ny && Math.abs(at(k) - at(k + nx)) > GOAL_EDGE_STEP_MM) {
        wall[k] = 1;
        wall[k + nx] = 1;
      }
    }
  }
  return wall;
}

function borderCells(goal: GoalHeightfield): Uint8Array {
  const { nx, ny, covered } = goal;
  const border = new Uint8Array(nx * ny);
  for (let i = 0; i < nx; i++) {
    if (covered[i] === 1) border[i] = 1;
    const bottom = (ny - 1) * nx + i;
    if (covered[bottom] === 1) border[bottom] = 1;
  }
  for (let j = 0; j < ny; j++) {
    const left = j * nx;
    if (covered[left] === 1) border[left] = 1;
    const right = j * nx + nx - 1;
    if (covered[right] === 1) border[right] = 1;
  }
  return border;
}

function dilateCells(mask: Uint8Array, nx: number, ny: number, pitch: number, radiusMm: number): Uint8Array {
  const out = new Uint8Array(nx * ny);
  const r = Math.ceil(radiusMm / pitch);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (mask[j * nx + i] !== 1) continue;
      for (let dj = -r; dj <= r; dj++) {
        const jj = j + dj;
        if (jj < 0 || jj >= ny) continue;
        for (let di = -r; di <= r; di++) {
          const ii = i + di;
          if (ii < 0 || ii >= nx) continue;
          if (Math.hypot(di * pitch, dj * pitch) > radiusMm + 1e-9) continue;
          out[jj * nx + ii] = 1;
        }
      }
    }
  }
  return out;
}

type CellClass = 'outside' | 'covered' | 'adjudicated' | 'edgeBreak' | 'wall' | 'shadow' | 'rawOnly';

interface Cells {
  classOf: Uint8Array; // CellClass index
  depth: Float32Array; // cut-into depth (positive) where cut; 0 otherwise
  leftover: Float32Array; // top − goal where positive
}

const CLASS: readonly CellClass[] = ['outside', 'covered', 'adjudicated', 'edgeBreak', 'wall', 'shadow', 'rawOnly'];
const CLASS_INDEX = Object.fromEntries(CLASS.map((c, i) => [c, i])) as Record<CellClass, number>;

function classify(goal: GoalHeightfield, top: ResultTop, report: GoalCutIntoReport, opts: GoalCutIntoOptions): Cells {
  const { nx, ny, covered, z } = goal;
  const cells = nx * ny;
  const classOf = new Uint8Array(cells);
  const depth = new Float32Array(cells);
  const leftover = new Float32Array(cells);
  const wall = designEdgeCells(goal);
  const border = borderCells(goal);
  const bandSeed = new Uint8Array(cells);
  for (let k = 0; k < cells; k++) if (wall[k] === 1 || border[k] === 1) bandSeed[k] = 1;
  const allowance = opts.edgeBreak;
  const allowanceActive = allowance !== undefined && allowance.reachMm > 0 && allowance.legMm > 0;
  const band = allowanceActive ? dilateCells(bandSeed, nx, ny, goal.pitch, allowance!.reachMm) : null;
  const shadow =
    opts.wallShadowRadiusMm !== undefined && opts.wallShadowRadiusMm > 0
      ? dilateCells(wall, nx, ny, goal.pitch, opts.wallShadowRadiusMm)
      : null;
  // TWO FLOORS, as designCheck.ts uses them: the RAW cut (and the exclusion set) is the report's
  // `cutIntoFloorMm` (0.01, GOAL_CUT_INTO_FLOOR_MM), while the ADJUDICATED set is the gate's
  // judged 0.1 mm floor, hardcoded in its adjudication loop. The report's counts verify both.
  const cutFloor = report.cutIntoFloorMm;
  const judgedFloor = 0.1;
  let adjudicated = 0;
  let edgeBreakCells = 0;
  let wallCells = 0;
  let shadowCells = 0;
  let rawCut = 0;
  let leftoverCells = 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (covered[k] !== 1) {
        classOf[k] = CLASS_INDEX.outside;
        continue;
      }
      const x = goal.x0 + i * goal.pitch;
      const y = goal.y0 + j * goal.pitch;
      const t = top(x, y);
      if (t === null) {
        classOf[k] = CLASS_INDEX.covered;
        continue;
      }
      const goalTop = z[k] as number;
      const d = t - goalTop;
      if (d > GOAL_LEFTOVER_BANDS_MM[0]!) {
        leftover[k] = d;
        leftoverCells++;
      }
      if (d >= -cutFloor) {
        classOf[k] = CLASS_INDEX.covered;
        continue;
      }
      rawCut++;
      depth[k] = -d;
      if (band !== null && band[k] === 1 && -d <= allowance!.legMm + 1e-9) {
        classOf[k] = CLASS_INDEX.edgeBreak;
        edgeBreakCells++;
        continue;
      }
      if (wall[k] === 1 || border[k] === 1) {
        classOf[k] = CLASS_INDEX.wall;
        wallCells++;
        continue;
      }
      if (shadow !== null && shadow[k] === 1 && wall[k] !== 1) {
        classOf[k] = CLASS_INDEX.shadow;
        shadowCells++;
        continue;
      }
      if (-d >= judgedFloor) {
        classOf[k] = CLASS_INDEX.adjudicated;
        adjudicated++;
      } else {
        // Cut below the raw floor but not below the judged 0.1 mm line: drawn faintly, not judged.
        classOf[k] = CLASS_INDEX.rawOnly;
      }
    }
  }
  // VERIFY the classes ARE the gate's, before drawing. The report's shares are over the same
  // covered-cell denominator it used; a drift here means this tool would draw a different map.
  const n = Math.max(report.goalCells, 1);
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-9;
  if (!near(adjudicated / n, report.adjudicatedFraction) || !near(edgeBreakCells / n, report.edgeBreakFraction)
    || !near(wallCells / n, report.wallNotScoredFraction) || !near(shadowCells / n, report.shadowNotScoredFraction)
    || !near(rawCut / n, report.cutIntoFraction) || !near(leftoverCells / n, report.leftoverFractions[0]!)) {
    throw new Error(
      `picture cell classes disagree with checkGoalCutInto: adj ${adjudicated}/${n} vs ${report.adjudicatedFraction}, ` +
        `edge ${edgeBreakCells}/${n} vs ${report.edgeBreakFraction}, wall ${wallCells}/${n} vs ${report.wallNotScoredFraction}, ` +
        `shadow ${shadowCells}/${n} vs ${report.shadowNotScoredFraction}, raw ${rawCut}/${n} vs ${report.cutIntoFraction}, ` +
        `leftover ${leftoverCells}/${n} vs ${report.leftoverFractions[0]}`,
    );
  }
  return { classOf, depth, leftover };
}

// ---------------------------------------------------------------------------------------------
// Raster (PNG) for the two top-view maps and the goal hillshade behind the toolpaths
// ---------------------------------------------------------------------------------------------

/** A minimal PNG encoder: 8-bit RGB, filter 0 per row, zlib via node:zlib. No dependencies. */
function pngBase64(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): string {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      const o = row + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const idat = deflateSync(raw, { level: 6 });
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return png.toString('base64');
}

let crcTable: Uint32Array | null = null;
function crc32(buf: Buffer): number {
  if (crcTable === null) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------------------------

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const rgb = (r: number, g: number, b: number): [number, number, number] => [Math.round(r), Math.round(g), Math.round(b)];
function ramp(t: number, from: [number, number, number], to: [number, number, number]): [number, number, number] {
  const u = Math.max(0, Math.min(1, t));
  return rgb(lerp(from[0], to[0], u), lerp(from[1], to[1], u), lerp(from[2], to[2], u));
}

const CUT_LOW: [number, number, number] = [255, 237, 160];
const CUT_HIGH: [number, number, number] = [203, 24, 29];
const LEFT_LOW: [number, number, number] = [254, 240, 138];
const LEFT_HIGH: [number, number, number] = [189, 0, 38];
const EDGE_BREAK: [number, number, number] = [43, 108, 176];
const WALL: [number, number, number] = [113, 128, 150];
const SHADOW: [number, number, number] = [128, 90, 213];
const UNCOVERED: [number, number, number] = [26, 32, 44];
const COVERED: [number, number, number] = [226, 232, 240];

/** A slope-shaded grey of the goal surface, so the maps read the part's shape under the colours. */
function hillshade(goal: GoalHeightfield): (i: number, j: number) => [number, number, number] {
  return (i, j) => {
    const k = j * goal.nx + i;
    if (goal.covered[k] !== 1) return UNCOVERED;
    const z = goal.z[k] as number;
    const left = i > 0 && goal.covered[k - 1] === 1 ? (goal.z[k - 1] as number) : z;
    const right = i + 1 < goal.nx && goal.covered[k + 1] === 1 ? (goal.z[k + 1] as number) : z;
    const dzdx = (right - left) / (2 * goal.pitch);
    const shade = Math.max(0.45, Math.min(1, 0.82 - dzdx * 0.22));
    const v = Math.round(255 * shade);
    return [v, v, v];
  };
}

// ---------------------------------------------------------------------------------------------
// SVG helpers
// ---------------------------------------------------------------------------------------------

interface Box {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function svgDoc(width: number, height: number, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect width="100%" height="100%" fill="#f7f5ef"/>${body}</svg>`;
}

/** The canvas rect the world box fills at ONE scale (no stretch), centred. */
function fitRect(box: Box, canvas: { x: number; y: number; w: number; h: number }): { x: number; y: number; w: number; h: number } {
  const scale = Math.min(canvas.w / (box.x1 - box.x0), canvas.h / (box.y1 - box.y0));
  const w = (box.x1 - box.x0) * scale;
  const h = (box.y1 - box.y0) * scale;
  return { x: canvas.x + (canvas.w - w) / 2, y: canvas.y + (canvas.h - h) / 2, w, h };
}

/** World→canvas for a top view: X to the right, Y up (the screen flips), one scale both ways. */
function topProjection(box: Box, canvas: { x: number; y: number; w: number; h: number }) {
  const fit = fitRect(box, canvas);
  const sx = fit.w / (box.x1 - box.x0);
  const sy = fit.h / (box.y1 - box.y0);
  return {
    x: (x: number) => fit.x + (x - box.x0) * sx,
    y: (y: number) => fit.y + fit.h - (y - box.y0) * sy,
    sx,
    sy,
  };
}

// ---------------------------------------------------------------------------------------------
// The four pictures
// ---------------------------------------------------------------------------------------------

function renderMaps(
  goal: GoalHeightfield,
  cells: Cells,
  report: GoalCutIntoReport,
  title: string,
  outDir: string,
): { svg: string; png: string }[] {
  const out: { svg: string; png: string }[] = [];
  const step = Math.max(1, Math.ceil(Math.max(goal.nx, goal.ny) / 760));
  const w = Math.ceil(goal.nx / step);
  const h = Math.ceil(goal.ny / step);
  const canvas = { x: 28, y: 44, w: 640, h: 420 };
  const fit = fitRect({ x0: goal.x0, x1: goal.x0 + (goal.nx - 1) * goal.pitch, y0: goal.y0, y1: goal.y0 + (goal.ny - 1) * goal.pitch }, canvas);

  const shade = hillshade(goal);
  const mapSvg = (
    name: string,
    frameColor: (x: number, y: number) => [number, number, number],
    caption: string,
    legend: string,
  ): void => {
    const png = pngBase64(w, h, (px, py) => {
      // The raster's row 0 is the top of the picture; the goal's j grows with Y (up).
      const i = Math.min(goal.nx - 1, px * step);
      const j = Math.min(goal.ny - 1, (h - 1 - py) * step);
      return frameColor(i, j);
    });
    const cardCoverage = 1 - (report.leftoverFractions[0] ?? 0);
    const body =
      `<text x="28" y="22" font-family="sans-serif" font-size="14" font-weight="700" fill="#1a202c">${esc(title)}</text>` +
      `<text x="28" y="40" font-family="sans-serif" font-size="10" fill="#4a5568">${esc(caption)}</text>` +
      `<rect x="${fit.x}" y="${fit.y}" width="${fit.w}" height="${fit.h}" fill="none" stroke="#4a5568"/>` +
      `<image x="${fit.x}" y="${fit.y}" width="${fit.w}" height="${fit.h}" href="data:image/png;base64,${png}" image-rendering="pixelated"/>` +
      `<text x="700" y="${canvas.y + 14}" font-family="sans-serif" font-size="11" font-weight="700" fill="#1a202c">coverage ${(cardCoverage * 100).toFixed(2)} %</text>` +
      `<text x="700" y="${canvas.y + 32}" font-family="sans-serif" font-size="10" fill="#4a5568">adjudicated ${(report.adjudicatedFraction * 100).toFixed(2)} % · raw ${(report.cutIntoFraction * 100).toFixed(2)} %</text>` +
      `<text x="700" y="${canvas.y + 48}" font-family="sans-serif" font-size="10" fill="#4a5568">worst raw ${report.maxCutIntoMm.toFixed(3)} mm</text>` +
      `<text x="28" y="${canvas.y + canvas.h + 16}" font-family="sans-serif" font-size="9" fill="#1a202c">${esc(legend)}</text>`;
    const svg = svgDoc(1000, 500, body);
    const svgPath = path.join(outDir, `${name}.svg`);
    writeFileSync(svgPath, svg);
    out.push({ svg: svgPath, png: path.join(outDir, `${name}.png`) });
  };

  // 1 — the adjudicated cut-into, with the excluded cells in their own colours.
  mapSvg(
    '01-cut-into-top',
    (i, j) => {
      const k = j * goal.nx + i;
      const cls = CLASS[cells.classOf[k]!]!;
      if (cls === 'outside') return UNCOVERED;
      const shadeAt = shade(i, j);
      if (cls === 'edgeBreak') return EDGE_BREAK;
      if (cls === 'wall') return WALL;
      if (cls === 'shadow') return SHADOW;
      if (cls === 'adjudicated') return ramp(cells.depth[k]! / 3, CUT_LOW, CUT_HIGH);
      if (cls === 'rawOnly') return [252, 214, 214];
      return shadeAt;
    },
    'red = adjudicated · pink = raw 0.01–0.10 mm · blue = edge break · grey = wall · purple = wall shadow',
    `red = adjudicated (>0.10 mm below the goal, the judged floor); pink = raw cut 0.01–0.10 mm; excluded cells keep their own colour.`,
  );

  // 2 — leftover above the 0.1 mm band.
  mapSvg(
    '02-leftover-top',
    (i, j) => {
      const k = j * goal.nx + i;
      if (goal.covered[k] !== 1) return UNCOVERED;
      const left = cells.leftover[k]!;
      if (left > GOAL_LEFTOVER_BANDS_MM[0]!) return ramp(left / 2, LEFT_LOW, LEFT_HIGH);
      return COVERED;
    },
    'leftover above the 0.1 mm band (uncovered surface)',
    `yellow→red = material standing above the goal by >0.1 mm (max ${report.maxLeftoverMm.toFixed(3)} mm); pale = within the band.`,
  );
  return out;
}

function renderToolpaths(
  goal: GoalHeightfield,
  runs: readonly PostedRun[],
  title: string,
  outDir: string,
): { svg: string; png: string } {
  const box: Box = { x0: goal.x0, x1: goal.x0 + (goal.nx - 1) * goal.pitch, y0: goal.y0, y1: goal.y0 + (goal.ny - 1) * goal.pitch };
  const step = Math.max(1, Math.ceil(Math.max(goal.nx, goal.ny) / 700));
  const w = Math.ceil(goal.nx / step);
  const h = Math.ceil(goal.ny / step);
  const hill = hillshade(goal);
  const bg = pngBase64(w, h, (px, py) => {
    const i = Math.min(goal.nx - 1, px * step);
    const j = Math.min(goal.ny - 1, (h - 1 - py) * step);
    return hill(i, j);
  });
  const palette = ['#e41a1c', '#377eb8', '#4daf4a', '#984ea3', '#ff7f00', '#a65628', '#f781bf'];
  // Small multiples: one panel per program, so a dense raster cannot blot the others.
  const cols = 2;
  const rows = Math.ceil(runs.length / cols);
  const panelW = 460;
  const panelH = 300;
  const svgW = 40 + cols * panelW;
  const svgH = 70 + rows * panelH;
  const panels: string[] = [];
  runs.forEach((run, idx) => {
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const canvas = { x: 24 + col * panelW, y: 54 + row * panelH, w: panelW - 40, h: panelH - 70 };
    const fit = fitRect(box, canvas);
    const proj = topProjection(box, canvas);
    const color = palette[idx % palette.length]!;
    let feed = '';
    let rapid = '';
    let segments = 0;
    let last: CamMove | null = null;
    for (const op of run.ir.operations) {
      for (const m of op.moves) {
        if (last !== null) {
          const d = Math.hypot(m.x - last.x, m.y - last.y);
          if (d >= 0.25 && segments < 30000) {
            // E's catch (972-render-set 263df637): ONE polyline joins the end of a segment to
            // the start of the next and draws a diagonal that is not in the NC (the contour
            // panels appeared to cross the part at −27 mm). Each move is its own M…L… subpath.
            const seg = `M${proj.x(last.x).toFixed(1)},${proj.y(last.y).toFixed(1)} L${proj.x(m.x).toFixed(1)},${proj.y(m.y).toFixed(1)} `;
            if (m.kind === 'feed') feed += seg;
            else rapid += seg;
            segments++;
          }
        }
        last = m;
      }
    }
    const label = `${run.cutterKey} — ${segments} drawn segments`;
    panels.push(
      `<text x="${canvas.x}" y="${canvas.y - 8}" font-family="sans-serif" font-size="11" font-weight="700" fill="#1a202c">${esc(label)}</text>` +
      `<rect x="${fit.x}" y="${fit.y}" width="${fit.w}" height="${fit.h}" fill="none" stroke="#4a5568"/>` +
      `<image x="${fit.x}" y="${fit.y}" width="${fit.w}" height="${fit.h}" href="data:image/png;base64,${bg}" image-rendering="pixelated"/>` +
      (rapid === '' ? '' : `<path d="${rapid}" fill="none" stroke="#718096" stroke-opacity="0.5" stroke-width="0.5" stroke-dasharray="3 2"/>`) +
      (feed === '' ? '' : `<path d="${feed}" fill="none" stroke="${color}" stroke-opacity="0.55" stroke-width="0.6"/>`),
    );
  });
  const body =
    `<text x="24" y="24" font-family="sans-serif" font-size="14" font-weight="700" fill="#1a202c">${esc(title)} — posted toolpaths, one panel per program</text>` +
    `<text x="24" y="40" font-family="sans-serif" font-size="10" fill="#4a5568">each panel: solid = that program's feed (its colour), dashed grey = its rapids, over the goal's top view</text>` +
    panels.join('');
  const svg = svgDoc(svgW, svgH, body);
  const svgPath = path.join(outDir, '03-toolpaths.svg');
  writeFileSync(svgPath, svg);
  return { svg: svgPath, png: path.join(outDir, '03-toolpaths.png') };
}

/** The worst cell (max depth) in a class or over the leftover field. */
function worstCell(
  cells: Cells,
  goal: GoalHeightfield,
  kind: 'adjudicated' | 'raw' | 'left',
): { x: number; y: number; value: number; cls: CellClass } | null {
  let best: { x: number; y: number; value: number; cls: CellClass } | null = null;
  for (let j = 0; j < goal.ny; j++) {
    for (let i = 0; i < goal.nx; i++) {
      const k = j * goal.nx + i;
      const cls = CLASS[cells.classOf[k]!]!;
      const v =
        kind === 'adjudicated' && cls === 'adjudicated'
          ? cells.depth[k]!
          : kind === 'raw' && cells.depth[k]! > 0
            ? cells.depth[k]!
            : kind === 'left'
              ? cells.leftover[k]!
              : 0;
      if (v > 0 && (best === null || v > best.value)) {
        best = { x: goal.x0 + i * goal.pitch, y: goal.y0 + j * goal.pitch, value: v, cls };
      }
    }
  }
  return best;
}

/** A vertical section at (x,y): along the longer covered direction through the cell. */
function renderSection(
  goal: GoalHeightfield,
  runs: readonly PostedRun[],
  doc: PicsDoc,
  top: ResultTop,
  at: { x: number; y: number; value: number; cls: CellClass },
  kind: 'cut' | 'left',
  title: string,
  name: string,
  outDir: string,
): { svg: string; png: string } {
  // Choose the axis with the longer covered run through the cell.
  const runLength = (alongX: boolean): number => {
    let len = 0;
    const other = alongX ? at.y : at.x;
    for (let t = 0; t < 4000; t++) {
      const v = (alongX ? at.x : at.y) + (t - 2000) * goal.pitch;
      const i = alongX ? Math.round((v - goal.x0) / goal.pitch) : Math.round((other - goal.x0) / goal.pitch);
      const j = alongX ? Math.round((other - goal.y0) / goal.pitch) : Math.round((v - goal.y0) / goal.pitch);
      if (i < 0 || j < 0 || i >= goal.nx || j >= goal.ny || goal.covered[j * goal.nx + i] !== 1) continue;
      len++;
    }
    return len;
  };
  const alongX = runLength(true) >= runLength(false);
  const other = alongX ? at.y : at.x;
  const lo = alongX ? goal.x0 : goal.y0;
  const hi = alongX ? goal.x0 + (goal.nx - 1) * goal.pitch : goal.y0 + (goal.ny - 1) * goal.pitch;
  const sampleAt = (v: number): { goalZ: number | null; topZ: number | null } => {
    const x = alongX ? v : other;
    const y = alongX ? other : v;
    const i = Math.round((x - goal.x0) / goal.pitch);
    const j = Math.round((y - goal.y0) / goal.pitch);
    if (i < 0 || j < 0 || i >= goal.nx || j >= goal.ny) return { goalZ: null, topZ: null };
    const k = j * goal.nx + i;
    const t = top(x, y);
    return { goalZ: goal.covered[k] === 1 ? (goal.z[k] as number) : null, topZ: t };
  };
  // The toolpaths' posted Z at this section: every segment crossing the section line.
  const crossings: { color: string; feed: boolean; v: number; z: number }[] = [];
  const palette = ['#e41a1c', '#377eb8', '#4daf4a', '#984ea3', '#ff7f00', '#a65628', '#f781bf'];
  runs.forEach((run, idx) => {
    let last: CamMove | null = null;
    for (const op of run.ir.operations) {
      for (const m of op.moves) {
        if (last !== null) {
          const a = alongX ? last.y - other : last.x - other;
          const b = alongX ? m.y - other : m.x - other;
          if ((a === 0 || b === 0 || a * b < 0) && Math.abs(a) < 20 && Math.abs(b) < 20) {
            const t = a === b ? 0 : Math.abs(a) / (Math.abs(a) + Math.abs(b));
            const v = alongX ? last.x + (m.x - last.x) * t : last.y + (m.y - last.y) * t;
            const z = last.z + (m.z - last.z) * t;
            crossings.push({ color: palette[idx % palette.length]!, feed: m.kind === 'feed', v, z });
          }
        }
        last = m;
      }
    }
  });
  const sample = (): { v: number; goalZ: number | null; topZ: number | null }[] => {
    const out: { v: number; goalZ: number | null; topZ: number | null }[] = [];
    for (let v = lo; v <= hi + 1e-9; v += goal.pitch) out.push({ v, ...sampleAt(v) });
    return out;
  };
  const data = sample();
  const panel = (
    box: { x: number; y: number; w: number; h: number },
    zTop: number,
    zBottom: number,
    opts: { ground: boolean; rapids: boolean },
  ): string => {
    const px = (v: number): number => box.x + ((v - lo) / (hi - lo)) * box.w;
    const py = (z: number): number => box.y + ((zTop - z) / (zTop - zBottom)) * box.h;
    const poly = (pick: (d: { goalZ: number | null; topZ: number | null }) => number | null): string => {
      let d = '';
      let open = false;
      for (const row of data) {
        const z = pick(row);
        if (z === null) { open = false; continue; }
        d += `${open ? 'L' : 'M'}${px(row.v).toFixed(1)} ${py(z).toFixed(1)} `;
        open = true;
      }
      return d;
    };
    const ticks = (): string => {
      let out = '';
      for (let t = 0; t <= 4; t++) {
        const v = lo + ((hi - lo) * t) / 4;
        out += `<line x1="${px(v).toFixed(0)}" y1="${box.y}" x2="${px(v).toFixed(0)}" y2="${box.y + box.h}" stroke="#e2e8f0" stroke-width="0.5"/>` +
          `<text x="${px(v).toFixed(0)}" y="${box.y + box.h + 12}" text-anchor="middle" font-family="sans-serif" font-size="9" fill="#4a5568">${v.toFixed(1)}</text>`;
      }
      for (let t = 0; t <= 4; t++) {
        const z = zTop - ((zTop - zBottom) * t) / 4;
        out += `<text x="${box.x - 4}" y="${py(z).toFixed(0)}" text-anchor="end" font-family="sans-serif" font-size="9" fill="#4a5568">${z.toFixed(2)}</text>`;
      }
      return out;
    };
    const marks = crossings
      .filter((c) => (opts.rapids ? true : c.feed))
      .map((c) => {
        if (c.feed) return `<circle cx="${px(c.v).toFixed(1)}" cy="${py(c.z).toFixed(1)}" r="2.6" fill="${c.color}" fill-opacity="0.8"/>`;
        return `<path d="M${(px(c.v) - 2).toFixed(1)} ${(py(c.z) - 2).toFixed(1)} l4 4 M${(px(c.v) + 2).toFixed(1)} ${(py(c.z) - 2).toFixed(1)} l-4 4" stroke="${c.color}" stroke-width="0.9" fill="none"/>`;
      })
      .join('');
    const ground = opts.ground
      ? `<line x1="${px(lo)}" y1="${py(doc.frame.stockTop)}" x2="${px(hi)}" y2="${py(doc.frame.stockTop)}" stroke="#a0aec0" stroke-dasharray="3 3"/>` +
        `<text x="${box.x + 4}" y="${py(doc.frame.stockTop) - 3}" font-family="sans-serif" font-size="9" fill="#718096">stock top ${doc.frame.stockTop.toFixed(2)}</text>` +
        `<line x1="${px(lo)}" y1="${py(doc.frame.partBottom)}" x2="${px(hi)}" y2="${py(doc.frame.partBottom)}" stroke="#4a5568" stroke-width="1.5"/>` +
        `<text x="${box.x + 4}" y="${py(doc.frame.partBottom) - 3}" font-family="sans-serif" font-size="9" fill="#4a5568">mesh bottom (partBottom ${doc.frame.partBottom.toFixed(2)})</text>` +
        `<line x1="${px(lo)}" y1="${py(doc.frame.stockTop - doc.stock.thickness)}" x2="${px(hi)}" y2="${py(doc.frame.stockTop - doc.stock.thickness)}" stroke="#718096" stroke-dasharray="6 3"/>` +
        `<text x="${box.x + 4}" y="${py(doc.frame.stockTop - doc.stock.thickness) + 11}" font-family="sans-serif" font-size="9" fill="#718096">stock bottom ${(doc.frame.stockTop - doc.stock.thickness).toFixed(2)}</text>`
      : '';
    return `<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" fill="#ffffff" stroke="#4a5568"/>${ticks()}${ground}` +
      `<path d="${poly((d) => d.goalZ)}" fill="none" stroke="#1a202c" stroke-width="1.5"/>` +
      `<path d="${poly((d) => d.topZ)}" fill="none" stroke="#d7301f" stroke-width="1.3"/>` + marks;
  };
  // Panel A: the whole part, with both ground surfaces. Panel B: the surface zoom (feed Z only).
  const full = { x: 60, y: 70, w: 860, h: 250 };
  // The zoom reads the SURFACE (goal/mesh top and sweep top), not the retract/plunge feed Z that
  // would stretch it to the safe plane; those stay in the whole-part panel.
  const zoomVals = data.flatMap((d) => [d.goalZ, d.topZ].filter((z): z is number => z !== null));
  const zoomLo = Math.min(...zoomVals) - 1;
  const zoomHi = Math.max(...zoomVals) + 1;
  const zoom = { x: 60, y: 400, w: 860, h: 320 };
  const axisLabel = (box: { x: number; y: number; w: number; h: number }, text: string): string =>
    `<text x="${(box.x + box.w / 2).toFixed(0)}" y="${box.y + box.h + 28}" text-anchor="middle" font-family="sans-serif" font-size="10" fill="#1a202c">${esc(text)}</text>`;
  const legendY = zoom.y + zoom.h + 46;
  const legend =
    `<line x1="60" y1="${legendY}" x2="90" y2="${legendY}" stroke="#1a202c" stroke-width="1.6"/><text x="96" y="${legendY + 4}" font-family="sans-serif" font-size="10" fill="#1a202c">goal / mesh top (0.1 mm sample)</text>` +
    `<line x1="360" y1="${legendY}" x2="390" y2="${legendY}" stroke="#d7301f" stroke-width="1.6"/><text x="396" y="${legendY + 4}" font-family="sans-serif" font-size="10" fill="#1a202c">posted sweep top</text>` +
    `<text x="60" y="${legendY + 20}" font-family="sans-serif" font-size="10" fill="#1a202c">toolpath Z: ● feed (each program a colour), × rapid (whole-part panel only)</text>`;
  const body =
    `<text x="28" y="22" font-family="sans-serif" font-size="14" font-weight="700" fill="#1a202c">${esc(title)} — ${kind === 'cut' ? `worst cut-into (${at.cls === 'adjudicated' ? 'adjudicated' : `raw, ${at.cls}`})` : 'worst leftover'} section</text>` +
    `<text x="28" y="40" font-family="sans-serif" font-size="11" fill="#4a5568">at ${at.x.toFixed(1)}, ${at.y.toFixed(1)} (${at.value.toFixed(3)} mm) along ${alongX ? 'X' : 'Y'} (${alongX ? `y = ${other.toFixed(1)}` : `x = ${other.toFixed(1)}`}) — upper: whole part; lower: surface zoom</text>` +
    panel(full, doc.frame.stockTop + 2, doc.frame.partBottom - 2, { ground: true, rapids: true }) +
    `<text x="${full.x}" y="${full.y - 8}" font-family="sans-serif" font-size="10" font-weight="700" fill="#1a202c">whole part</text>` +
    axisLabel(full, `${alongX ? 'X' : 'Y'} along the section, mm`) +
    panel(zoom, zoomHi, zoomLo, { ground: false, rapids: false }) +
    `<text x="${zoom.x}" y="${zoom.y - 8}" font-family="sans-serif" font-size="10" font-weight="700" fill="#1a202c">surface zoom (Z ${zoomLo.toFixed(2)} … ${zoomHi.toFixed(2)}) — feed Z only</text>` +
    axisLabel(zoom, `${alongX ? 'X' : 'Y'} along the section, mm`) +
    legend;
  const svg = svgDoc(1000, 840, body);
  const svgPath = path.join(outDir, `${name}.svg`);
  writeFileSync(svgPath, svg);
  return { svg: svgPath, png: path.join(outDir, `${name}.png`) };
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const plan = JSON.parse(readFileSync(args.plan, 'utf8')) as { perSetup: { programs: ToolpathIR[] }[] };
  const doc = JSON.parse(readFileSync(args.pics, 'utf8')) as PicsDoc;
  const programs = plan.perSetup[0]?.programs ?? [];
  if (programs.length === 0) throw new Error(`${args.plan}: no programs in perSetup[0]`);
  mkdirSync(args.out, { recursive: true });
  const goal = goalOf(doc);
  const runs = postRuns(programs, doc.post);
  const top = stampedTop(runs, goal);
  const report = checkGoalCutInto(goal, top, doc.cutIntoOptions);
  if (!report.ran) throw new Error(`the goal check did not run: ${report.reason}`);
  const cells = classify(goal, top, report, doc.cutIntoOptions);
  const title = `${doc.card} — ${path.basename(path.dirname(args.plan))}`;
  const files = [
    ...renderMaps(goal, cells, report, title, args.out),
    renderToolpaths(goal, runs, title, args.out),
  ];
  const worstCut = worstCell(cells, goal, 'adjudicated') ?? worstCell(cells, goal, 'raw');
  const worstLeft = worstCell(cells, goal, 'left');
  if (worstCut !== null) files.push(renderSection(goal, runs, doc, top, worstCut, 'cut', title, '04-section-worst-cut-into', args.out));
  if (worstLeft !== null) files.push(renderSection(goal, runs, doc, top, worstLeft, 'left', title, '05-section-worst-leftover', args.out));
  // Render every SVG to PNG with the maintainer's Playwright tool.
  for (const f of files) {
    execFileSync(process.execPath, [path.join(process.env.HOME ?? '', 'projects', 'cm-gate2', 'casemaker-app', 'svg2png.tmp.mjs'), f.svg, f.png], { stdio: 'pipe' });
  }
  process.stdout.write(`${files.map((f) => f.png).join('\n')}\n`);
}

main();
