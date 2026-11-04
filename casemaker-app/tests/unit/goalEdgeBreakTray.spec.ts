// #955/V2-2 — THE EDGE-BREAK ALLOWANCE, RED-FIRST ON MAKERA'S TRAY NC.
//
// E's checker scored Makera's own tray program on the app's goal grid:
//   cutIntoInclEdgePct (0.01 floor before exclusions)  ~2.6 %
//   edgeBreakPct                                       ~3.66 %
//   cutInto0p1Pct (after edge break / wall / shadow)   0 %
// The app's goal check now applies the same rule. The references are LOCAL
// (`.scratch/makerables`, CC BY-NC-SA, evaluation only) and skipped when absent or when a file's
// sha256 has moved — the committed artefact is the rule and its expectations, never the data.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { expect, it } from 'vitest';

import { checkGoalCutInto } from '@/engine/cnc/engrave/designCheck';
import type { GoalHeightfield } from '@/engine/cnc/engrave/goalHeightfield';
import { buildTimeline, parseGcode, stubSetup } from '@/engine/cnc';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { exactSweptFieldTooled } from '@/workers/sim/sweptPoint';

const ROOT = process.env.CM_MAKERABLES ?? path.resolve(process.cwd(), '..', '.scratch/makerables');
const HF = path.join(ROOT, 'hf');
const RUN = path.join(ROOT, 'runs', 'tray70-top-dz1.2');

/** The files this test read; sha256 recorded when it was written, so a stale tree skips. */
const FILES = {
  goalBin: [path.join(HF, 'tray70-top.bin'), '3303432d0e7eba0a219cd5305c28102c0cc1151b9aa533f39a6cb3b1d94b6f91'],
  goalCov: [path.join(HF, 'tray70-top.cov'), '03f8f7a9a1fd9bc700d4185625bb3124f756c97d9fa0371d248f79d55cc45975'],
  goalMeta: [path.join(HF, 'tray70-top.json'), '42394bab61d9fe3a1508bab3b9a126bd3bd1232da2b4d93bca6a5ca425b9f04f'],
  swept: [path.join(RUN, 'goalcheck.npy'), '9e29b40aed3c3476ace5a2cefbb021ca8f2737bcb8321af9cf6aa11db75d299e'],
  checked: [path.join(RUN, 'goalcheck.json'), '5659b52d71da69d0b50a08e9b3c505dd98934dfba3847eb8f9cf5c2d5bbcc0ea'],
  // #964 — the vendor NC itself, for the per-cell `who` map (the vendor runs four cutters).
  nc: [path.join(ROOT, 'dl', 'modular-stackable-tool-trays', 'Tool_Tray_70mm_Top-msfi5w1b.nc'), '67c2d2f9f3536ecc93fdfa7e67fb94c9826ef674bf3b8a1e85ce2795aae482ab'],
} as const;

function sha(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

const usable = Object.values(FILES).every(([file, hash]) => existsSync(file) && sha(file) === hash);
const maybe = usable ? it : it.skip;

interface Meta {
  nx: number;
  ny: number;
  x0: number;
  y0: number;
  pitch: number;
  topZ: number;
  minZ: number;
  coveredCount: number;
}

/** A minimal `.npy` reader: little-endian float32/float64, C order (the checker's own `save`). */
function readNpy(file: string): { shape: [number, number]; data: Float64Array } {
  const buf = readFileSync(file);
  if (buf.toString('latin1', 0, 6) !== '\x93NUMPY') throw new Error('not a .npy file');
  const major = buf[6]!;
  const headerLen = major === 1 ? buf.readUInt16LE(8) : buf.readUInt32LE(8);
  const headerStart = major === 1 ? 10 : 12;
  const header = buf.toString('latin1', headerStart, headerStart + headerLen);
  const descr = /'descr':\s*'([^']+)'/.exec(header)?.[1];
  const shape = /'shape':\s*\(([^)]*)\)/.exec(header)?.[1]?.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
  if ((descr !== '<f4' && descr !== '<f8') || shape?.length !== 2) throw new Error(`unsupported .npy ${descr} ${header}`);
  const [ny, nx] = shape as [number, number];
  const start = headerStart + headerLen;
  const bytes = descr === '<f8' ? nx * ny * 8 : nx * ny * 4;
  const slice = buf.buffer.slice(buf.byteOffset + start, buf.byteOffset + start + bytes);
  const data = descr === '<f8' ? new Float64Array(slice) : Float64Array.from(new Float32Array(slice));
  return { shape: [ny, nx], data };
}

/** The vendor NC's own tool records (`;@MKR|TOOL|…`), as Tool objects the stamp can use. */
function vendorTools(ncText: string): Map<number, Tool> {
  const out = new Map<number, Tool>();
  for (const line of ncText.split('\n')) {
    const m = /^;@MKR\|TOOL\|(.*)$/.exec(line.trim());
    if (m === null) continue;
    const kv = new Map<string, string>();
    for (const part of m[1]!.split('|')) {
      const i = part.indexOf('=');
      if (i > 0) kv.set(part.slice(0, i), part.slice(i + 1));
    }
    const number = Number(kv.get('number'));
    if (!Number.isFinite(number)) continue;
    const name = kv.get('name') ?? `tool ${number}`;
    const diameter = Number(kv.get('diameter') ?? kv.get('handlediameter') ?? 0);
    const type = kv.get('type') ?? '';
    const flute = Number(kv.get('flutelength') ?? 0);
    const base = { number, name, fluteLength: Number.isFinite(flute) && flute > 0 ? flute : null };
    if (type === 'Ball Nose') {
      out.set(number, flatEndMill(diameter, { ...base, shape: 'ball', typeText: type, tipDiameter: diameter }));
    } else if (type === 'V-Bit') {
      const angle = Number(kv.get('angle') ?? 90);
      out.set(number, flatEndMill(diameter, {
        ...base, shape: 'chamfer', typeText: type,
        tipDiameter: Number(kv.get('tipdiameter') ?? 0), angle, halfAngle: angle / 2,
      }));
    } else {
      out.set(number, flatEndMill(diameter, { ...base }));
    }
  }
  return out;
}

maybe('the app’s rule passes the tray: 6.85 % raw, 0 adjudicated, edge break at least E’s 3.66 %', () => {
  const meta: Meta = JSON.parse(readFileSync(FILES.goalMeta[0], 'utf8'));
  // The checker's run placed the goal `dz = 1.2` below the stock top (`goalMinZ −7.2`).
  const DZ = 1.2;
  const bin = new Float32Array(readFileSync(FILES.goalBin[0]).buffer.slice(0));
  const goalZ = new Float32Array(bin.length);
  for (let k = 0; k < bin.length; k++) goalZ[k] = bin[k]! - DZ;
  const covered = new Uint8Array(readFileSync(FILES.goalCov[0]));
  const goal: GoalHeightfield = {
    nx: meta.nx,
    ny: meta.ny,
    x0: meta.x0,
    y0: meta.y0,
    pitch: meta.pitch,
    topZ: meta.topZ,
    minZ: meta.minZ - DZ,
    z: goalZ,
    covered,
    coveredCount: meta.coveredCount,
    resolutionNote: 'tray reference',
  };
  const swept = readNpy(FILES.swept[0]);
  expect(swept.shape).toEqual([meta.ny, meta.nx]);
  const top = (x: number, y: number): number | null => {
    const i = Math.round((x - meta.x0) / meta.pitch);
    const j = Math.round((y - meta.y0) / meta.pitch);
    if (i < 0 || j < 0 || i >= meta.nx || j >= meta.ny) return null;
    return swept.data[j * meta.nx + i]!;
  };

  // E's checker (goal_check.py, 30da03b6) on this NC, goal and dz:
  //   cutIntoInclEdgePct 6.85 · edgeBreakPct 3.66 · cutInto0p1Pct 0 · wall 0.30 · shadow 2.45
  // The 90° chamfer's header: diameter 3.175 (the cone's outer end), tip 0.1, angle 90° → reach
  // 1.5875 mm, leg (1.5875 − 0.05)/tan45° = 1.5375 mm (the checker's own leg reads 1.538). The
  // widest cutting tool is the ⌀6 flat/ball → the wall shadow is 3 mm.
  const r = checkGoalCutInto(goal, top, {
    edgeBreak: { reachMm: 3.175 / 2, legMm: (3.175 / 2 - 0.1 / 2) / Math.tan(Math.PI / 4) },
    wallShadowRadiusMm: 3,
  });

  expect(r.cutIntoFraction * 100).toBeCloseTo(6.85, 1);
  // Without the `who` rule the allowance excuses cells on geometry alone: every cell within the
  // V's reach and leg, whichever cutter took it deepest. That reads ~4.95 %, an upper bound.
  expect(r.edgeBreakFraction * 100).toBeGreaterThan(4.5);
  expect(r.edgeBreakFraction * 100).toBeLessThan(5.2);
  expect(r.adjudicatedFraction * 100).toBeCloseTo(0, 6);
  expect(r.wallNotScoredFraction).toBeGreaterThan(0);
  expect(r.shadowNotScoredFraction).toBeGreaterThan(0);
  // The rule's point: the vendor's own program passes line 2 once its rim break is allowed.
  expect(r.ok).toBe(true);

  // #964 — THE PAGE'S `who` RULE. E's 3.66 % excuses a cell only where the DEEPEST stamp in it
  // is the V bit. The vendor NC runs four cutters (⌀6 flat, ⌀3.175 flat, ⌀6 ball, ⌀3.175 90°
  // chamfer); stamping each checkpoint with the tool it actually ran gives that per-cell identity.
  const ncText = readFileSync(FILES.nc[0], 'utf8');
  const tools = vendorTools(ncText);
  const slab = { kind: 'prism' as const, outline: { kind: 'p-rect' as const, size: [110, 140] as [number, number] }, thickness: 27.2 };
  const timeline = buildTimeline(parseGcode(ncText), stubSetup(slab, { kind: 'tape-down', contact: slab.outline }));
  const stamp = exactSweptFieldTooled(goal, timeline, (t) => (typeof t === 'number' ? tools.get(t) ?? null : null));
  expect(stamp).not.toBeNull();
  const who = (stamp as NonNullable<typeof stamp>).who;
  const whoAt = (x: number, y: number): number | null => {
    const i = Math.round((x - meta.x0) / meta.pitch);
    const j = Math.round((y - meta.y0) / meta.pitch);
    if (i < 0 || j < 0 || i >= meta.nx || j >= meta.ny) return null;
    return who[j * meta.nx + i]!;
  };
  const gated = checkGoalCutInto(goal, top, {
    edgeBreak: { reachMm: 3.175 / 2, legMm: (3.175 / 2 - 0.1 / 2) / Math.tan(Math.PI / 4), toolNumber: 4 },
    whoAt,
    wallShadowRadiusMm: 3,
  });
  // E's own reading on this NC: edgeBreakPct 3.66, cutInto0p1Pct 0.
  expect(gated.edgeBreakFraction * 100).toBeGreaterThan(3.5);
  expect(gated.edgeBreakFraction * 100).toBeLessThan(3.85);
  expect(gated.adjudicatedFraction * 100).toBeCloseTo(0, 6);
  expect(gated.ok).toBe(true);
});
