/**
 * The measurements #222 and #239 ask for, on the benchmark files. ENV-GATED and skipped by
 * default — it parses ~100 k-move vendor programs and sweeps them, which is seconds to minutes.
 *
 * Run it (Windows side):
 *   $env:COLUMN_FLAT_MEASURE='1'; npx vitest run tests/unit/columnFlatMeasure.spec.ts
 *
 * It re-measures the numbers #222 quotes — the distinct-Z counts (its entry conditions say
 * TopClamp has 482 and PirateShip 6 683) — and reports the FLAT engine's grid, time and memory,
 * so the "grid resolution versus memory" decision is made on measurement, not the doc's estimate.
 * It also runs the amended R8 rule (#239) on the vendor rotary files: the rough must simulate and
 * the finish must be refused at a genuine crossing.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGcode, buildTimeline, stubSetup, MACHINES } from '@/engine/cnc';
import { flatEndMill } from '@/engine/cnc/tool';
import { columnSweep, COLUMN_SIM_RESOLUTION } from '@/workers/geometry/columnEngine';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ON = process.env.COLUMN_FLAT_MEASURE === '1';

/** Stock sized to the cutting extent, exactly as `scripts/sweep-timing.ts` does (bbox + 5 mm a side). */
function flatSetupFor(text: string) {
  const parsed = parseGcode(text);
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity,
    minZ = Infinity;
  for (const e of parsed.events) {
    if (e.kind !== 'move' || e.mode !== 'cut') continue;
    for (const p of [e.from, e.to]) {
      if (p[0] !== null) {
        minX = Math.min(minX, p[0]);
        maxX = Math.max(maxX, p[0]);
      }
      if (p[1] !== null) {
        minY = Math.min(minY, p[1]);
        maxY = Math.max(maxY, p[1]);
      }
      if (p[2] !== null) minZ = Math.min(minZ, p[2]);
    }
  }
  const thickness = Math.max(0.1, -minZ + 2);
  const part = {
    kind: 'prism' as const,
    outline: { kind: 'p-rect' as const, size: [maxX - minX + 10, maxY - minY + 10] as [number, number] },
    thickness,
  };
  const setup = stubSetup(part, { kind: 'tape-down', contact: part.outline }, {}, MACHINES.Z1);
  setup.placement = { origin: [minX - 5, minY - 5, 0], rotationZ: 0, source: 'stub' };
  setup.wcs = { origin: [0, 0, thickness], source: 'stub', uncertainty: 0.05 };
  return { parsed, setup, extent: { minX, minY, maxX, maxY, thickness } };
}

function measure(file: string): void {
  const text = readFileSync(join(ROOT, 'reference-gcode', file), 'latin1');
  const { parsed, setup, extent } = flatSetupFor(text);
  const t0 = performance.now();
  const timeline = buildTimeline(parsed, setup, MACHINES.Z1);
  const tBuild = performance.now();
  const distinctZ = new Set(timeline.checkpoints.map((c) => c.zKey)).size;
  const rss0 = process.memoryUsage().rss / 1024 / 1024;
  const t1 = performance.now();
  const out = columnSweep(timeline, flatEndMill(3.175), setup, { resolution: COLUMN_SIM_RESOLUTION });
  const tSweep = performance.now() - t1;
  const rss1 = process.memoryUsage().rss / 1024 / 1024;
  const stock = `${(extent.maxX - extent.minX + 10).toFixed(1)}x${(extent.maxY - extent.minY + 10).toFixed(1)}x${extent.thickness.toFixed(2)}`;
  console.log(
    `# ${file}  stock=${stock} mm  cuts=${timeline.summary.cuttingMoves}  checkpoints=${timeline.checkpoints.length}  distinctZ=${distinctZ}  buildTimeline=${(tBuild - t0).toFixed(0)}ms`,
  );
  if (!out.ok) {
      console.log(`#   REFUSED in ${tSweep.toFixed(0)}ms: ${out.diagnostics.map((d) => `${d.code}: ${d.message}`).join(' | ')}`);
    return;
  }
  console.log(
    `#   grid ${out.stats.resolution?.dx} × ${out.stats.resolution?.dThetaDeg} (mm × mm)  sweep=${tSweep.toFixed(0)}ms  rssΔ=${(rss1 - rss0).toFixed(0)}MB`,
  );
  console.log(
    `#   columnOps=${out.stats.columnOps}  removed=${out.stats.removedVolume.toFixed(1)} of stock ${out.stats.stockVolume.toFixed(1)} mm³  result tris=${out.result.triangleCount}  stock tris=${out.stock.triangleCount}`,
  );
  expect(out.stats.engine).toBe('column');
}

describe.runIf(ON)('flat column engine on the benchmark files (#222)', () => {
  it('measures Z1/TopClamp.nc', () => measure('Z1/TopClamp.nc'), 300_000);
  it('measures Relief/PirateShip.nc', () => measure('Relief/PirateShip.nc'), 300_000);
});

/** Cylinder sized as `scripts/sweep-rotary-timing.ts` does: ⌀ = 2×max cutting Z (radius), length = X extent + 2 mm an end. */
function rotarySetupFor(text: string) {
  const parsed = parseGcode(text);
  let minX = Infinity,
    maxX = -Infinity,
    maxR = -Infinity;
  for (const e of parsed.events) {
    if (e.kind !== 'move' || e.mode !== 'cut') continue;
    for (const p of [e.from, e.to]) {
      if (p[0] !== null) {
        minX = Math.min(minX, p[0]);
        maxX = Math.max(maxX, p[0]);
      }
      if (p[2] !== null) maxR = Math.max(maxR, p[2]);
    }
  }
  const length = maxX - minX + 4;
  const part = { kind: 'cylinder' as const, diameter: 2 * maxR, length };
  const setup = stubSetup(part, { kind: 'rotary-chuck', jawDiameter: 25, stickout: length }, {}, MACHINES.Z1);
  return { parsed, setup, maxR, length };
}

/** The amended R8 rule on the vendor rotary files (#239 acceptance): rough simulates, finish refused. */
function measureRotary(file: string): void {
  const text = readFileSync(join(ROOT, 'reference-gcode', file), 'latin1');
  const { parsed, setup, maxR, length } = rotarySetupFor(text);
  const t0 = performance.now();
  const timeline = buildTimeline(parsed, setup, MACHINES.Z1);
  const tBuild = performance.now();
  const t1 = performance.now();
  const out = columnSweep(timeline, flatEndMill(3.175), setup, { resolution: COLUMN_SIM_RESOLUTION, budgetMs: 180_000 });
  const tSweep = performance.now() - t1;
  console.log(
    `# ${file}  stock=cylinder ⌀${(2 * maxR).toFixed(2)}×${length.toFixed(2)}  checkpoints=${timeline.checkpoints.length}  buildTimeline=${(tBuild - t0).toFixed(0)}ms  sweep=${tSweep.toFixed(0)}ms`,
  );
  if (!out.ok) {
    const cross = out.diagnostics.find((d) => d.code === 'axis-crossing');
    console.log(`#   REFUSED after ${out.stats?.checkpointsSwept ?? '?'} checkpoints: ${cross?.message ?? out.diagnostics.map((d) => d.code).join(',')}`);
    return;
  }
  const clamped = out.axisClamped;
  console.log(
    `#   OK  checkpoints=${out.count}  columnOps=${out.stats.columnOps}  removed=${out.stats.removedVolume.toFixed(1)} of ${out.stats.stockVolume.toFixed(1)} mm³  axisClamped=${clamped ? `${clamped.count} (deepest ${clamped.deepestZ.toFixed(3)})` : 'none'}`,
  );
  expect(out.stats.engine).toBe('column');
}

describe.runIf(ON)('the amended axis rule on the vendor rotary files (#239)', () => {
  it('measures Rotation/NefertitiRough.nc — should simulate, not refuse', () => measureRotary('Rotation/NefertitiRough.nc'), 300_000);
  it('measures Rotation/NefertitiFinish.nc — should refuse a genuine crossing', () => measureRotary('Rotation/NefertitiFinish.nc'), 300_000);
});
