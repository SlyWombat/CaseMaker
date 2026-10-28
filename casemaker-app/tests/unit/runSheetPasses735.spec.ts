// #735 item 1 — a run sheet counts DEPTH PASSES, not the chords of a helix.
//
// `summarize()` counted each distinct feed Z in an operation as a pass. A pocket descends one Z per
// pass, so that reading is right for it; a HELIX changes Z on every chord, so j18's two ⌀2.6 bores
// read "3648 × 0.5 mm passes" and the j15 keychain's through bore helped make "543". And a program
// that runs two step-downs (a pocket at the row's 0.5 mm, its cut-out slot at the halved 0.25 mm)
// printed one total — j01's "33 × 0.5 mm passes" — against the feeds row's 0.5 mm, which is only
// true for 11 of the 33.
//
// The CAM now states each operation's depth passes and the descent one took; the summary sums them
// and keeps the per-step tally, so the sheet can print the truth. The bench fixtures are the proof
// the issue asks for: j18's bore (a continuous helix), j01's two-step-down program, and j18's
// thread (a helical climb the generic line never printed, but the receipt's count read 530).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRunSheet } from '@/engine/cnc/engrave/runSheet';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import type { EngraveJob } from '@/types/engraveJob';
import type { EngraveGenerated } from '@/workers/sim/engraveGenerate';
import { generate } from './helpers/engravePipeline';
import { tl } from './helpers/manifoldExec';

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH = resolve(HERE, '../../../docs/bench/2026-10-27-z1-typical-jobs/jobs');

// The cutters the bench set names, with the geometry the machine's own inventory holds.
const TOOLS: Record<string, Tool> = {
  'inv:kz-corn-2-0-10-5': flatEndMill(2.0, { fluteLength: 10.5, cornerRadius: 0 }),
  'inv:kz-o-flute-3-175-25': flatEndMill(3.175, { fluteLength: 25, handleDiameter: 3.175 }),
  'inv:kz-thread-m3-9': flatEndMill(2.4, {
    name: 'Thread Milling Bit - 1/8" Shank M3(d2.4mm) * 9mm',
    typeText: 'Thread mill',
    shape: 'thread',
    tipDiameter: 2.4,
    diameter: 3.175,
    fluteLength: 9,
    cornerRadius: null,
  }),
};

function benchJob(name: string): EngraveJob {
  const parsed = parseEngraveJob(JSON.parse(readFileSync(resolve(BENCH, `${name}.json`), 'utf8')));
  if (!parsed.ok) throw new Error(`the bench fixture no longer parses: ${JSON.stringify(parsed.errors)}`);
  const job = parsed.job;
  const tool = TOOLS[job.toolKey];
  if (tool === undefined) throw new Error(`no tool recorded for the fixture's ${job.toolKey}`);
  return { ...job, tool };
}

/** Generate the fixture and return the cut section's parameter step's value. */
function cutParams(job: EngraveJob): { generated: EngraveGenerated; value: string } {
  const generated = generate(tl, job);
  expect(generated.ok, `${generated.stage}: ${JSON.stringify(generated.errors)}`).toBe(true);
  const sheet = buildRunSheet(job, generated, null);
  const cut = sheet.sections.find((s) => s.id === 'cut');
  const value = cut?.steps[0]?.value ?? '';
  return { generated, value };
}

describe('#735 item 1 — the sheet counts depth passes, not helix chords', () => {
  it('j18’s bore: 2 × 92 turns at the 0.066 mm pitch, not 3648 chords', () => {
    const job = benchJob('j18-thread-a-bore-proxy');
    const { generated, value } = cutParams(job);
    // The bore is plain (⌀2.6 hole, ⌀2.0 cutter): a continuous helix at
    // min(0.5 mm step-down, 2π·0.3·tan 2°) = 0.0658 mm per turn, 6 mm deep → 92 depth passes a
    // bore. The feed Z changes on every one of the 1824 chords; a chord is not a pass.
    expect(generated.cam?.passes).toBe(184);
    expect(value).toContain('184 × 0.066 mm passes');
    expect(value).not.toContain('3648');
  });

  it('j01’s two-step-down program: 33 depth passes, at 0.5 mm and 0.25 mm — not "33 × 0.5 mm"', () => {
    const job = benchJob('j01-topclamp-alu-proxy-adjusted');
    const { generated, value } = cutParams(job);
    // 5.3 mm deep: the pocket at the row's 0.5 mm (11 passes) and the cut-out slot at the
    // profile row's halved 0.25 mm (22 passes). The total was right; the one step-down beside it
    // was not.
    expect(generated.cam?.passes).toBe(33);
    expect(value).toContain('33 depth passes — 11 × 0.5 mm, 22 × 0.25 mm');
    expect(value).not.toContain('33 × 0.5 mm passes');
  });

  it('j18’s thread: 2 threads × 11 helix turns × 2 radial passes = 44, not 530 chords', () => {
    const job = benchJob('j18-thread-b-mill-proxy');
    const generated = generate(tl, job);
    expect(generated.ok, `${generated.stage}: ${JSON.stringify(generated.errors)}`).toBe(true);
    // The fixture holds two M3 threads. Each is one operation of 11 pitch-turns (5 mm of thread +
    // one pitch of run-out, M3 pitch 0.5 mm) at 2 radial passes — 22 depth passes a thread, 44 the
    // program. The thread's own sheet line prints the radial passes; the summary (the receipt, the
    // panel's count) must still not read the climb's chords as passes.
    expect(generated.cam?.passes).toBe(44);
  });
});
