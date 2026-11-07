/** SCRATCH (6b's #955 item 1) — the app-engine goal check on the tape card's posted NCs, with the
 * reproduced leftover cells binned against the page's goal.bin. Not committed. */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

import { sampleGoalHeightfield } from '@/engine/cnc/engrave/goalHeightfield';
import { checkGoalCutInto } from '@/engine/cnc/engrave/designCheck';
import { parseGcode, setupFromHeader, stubSetup } from '@/engine/cnc';
import { buildTimeline } from '@/engine/cnc/emulator/timeline';
import { exactSweptFieldTooled } from '@/workers/sim/sweptPoint';
import { Z1 } from '@/engine/cnc/machine';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';

const RUN = process.env.TAPE_RUN!;

function toolFromHeader(rec: Record<string, string>): Tool {
  const num = (k: string): number => Number(rec[k] ?? 0);
  const type = rec['type'] ?? '';
  const shape = /ball/i.test(type) ? 'ball' : 'flat';
  const d = num('diameter');
  const tip = num('tipdiameter') || d;
  const base = flatEndMill(shape === 'ball' ? tip : d, {
    number: num('number') || 1,
    id: rec['id'] || null,
    name: rec['name'] ?? 'program cutter',
    fluteLength: num('flutelength') || null,
  });
  return shape === 'ball'
    ? { ...base, typeText: 'Ball Nose', shape: 'ball', diameter: d, tipDiameter: tip, cornerRadius: tip / 2 }
    : base;
}

const job = JSON.parse(readFileSync(`${RUN}/job.json`, 'utf8'));
const target = job.targetObject;
const field = sampleGoalHeightfield(target, { pitchMm: 0.1, stockTopZ: 0 });
const { nx, ny, pitch, x0, y0 } = field;
console.log(`app grid: nx ${nx} ny ${ny} pitch ${pitch} origin (${x0}, ${y0}) z ${field.minZ}..${field.stockTopZ ?? '?'}`);

let acc: Float32Array | null = null;
let who: Uint8Array | null = null;
const ncs = readdirSync(RUN).filter((f) => f.endsWith('.nc')).sort();
const perProgram: { file: string; cutter: string; ownLeftover: number | null }[] = [];
for (const file of ncs) {
  const text = readFileSync(`${RUN}/${file}`, 'utf8');
  const parsed = parseGcode(text);
  const part = setupFromHeader(parsed.header).patch.part;
  if (part === undefined || part.kind !== 'prism' || part.outline.kind !== 'p-rect') throw new Error(`${file}: no rect stock header`);
  const setup = stubSetup(part, { kind: 'tape-down', contact: part.outline }, { startingTool: 1 }, Z1);
  const toolRec = (parsed.header?.records ?? []).find((r: { tag: string }) => r.tag === 'TOOL');
  const tool = toolFromHeader((toolRec?.fields ?? {}) as Record<string, string>);
  const timeline = buildTimeline(parsed, setup, Z1);
  const stamp = exactSweptFieldTooled(field, timeline, () => tool);
  if (stamp === null) throw new Error(`${file}: no stamp`);
  // This program ALONE vs the goal: what it reports when it does not carry the earlier removal.
  const ownTop = (x: number, y: number): number | null => {
    const i = Math.round((x - x0) / pitch);
    const j = Math.round((y - y0) / pitch);
    if (i < 0 || j < 0 || i >= nx || j >= ny) return null;
    return stamp.field[j * nx + i]!;
  };
  const ownWho = (x: number, y: number): number | null => {
    const i = Math.round((x - x0) / pitch);
    const j = Math.round((y - y0) / pitch);
    if (i < 0 || j < 0 || i >= nx || j >= ny) return null;
    return stamp.who[j * nx + i]!;
  };
  const own = checkGoalCutInto(field, ownTop, { passCoverage: 0.95, whoAt: ownWho });
  perProgram.push({ file, cutter: tool.name, ownLeftover: own.leftoverFractions[0] ?? null });
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
const gridTop = acc!;
const identity = who!;
const top = (x: number, y: number): number | null => {
  const i = Math.round((x - x0) / pitch);
  const j = Math.round((y - y0) / pitch);
  if (i < 0 || j < 0 || i >= nx || j >= ny) return null;
  return gridTop[j * nx + i]!;
};
const whoAt = (x: number, y: number): number | null => {
  const i = Math.round((x - x0) / pitch);
  const j = Math.round((y - y0) / pitch);
  if (i < 0 || j < 0 || i >= nx || j >= ny) return null;
  return identity[j * nx + i]!;
};
const report = checkGoalCutInto(field, top, { passCoverage: 0.95, whoAt });

// The page's grid for the class binning.
const pg = JSON.parse(readFileSync(`${RUN}/goal.json`, 'utf8'));
const goalBin = new Float32Array(readFileSync(`${RUN}/goal.bin`).buffer.slice(0));
const cov = new Uint8Array(readFileSync(`${RUN}/goal.cov`).buffer.slice(0));
const pNx = pg.nx;
const pNy = pg.ny;
const pX0 = pg.x0;
const pY0 = pg.y0;
const pPitch = pg.pitch;
let topFace = 0, floor = 0, outside = 0, unmatched = 0;
let leftoverCells = 0;
for (let j = 0; j < ny; j++) {
  for (let i = 0; i < nx; i++) {
    const k = j * nx + i;
    if (field.covered[k] !== 1) continue;
    const t = gridTop[k]!;
    const g = field.z[k]!;
    if (t - g <= 0.1) continue;
    leftoverCells++;
    const x = x0 + i * pitch;
    const y = y0 + j * pitch;
    const pi = Math.round((x - pX0) / pPitch);
    const pj = Math.round((y - pY0) / pPitch);
    if (pi < 0 || pj < 0 || pi >= pNx || pj >= pNy) { unmatched++; continue; }
    const pk = pj * pNx + pi;
    if (cov[pk] !== 1) outside++;
    else if (Math.abs(goalBin[pk]!) < 1e-9) topFace++;
    else floor++;
  }
}
const share = (n: number): string => `${((100 * n) / Math.max(leftoverCells, 1)).toFixed(2)} %`;
const out = {
  appGrid: { nx, ny, pitch, x0, y0, minZ: field.minZ },
  report: {
    leftoverFractions: report.leftoverFractions,
    cutIntoFraction: report.cutIntoFraction,
    adjudicatedFraction: report.adjudicatedFraction,
    passCoverage: report.passCoverage,
  },
  leftoverCells,
  perProgram,
  lastProgram: perProgram[perProgram.length - 1] ?? null,
  bins: { topFace, floor, outside, unmatched },
  shares: { topFace: share(topFace), floor: share(floor), outside: share(outside), unmatched: share(unmatched) },
};
writeFileSync('/tmp/tape-goal-repro.json', JSON.stringify(out, null, 1));
console.log(JSON.stringify(out));
