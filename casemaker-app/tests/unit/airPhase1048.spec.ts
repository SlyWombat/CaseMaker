/**
 * #1048 — THE RAPID-MOVE CHECK REPORTS WHILE IT WORKS (the column engine).
 *
 * The client's silence clock re-arms only on messages; before this, a long air phase was silent
 * from the first checkpoint to the load's end, so on a slow machine the worker was terminated as
 * stalled with nothing actually wrong. The phase now announces itself ('air') and ticks every
 * AIR_PROGRESS_EVERY tested moves, so the window always sees it working.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AIR_PROGRESS_EVERY, AIR_TICK_MS } from '@/workers/geometry/sweep';
import { columnSweep } from '@/workers/geometry/columnEngine';
import { buildTimeline, parseGcode, stubSetup, MACHINES } from '@/engine/cnc';
import { flatEndMill } from '@/engine/cnc/tool';

const SLAB = { kind: 'prism' as const, outline: { kind: 'p-rect' as const, size: [100, 60] as [number, number] }, thickness: 5 };
const setup = () => stubSetup(SLAB, { kind: 'tape-down', contact: SLAB.outline });
const tool = flatEndMill(1);

/** One stroke, then 300 rapids below the stock top: more than one tick inside the air phase. */
const RAPIDS = Array.from({ length: 300 }, (_, i) => `G0 X${2 + (i % 40)} Y${2 + Math.floor(i / 40)} Z-0.5`).join('\n');
const SRC = 'S1000 M3\nG0 X10 Y10 Z-1\nG1 X20 F100\nG0 Z-0.5\n' + RAPIDS + '\nG0 Z2\nM5\n';

describe('#1048 — the column engine’s rapid-move check is its own phase', () => {
  it('announces itself and ticks every AIR_PROGRESS_EVERY tested moves', () => {
    const s = setup();
    const timeline = buildTimeline(parseGcode(SRC), s, MACHINES.Z1);
    const phases: string[] = [];
    const ticks: [number, number][] = [];
    const out = columnSweep(timeline, tool, s, {
      onPhase: (p) => phases.push(p),
      onProgress: (d, t) => ticks.push([d, t]),
    });
    expect(out.ok).toBe(true);
    expect(phases).toEqual(['air', 'air-done']);
    const airTicks = ticks.filter(([, total]) => total > 100);
    expect(airTicks.length, 'the phase ticks while it works').toBeGreaterThanOrEqual(1);
    expect(airTicks[0]![0] % AIR_PROGRESS_EVERY).toBe(0);
    expect(Math.max(...airTicks.map(([, total]) => total))).toBeGreaterThanOrEqual(300);
    expect(out.diagnostics.some((d) => d.code === 'air-moves-unchecked'), '300 moves fit the cap').toBe(false);
  });

  const airProgram = (count: number): string => {
    const many = Array.from({ length: count }, (_, i) => `G0 X${2 + (i % 60)} Y${2 + Math.floor((i / 60) % 40)} Z-0.5`).join('\n');
    return 'S1000 M3\nG0 X10 Y10 Z-1\nG1 X20 F100\nG0 Z-0.5\n' + many + '\nG0 Z2\nM5\n';
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('#1056 — 35 slow air moves and no count tick: the TIME tick keeps the phase reporting', () => {
    // Fewer below-top moves than AIR_PROGRESS_EVERY, so only the time tick can speak while the
    // phase runs. The clock is mocked to advance 0.9 s per reading — a slow move.
    let t = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (t += 900));
    const s = setup();
    const timeline = buildTimeline(parseGcode(airProgram(35)), s, MACHINES.Z1);
    const phases: string[] = [];
    const ticks: [number, number][] = [];
    let phaseAt: number | null = null;
    const out = columnSweep(timeline, tool, s, {
      onPhase: (p) => { phases.push(p); if (p === 'air') phaseAt = ticks.length; },
      onProgress: (d, total) => ticks.push([d, total]),
    });
    expect(out.ok).toBe(true);
    expect(phases).toEqual(['air', 'air-done']);
    // Only ticks AFTER the phase opened count: the checkpoint progress that precedes it is not
    // the air phase reporting.
    const airTicks = ticks.slice(phaseAt ?? ticks.length);
    expect(airTicks.length, `air ticks: ${JSON.stringify(airTicks)}`).toBeGreaterThanOrEqual(1);
    expect(airTicks.every(([, total]) => total <= 40)).toBe(true);
    expect(AIR_TICK_MS).toBeLessThanOrEqual(2_000);
  });

  it('#858/#1048 — a job with more moves than the EXACT cap still checks every one here', () => {
    // The e2e's figure job has 5,039 air moves below the stock top; the column engine has NO cap
    // (its check is a cell walk, not a boolean), so none is left unchecked.
    const s = setup();
    const timeline = buildTimeline(parseGcode(airProgram(5000)), s, MACHINES.Z1);
    const out = columnSweep(timeline, tool, s, {});
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.diagnostics.some((d) => d.code === 'air-moves-unchecked'), 'no move is left unchecked').toBe(false);
    expect(out.stats.airMovesChecked).toBeGreaterThan(4000);
  });

  it('#858/#1048 — 150,000 rapids: every move checked, and the wall time recorded', () => {
    // 6b's requested size: a cap at 100,000 would only have MOVED the cliff here. The program's
    // own move count is the bound; the number below goes on the issue.
    const s = setup();
    const parsed = parseGcode(airProgram(150_000));
    const timeline = buildTimeline(parsed, s, MACHINES.Z1);
    let ticks = 0;
    let lastTotal = 0;
    const t0 = performance.now();
    const out = columnSweep(timeline, tool, s, { onProgress: (_done: number, total: number) => { ticks += 1; lastTotal = total; } });
    const ms = performance.now() - t0;
    console.log(`[#1048] 150,000-rapid air check: sweep ${ms.toFixed(0)} ms, ${ticks} ticks, airTotal ${lastTotal}`);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.diagnostics.some((d) => d.code === 'air-moves-unchecked'), 'no move is left unchecked').toBe(false);
    expect(out.stats.airMovesChecked).toBeGreaterThanOrEqual(150_000);
    expect(ticks, 'the ticks keep the client window open across the whole phase').toBeGreaterThanOrEqual(Math.floor(150_000 / AIR_PROGRESS_EVERY));
  }, 120_000);
});
