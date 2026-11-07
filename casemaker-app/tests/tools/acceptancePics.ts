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

import { exactSweptFieldTooled } from '@/workers/sim/sweptPoint';
import { cuttingDiameter, type Tool } from '@/engine/cnc/tool';
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
  /** The vendor's own NC files, drawn beside ours at the same scale (repeatable). */
  vendor: string[];
  /** The coverage line the attribution measures the gap against (default: the doc's passCoverage). */
  line?: string;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Record<string, string> = {};
  const vendor: string[] = [];
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]!.replace(/^--/, '');
    const value = argv[i + 1]!;
    if (key === 'vendor') vendor.push(value);
    else args[key] = value;
  }
  const plan = args.plan;
  const pics = args.pics;
  const out = args.out;
  if (plan === undefined || pics === undefined || out === undefined) {
    throw new Error('usage: acceptancePics.ts --plan <plan.json> --pics <pics.json> --out <dir> [--vendor <nc> ...] [--line <fraction>]');
  }
  return { plan, pics, out, vendor, line: args.line };
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

/** Each posted program stamped at every goal cell centre — one field per program, so a cell can
 * be coloured by the program that owns its floor; folded to the union the gate scores. The fold is
 * the same one `opsAcceptance959`/`figureAcceptance965` use (`stampedTop`/`wholeSurfaceTop`), with
 * v4's per-cell identity riding it (lowest reach wins; a tie keeps the earlier run's cutter). */
interface RunStamp {
  field: Float32Array;
  who: Uint8Array;
}

function stampedFields(runs: readonly PostedRun[], goal: GoalHeightfield): RunStamp[] {
  return runs.map((run) => {
    const parsed = parseGcode(run.text);
    const part = setupFromHeader(parsed.header).patch.part;
    if (part === undefined || part.kind !== 'prism' || part.outline.kind !== 'p-rect') {
      throw new Error(`program "${run.cutterKey}" posted no rectangular stock header`);
    }
    const setup = stubSetup(part, { kind: 'tape-down', contact: part.outline }, { startingTool: 1 }, Z1);
    const timeline = buildTimeline(parsed, setup, Z1);
    const stamp = exactSweptFieldTooled(goal, timeline, () => run.ir.tool);
    if (stamp === null) throw new Error(`program "${run.cutterKey}" produced no exact stamp`);
    return { field: stamp.field, who: Uint8Array.from(stamp.who) };
  });
}

function foldFields(stamps: readonly RunStamp[]): RunStamp {
  let acc: Float32Array | null = null;
  let who: Uint8Array | null = null;
  for (const stamp of stamps) {
    if (acc === null || who === null) {
      acc = Float32Array.from(stamp.field);
      who = Uint8Array.from(stamp.who);
    } else {
      for (let k = 0; k < acc.length; k++) {
        if (stamp.field[k]! < acc[k]!) {
          acc[k] = stamp.field[k]!;
          who[k] = stamp.who[k]!;
        }
      }
    }
  }
  if (acc === null || who === null) throw new Error('no programs to stamp');
  return { field: acc, who };
}

function topOfField(field: Float32Array, goal: GoalHeightfield): ResultTop {
  return (x, y) => {
    const i = Math.round((x - goal.x0) / goal.pitch);
    const j = Math.round((y - goal.y0) / goal.pitch);
    if (i < 0 || j < 0 || i >= goal.nx || j >= goal.ny) return null;
    return field[j * goal.nx + i]!;
  };
}

/** The program whose floor is the cell's top (the owner of its final surface); ties go earlier. */
function ownerField(fields: readonly Float32Array[]): Int32Array {
  const cells = fields[0]!.length;
  const owner = new Int32Array(cells);
  for (let k = 0; k < cells; k++) {
    let best = 0;
    let bestZ = fields[0]![k]!;
    for (let p = 1; p < fields.length; p++) {
      if (fields[p]![k]! < bestZ) {
        best = p;
        bestZ = fields[p]![k]!;
      }
    }
    owner[k] = best;
  }
  return owner;
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

function classify(
  goal: GoalHeightfield,
  top: ResultTop,
  report: GoalCutIntoReport,
  opts: GoalCutIntoOptions,
  whoAt: (x: number, y: number) => number | null,
): Cells {
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
      // #948/v4 — the V gate: a band cell is edge break only where the V is its deepest cutter.
      const vAllowed = allowance !== undefined && allowance.toolNumber !== undefined;
      const whoOk = !vAllowed || whoAt(x, y) === allowance!.toolNumber;
      if (band !== null && band[k] === 1 && -d <= allowance!.legMm + 1e-9 && whoOk) {
        classOf[k] = CLASS_INDEX.edgeBreak;
        edgeBreakCells++;
        continue;
      }
      if (wall[k] === 1 || border[k] === 1) {
        classOf[k] = CLASS_INDEX.wall;
        wallCells++;
        continue;
      }
      // v5 (#970) — a wall-shadow cell is excused only on the rule's proof: the V cut it within its
      // leg (case a), or the deepest stamp's CL stays R from the wall (case b). This harness builds
      // its stamped fields from posted NCs and carries no CL, and the acceptance run states no
      // clAt, so case (b) excuses nothing here and the conservative path applies: with no proof the
      // cell falls through to the floor rule (adjudicated when it is past the 0.1 mm line).
      // Guarded by the class report below: if a future run starts stating clAt, this throws rather
      // than drawing a different map.
      const vShadowExcused = vAllowed && whoOk && -d <= allowance!.legMm + 1e-9;
      if (shadow !== null && shadow[k] === 1 && wall[k] !== 1 && vShadowExcused) {
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
const EDGE_BREAK: [number, number, number] = [43, 108, 176];
const WALL: [number, number, number] = [113, 128, 150];
const SHADOW: [number, number, number] = [128, 90, 213];
const UNCOVERED: [number, number, number] = [26, 32, 44];
const COVERED: [number, number, number] = [226, 232, 240];

/** One colour per posted program, shared by every map and the toolpath panels. */
const PROGRAM_PALETTE = ['#e41a1c', '#377eb8', '#4daf4a', '#984ea3', '#ff7f00', '#a65628', '#f781bf', '#1b9e77'];
const programRgb = (idx: number): [number, number, number] => {
  const hex = PROGRAM_PALETTE[idx % PROGRAM_PALETTE.length]!;
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
};
const mix = (a: [number, number, number], b: [number, number, number], t: number): [number, number, number] =>
  rgb(lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t));

/** A blue→green→yellow→red ramp for Z, so depth reads at a glance. */
function zRamp(z: number, lo: number, hi: number): [number, number, number] {
  const t = Math.max(0, Math.min(1, (z - lo) / Math.max(hi - lo, 1e-9)));
  const stops: [number, number, number][] = [
    [49, 54, 149], [69, 117, 180], [116, 173, 209], [171, 217, 233],
    [224, 243, 248], [254, 224, 144], [253, 174, 97], [244, 109, 67], [215, 48, 39], [165, 0, 38],
  ];
  const u = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(u));
  return mix(stops[i]!, stops[i + 1]!, u - i);
}

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
  owner: Int32Array,
  programs: readonly string[],
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
      `<text x="28" y="${canvas.y + canvas.h + 16}" font-family="sans-serif" font-size="9" fill="#1a202c">${esc(legend.slice(0, 115))}</text>` +
      (legend.length > 115 ? `<text x="28" y="${canvas.y + canvas.h + 28}" font-family="sans-serif" font-size="9" fill="#1a202c">${esc(legend.slice(115))}</text>` : '');
    const svg = svgDoc(1000, 500, body);
    const svgPath = path.join(outDir, `${name}.svg`);
    writeFileSync(svgPath, svg);
    out.push({ svg: svgPath, png: path.join(outDir, `${name}.png`) });
  };

  // 1 — the adjudicated cut-into, coloured per program (the program whose floor owns the cell),
  // with the excluded classes in their own colours.
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
      if (cls === 'adjudicated') return mix(programRgb(owner[k]!), [255, 255, 255], Math.max(0, 0.45 - cells.depth[k]! / 8));
      if (cls === 'rawOnly') return [252, 214, 214];
      return shadeAt;
    },
    `adjudicated cells take the owner program's colour (1..${programs.length} = the panel order in 03-toolpaths; lightening = deeper) · blue = edge break · grey = wall · purple = shadow · pink = raw 0.01–0.10 mm`,
    `adjudicated cells take the OWNER program's colour (>0.10 mm below the goal, the judged floor), lightened with depth; pink = raw cut 0.01–0.10 mm; excluded cells keep their own colour.`,
  );

  // 2 — leftover above the 0.1 mm band, coloured by the program whose floor set the cell's top.
  mapSvg(
    '02-leftover-top',
    (i, j) => {
      const k = j * goal.nx + i;
      if (goal.covered[k] !== 1) return UNCOVERED;
      const left = cells.leftover[k]!;
      if (left > GOAL_LEFTOVER_BANDS_MM[0]!) return mix(programRgb(owner[k]!), [255, 255, 255], Math.max(0, 0.35 - left / 6));
      return COVERED;
    },
    `leftover coloured by the program whose floor set the cell's top (1..${programs.length} = the panel order in 03-toolpaths)`,
    `program-coloured = material standing above the goal by >0.1 mm (max ${report.maxLeftoverMm.toFixed(3)} mm); pale = within the band.`,
  );
  return out;
}

/** A vendor NC as tool runs: `T<n>` switches, every G0/G1 an XY move. The vendor's own frame is
 * stocked top-left 0..length / 0..width (checked on the tray: X −1..111 on a 110 mm stock). */
interface VendorRun {
  tool: number;
  moves: { x: number; y: number; z: number; feed: boolean }[];
}

function parseVendor(ncPath: string): VendorRun[] {
  const runs: VendorRun[] = [];
  let current: VendorRun = { tool: 0, moves: [] };
  runs.push(current);
  let x = 0, y = 0, z = 0;
  for (const raw of readFileSync(ncPath, 'utf8').split('\n')) {
    const line = raw.split(';')[0]!.trim().toUpperCase();
    const tool = /^T(\d+)/.exec(line);
    if (tool !== null) {
      if (current.moves.length > 0) {
        current = { tool: Number(tool[1]), moves: [] };
        runs.push(current);
      } else {
        current.tool = Number(tool[1]);
      }
      continue;
    }
    if (!/^G0?[01]\b/.test(line)) continue;
    const mx = /X(-?\d*\.?\d+)/.exec(line);
    const my = /Y(-?\d*\.?\d+)/.exec(line);
    const mz = /Z(-?\d*\.?\d+)/.exec(line);
    if (mx) x = Number(mx[1]);
    if (my) y = Number(my[1]);
    if (mz) z = Number(mz[1]);
    current.moves.push({ x, y, z, feed: /^G0?1\b/.test(line) });
  }
  return runs.filter((r) => r.moves.length > 0);
}

/** The covered region's boundary, as world segments, so the part outline reads on every panel. */
function outlineSegments(goal: GoalHeightfield): [number, number, number, number][] {
  const segs: [number, number, number, number][] = [];
  const half = goal.pitch / 2;
  for (let j = 0; j < goal.ny; j++) {
    for (let i = 0; i < goal.nx; i++) {
      if (goal.covered[j * goal.nx + i] !== 1) continue;
      const cx = goal.x0 + i * goal.pitch;
      const cy = goal.y0 + j * goal.pitch;
      const open = (ii: number, jj: number): boolean => ii < 0 || jj < 0 || ii >= goal.nx || jj >= goal.ny || goal.covered[jj * goal.nx + ii] !== 1;
      if (open(i, j + 1)) segs.push([cx - half, cy + half, cx + half, cy + half]);
      if (open(i, j - 1)) segs.push([cx - half, cy - half, cx + half, cy - half]);
      if (open(i - 1, j)) segs.push([cx - half, cy - half, cx - half, cy + half]);
      if (open(i + 1, j)) segs.push([cx + half, cy - half, cx + half, cy + half]);
    }
  }
  return segs;
}

function renderToolpaths(
  goal: GoalHeightfield,
  runs: readonly PostedRun[],
  title: string,
  outDir: string,
  vendorPaths: readonly string[],
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
  const outline = outlineSegments(goal);

  // The Z ramp's range spans every drawn move (ours and the vendor's), so the panels compare.
  const vendors = vendorPaths.map((p) => ({ path: p, runs: parseVendor(p) }));
  let zLo = Infinity;
  let zHi = -Infinity;
  const seeZ = (z: number): void => {
    if (z < zLo) zLo = z;
    if (z > zHi) zHi = z;
  };
  for (const run of runs) for (const op of run.ir.operations) for (const m of op.moves) if (m.kind === 'feed') seeZ(m.z);
  for (const v of vendors) for (const r of v.runs) for (const m of r.moves) if (m.feed) seeZ(m.z);
  if (!Number.isFinite(zLo)) { zLo = 0; zHi = 0; }
  const bands = 24;

  type Panel = { label: string; feeds: { x1: number; y1: number; x2: number; y2: number; z: number }[]; rapids: [number, number, number, number][] };
  const panelsData: Panel[] = [];
  for (const run of runs) {
    const feeds: Panel['feeds'] = [];
    const rapids: Panel['rapids'] = [];
    let last: CamMove | null = null;
    for (const op of run.ir.operations) {
      for (const m of op.moves) {
        if (last !== null) {
          const d = Math.hypot(m.x - last.x, m.y - last.y);
          if (d >= 0.25 && feeds.length + rapids.length < 40000) {
            if (m.kind === 'feed') feeds.push({ x1: last.x, y1: last.y, x2: m.x, y2: m.y, z: m.z });
            else rapids.push([last.x, last.y, m.x, m.y]);
          }
        }
        last = m;
      }
    }
    panelsData.push({ label: `ours — ${run.cutterKey}`, feeds, rapids });
  }
  for (const v of vendors) {
    for (const r of v.runs) {
      const feeds: Panel['feeds'] = [];
      const rapids: Panel['rapids'] = [];
      let last: { x: number; y: number; z: number } | null = null;
      for (const m of r.moves) {
        if (last !== null) {
          const d = Math.hypot(m.x - last.x, m.y - last.y);
          if (d >= 0.25) {
            if (m.feed) feeds.push({ x1: last.x, y1: last.y, x2: m.x, y2: m.y, z: m.z });
            else rapids.push([last.x, last.y, m.x, m.y]);
          }
        }
        last = m;
      }
      panelsData.push({ label: `vendor T${r.tool} — ${path.basename(v.path)}`, feeds, rapids });
    }
  }

  const cols = 2;
  const rows = Math.ceil(panelsData.length / cols);
  const panelW = 460;
  const panelH = 300;
  const svgW = 40 + cols * panelW;
  const svgH = 130 + rows * panelH;
  const panels: string[] = [];
  panelsData.forEach((panel, idx) => {
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const canvas = { x: 24 + col * panelW, y: 114 + row * panelH, w: panelW - 40, h: panelH - 70 };
    const fit = fitRect(box, canvas);
    const proj = topProjection(box, canvas);
    const zBand = (z: number): number => Math.max(0, Math.min(bands - 1, Math.round(((z - zLo) / Math.max(zHi - zLo, 1e-9)) * (bands - 1))));
    // Each segment is its own path command pair: a polyline would join the end of one segment
    // to the start of the next and draw lines that are not in the NC.
    const feedBands: string[] = new Array(bands).fill('');
    for (const f of panel.feeds) {
      feedBands[zBand(f.z)] += `M${proj.x(f.x1).toFixed(1)} ${proj.y(f.y1).toFixed(1)}L${proj.x(f.x2).toFixed(1)} ${proj.y(f.y2).toFixed(1)} `;
    }
    let rapidPath = '';
    for (const [x1, y1, x2, y2] of panel.rapids) rapidPath += `M${proj.x(x1).toFixed(1)} ${proj.y(y1).toFixed(1)}L${proj.x(x2).toFixed(1)} ${proj.y(y2).toFixed(1)} `;
    let outlinePath = '';
    for (const [x1, y1, x2, y2] of outline) outlinePath += `M${proj.x(x1).toFixed(1)} ${proj.y(y1).toFixed(1)}L${proj.x(x2).toFixed(1)} ${proj.y(y2).toFixed(1)} `;
    const feedsSvg = feedBands.map((pts, b) => {
      if (pts === '') return '';
      const z = zLo + ((zHi - zLo) * b) / (bands - 1);
      const [r, g, bl] = zRamp(z, zLo, zHi);
      return `<path d="${pts}" fill="none" stroke="rgb(${r},${g},${bl})" stroke-opacity="0.65" stroke-width="0.6"/>`;
    }).join('');
    panels.push(
      `<text x="${canvas.x}" y="${canvas.y - 28}" font-family="sans-serif" font-size="11" font-weight="700" fill="#1a202c">${esc(panel.label)}</text>` +
      `<text x="${canvas.x}" y="${canvas.y - 12}" font-family="sans-serif" font-size="9" fill="#4a5568">${panel.feeds.length} feed · ${panel.rapids.length} rapid segments; colour = Z</text>` +
      `<rect x="${fit.x}" y="${fit.y}" width="${fit.w}" height="${fit.h}" fill="none" stroke="#4a5568"/>` +
      `<image x="${fit.x}" y="${fit.y}" width="${fit.w}" height="${fit.h}" href="data:image/png;base64,${bg}" image-rendering="pixelated"/>` +
      (outlinePath === '' ? '' : `<path d="${outlinePath}" fill="none" stroke="#1a202c" stroke-opacity="0.5" stroke-width="0.7"/>`) +
      (rapidPath === '' ? '' : `<path d="${rapidPath}" fill="none" stroke="#e53e3e" stroke-opacity="0.5" stroke-width="0.5"/>`) +
      feedsSvg,
    );
  });
  // A Z legend built from the same ramp.
  let legend = '';
  for (let b = 0; b < 13; b++) {
    const z = zLo + ((zHi - zLo) * b) / 12;
    const [r, g, bl] = zRamp(z, zLo, zHi);
    legend += `<rect x="${650 + b * 21}" y="72" width="21" height="12" fill="rgb(${r},${g},${bl})"/>`;
  }
  const body =
    `<text x="24" y="24" font-family="sans-serif" font-size="14" font-weight="700" fill="#1a202c">${esc(title)} — posted toolpaths, one panel per program (ours, then the vendor's T runs)</text>` +
    `<text x="24" y="40" font-family="sans-serif" font-size="10" fill="#4a5568">feed moves coloured by Z (shared ramp: ${zLo.toFixed(2)} … ${zHi.toFixed(2)} mm), rapids red, the part's outline black, over the goal's top view</text>` +
    `<text x="650" y="66" font-family="sans-serif" font-size="9" fill="#4a5568">Z ${zLo.toFixed(1)} mm</text>` +
    `<text x="925" y="66" font-family="sans-serif" font-size="9" text-anchor="end" fill="#4a5568">${zHi.toFixed(1)} mm</text>` +
    legend +
    panels.join('');
  const svg = svgDoc(svgW, svgH, body);
  const svgPath = path.join(outDir, '03-toolpaths.svg');
  writeFileSync(svgPath, svg);
  return { svg: svgPath, png: path.join(outDir, '03-toolpaths.png') };
}

/** 06 — the simulated stock after every program: the union sweep's top, coloured by Z. */
function renderStock(
  goal: GoalHeightfield,
  union: Float32Array,
  title: string,
  outDir: string,
): { svg: string; png: string } {
  const { nx, ny, pitch, x0, y0 } = goal;
  const step = Math.max(1, Math.ceil(Math.max(nx, ny) / 760));
  const w = Math.ceil(nx / step);
  const h = Math.ceil(ny / step);
  let lo = Infinity, hi = -Infinity;
  for (let k = 0; k < nx * ny; k++) {
    if (goal.covered[k]! !== 1) continue;
    const v = union[k]!;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const canvas = { x: 28, y: 64, w: 660, h: 430 };
  const fit = fitRect({ x0, x1: x0 + (nx - 1) * pitch, y0, y1: y0 + (ny - 1) * pitch }, canvas);
  const png = pngBase64(w, h, (px, py) => {
    const i = Math.min(nx - 1, px * step);
    const j = Math.min(ny - 1, (h - 1 - py) * step);
    const k = j * nx + i;
    if (goal.covered[k] !== 1) return UNCOVERED;
    const v = union[k]!;
    const c = zRamp(v, lo, hi);
    // a little relief from the union's own gradient
    const right = i + 1 < nx && goal.covered[k + 1] === 1 ? union[k + 1]! : v;
    const shade = Math.max(0.6, Math.min(1, 0.92 - (right - v) * 0.12));
    return [Math.round(c[0] * shade), Math.round(c[1] * shade), Math.round(c[2] * shade)];
  });
  const legend: string[] = [];
  for (let b = 0; b < 13; b++) {
    const z = lo + ((hi - lo) * b) / 12;
    const [r, g, bl] = zRamp(z, lo, hi);
    legend.push(`<rect x="720" y="${canvas.y + 40 + b * 18}" width="16" height="18" fill="rgb(${r},${g},${bl})"/>`);
  }
  const body =
    `<text x="28" y="24" font-family="sans-serif" font-size="14" font-weight="700" fill="#1a202c">${esc(title)} — simulated stock after all programs</text>` +
    `<text x="28" y="42" font-family="sans-serif" font-size="10" fill="#4a5568">union of every posted program's exact sweep, sampled on the goal grid (0.1 mm): top ${hi.toFixed(3)} mm, bottom ${lo.toFixed(3)} mm; stock top 0</text>` +
    `<rect x="${fit.x}" y="${fit.y}" width="${fit.w}" height="${fit.h}" fill="none" stroke="#4a5568"/>` +
    `<image x="${fit.x}" y="${fit.y}" width="${fit.w}" height="${fit.h}" href="data:image/png;base64,${png}" image-rendering="pixelated"/>` +
    `<text x="744" y="${canvas.y + 34}" font-family="sans-serif" font-size="9" fill="#4a5568">Z mm</text>` +
    legend.map((rect, b) => rect + `<text x="740" y="${canvas.y + 54 + b * 18}" font-family="sans-serif" font-size="8" fill="#1a202c">${(lo + ((hi - lo) * b) / 12).toFixed(1)}</text>`).join('');
  const svg = svgDoc(1000, 520, body);
  const svgPath = path.join(outDir, '06-simulated-stock.svg');
  writeFileSync(svgPath, svg);
  return { svg: svgPath, png: path.join(outDir, '06-simulated-stock.png') };
}

interface TreePocketNode {
  id: string; floorZ: number; mouthZ: number; through: boolean;
  region: [number, number][][]; floors: { polygons: [number, number][][] }[];
  islands: { outline: [number, number][][]; topZ: number }[];
  children: TreePocketNode[];
}

/** 07 — the feature tree drawn: floors, islands, contour, rims and remainder (#958). */
function renderTree(
  tree: {
    levels: number[];
    contour: { outline: [number, number][][]; zTo: number; frees: boolean };
    pockets: TreePocketNode[];
    rims: { id: string; polyline: [number, number][]; z: number; of: string; kind: string }[];
    remainder: { id: string; footprint: [number, number][][]; area: number; zTop: number; zBottom: number }[];
  },
  goal: GoalHeightfield,
  title: string,
  outDir: string,
): { svg: string; png: string } {
  const { nx, ny, pitch, x0, y0 } = goal;
  const box: Box = { x0, x1: x0 + (nx - 1) * pitch, y0, y1: y0 + (ny - 1) * pitch };
  const canvas = { x: 60, y: 64, w: 760, h: 500 };
  const proj = topProjection(box, canvas);
  const fit = fitRect(box, canvas);
  const poly = (rings: readonly (readonly [number, number][])[], close = true): string =>
    rings.map((ring) => ring.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${proj.x(x).toFixed(1)} ${proj.y(y).toFixed(1)}`).join('') + (close ? 'Z' : '')).join(' ');
  const parts: string[] = [];
  // remainder first (under everything), then pockets, floors, islands, contour, rims.
  for (const r of tree.remainder) parts.push(`<path d="${poly(r.footprint)}" fill="#4daf4a" fill-opacity="0.18" stroke="#2f7d32" stroke-width="0.8"/>`);
  const drawPocket = (p: TreePocketNode, depth: number): void => {
    const label = p.through ? `${p.id} (through)` : `${p.id} floor ${p.floorZ.toFixed(2)}`;
    parts.push(`<path d="${poly(p.region)}" fill="#377eb8" fill-opacity="${depth === 0 ? 0.10 : 0.16}" stroke="#377eb8" stroke-width="${depth === 0 ? 0.8 : 1.0}"/>`);
    for (const f of p.floors) parts.push(`<path d="${poly(f.polygons)}" fill="#377eb8" fill-opacity="0.35" stroke="none"/>`);
    for (const isl of p.islands) parts.push(`<path d="${poly(isl.outline)}" fill="#ffffff" fill-opacity="0.9" stroke="#718096" stroke-width="0.7"/>`);
    const ring = p.region[0] ?? [];
    const cx = ring.reduce((a, [x]) => a + x, 0) / Math.max(1, ring.length);
    const cy = ring.reduce((a, [, y]) => a + y, 0) / Math.max(1, ring.length);
    parts.push(`<text x="${proj.x(cx).toFixed(1)}" y="${proj.y(cy).toFixed(1)}" text-anchor="middle" font-family="sans-serif" font-size="9" fill="#1a4a7a">${esc(label)}</text>`);
    for (const c of p.children) drawPocket(c, depth + 1);
  };
  for (const p of tree.pockets) drawPocket(p, 0);
  parts.push(`<path d="${poly(tree.contour.outline, false) !== '' ? poly(tree.contour.outline) : ''}" fill="none" stroke="#1a202c" stroke-width="2"/>`);
  for (const r of tree.rims) {
    parts.push(`<path d="${poly([r.polyline], false)}" fill="none" stroke="#e41a1c" stroke-width="1.4"/>`);
  }
  const body =
    `<text x="60" y="24" font-family="sans-serif" font-size="14" font-weight="700" fill="#1a202c">${esc(title)} — the feature tree (#958)</text>` +
    `<text x="60" y="42" font-family="sans-serif" font-size="10" fill="#4a5568">levels ${tree.levels.map((z) => z.toFixed(2)).join(', ')} · ${tree.pockets.length} pockets · ${tree.remainder.length} remainder regions · contour ${tree.contour.frees ? 'frees' : 'does not free'} to ${tree.contour.zTo.toFixed(2)}</text>` +
    `<rect x="${fit.x}" y="${fit.y}" width="${fit.w}" height="${fit.h}" fill="#ffffff" stroke="#4a5568"/>` +
    parts.join('') +
    `<text x="60" y="${canvas.y + canvas.h + 22}" font-family="sans-serif" font-size="9" fill="#1a202c">blue = pocket region, darker blue = floor patches · white = islands · green = remainder · black = contour · red = rims</text>`;
  const svg = svgDoc(1000, 620, body);
  const svgPath = path.join(outDir, '07-feature-tree.svg');
  writeFileSync(svgPath, svg);
  return { svg: svgPath, png: path.join(outDir, '07-feature-tree.png') };
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
// #959 — COVERAGE ATTRIBUTION (ported from f206c538's pass, #959): which op should have cut each
// leftover cell, the three biggest patches, and whether the vendor's own NC cuts them. Measurement
// only; the maps are drawn from the same posted stamp the goal check used. Runs only for plans
// whose dump carries the ops (the ops acceptance); figure plans carry programs only.
// ---------------------------------------------------------------------------------------------

interface PlanOpLike {
  kind: string;
  region?: { id?: string; kind?: string };
  outcome: { ir: ToolpathIR; cutter: string };
}

interface Attribution {
  goalCells: number;
  leftoverCells: number;
  leftoverMm2: number;
  coverageFraction: number;
  /** The cells that must be recovered to reach the line (coverage >= lineFraction), and mm². */
  gap: { lineFraction: number; cells: number; mm2: number };
  ops: { key: string; kind: string; region: string; cutter: string; radius: number; cells: number; mm2: number }[];
  unassigned: { cells: number; mm2: number };
  /** The vendor's stamp over the SAME goal grid: the share of covered cells within the band. */
  vendorOverall: { cutCells: number; cutFraction: number } | null;
  patches: PatchAttribution[];
}

interface PatchAttribution {
  rank: number;
  cells: number;
  mm2: number;
  bbox: [number, number, number, number];
  worst: { x: number; y: number; depth: number };
  ops: { key: string; cells: number; mm2: number }[];
  vendor: { cutFraction: number; tools: { t: number; name: string; cells: number }[] } | null;
}

/** Feed-path sample points per op, bucketed on a coarse XY grid for the nearest-op query. */
function opPathIndex(ops: readonly PlanOpLike[], bucketMm = 2): {
  buckets: Map<string, { op: number; x: number; y: number }[]>;
  info: { key: string; kind: string; region: string; cutter: string; radius: number }[];
} {
  const buckets = new Map<string, { op: number; x: number; y: number }[]>();
  const info: { key: string; kind: string; region: string; cutter: string; radius: number }[] = [];
  const put = (op: number, x: number, y: number): void => {
    const k = `${Math.floor(x / bucketMm)},${Math.floor(y / bucketMm)}`;
    const list = buckets.get(k);
    if (list === undefined) buckets.set(k, [{ op, x, y }]);
    else list.push({ op, x, y });
  };
  ops.forEach((op, index) => {
    const tool = op.outcome.ir.tool;
    const radius = (cuttingDiameter(tool) ?? 0) / 2;
    info.push({ key: `${op.kind}:${op.outcome.cutter}`, kind: op.kind, region: op.region?.id ?? '', cutter: op.outcome.cutter, radius });
    for (const operation of op.outcome.ir.operations) {
      let last: CamMove | null = null;
      for (const m of operation.moves) {
        if (last !== null && m.kind === 'feed') {
          const d = Math.hypot(m.x - last.x, m.y - last.y);
          const steps = Math.max(1, Math.ceil(d / 0.5));
          for (let i = 0; i <= steps; i++) put(index, last.x + ((m.x - last.x) * i) / steps, last.y + ((m.y - last.y) * i) / steps);
        }
        last = m;
      }
    }
  });
  return { buckets, info };
}

/** The nearest op path to a cell, as (distance − the cutter's radius): <= reach means the op's
 * footprint could have touched the cell; beyond it the cell is outside every op's own reach. */
function nearestOp(
  index: ReturnType<typeof opPathIndex>,
  x: number,
  y: number,
  bucketMm = 2,
): { op: number; reach: number } | null {
  const bx = Math.floor(x / bucketMm);
  const by = Math.floor(y / bucketMm);
  let best = Number.POSITIVE_INFINITY;
  let bestOp = -1;
  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = -2; dy <= 2; dy++) {
      for (const p of index.buckets.get(`${bx + dx},${by + dy}`) ?? []) {
        const reach = Math.hypot(p.x - x, p.y - y) - index.info[p.op]!.radius;
        if (reach < best) {
          best = reach;
          bestOp = p.op;
        }
      }
    }
  }
  return bestOp < 0 ? null : { op: bestOp, reach: best };
}

/** The vendor's stamp: its NC parsed and stamped, with the tool identity of every checkpoint. */
function vendorStamp(ncPath: string, goal: GoalHeightfield, sample: PostedRun): { top: ResultTop; who: (x: number, y: number) => number | null; names: Map<number, string> } {
  const text = readFileSync(ncPath, 'utf8');
  const names = new Map<number, string>();
  const tools = new Map<number, Tool>();
  for (const line of text.split('\n')) {
    if (!line.startsWith(';@MKR|TOOL|')) continue;
    const f: Record<string, string> = {};
    for (const part of line.replace(';@MKR|TOOL|', '').split('|')) {
      const at = part.indexOf('=');
      if (at > 0) f[part.slice(0, at).toLowerCase()] = part.slice(at + 1);
    }
    const number = Number(f['number']);
    const type = f['type'] ?? '';
    const shape = type.includes('Ball') ? 'ball' : type.includes('V-Bit') ? 'chamfer' : 'flat';
    const diameter = f['diameter'] === undefined ? null : Number(f['diameter']);
    const statedTip = f['tipdiameter'] === undefined ? null : Number(f['tipdiameter']);
    // The vendor states a ball as diameter + cornerradius with tipdiameter=0; the stamp's cutting
    // diameter for a ball is its diameter, not that zero (a 0 radius stamps nothing).
    const tipDiameter = shape === 'ball' ? diameter : statedTip;
    const tool: Tool = {
      number,
      id: f['id'] ?? null,
      name: f['name'] ?? `T${number}`,
      typeText: type,
      shape,
      handleDiameter: f['handlediameter'] === undefined ? null : Number(f['handlediameter']),
      tipDiameter,
      diameter,
      cornerRadius: f['cornerradius'] === undefined ? null : Number(f['cornerradius']),
      angle: f['angle'] === undefined ? null : Number(f['angle']),
      halfAngle: f['halfangle'] === undefined ? null : Number(f['halfangle']),
      fluteLength: f['flutelength'] === undefined ? null : Number(f['flutelength']),
      shoulderLength: f['shoulderlength'] === undefined ? null : Number(f['shoulderlength']),
      stickout: null,
      centreCutting: true,
    } as Tool;
    tools.set(number, tool);
    names.set(number, tool.name);
  }
  const parsedSample = parseGcode(sample.text);
  const part = setupFromHeader(parsedSample.header).patch.part;
  if (part === undefined || part.kind !== 'prism' || part.outline.kind !== 'p-rect') throw new Error('#959: the posted program carries no rectangular stock header to size the vendor setup');
  const setup = stubSetup(part, { kind: 'tape-down', contact: part.outline }, { startingTool: 1 }, Z1);
  const timeline = buildTimeline(parseGcode(text), setup, Z1);
  const stamp = exactSweptFieldTooled(goal, timeline, (state) => tools.get(state as number) ?? null);
  if (stamp === null) throw new Error(`#959: the vendor NC ${ncPath} produced no stamp`);
  const field = stamp.field;
  const who = stamp.who;
  return {
    top: (x, y) => {
      const i = Math.round((x - goal.x0) / goal.pitch);
      const j = Math.round((y - goal.y0) / goal.pitch);
      if (i < 0 || j < 0 || i >= goal.nx || j >= goal.ny) return null;
      return field[j * goal.nx + i]!;
    },
    who: (x, y) => {
      const i = Math.round((x - goal.x0) / goal.pitch);
      const j = Math.round((y - goal.y0) / goal.pitch);
      if (i < 0 || j < 0 || i >= goal.nx || j >= goal.ny) return null;
      return who[j * goal.nx + i]!;
    },
    names,
  };
}

/** The attribution pass: leftover cells → the nearest op, contiguous patches, vendor coverage. */
function attributeCoverage(
  goal: GoalHeightfield,
  top: ResultTop,
  ops: readonly PlanOpLike[],
  lineFraction: number,
  vendor: { top: ResultTop; who: (x: number, y: number) => number | null; names: Map<number, string> } | null,
): { attribution: Attribution; opOf: Int32Array } {
  const index = opPathIndex(ops);
  const cells = goal.nx * goal.ny;
  const opOf = new Int32Array(cells).fill(-1);
  const leftover = new Uint8Array(cells);
  const depth = new Float32Array(cells);
  let covered = 0;
  let leftoverCells = 0;
  let vendorCutCells = 0;
  for (let j = 0; j < goal.ny; j++) {
    for (let i = 0; i < goal.nx; i++) {
      const k = j * goal.nx + i;
      if (goal.covered[k] !== 1) continue;
      covered++;
      if (vendor !== null) {
        const v = vendor.top(goal.x0 + i * goal.pitch, goal.y0 + j * goal.pitch);
        if (v !== null && v - (goal.z[k] as number) <= GOAL_LEFTOVER_BANDS_MM[0]!) vendorCutCells++;
      }
      const t = top(goal.x0 + i * goal.pitch, goal.y0 + j * goal.pitch);
      if (t === null) continue;
      const d = t - (goal.z[k] as number);
      if (d > GOAL_LEFTOVER_BANDS_MM[0]!) {
        leftover[k] = 1;
        depth[k] = d;
        leftoverCells++;
        const near = nearestOp(index, goal.x0 + i * goal.pitch, goal.y0 + j * goal.pitch);
        if (near !== null && near.reach <= Math.max(1.5, index.info[near.op]!.radius)) opOf[k] = near.op;
      }
    }
  }
  const cellArea = goal.pitch * goal.pitch;
  const opCells = new Map<number, number>();
  let unassigned = 0;
  for (let k = 0; k < cells; k++) {
    if (leftover[k] !== 1) continue;
    if (opOf[k]! >= 0) opCells.set(opOf[k]!, (opCells.get(opOf[k]!) ?? 0) + 1);
    else unassigned++;
  }
  const opsOut = [...opCells.entries()]
    .map(([op, n]) => ({ ...index.info[op]!, cells: n, mm2: n * cellArea }))
    .sort((a, b) => b.cells - a.cells);
  const coverageFraction = covered === 0 ? 0 : 1 - leftoverCells / covered;
  const gapCells = Math.max(0, Math.ceil((lineFraction - coverageFraction) * covered));
  // Contiguous patches, 8-connected, biggest first.
  const seen = new Uint8Array(cells);
  const patches: { cells: number[]; depth: number }[] = [];
  for (let k0 = 0; k0 < cells; k0++) {
    if (leftover[k0] !== 1 || seen[k0] === 1) continue;
    const stack = [k0];
    seen[k0] = 1;
    const members: number[] = [];
    while (stack.length > 0) {
      const k = stack.pop()!;
      members.push(k);
      const i = k % goal.nx;
      const j = (k - i) / goal.nx;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const ii = i + di;
          const jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= goal.nx || jj >= goal.ny) continue;
          const kk = jj * goal.nx + ii;
          if (leftover[kk] === 1 && seen[kk] === 0) {
            seen[kk] = 1;
            stack.push(kk);
          }
        }
      }
    }
    patches.push({ cells: members, depth: Math.max(...members.map((k) => depth[k]!)) });
  }
  patches.sort((a, b) => b.cells.length - a.cells.length);
  const patchOut: PatchAttribution[] = patches.slice(0, 3).map((patch, rank) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let worstK = patch.cells[0]!;
    const counts = new Map<number, number>();
    const vendorWho = new Map<number, number>();
    let vendorCut = 0;
    for (const k of patch.cells) {
      const i = k % goal.nx;
      const j = (k - i) / goal.nx;
      const x = goal.x0 + i * goal.pitch;
      const y = goal.y0 + j * goal.pitch;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      if (depth[k]! > depth[worstK]!) worstK = k;
      const op = opOf[k]!;
      if (op >= 0) counts.set(op, (counts.get(op) ?? 0) + 1);
      if (vendor !== null) {
        const v = vendor.top(x, y);
        if (v !== null && v - (goal.z[k] as number) <= GOAL_LEFTOVER_BANDS_MM[0]!) {
          vendorCut++;
          const t = vendor.who(x, y);
          if (t !== null && t > 0) vendorWho.set(t, (vendorWho.get(t) ?? 0) + 1);
        }
      }
    }
    const j = worstK % goal.nx;
    const jj = (worstK - j) / goal.nx;
    return {
      rank: rank + 1,
      cells: patch.cells.length,
      mm2: patch.cells.length * cellArea,
      bbox: [minX, minY, maxX, maxY],
      worst: { x: goal.x0 + j * goal.pitch, y: goal.y0 + jj * goal.pitch, depth: depth[worstK]! },
      ops: [...counts.entries()].map(([op, n]) => ({ ...index.info[op]!, cells: n, mm2: n * cellArea })).sort((a, b) => b.cells - a.cells),
      vendor:
        vendor === null
          ? null
          : {
              cutFraction: patch.cells.length === 0 ? 0 : vendorCut / patch.cells.length,
              tools: [...vendorWho.entries()].map(([t, n]) => ({ t, name: vendor.names.get(t) ?? `T${t}`, cells: n })).sort((a, b) => b.cells - a.cells),
            },
    };
  });
  return {
    attribution: {
      goalCells: covered,
      leftoverCells,
      leftoverMm2: leftoverCells * cellArea,
      coverageFraction,
      gap: { lineFraction, cells: gapCells, mm2: gapCells * cellArea },
      ops: opsOut,
      unassigned: { cells: unassigned, mm2: unassigned * cellArea },
      vendorOverall: vendor === null ? null : { cutCells: vendorCutCells, cutFraction: covered === 0 ? 0 : vendorCutCells / covered },
      patches: patchOut,
    },
    opOf,
  };
}

/** 08 — the leftover map coloured by the op whose path is nearest, with the gap to the line. */
function renderLeftoverByOp(
  goal: GoalHeightfield,
  cells: Cells,
  opOf: Int32Array,
  index: ReturnType<typeof opPathIndex>,
  attribution: Attribution,
  title: string,
  outDir: string,
): { svg: string; png: string } {
  const step = Math.max(1, Math.ceil(Math.max(goal.nx, goal.ny) / 760));
  const w = Math.ceil(goal.nx / step);
  const h = Math.ceil(goal.ny / step);
  const canvas = { x: 28, y: 44, w: 640, h: 420 };
  const fit = fitRect({ x0: goal.x0, x1: goal.x0 + (goal.nx - 1) * goal.pitch, y0: goal.y0, y1: goal.y0 + (goal.ny - 1) * goal.pitch }, canvas);
  const shade = hillshade(goal);
  const palette = ['#e41a1c', '#377eb8', '#4daf4a', '#984ea3', '#ff7f00', '#a65628', '#f781bf', '#17becf'];
  const keys = [...new Set(attribution.ops.map((o) => o.key))];
  const colorOfKey = new Map(keys.map((k, i) => [k, palette[i % palette.length]!]));
  const opKey = (op: number): string => index.info[op]!.key;
  const rgb = (hex: string): [number, number, number] => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
  const png = pngBase64(w, h, (px, py) => {
    const i = Math.min(goal.nx - 1, px * step);
    const j = Math.min(goal.ny - 1, (h - 1 - py) * step);
    const k = j * goal.nx + i;
    if (goal.covered[k] !== 1) return UNCOVERED;
    if (cells.leftover[k]! <= GOAL_LEFTOVER_BANDS_MM[0]!) return shade(i, j);
    const op = opOf[k]!;
    if (op < 0) return [20, 20, 20];
    return rgb(colorOfKey.get(opKey(op))!);
  });
  const legendRows = keys.map((key, i) => {
    const n = attribution.ops.filter((o) => o.key === key).reduce((sum, o) => sum + o.cells, 0);
    return `<rect x="${700}" y="${canvas.y + 70 + i * 18}" width="10" height="10" fill="${palette[i % palette.length]}"/>` +
      `<text x="716" y="${canvas.y + 79 + i * 18}" font-family="sans-serif" font-size="10" fill="#1a202c">${esc(key)} — ${n} cells (${(n * goal.pitch * goal.pitch).toFixed(1)} mm²)</text>`;
  });
  const body =
    `<text x="28" y="22" font-family="sans-serif" font-size="14" font-weight="700" fill="#1a202c">${esc(title)} — leftover above the 0.1 mm band, by the op whose path is nearest</text>` +
    `<text x="28" y="40" font-family="sans-serif" font-size="10" fill="#4a5568">coloured = leftover cells (one colour per op kind:cutter); black = no op's reach covers the cell (region boundary / reach); pale = within the band</text>` +
    `<rect x="${fit.x}" y="${fit.y}" width="${fit.w}" height="${fit.h}" fill="none" stroke="#4a5568"/>` +
    `<image x="${fit.x}" y="${fit.y}" width="${fit.w}" height="${fit.h}" href="data:image/png;base64,${png}" image-rendering="pixelated"/>` +
    `<text x="700" y="${canvas.y + 14}" font-family="sans-serif" font-size="11" font-weight="700" fill="#1a202c">coverage ${(attribution.coverageFraction * 100).toFixed(2)} %</text>` +
    `<text x="700" y="${canvas.y + 32}" font-family="sans-serif" font-size="10" fill="#4a5568">leftover ${attribution.leftoverCells} cells = ${attribution.leftoverMm2.toFixed(1)} mm²</text>` +
    `<text x="700" y="${canvas.y + 48}" font-family="sans-serif" font-size="10" fill="#4a5568">to reach ${(attribution.gap.lineFraction * 100).toFixed(2)} %: ${attribution.gap.cells} cells = ${attribution.gap.mm2.toFixed(1)} mm²</text>` +
    legendRows.join('') +
    `<rect x="700" y="${canvas.y + 70 + keys.length * 18}" width="10" height="10" fill="#141414"/>` +
    `<text x="716" y="${canvas.y + 79 + keys.length * 18}" font-family="sans-serif" font-size="10" fill="#1a202c">none — ${attribution.unassigned.cells} cells (${attribution.unassigned.mm2.toFixed(1)} mm²)</text>`;
  const svg = svgDoc(1000, 520, body);
  const svgPath = path.join(outDir, '08-leftover-by-op.svg');
  writeFileSync(svgPath, svg);
  return { svg: svgPath, png: path.join(outDir, '08-leftover-by-op.png') };
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const plan = JSON.parse(readFileSync(args.plan, 'utf8')) as {
    perSetup: { programs: ToolpathIR[]; features?: Parameters<typeof renderTree>[0]; ops?: PlanOpLike[] }[];
  };
  const doc = JSON.parse(readFileSync(args.pics, 'utf8')) as PicsDoc;
  const programs = plan.perSetup[0]?.programs ?? [];
  if (programs.length === 0) throw new Error(`${args.plan}: no programs in perSetup[0]`);
  mkdirSync(args.out, { recursive: true });
  const goal = goalOf(doc);
  const runs = postRuns(programs, doc.post);
  const stamps = stampedFields(runs, goal);
  const union = foldFields(stamps);
  const top = topOfField(union.field, goal);
  const owner = ownerField(stamps.map((st) => st.field));
  const whoAt = (x: number, y: number): number | null => {
    const i = Math.round((x - goal.x0) / goal.pitch);
    const j = Math.round((y - goal.y0) / goal.pitch);
    if (i < 0 || j < 0 || i >= goal.nx || j >= goal.ny) return null;
    return union.who[j * goal.nx + i]!;
  };
  const options: GoalCutIntoOptions =
    doc.cutIntoOptions.edgeBreak?.toolNumber === undefined ? doc.cutIntoOptions : { ...doc.cutIntoOptions, whoAt };
  const report = checkGoalCutInto(goal, top, options);
  if (!report.ran) throw new Error(`the goal check did not run: ${report.reason}`);
  const cells = classify(goal, top, report, options, whoAt);
  {
    let over01 = 0, over1 = 0, over10 = 0, maxL = 0, maxAt = '';
    let adj = 0;
    for (let j = 0; j < goal.ny; j++) {
      for (let i = 0; i < goal.nx; i++) {
        const k = j * goal.nx + i;
        if (goal.covered[k]! !== 1) continue;
        const l = cells.leftover[k]!;
        if (l > 0.1) over01++;
        if (l > 1) over1++;
        if (l > 10) over10++;
        if (l > maxL) { maxL = l; maxAt = `(${(goal.x0 + i * goal.pitch).toFixed(1)}, ${(goal.y0 + j * goal.pitch).toFixed(1)})`; (globalThis as Record<string, unknown>)['__maxCell'] = [i, j, goal.z[k], union.field[k], l, CLASS[cells.classOf[k]!]]; }
        if (CLASS[cells.classOf[k]!] === 'adjudicated') adj++;
      }
    }
    process.stdout.write(`leftover: >0.1 mm ${over01} cells · >1 mm ${over1} · >10 mm ${over10} · max ${maxL.toFixed(3)} at ${maxAt} · adjudicated cut-into ${adj} cells\n`);
    process.stdout.write(`max cell raw: ${JSON.stringify((globalThis as Record<string, unknown>)['__maxCell'])}\n`);
  }
  const title = `${doc.card} — ${path.basename(path.dirname(args.plan))}`;
  const stl = Buffer.from(doc.target.data ?? '', 'base64');
  const triangles = stl.length >= 84 ? stl.readUInt32LE(80) : 0;
  process.stdout.write(
    `mesh source: ${doc.target.name}, ${triangles} triangles (the planning mesh the plan was made on) · ` +
      `goal grid ${goal.nx}x${goal.ny} @ ${goal.pitch} mm · stock ${doc.stock.length}x${doc.stock.width}x${doc.stock.thickness} · ` +
      `programs: ${runs.map((r) => r.cutterKey).join(', ')}\n`,
  );
  // Offline data for the zoomed figures (grid, goal, union, posted programs, cell classes).
  writeFileSync(path.join(args.out, 'grid.json'), JSON.stringify({ nx: goal.nx, ny: goal.ny, x0: goal.x0, y0: goal.y0, pitch: goal.pitch }));
  writeFileSync(path.join(args.out, 'classes.u8'), Buffer.from(cells.classOf));
  writeFileSync(path.join(args.out, 'owner.i32'), Buffer.from(owner.buffer, owner.byteOffset, owner.byteLength));
  writeFileSync(path.join(args.out, 'depth.f32'), Buffer.from(cells.depth.buffer, cells.depth.byteOffset, cells.depth.byteLength));
  writeFileSync(path.join(args.out, 'leftover.f32'), Buffer.from(cells.leftover.buffer, cells.leftover.byteOffset, cells.leftover.byteLength));
  {
    const names = ['outside', 'covered', 'adjudicated', 'edgeBreak', 'wall', 'shadow', 'rawOnly'];
    const stats: Record<string, { cells: number; maxMm: number; medianMm: number; over01: number; over05: number }> = {};
    for (let c = 0; c < names.length; c++) {
      const depths: number[] = [];
      for (let k = 0; k < cells.classOf.length; k++) if (cells.classOf[k] === c && cells.depth[k]! > 0) depths.push(cells.depth[k]!);
      depths.sort((a, b) => a - b);
      stats[names[c]!] = {
        cells: depths.length,
        maxMm: depths.length === 0 ? 0 : depths[depths.length - 1]!,
        medianMm: depths.length === 0 ? 0 : depths[Math.floor(depths.length / 2)]!,
        over01: depths.filter((d) => d > 0.1).length,
        over05: depths.filter((d) => d > 0.5).length,
      };
    }
    writeFileSync(path.join(args.out, 'class-depth.json'), JSON.stringify(stats, null, 1));
    process.stdout.write(`class depths: ${JSON.stringify(stats)}\n`);
  }
  writeFileSync(path.join(args.out, 'goal.f32'), Buffer.from(goal.z.buffer, goal.z.byteOffset, goal.z.byteLength));
  writeFileSync(path.join(args.out, 'union.f32'), Buffer.from(union.field.buffer, union.field.byteOffset, union.field.byteLength));
  runs.forEach((run, i) => writeFileSync(path.join(args.out, `program-${i + 1}-${run.cutterKey}.nc`), run.text));
  const files = [
    ...renderMaps(goal, cells, report, owner, runs.map((r) => r.cutterKey), title, args.out),
    renderToolpaths(goal, runs, title, args.out, args.vendor),
    renderStock(goal, union.field, title, args.out),
  ];
  if (plan.perSetup[0]?.features !== undefined) files.push(renderTree(plan.perSetup[0].features, goal, title, args.out));
  const worstCut = worstCell(cells, goal, 'adjudicated') ?? worstCell(cells, goal, 'raw');
  const worstLeft = worstCell(cells, goal, 'left');
  if (worstCut !== null) files.push(renderSection(goal, runs, doc, top, worstCut, 'cut', title, '04-section-worst-cut-into', args.out));
  if (worstLeft !== null) files.push(renderSection(goal, runs, doc, top, worstLeft, 'left', title, '05-section-worst-leftover', args.out));
  // #959 — the coverage attribution (needs the plan's ops; the vendor stamp needs --vendor).
  const ops = plan.perSetup[0]?.ops;
  if (ops !== undefined && ops.length > 0) {
    const vendor = args.vendor.length === 0 ? null : vendorStamp(args.vendor[0]!, goal, runs[0]!);
    const lineFraction = args.line === undefined ? (doc.cutIntoOptions.passCoverage ?? 0.95) : Number(args.line);
    const { attribution, opOf } = attributeCoverage(goal, top, ops, lineFraction, vendor);
    const index = opPathIndex(ops);
    files.push(renderLeftoverByOp(goal, cells, opOf, index, attribution, title, args.out));
    attribution.patches.forEach((patch) => {
      const at = { x: patch.worst.x, y: patch.worst.y, value: patch.worst.depth, cls: 'covered' as CellClass };
      files.push(renderSection(goal, runs, doc, top, at, 'left', `${title} — leftover patch ${patch.rank}`, `09-patch-${patch.rank}-section`, args.out));
    });
    writeFileSync(
      path.join(args.out, `${doc.card}-coverage-attribution.json`),
      JSON.stringify({ card: doc.card, ...attribution }, null, 1),
    );
  }
  // Render every SVG to PNG with the maintainer's Playwright tool.
  for (const f of files) {
    execFileSync(process.execPath, [path.join(process.env.HOME ?? '', 'projects', 'cm-gate2', 'casemaker-app', 'svg2png.tmp.mjs'), f.svg, f.png], { stdio: 'pipe' });
  }
  process.stdout.write(`${files.map((f) => f.png).join('\n')}\n`);
}

main();
