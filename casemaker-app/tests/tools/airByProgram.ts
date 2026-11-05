/**
 * #961 — THE AIR LINE, BY PROGRAM. Test-tool, not engine code.
 *
 * The manager's 11-05 question: the tray's air fraction rose from 18.39 % to 23.63 % when the
 * rest became a floor-level pass — is that the rest's own air growing, or the denominator (air is
 * rapidSeconds / cycleSeconds, so removing useful feed raises it even when travel does not move)?
 * This posts every program of a plan through the app's own door and prints each one's cycle,
 * rapid and feed seconds and its share, with the whole-plan fold beside them.
 *
 *   npx tsx --tsconfig tsconfig.scripts.json tests/tools/airByProgram.ts \
 *     --plan /tmp/score-961/tray-plan.json --pics /tmp/score-961/tray-pics.json
 */
import { readFileSync } from 'node:fs';

import { postZ1, type PostContext } from '@/engine/cnc/post/z1';
import type { ToolpathIR } from '@/engine/cnc/cam/ir';
import { Z1 } from '@/engine/cnc/machine';
import { measurePostedProgram } from './postedFacts';

interface PicsDoc {
  card: string;
  post: PostContext;
}

interface PlanDoc {
  perSetup: { programs?: ToolpathIR[] }[];
}

function main(): void {
  const args: Record<string, string> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) args[argv[i]!.replace(/^--/, '')] = argv[i + 1]!;
  const plan = JSON.parse(readFileSync(args.plan!, 'utf8')) as PlanDoc;
  const pics = JSON.parse(readFileSync(args.pics!, 'utf8')) as PicsDoc;
  const programs = plan.perSetup[0]?.programs ?? [];
  const rows: string[] = [];
  let cycle = 0;
  let rapid = 0;
  let feed = 0;
  for (const [i, ir] of programs.entries()) {
    const posted = postZ1(ir, pics.post, Z1);
    if (!posted.ok) throw new Error(`program ${i} refused to post: ${posted.errors.join('; ')}`);
    const f = measurePostedProgram(posted.text);
    cycle += f.cycleSeconds;
    rapid += f.rapidSeconds;
    feed += f.feedSeconds;
    rows.push(
      `${i}  ${(ir.tool.id ?? ir.tool.name).padEnd(14)} cycle ${f.cycleSeconds.toFixed(1).padStart(8)} s  rapid ${f.rapidSeconds.toFixed(1).padStart(8)} s  feed ${f.feedSeconds.toFixed(1).padStart(8)} s  air ${(100 * f.airFraction).toFixed(2).padStart(6)} %`,
    );
  }
  process.stdout.write(`${pics.card} — air by program\n${rows.join('\n')}\n` +
    `whole plan: cycle ${cycle.toFixed(1)} s, rapid ${rapid.toFixed(1)} s, feed ${feed.toFixed(1)} s, air ${(100 * rapid / cycle).toFixed(2)} %\n`);
}

main();
