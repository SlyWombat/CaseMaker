/**
 * Rotary column-engine probe — #239 R-2 ("write the probe script FIRST and measure
 * `/Rotary.md` §4.4's estimates rather than trusting them").
 *
 * Usage (from `casemaker-app/`):
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/sweep-rotary-timing.ts <file> [flags]
 *
 * Phase 1 (this file, characterisation) parses and runs a vendor rotary program through the
 * EXISTING pipeline (parse → buildTimeline → cylinder setup) and prints what the engine will
 * actually see: the resolved work-frame Z (= radius from the axis, R6) of every cutting move,
 * the first move whose tip reaches Z ≤ 0 (the `axis-crossing` trigger, R8), the A range, the
 * checkpoint count, and the memory the timeline alone costs.
 *
 * Phase 2 (the column engine) is appended once the engine exists: it runs `columnSweep`,
 * prints its stats/peak memory, and the analytic-oracle check.
 *
 * `<file>` is a name under `reference-gcode/` (e.g. `Rotation/NefertitiRough.nc`) or a path.
 *
 * Stock: a CYLINDER (R6 work frame — origin on the axis, Z = radius). Diameter/length default
 * to the file's cutting extent unless `--diameter`/`--length` are given:
 *   - length = cutting X extent + `--end-allow` mm each end (default 2),
 *   - diameter = 2 × the LARGEST cutting Z (radius) — the outermost radius the program touches,
 *     which is the smallest stock the program fits. This is the doc's ⌀44 for the Nefertiti
 *     files (first roughing pass at Z 22) and is reported with its source.
 */
import { existsSync, readFileSync } from 'node:fs';

interface Args {
  file: string;
  diameter: number | null;
  length: number | null;
  endAllow: number;
  tool: number;
  machine: string;
}

const CORPUS = 'reference-gcode';

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let diameter: number | null = null;
  let length: number | null = null;
  let endAllow = 2;
  let tool = 3.175;
  let machine = 'Z1';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const num = (v: string | undefined): number => {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error(`expected a number, got "${v}"`);
      return n;
    };
    if (a === '--diameter') diameter = num(argv[++i]);
    else if (a.startsWith('--diameter=')) diameter = num(a.slice('--diameter='.length));
    else if (a === '--length') length = num(argv[++i]);
    else if (a.startsWith('--length=')) length = num(a.slice('--length='.length));
    else if (a === '--end-allow') endAllow = num(argv[++i]);
    else if (a.startsWith('--end-allow=')) endAllow = num(a.slice('--end-allow='.length));
    else if (a === '--tool') tool = num(argv[++i]);
    else if (a.startsWith('--tool=')) tool = num(a.slice('--tool='.length));
    else if (a === '--machine') machine = argv[++i] as string;
    else if (a.startsWith('--machine=')) machine = a.slice('--machine='.length);
    else positional.push(a);
  }
  const file = positional[0];
  if (!file) throw new Error('usage: sweep-rotary-timing.ts <file> [--diameter D] [--length L] [--end-allow E] [--tool D] [--machine Z1|none]');
  return { file, diameter, length, endAllow, tool, machine };
}

function resolveCorpusPath(file: string): string {
  if (existsSync(file)) return file;
  const under = `${CORPUS}/${file}`;
  if (existsSync(under)) return under;
  throw new Error(`file not found: "${file}" (also tried "${under}" from ${process.cwd()})`);
}

const rssMb = (): number => process.memoryUsage().rss / 1024 / 1024;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const path = resolveCorpusPath(args.file);

  const { parseGcode, buildTimeline, stubSetup, MACHINES } = await import('@/engine/cnc');
  const { flatEndMill } = await import('@/engine/cnc/tool');
  const machine = args.machine === 'none' ? undefined : MACHINES[args.machine];
  if (args.machine !== 'none' && !machine) throw new Error(`unknown machine "${args.machine}"; known: ${Object.keys(MACHINES).join(', ')}`);

  const text = readFileSync(path, 'latin1');
  const t0 = performance.now();
  const parsed = parseGcode(text);

  // Cutting extent from the PARSER's events (before the runner), to size the cylinder.
  let minX = Infinity, maxX = -Infinity, maxR = -Infinity, minR = Infinity;
  let cuts = 0;
  for (const e of parsed.events) {
    if (e.kind !== 'move' || e.mode !== 'cut') continue;
    cuts++;
    for (const p of [e.from, e.to]) {
      if (p[0] !== null) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); }
      if (p[2] !== null) { maxR = Math.max(maxR, p[2]); minR = Math.min(minR, p[2]); }
    }
  }
  if (cuts === 0) throw new Error(`${path}: no cutting moves found`);
  const diameter = args.diameter ?? 2 * maxR;
  const length = args.length ?? (maxX - minX) + 2 * args.endAllow;
  const part = { kind: 'cylinder' as const, diameter, length };
  const setup = stubSetup(part, { kind: 'rotary-chuck', jawDiameter: 25, stickout: length }, {}, machine);
  const tool = flatEndMill(args.tool);

  const tSetup = performance.now();
  const timeline = buildTimeline(parsed, setup, machine);
  const tBuild = performance.now();

  const cp = timeline.checkpoints;
  const distinctZ = new Set(cp.map((c) => c.zKey)).size;
  // First cutting move whose resolved work Z (= radius) reaches ≤ 0: the R8 trigger.
  let firstCross: { step: number; line: number; z: number } | null = null;
  let crossingMoves = 0;
  for (const c of cp) {
    for (let i = 0; i < c.steps.length; i++) {
      const z0 = c.zs[i * 2] as number;
      const z1 = c.zs[i * 2 + 1] as number;
      const z = Math.min(z0, z1);
      if (z <= 0) {
        crossingMoves++;
        if (!firstCross) {
          const step = c.steps[i] as number;
          const ev = timeline.events[step];
          firstCross = { step, line: ev?.line ?? -1, z };
        }
      }
    }
  }

  // A range from the runner's state at each cutting step (unwound, Float64 in JS).
  let aMin = Infinity, aMax = -Infinity;
  for (const c of cp) for (const s of c.steps) {
    const st = timeline.stateAt(s);
    if (st.a !== null) { aMin = Math.min(aMin, st.a); aMax = Math.max(aMax, st.a); }
  }

  console.log(`# file=${path}`);
  console.log(`# parse=${(tSetup - t0).toFixed(0)}ms  buildTimeline=${(tBuild - tSetup).toFixed(0)}ms  rss=${rssMb().toFixed(0)}MB`);
  console.log(`# stock(cylinder ⌀${diameter.toFixed(2)} × ${length.toFixed(2)} mm)  diameter source=${args.diameter === null ? `2×max cutting Z (${maxR.toFixed(2)})` : 'flag'}  length source=${args.length === null ? 'cutting X extent + allow' : 'flag'}`);
  console.log(`# tool=⌀${args.tool} flat  machine=${args.machine}`);
  console.log(`# summary: cuts=${timeline.summary.cuttingMoves} rotary=${timeline.summary.rotary} laser=${timeline.summary.laser} unswept=${timeline.summary.unsweptMoves} airMoves=${timeline.summary.airMoves}`);
  console.log(`# checkpoints=${cp.length}  distinctZ(cut)=${distinctZ}  MAX_CHECKPOINTS=1000  exceeds=${cp.length > 1000}`);
  console.log(`# cutting Z (radius) range = ${minR.toFixed(3)} … ${maxR.toFixed(3)} mm   A range = ${aMin.toFixed(2)} … ${aMax.toFixed(2)}°`);
  console.log(`# cutting moves reaching Z ≤ 0: ${crossingMoves}${firstCross ? `  FIRST at step ${firstCross.step}, line ${firstCross.line}, Z=${firstCross.z.toFixed(3)}` : ''}`);
  const diag = timeline.diagnostics.filter((d) => d.severity === 'error');
  console.log(`# timeline diagnostics: ${timeline.diagnostics.length} (${diag.length} error)`);

  // ---------------------------------------------------------------------------------------
  // Phase 2 (#239): run the column engine itself, at the strict R8 rule and at the relaxed
  // reading, so both the acceptance numbers and the refusal are measured rather than assumed.
  // ---------------------------------------------------------------------------------------
  const { columnSweep } = await import('@/workers/geometry/columnEngine');
  if (timeline.summary.rotary) {
    for (const [label, tol] of [
      ['strict (R8, tol 0)', 0],
      [`relaxed (tol = tool radius ${(args.tool / 2).toFixed(4)} mm)`, args.tool / 2],
    ] as const) {
      const before = rssMb();
      const t0e = performance.now();
      const res = columnSweep(timeline, tool, setup, { axisToleranceMm: tol });
      const ms = performance.now() - t0e;
      const rss = rssMb();
      if (!res.ok) {
        const first = res.diagnostics.find((d) => d.code === 'axis-crossing');
        console.log(`# column[${label}]: REFUSED after ${res.stats?.checkpointsSwept ?? '?'} checkpoints in ${ms.toFixed(0)}ms  rssΔ=${(rss - before).toFixed(0)}MB`);
        if (first) console.log(`#   ${first.message}`);
        for (const d of res.diagnostics) if (d.code !== 'axis-crossing') console.log(`#   [${d.severity}] ${d.code}: ${d.message}`);
      } else {
        const s = res.stats;
        console.log(`# column[${label}]: OK  ${ms.toFixed(0)}ms  rssΔ=${(rss - before).toFixed(0)}MB  grid ${s.resolution?.dx.toFixed(3)}mm × ${s.resolution?.dThetaDeg.toFixed(3)}°`);
        console.log(`#   checkpoints=${res.count}  columnOps=${s.columnOps}  removed=${s.removedVolume.toFixed(2)}mm³ of stock ${s.stockVolume.toFixed(2)}mm³  mesh tris stock=${res.stock.triangleCount} result=${res.result.triangleCount}`);
        for (const d of res.diagnostics) console.log(`#   [${d.severity}] ${d.code}: ${d.message}`);
      }
    }
  }
}

await main();
