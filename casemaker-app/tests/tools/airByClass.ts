/**
 * #962 — THE AIR LINE, BY RAPID CLASS. Test-tool, not engine code.
 *
 * The manager's 11-05 question on the tray: the card's air is 20.91 % against the vendor's
 * 6.7 + 10 = 16.7 % (within 1 point of 6.7). Where do the rapid SECONDS go? Every rapid move of
 * every posted program (ours) and of the vendor NC is classified by its own geometry and context,
 * and priced with the app's own timing model (`Z1.rapidEstimate`, `rapidRate`, `moveSeconds`):
 *
 *   tool change — a rapid before the run's first feed (our program; the vendor's T-run)
 *   leg         — |ΔXY| < 0.05 mm  (a retract/plunge in place)
 *   hop         — |ΔXY| < 3 mm     (the next raster row)
 *   region      — |ΔXY| ≥ 3 mm     (crossing between regions/ops)
 *
 *   npx tsx --tsconfig tsconfig.scripts.json tests/tools/airByClass.ts \
 *     --plan <plan.json> --pics <pics.json> [--vendor <nc> ...] [--json <out.json>]
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { postZ1 } from '@/engine/cnc/post/z1';
import type { ToolpathIR } from '@/engine/cnc/cam/ir';
import { moveSeconds, rapidRate, type RapidEstimate } from '@/engine/cnc/cam/ir';
import { Z1 } from '@/engine/cnc/machine';
import { parseGcode } from '@/engine/cnc/gcode/interpreter';

type ClassName = 'tool-change' | 'leg' | 'hop' | 'region';
const CLASSES: ClassName[] = ['tool-change', 'leg', 'hop', 'region'];

interface Rapid {
  cls: ClassName;
  seconds: number;
  mm: number;
  from: [number, number, number];
  to: [number, number, number];
}

function classify(dx: number, dy: number, beforeFirstFeed: boolean): ClassName {
  if (beforeFirstFeed) return 'tool-change';
  const xy = Math.hypot(dx, dy);
  if (xy < 0.05) return 'leg';
  if (xy < 3) return 'hop';
  return 'region';
}

/** Every rapid in one posted text, classified and timed; `rapid` is the app's own estimate. */
function analytics(text: string, rapid: RapidEstimate): Rapid[] {
  const parsed = parseGcode(text);
  const out: Rapid[] = [];
  let seenFeed = false;
  for (const e of parsed.events) {
    if (e.kind !== 'move') continue;
    if (e.mode === 'cut') {
      seenFeed = true;
      continue;
    }
    const [fx, fy, fz] = e.from;
    const [tx, ty, tz] = e.to;
    if (fx === null || fy === null || fz === null || tx === null || ty === null || tz === null) continue;
    const dx = tx - fx;
    const dy = ty - fy;
    const dz = tz - fz;
    const dist = Math.hypot(dx, dy, dz);
    const cls = classify(dx, dy, !seenFeed);
    out.push({
      cls,
      seconds: moveSeconds(dist, rapidRate(rapid, dx, dy, dz), rapid.accelMmPerS2),
      mm: dist,
      from: [fx, fy, fz],
      to: [tx, ty, tz],
    });
  }
  return out;
}

function main(): void {
  const args: Record<string, string> = {};
  const vendor: string[] = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]!.replace(/^--/, '');
    const value = argv[i + 1]!;
    if (key === 'vendor') vendor.push(value);
    else args[key] = value;
  }
  const plan = JSON.parse(readFileSync(args.plan!, 'utf8')) as { perSetup: { programs?: ToolpathIR[] }[] };
  const pics = JSON.parse(readFileSync(args.pics!, 'utf8')) as { card: string; post: Parameters<typeof postZ1>[1] };
  const programs = plan.perSetup[0]?.programs ?? [];
  const rapid = Z1.rapidEstimate;

  const perProgram = programs.map((ir, i) => {
    const posted = postZ1(ir, pics.post, Z1);
    if (!posted.ok) throw new Error(`program ${i} refused to post: ${posted.errors.join('; ')}`);
    const rapids = analytics(posted.text, rapid);
    const byClass = Object.fromEntries(CLASSES.map((c) => [c, { count: 0, seconds: 0 }])) as Record<ClassName, { count: number; seconds: number }>;
    for (const r of rapids) {
      byClass[r.cls].count++;
      byClass[r.cls].seconds += r.seconds;
    }
    const seconds = rapids.reduce((s, r) => s + r.seconds, 0);
    return { program: i, tool: ir.tool.id ?? ir.tool.name, seconds, count: rapids.length, byClass, rapids };
  });

  const vendorRows = vendor.map((file) => {
    const rapids = analytics(readFileSync(file, 'utf8'), rapid);
    const byClass = Object.fromEntries(CLASSES.map((c) => [c, { count: 0, seconds: 0 }])) as Record<ClassName, { count: number; seconds: number }>;
    for (const r of rapids) {
      byClass[r.cls].count++;
      byClass[r.cls].seconds += r.seconds;
    }
    return { file, seconds: rapids.reduce((s, r) => s + r.seconds, 0), count: rapids.length, byClass, rapids };
  });

  const fold = (rows: { byClass: Record<ClassName, { count: number; seconds: number }>; seconds: number }[]) => {
    const byClass = Object.fromEntries(CLASSES.map((c) => [c, { count: 0, seconds: 0 }])) as Record<ClassName, { count: number; seconds: number }>;
    let seconds = 0;
    for (const row of rows) {
      for (const c of CLASSES) {
        byClass[c].count += row.byClass[c].count;
        byClass[c].seconds += row.byClass[c].seconds;
      }
      seconds += row.seconds;
    }
    return { seconds, byClass };
  };
  const ours = fold(perProgram);
  const theirs = fold(vendorRows);
  const pct = (x: number): string => `${((100 * x) / Math.max(1e-9, ours.seconds)).toFixed(1)} %`;
  const pctV = (x: number): string => `${((100 * x) / Math.max(1e-9, theirs.seconds)).toFixed(1)} %`;
  const rows = perProgram.map(
    (p) => `  p${p.program} ${String(p.tool).padEnd(14)} rapid ${p.seconds.toFixed(1).padStart(7)} s  ` +
      CLASSES.map((c) => `${c} ${p.byClass[c].seconds.toFixed(1)} s/${p.byClass[c].count}`).join('  '),
  );
  process.stdout.write(
    `${pics.card} — rapid seconds by class\n${rows.join('\n')}\n` +
      `  OURS  total ${ours.seconds.toFixed(1)} s — ` +
      CLASSES.map((c) => `${c} ${ours.byClass[c].seconds.toFixed(1)} s (${ours.byClass[c].count}, ${pct(ours.byClass[c].seconds)})`).join(', ') + '\n' +
      `  VENDOR total ${theirs.seconds.toFixed(1)} s — ` +
      CLASSES.map((c) => `${c} ${theirs.byClass[c].seconds.toFixed(1)} s (${theirs.byClass[c].count}, ${pctV(theirs.byClass[c].seconds)})`).join(', ') + '\n',
  );
  if (args.json !== undefined) {
    writeFileSync(args.json, JSON.stringify({ card: pics.card, perProgram, ours, vendor: theirs, vendorRows }, null, 1));
    process.stdout.write(`wrote ${args.json}\n`);
  }
}

main();
