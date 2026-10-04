/**
 * Sweep timing harness — #194 step 1 ("Measure first — do not skip this").
 *
 * Usage (from `casemaker-app/`):
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/sweep-timing.ts <file> [--budget-ms N]
 *
 * `<file>` is a corpus name under `reference-gcode/` (e.g. `Z1/TopClamp.nc`), or a path
 * that already exists as given. Budget defaults to 120 000 ms.
 *
 * For one file it:
 *   - sizes a prism stock to the job's XY bounding box plus 5 mm a side and its Z depth
 *     plus 2 mm, copying how the Balloon test in tests/unit/cncSweep.spec.ts builds its
 *     stock (CopperCAM/Makera files do not carry a usable stock in a form V1 models),
 *   - runs `sweepTimeline` and prints `stats.ms`, peak RSS, and the checkpoint / distinct-Z
 *     counts,
 *   - then runs `createPlayback` and seven `stockAt` seeks (-1, 0, count/4, count/2,
 *     3·count/4, count-1, count/2 again), printing each seek's time.
 *
 * WHY A CHILD PROCESS. `sweepTimeline` is a synchronous wasm call: once it is inside one
 * boolean nothing on that thread can interrupt it, so a wall-clock budget cannot be enforced
 * in-process. The work therefore runs in a CHILD process; the parent kills the child when
 * `--budget-ms` (+ a short grace) is exceeded, after forwarding everything the child had
 * already printed. The child also checks the budget itself while it is iterating checkpoints
 * and air moves, so an overrun during those loops is reported cleanly (and how far it got)
 * instead of as a kill.
 *
 * Tool: a 3.175 mm flat end mill for every file, matching the only existing vendor sweep
 * test (LED/ACRYLIC-Balloon.nc). The PCB CopperCAM files name V-bits in a comment; a V-bit
 * is refused by `cuttingRadiusForSweep`, so a flat end of the same diameter is used to
 * measure the SWEEP cost, which is what #194 is about.
 *
 * `--machine Z1|none` picks the machine profile (default Z1, which is what the issue's
 * probe-checkpoints counts were taken on). On LED/ACRYLIC-Balloon.nc Z1 injects 8 synthetic
 * rapids (air moves 353 vs 345, 8 `rapid-below-bed` errors vs 0) — a few percent, not the
 * cost driver. Every output below is machine=Z1 unless a run says otherwise.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEFAULT_BUDGET_MS = 120_000;
/** Kill the child this long after the budget if it could not check the clock itself. */
const KILL_GRACE_MS = 5_000;
const CORPUS = 'reference-gcode';

interface Args {
  file: string;
  budgetMs: number;
  machine: string;
  child: boolean;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let budgetMs = DEFAULT_BUDGET_MS;
  let machine = 'Z1';
  let child = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--child') child = true;
    else if (a === '--budget-ms') budgetMs = Number(argv[++i]);
    else if (a.startsWith('--budget-ms=')) budgetMs = Number(a.slice('--budget-ms='.length));
    else if (a === '--machine') machine = argv[++i] as string;
    else if (a.startsWith('--machine=')) machine = a.slice('--machine='.length);
    else positional.push(a);
  }
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) budgetMs = DEFAULT_BUDGET_MS;
  const file = positional[0];
  if (!file) {
    throw new Error('usage: sweep-timing.ts <file> [--budget-ms N] [--machine Z1|none]  (file is under reference-gcode/ or a path that exists)');
  }
  return { file, budgetMs, machine, child };
}

/** Resolve `<file>`: as given, or under reference-gcode/. */
function resolveCorpusPath(file: string): string {
  if (existsSync(file)) return file;
  const under = `${CORPUS}/${file}`;
  if (existsSync(under)) return under;
  throw new Error(`file not found: "${file}" (also tried "${under}" from ${process.cwd()})`);
}

function killTree(pid: number): void {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

// ---------------------------------------------------------------------------------------
// Parent: spawn the child, forward its output, enforce the budget with a hard kill.
// ---------------------------------------------------------------------------------------
function runParent(args: Args): void {
  const here = fileURLToPath(import.meta.url);
  const require = createRequire(import.meta.url);
  const tsxCli = require.resolve('tsx/cli');
  const childArgs = [tsxCli, '--tsconfig', 'tsconfig.scripts.json', here, '--child', '--budget-ms', String(args.budgetMs), '--machine', args.machine, args.file];
  const child = spawn(process.execPath, childArgs, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  console.log(`# sweep-timing: ${args.file}  budget=${args.budgetMs}ms  child pid=${child.pid}`);
  child.stdout.on('data', (d: Buffer) => process.stdout.write(d));
  child.stderr.on('data', (d: Buffer) => process.stderr.write(d));
  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    if (child.pid !== undefined) killTree(child.pid);
  }, args.budgetMs + KILL_GRACE_MS);
  child.on('exit', (code, signal) => {
    clearTimeout(timer);
    if (killed) {
      console.log(`\n== BUDGET EXCEEDED: child killed after ${args.budgetMs + KILL_GRACE_MS} ms (budget ${args.budgetMs} + ${KILL_GRACE_MS} grace) ==`);
      console.log('== the sweep did not return; see the last [progress] line above for how far it got ==');
      process.exitCode = 2;
    } else {
      if (signal) console.log(`\n== child exited on signal ${signal} ==`);
      process.exitCode = code ?? 1;
    }
  });
}

// ---------------------------------------------------------------------------------------
// Child: do the measurement.
// ---------------------------------------------------------------------------------------
class BudgetExceeded extends Error {
  constructor(
    readonly phase: 'checkpoints' | 'air-moves' | 'playback',
    readonly index: number,
    readonly total: number,
    readonly elapsedMs: number,
  ) {
    super(`budget exceeded during ${phase} at ${index + 1}/${total} (${elapsedMs.toFixed(0)} ms)`);
  }
}

const rssMb = (): number => process.memoryUsage().rss / 1024 / 1024;

async function runChild(args: Args): Promise<void> {
  const t0 = performance.now();
  const path = resolveCorpusPath(args.file);

  // Loaded lazily so the parent (which never loads wasm) also imports this file cheaply.
  const ManifoldModule = (await import('manifold-3d')).default;
  const require = createRequire(import.meta.url);
  const wasmPath = require.resolve('manifold-3d/manifold.wasm');
  const tl = await ManifoldModule({ locateFile: () => wasmPath });
  tl.setup();

  const { parseGcode, buildTimeline, stubSetup, MACHINES } = await import('@/engine/cnc');
  const machine = args.machine === 'none' ? undefined : MACHINES[args.machine];
  if (args.machine !== 'none' && !machine) throw new Error(`unknown machine "${args.machine}"; known: ${Object.keys(MACHINES).join(', ')}`);
  const { sweepTimeline } = await import('@/workers/geometry/sweep');
  const { createPlayback } = await import('@/workers/geometry/playback');
  const { flatEndMill } = await import('@/engine/cnc/tool');
  type SweepTimeline = typeof import('@/workers/geometry/sweep').sweepTimeline;

  const text = (await import('node:fs')).readFileSync(path, 'latin1');
  const parsed = parseGcode(text);

  // Stock from the cutting moves' extent, exactly as the Balloon corpus test does.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, minZ = Infinity;
  for (const e of parsed.events) {
    if (e.kind !== 'move' || e.mode !== 'cut') continue;
    for (const p of [e.from, e.to]) {
      if (p[0] !== null) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); }
      if (p[1] !== null) { minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
      if (p[2] !== null) minZ = Math.min(minZ, p[2]);
    }
  }
  const thickness = Math.max(0.1, -minZ + 2); // Z depth + 2 mm
  const part = {
    kind: 'prism' as const,
    outline: { kind: 'p-rect' as const, size: [maxX - minX + 10, maxY - minY + 10] as [number, number] },
    thickness,
  };
  const setup = stubSetup(part, { kind: 'tape-down', contact: part.outline }, {}, machine);
  setup.placement = { origin: [minX - 5, minY - 5, 0], rotationZ: 0, source: 'stub' };
  setup.wcs = { origin: [0, 0, thickness], source: 'stub', uncertainty: 0.05 };

  const timeline = buildTimeline(parsed, setup, machine);
  const distinctZ = new Set(timeline.checkpoints.map((c) => c.zKey)).size;
  const cpTotal = timeline.checkpoints.length;
  const airTotal = timeline.airMoves.length;
  console.log(`# file=${path}`);
  console.log(`# stock=${(maxX - minX + 10).toFixed(1)}x${(maxY - minY + 10).toFixed(1)}x${thickness.toFixed(2)} mm  (bbox + 5 mm a side, depth + 2 mm; machine=${args.machine}, 3.175 mm flat end)`);
  console.log(`# cuts=${timeline.summary.cuttingMoves}  distinctZ=${distinctZ}  checkpoints=${cpTotal}  airMoves=${airTotal}`);
  console.log(`# parse+build=${(performance.now() - t0).toFixed(0)}ms  rss=${rssMb().toFixed(0)}MB  SWEEP_START`);

  // Instrument the two arrays the sweep drives so we can check the budget and report how
  // far it got. Reads through the Proxy are how `forEach`, `filter` and `for…of` see the
  // elements; the added cost is one integer check per element.
  let peakRss = rssMb();
  let lastProgressPrint = 0;
  const checkBudget = (phase: 'checkpoints' | 'air-moves', index: number, total: number): void => {
    const now = performance.now();
    const rss = rssMb();
    if (rss > peakRss) peakRss = rss;
    if (now - t0 > args.budgetMs) throw new BudgetExceeded(phase, index, total, now - t0);
    if (now - lastProgressPrint > 500) {
      lastProgressPrint = now;
      console.log(`[progress] ${phase} ${index + 1}/${total}  elapsed=${(now - t0).toFixed(0)}ms  rss=${rss.toFixed(0)}MB`);
    }
  };
  const instrument = <T,>(arr: T[], phase: 'checkpoints' | 'air-moves'): T[] =>
    new Proxy(arr, {
      get(target, prop, recv) {
        if (typeof prop === 'string') {
          const i = Number(prop);
          if (Number.isInteger(i) && i >= 0 && i < target.length) checkBudget(phase, i, target.length);
        }
        return Reflect.get(target, prop, recv);
      },
    });
  const instrumented = { ...timeline, checkpoints: instrument(timeline.checkpoints, 'checkpoints'), airMoves: instrument(timeline.airMoves, 'air-moves') };

  const tool = flatEndMill(3.175);
  let out: ReturnType<SweepTimeline>;
  try {
    out = sweepTimeline(tl, instrumented, tool, setup);
  } catch (e) {
    if (e instanceof BudgetExceeded) {
      console.log(`\n== BUDGET EXCEEDED (self-check): ${e.message} ==`);
      console.log(`== partial: cuts=${timeline.summary.cuttingMoves} distinctZ=${distinctZ} checkpoints=${cpTotal} peakRss~${peakRss.toFixed(0)}MB (was inside sweepTimeline) ==`);
      process.exitCode = 2;
      return;
    }
    throw e;
  }
  const sweepMs = performance.now() - t0;

  if (!out.ok) {
    console.log(`\n# sweep REFUSED in ${sweepMs.toFixed(0)}ms:`);
    for (const d of out.diagnostics) console.log(`  [${d.severity}] ${d.code}: ${d.message}`);
    process.exitCode = 0;
    return;
  }
  const v = out.value;
  const rssAfterSweep = rssMb();
  if (rssAfterSweep > peakRss) peakRss = rssAfterSweep;
  console.log(`\n# sweep OK   total=${v.stats.ms.total.toFixed(0)}ms  swept=${v.stats.checkpointsSwept}  skipped=${v.stats.checkpointsSkipped}  contours=${v.stats.contours}`);
  console.log(`#   union2d=${v.stats.ms.union2d.toFixed(0)}ms  extrude=${v.stats.ms.extrude.toFixed(0)}ms  airCheck=${v.stats.ms.airCheck.toFixed(0)}ms  subtract=${v.stats.ms.subtract.toFixed(0)}ms`);
  console.log(`#   airMoves checked=${v.stats.airMovesChecked} rechecked=${v.stats.airMovesRechecked}  stockVol=${v.stats.stockVolume.toFixed(1)} removedVol=${v.stats.removedVolume.toFixed(1)}`);
  console.log(`#   rss=${rssAfterSweep.toFixed(0)}MB  peakRss~${peakRss.toFixed(0)}MB  (whole run ${sweepMs.toFixed(0)}ms)`);
  const errs = v.diagnostics.filter((d) => d.severity === 'error');
  const errCodes = [...new Set(errs.map((d) => d.code))];
  console.log(`#   diagnostics: ${v.diagnostics.length} (${errs.length} error${errs.length ? `: ${errCodes.join(', ')}` : ''})`);
  if (errs[0]) console.log(`#     e.g. ${errs[0].code}: ${errs[0].message}`);

  // Playback: seven seeks, six distinct, the last one warm.
  const count = v.perCheckpoint.length;
  const t2 = performance.now();
  const playback = createPlayback(tl, timeline, v);
  console.log(`\n# createPlayback=${(performance.now() - t2).toFixed(0)}ms  count=${count}`);
  const seq: Array<[string, number]> = [
    ['-1', -1],
    ['0', 0],
    ['count/4', Math.floor(count / 4)],
    ['count/2', Math.floor(count / 2)],
    ['3·count/4', Math.floor((3 * count) / 4)],
    ['count-1', count - 1],
    ['count/2 (again)', Math.floor(count / 2)],
  ];
  let worstCold = 0;
  let worstLabel = '';
  seq.forEach(([label, k], i) => {
    const a = performance.now();
    const stock = playback.stockAt(k);
    void stock.numTri(); // force the lazy union+subtract (playback does not evaluate it)
    const ms = performance.now() - a;
    const warm = i > 0 && seq.slice(0, i).some(([, kk]) => kk === k);
    if (!warm && ms > worstCold) { worstCold = ms; worstLabel = label; }
    console.log(`# seek ${label.padEnd(16)} k=${String(k).padStart(5)}  ${ms.toFixed(0)}ms${warm ? ' (warm)' : ''}  rss=${rssMb().toFixed(0)}MB`);
  });

  playback.dispose();
  v.stock.delete();
  v.result.delete();
  v.removal?.delete();
  for (const s of v.perCheckpoint) s?.delete();
  for (const g of v.gouges) g.solid.delete();

  const totalMs = performance.now() - t0;
  if (rssMb() > peakRss) peakRss = rssMb();
  const okSweep = v.stats.ms.total <= 10_000;
  const okSeek = worstCold <= 1_000;
  const okRss = peakRss <= 1_536; // 1.5 GB
  console.log(`\n# VERDICT ${okSweep && okSeek && okRss ? 'ACCEPT (simulable)' : 'REFUSE (not simulable)'}`);
  console.log(`#   sweep ${v.stats.ms.total.toFixed(0)}ms ${okSweep ? '<=' : '>'} 10s: ${okSweep ? 'ok' : 'FAIL'}`);
  console.log(`#   worst cold seek ${worstCold.toFixed(0)}ms (${worstLabel}) ${okSeek ? '<=' : '>'} 1s: ${okSeek ? 'ok' : 'FAIL'}`);
  console.log(`#   peak RSS ~${peakRss.toFixed(0)}MB ${okRss ? '<=' : '>'} 1.5GB: ${okRss ? 'ok' : 'FAIL'}`);
  console.log(`# total wall ${totalMs.toFixed(0)}ms`);
  process.exitCode = 0;
}

const args = parseArgs(process.argv.slice(2));
if (args.child) {
  await runChild(args);
} else {
  runParent(args);
}
