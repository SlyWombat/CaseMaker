/**
 * #961 — THE REST PROGRAM'S MATERIAL MAP. Test-tool, not engine code.
 *
 * The manager's question (2026-11-05): the tray's ⌀3.175 rest costs 4,306 s — nearly the vendor's
 * whole tray — for about 139 mm² recovered. A rest should cut only where the ⌀6 left material:
 * does this one re-cut whole pockets the primary already cleared?
 *
 * This draws the rest program's plan view with each FEED coloured by the material it removes:
 * the as-cut surface before the rest (the primary program's own exact stamp) vs the depth that
 * feed's flat disc reaches at its own Z. Grey = the feed passes over floor the primary already
 * cleared; warm = it removes material above the 0.1 mm band; hot = it removes material that was
 * the goal's own leftover.
 *
 * Inputs (the #959 acceptance's own outputs):
 *   --plan  <run>/<card>-plan.json
 *   --pics  <run>/<card>-pics.json
 *   --rest  <cutterKey>   the rest program to measure (e.g. 111011313825)
 *   --out   <dir>
 *
 * Writes rest-material.svg/.png and rest-material.json (feed length by removal class, cells and
 * mm² recovered, the top leftover patches and which feeds cut them).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { exactSweptFieldTooled } from '@/workers/sim/sweptPoint';
import { parseGcode, setupFromHeader, stubSetup } from '@/engine/cnc';
import { buildTimeline } from '@/engine/cnc/emulator/timeline';
import type { CamMove, ToolpathIR } from '@/engine/cnc/cam/ir';
import { sampleGoalHeightfield, type GoalHeightfield } from '@/engine/cnc/engrave/goalHeightfield';
import { Z1 } from '@/engine/cnc/machine';
import { cuttingDiameter, type Tool } from '@/engine/cnc/tool';
import { postZ1, type PostContext } from '@/engine/cnc/post/z1';
import type { EngraveTargetObject } from '@/types/engraveJob';

const BAND_MM = 0.1;

interface PicsDoc {
  card: string;
  target: EngraveTargetObject;
  stock: { length: number; width: number; thickness: number };
  frame: { stockTop: number; partBottom: number };
  post: PostContext;
}

interface PlanDoc {
  perSetup: { programs?: ToolpathIR[] }[];
}

function parseArgs(argv: readonly string[]): { plan: string; pics: string; rest: string; out: string } {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i]!.replace(/^--/, '')] = argv[i + 1]!;
  if (args.plan === undefined || args.pics === undefined || args.rest === undefined || args.out === undefined) {
    throw new Error('usage: restMaterial.ts --plan <plan.json> --pics <pics.json> --rest <cutterKey> --out <dir>');
  }
  return { plan: args.plan, pics: args.pics, rest: args.rest, out: args.out };
}

function stampOf(ir: ToolpathIR, post: PostContext, goal: GoalHeightfield): Float32Array {
  const posted = postZ1(ir, post, Z1);
  if (!posted.ok) throw new Error(`${ir.tool.name}: postZ1 refused — ${posted.errors.join('; ')}`);
  const parsed = parseGcode(posted.text);
  const part = setupFromHeader(parsed.header).patch.part;
  if (part === undefined || part.kind !== 'prism' || part.outline.kind !== 'p-rect') {
    throw new Error(`${ir.tool.name}: posted text carries no rectangular stock header`);
  }
  const setup = stubSetup(part, { kind: 'tape-down', contact: part.outline }, { startingTool: 1 }, Z1);
  const stamp = exactSweptFieldTooled(goal, buildTimeline(parsed, setup, Z1), () => ir.tool);
  if (stamp === null) throw new Error(`${ir.tool.name}: no exact stamp`);
  return stamp.field;
}

interface Feed {
  cutterKey: string;
  /** Index in the program's flat move list. */
  index: number;
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
  /** Feed length, mm (XY; a plunge has ~0). */
  lengthMm: number;
  /** The XY point of the move's deepest Z (for labelling). */
  z: number;
}

function feedsOf(ir: ToolpathIR): Feed[] {
  let x = 0, y = 0, z = 0;
  const out: Feed[] = [];
  let index = 0;
  for (const op of ir.operations) {
    for (const move of op.moves as CamMove[]) {
      const nx = 'x' in move ? (move.x ?? x) : x;
      const ny = 'y' in move ? (move.y ?? y) : y;
      const nz = 'z' in move ? (move.z ?? z) : z;
      if (move.kind === 'feed') {
        const length = Math.hypot(nx - x, ny - y);
        out.push({ cutterKey: ir.tool.id ?? ir.tool.name, index, ax: x, ay: y, az: z, bx: nx, by: ny, bz: nz, lengthMm: length, z: Math.min(nz, z) });
      }
      x = nx; y = ny; z = nz;
      index++;
    }
  }
  return out;
}

/** Visit every goal cell strictly inside the tool's disc at one point (the caller decides the Z). */
function stampDiscAt(
  goal: GoalHeightfield,
  tool: Tool,
  x: number,
  y: number,
  visit: (i: number, j: number, k: number) => void,
): void {
  const R = (cuttingDiameter(tool) ?? 0) / 2;
  if (!(R > 0)) return;
  const Rin2 = (R - 1e-9) ** 2;
  const iLo = Math.max(0, Math.ceil((x - R - goal.x0) / goal.pitch));
  const iHi = Math.min(goal.nx - 1, Math.floor((x + R - goal.x0) / goal.pitch));
  const jLo = Math.max(0, Math.ceil((y - R - goal.y0) / goal.pitch));
  const jHi = Math.min(goal.ny - 1, Math.floor((y + R - goal.y0) / goal.pitch));
  for (let j = jLo; j <= jHi; j++) {
    const dy = goal.y0 + j * goal.pitch - y;
    for (let i = iLo; i <= iHi; i++) {
      const dx = goal.x0 + i * goal.pitch - x;
      if (dx * dx + dy * dy >= Rin2) continue;
      visit(i, j, j * goal.nx + i);
    }
  }
}

interface Patch {
  cells: number;
  mm2: number;
  bbox: [number, number, number, number];
  gainedByRest: number;
  /** The Z range of the feeds that gained this patch's cells (the depth the rest had to reach). */
  gainZ: [number, number] | null;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const pics = JSON.parse(readFileSync(args.pics, 'utf8')) as PicsDoc;
  const plan = JSON.parse(readFileSync(args.plan, 'utf8')) as PlanDoc;
  const programs = plan.perSetup[0]?.programs ?? [];
  const goal = sampleGoalHeightfield(pics.target, { pitchMm: 0.1, stockTopZ: 0 });
  const cellArea = goal.pitch * goal.pitch;

  const restIndex = programs.findIndex((ir) => (ir.tool.id ?? ir.tool.name) === args.rest);
  if (restIndex < 0) throw new Error(`no program for cutter "${args.rest}" in the plan`);
  const restIr = programs[restIndex]!;
  const restTool = restIr.tool;

  // THE COUNTERFACTUAL: the plan WITHOUT the rest (every other program, in order) — what the card's
  // coverage would be if the picker had declined it. The rest's own material measure is against the
  // surface as it stands WHEN the rest runs (the programs before it), which is what its discs see.
  const fold = (acc: Float32Array | null, field: Float32Array): Float32Array => {
    if (acc === null) return Float32Array.from(field);
    for (let k = 0; k < acc.length; k++) if (field[k]! < acc[k]!) acc[k] = field[k]!;
    return acc;
  };
  let beforeFinal: Float32Array | null = null;
  let beforeRest: Float32Array | null = null;
  for (let i = 0; i < programs.length; i++) {
    if (i === restIndex) continue;
    const field = stampOf(programs[i]!, pics.post, goal);
    beforeFinal = fold(beforeFinal, field);
    if (i < restIndex) beforeRest = fold(beforeRest, field);
  }
  if (beforeFinal === null || beforeRest === null) throw new Error('the rest is the first program — nothing precedes it');
  const restField = stampOf(restIr, pics.post, goal);
  const afterFinal = fold(Float32Array.from(beforeFinal), restField);
  const before = beforeRest; // the surface the rest's discs actually meet

  const beforeLeftover = new Uint8Array(goal.nx * goal.ny);
  let beforeCells = 0;
  let afterCells = 0;
  for (let k = 0; k < afterFinal.length; k++) {
    if (goal.covered[k] !== 1) continue;
    if (beforeFinal[k]! - goal.z[k]! > BAND_MM) { beforeLeftover[k] = 1; beforeCells++; }
    if (afterFinal[k]! - goal.z[k]! > BAND_MM) afterCells++;
  }

  // Per feed: the disc stamp along the move, against the BEFORE surface.
  const feeds = feedsOf(restIr);
  const removedByFeed = new Map<number, { touched: number; removedMm3: number; gainedCells: number; gainedArea: number; maxRemoved: number }>();
  const gainedCells = new Set<number>();
  const gainFeed = new Map<number, number>(); // cell -> feed index that gained it
  for (const feed of feeds) {
    const dx = feed.bx - feed.ax;
    const dy = feed.by - feed.ay;
    const dz = feed.bz - feed.az;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 0.1));
    const stat = { touched: 0, removedMm3: 0, gainedCells: 0, gainedArea: 0, maxRemoved: 0 };
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = feed.ax + dx * t;
      const y = feed.ay + dy * t;
      const z = feed.az + dz * t;
      stampDiscAt(goal, restTool, x, y, (_i, _j, k) => {
        const b = before![k]!;
        if (b > z + 1e-9) {
          const removed = b - z;
          stat.touched++;
          stat.removedMm3 += removed * cellArea;
          if (removed > stat.maxRemoved) stat.maxRemoved = removed;
        }
        if (beforeLeftover[k] === 1 && !gainedCells.has(k)) {
          // The cell ends inside the band in the real plan, and this feed reaches below it: the
          // rest is what buys it back (a cell the ball would have finished anyway is not a gain).
          if (afterFinal[k]! - goal.z[k]! <= BAND_MM && z <= afterFinal[k]! + 1e-6) {
            gainedCells.add(k);
            gainFeed.set(k, feed.index);
            stat.gainedCells++;
            stat.gainedArea += cellArea;
          }
        }
      });
    }
    removedByFeed.set(feed.index, stat);
  }

  // The top leftover patches BEFORE the rest — 8-connected, ranked by area.
  const gainFeedByIndex = new Map(feeds.map((f) => [f.index, f] as const));
  const seen = new Uint8Array(goal.nx * goal.ny);
  const patches: Patch[] = [];
  const stack: number[] = [];
  for (let k0 = 0; k0 < beforeLeftover.length; k0++) {
    if (beforeLeftover[k0] !== 1 || seen[k0] === 1) continue;
    seen[k0] = 1;
    stack.length = 0;
    stack.push(k0);
    let cells = 0;
    let gained = 0;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let zMin = Infinity, zMax = -Infinity;
    while (stack.length > 0) {
      const k = stack.pop()!;
      cells++;
      if (gainedCells.has(k)) {
        gained++;
        const feed = gainFeedByIndex.get(gainFeed.get(k) ?? -1);
        if (feed !== undefined) { zMin = Math.min(zMin, feed.z); zMax = Math.max(zMax, feed.z); }
      }
      const i = k % goal.nx;
      const j = Math.floor(k / goal.nx);
      const x = goal.x0 + i * goal.pitch;
      const y = goal.y0 + j * goal.pitch;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (di === 0 && dj === 0) continue;
          const ni = i + di, nj = j + dj;
          if (ni < 0 || nj < 0 || ni >= goal.nx || nj >= goal.ny) continue;
          const nk = nj * goal.nx + ni;
          if (beforeLeftover[nk] === 1 && seen[nk] === 0) { seen[nk] = 1; stack.push(nk); }
        }
      }
    }
    patches.push({
      cells, mm2: cells * cellArea, bbox: [minX, minY, maxX, maxY], gainedByRest: gained,
      gainZ: gained > 0 && Number.isFinite(zMin) ? [zMin, zMax] : null,
    });
  }
  patches.sort((a, b) => b.cells - a.cells);
  const topPatches = patches.slice(0, 3);

  // Feed length by removal class.
  let feedLength = 0;
  let airLength = 0;
  let bandLength = 0;
  let gainLength = 0;
  for (const feed of feeds) {
    const stat = removedByFeed.get(feed.index)!;
    feedLength += feed.lengthMm;
    if (stat.maxRemoved <= 1e-6) airLength += feed.lengthMm;
    else if (stat.gainedCells === 0) bandLength += feed.lengthMm;
    else gainLength += feed.lengthMm;
  }
  const restMinutes = restIr.operations.reduce((s, op) => s + (op.estimatedSeconds ?? 0), 0) / 60;

  const summary = {
    card: pics.card,
    restCutter: args.rest,
    restProgram: { operations: restIr.operations.length, moves: restIr.operations.reduce((s, op) => s + op.moves.length, 0), feeds: feeds.length, estimateMinutes: restMinutes },
    goalCells: goal.coveredCount,
    /** The plan WITHOUT the rest (the counterfactual) vs the plan as posted. */
    withoutRest: { leftoverCells: beforeCells, leftoverMm2: beforeCells * cellArea, coverage: 1 - beforeCells / goal.coveredCount },
    withRest: { leftoverCells: afterCells, leftoverMm2: afterCells * cellArea, coverage: 1 - afterCells / goal.coveredCount, gainedCells: beforeCells - afterCells, gainedMm2: (beforeCells - afterCells) * cellArea },
    feedLength: {
      totalMm: feedLength,
      overClearedFloorMm: airLength,
      overClearedFloorPct: feedLength > 0 ? (100 * airLength) / feedLength : 0,
      removesMaterialButNoGainMm: bandLength,
      gainsCoverageMm: gainLength,
    },
    topPatches: topPatches.map((p) => ({ ...p, gainedByRest: p.gainedByRest, gainedFraction: p.cells > 0 ? p.gainedByRest / p.cells : 0 })),
  };

  mkdirSync(args.out, { recursive: true });
  writeFileSync(path.join(args.out, 'rest-material.json'), JSON.stringify(summary, null, 1));

  // ---- the picture --------------------------------------------------------------------------
  const widthMm = goal.nx * goal.pitch;
  const heightMm = goal.ny * goal.pitch;
  const S = 5; // px/mm
  const panelW = 330;
  const W = Math.round(widthMm * S) + panelW + 50;
  const H = Math.max(Math.round(heightMm * S) + 60, 420);
  const ox = 25;
  const oy = 40;
  const X = (x: number): number => ox + (x - goal.x0) * S;
  const Y = (y: number): number => oy + (y - goal.y0) * S;

  const feedColour = (feed: Feed): string => {
    const stat = removedByFeed.get(feed.index)!;
    if (stat.gainedCells > 0) return '#c2185b'; // removes goal leftover — the coverage it buys
    if (stat.maxRemoved > BAND_MM) return '#ef6c00'; // removes material, but not goal leftover
    if (stat.maxRemoved > 1e-6) return '#f9a825'; // shaves the band only
    return '#b0bec5'; // over floor the primary already cleared
  };
  const lines: string[] = [];
  for (const feed of feeds) {
    const len = Math.hypot(feed.bx - feed.ax, feed.by - feed.ay);
    if (len < 1e-6) continue;
    lines.push(
      `<line x1="${X(feed.ax).toFixed(1)}" y1="${Y(feed.ay).toFixed(1)}" x2="${X(feed.bx).toFixed(1)}" y2="${Y(feed.by).toFixed(1)}" stroke="${feedColour(feed)}" stroke-width="1" stroke-linecap="round"/>`,
    );
  }
  const patchRects = topPatches.map((p, i) =>
    `<rect x="${X(p.bbox[0]).toFixed(1)}" y="${Y(p.bbox[1]).toFixed(1)}" width="${((p.bbox[2] - p.bbox[0]) * S).toFixed(1)}" height="${((p.bbox[3] - p.bbox[1]) * S).toFixed(1)}" fill="none" stroke="#111" stroke-width="1.2" stroke-dasharray="4 2"/>` +
    `<text x="${X(p.bbox[0]).toFixed(1)}" y="${(Y(p.bbox[1]) - 4).toFixed(1)}" font-family="monospace" font-size="11" fill="#111">${i + 1}</text>`,
  ).join('\n');
  const lx = ox + widthMm * S + 25;
  const legend = [
    `<text x="${lx}" y="60" font-family="monospace" font-size="13" font-weight="bold">${pics.card} — rest feeds by material removed</text>`,
    `<text x="${lx}" y="82" font-family="monospace" font-size="12">rest ${args.rest} (⌀${cuttingDiameter(restTool)}), ${restMinutes.toFixed(0)} min, ${feeds.length} feeds</text>`,
    `<text x="${lx}" y="100" font-family="monospace" font-size="12">before: leftover ${(beforeCells * cellArea).toFixed(2)} mm² (${(100 * (1 - beforeCells / goal.coveredCount)).toFixed(2)} %)</text>`,
    `<text x="${lx}" y="118" font-family="monospace" font-size="12">after the rest alone: ${(afterCells * cellArea).toFixed(2)} mm² (${(100 * (1 - afterCells / goal.coveredCount)).toFixed(2)} %)</text>`,
    `<text x="${lx}" y="136" font-family="monospace" font-size="12">gained ${((beforeCells - afterCells) * cellArea).toFixed(2)} mm² of coverage</text>`,
    `<rect x="${lx}" y="152" width="12" height="12" fill="#c2185b"/><text x="${lx + 18}" y="162" font-family="monospace" font-size="12">removes goal leftover (${(100 * gainLength / feedLength).toFixed(1)} % of feed)</text>`,
    `<rect x="${lx}" y="172" width="12" height="12" fill="#ef6c00"/><text x="${lx + 18}" y="182" font-family="monospace" font-size="12">removes material, no coverage (${(100 * bandLength / feedLength).toFixed(1)} %)</text>`,
    `<rect x="${lx}" y="192" width="12" height="12" fill="#f9a825"/><text x="${lx + 18}" y="202" font-family="monospace" font-size="12">shaves within the band</text>`,
    `<rect x="${lx}" y="212" width="12" height="12" fill="#b0bec5"/><text x="${lx + 18}" y="222" font-family="monospace" font-size="12">cleared floor, removes nothing (${(100 * airLength / feedLength).toFixed(1)} %)</text>`,
    `<text x="${lx}" y="252" font-family="monospace" font-size="12">total feed length ${feedLength.toFixed(0)} mm; nothing removed on</text>`,
    `<text x="${lx}" y="268" font-family="monospace" font-size="12">${airLength.toFixed(0)} mm (${(100 * airLength / feedLength).toFixed(1)} %)</text>`,
    `<text x="${lx}" y="298" font-family="monospace" font-size="12">— top leftover patches before the rest —</text>`,
    ...topPatches.flatMap((p, i) => [
      `<text x="${lx}" y="${316 + i * 30}" font-family="monospace" font-size="12">${i + 1}. ${p.mm2.toFixed(2)} mm² at (${p.bbox[0].toFixed(1)}, ${p.bbox[1].toFixed(1)})–(${p.bbox[2].toFixed(1)}, ${p.bbox[3].toFixed(1)})</text>`,
      `<text x="${lx}" y="${332 + i * 30}" font-family="monospace" font-size="12">   the rest removes it: ${p.gainedByRest}/${p.cells} cells (${(100 * p.gainedByRest / p.cells).toFixed(0)} %)</text>`,
    ]),
  ].join('\n');

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="#ffffff"/>
<rect x="${ox}" y="${oy}" width="${(widthMm * S).toFixed(1)}" height="${(heightMm * S).toFixed(1)}" fill="#f4f4f2" stroke="#999"/>
${lines.join('\n')}
${patchRects}
${legend}
</svg>`;
  const svgPath = path.join(args.out, 'rest-material.svg');
  writeFileSync(svgPath, svg);
  execFileSync(process.execPath, [path.join(process.env.HOME ?? '', 'projects', 'cm-gate2', 'casemaker-app', 'svg2png.tmp.mjs'), svgPath, path.join(args.out, 'rest-material.png')], { stdio: 'pipe' });
  process.stdout.write(`${JSON.stringify(summary, null, 1)}\n`);
}

main();
