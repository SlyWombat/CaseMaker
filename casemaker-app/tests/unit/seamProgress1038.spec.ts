/**
 * #1038 — THE GOAL PATH'S PLANNER MUST REPORT ITS STAGES.
 *
 * Measured on the shipped app at main 5e8b958da (the M1 tray job, driven over CDP): pressing
 * Generate showed the run rows at "…generating…" and then NOTHING for 180 s; the app's silence
 * watchdog stopped the run ("The generator stopped reporting for 180 s"), while the browser tree
 * sat at ~110–120 % CPU — the worker was computing the plan, not waiting. The cause is a dropped
 * channel, not a slow plan: `engraveGenerate` dispatches a goal job to `generateGoalProgram`
 * without `onProgress`, and the seam calls `planTwoOutcomes(input)` with no options, so
 * `planModelCam`'s four stage reports (features 0 %, sequence 40 %, linking 90 %, linking 100 % per
 * setup) reach nobody. On the plate — the real 70 mm tray that takes minutes to plan — the run
 * looks dead for longer than the 3-minute watchdog and is killed.
 *
 * Red-first: at the tip the planner's stages are ZERO. The fix forwards the progress channel (and
 * an optional AbortSignal) through the seam into `planTwoOutcomes`, so the same run reports at
 * least three planner stages — each one re-arming the watchdog on the main thread.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { clearTargetObjectMeshCache } from '@/engine/import/targetObject';
import { parseStl } from '@/engine/import/stlParser';
import { flatEndMill } from '@/engine/cnc/tool';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import { engraveGenerate, generateGoalProgram, type EngraveProgress } from '@/workers/sim/engraveGenerate';
import { tl } from './helpers/manifoldExec';

afterEach(() => {
  clearTargetObjectMeshCache();
});

/** The plate: the licensed 70 mm tray's shipped STL beside the STEP the gate env names. */
const TRAY_STEP = process.env.CM_959_TRAY_STEP;
const TRAY_STL = TRAY_STEP === undefined ? null : path.join(path.dirname(TRAY_STEP), `${path.basename(TRAY_STEP, path.extname(TRAY_STEP))}.stl`);

/** The owned ⌀3.175 × 42 O-flute the morning's job cuts with. */
const X42 = flatEndMill(3.175, { name: 'Spiral O Single Flute 3.175 x 42', id: 'inv:kz-o-flute-3-175-42', fluteLength: 42 });
const X42_ENTRY: ToolLibraryEntry = { key: 'inv:kz-o-flute-3-175-42', tool: X42, provenance: 'test' };

function trayJob(stlPath: string): EngraveJob {
  const bytes = readFileSync(stlPath);
  const parsed = parseStl(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const size = {
    x: parsed.bbox.max[0] - parsed.bbox.min[0],
    y: parsed.bbox.max[1] - parsed.bbox.min[1],
    z: parsed.bbox.max[2] - parsed.bbox.min[2],
  };
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const goal: EngraveTargetObject = {
    id: sha256.slice(0, 16),
    name: path.basename(stlPath),
    format: 'stl',
    sha256,
    data: bytes.toString('base64'),
    size,
    position: { x: 55, y: 70, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
  };
  const base = defaultEngraveJob();
  return {
    ...base,
    name: 'm1-tray-70mm',
    stock: { ...base.stock, length: 110, width: 140, thickness: 27.2, material: 'hardwood' },
    labels: [],
    shapes: [],
    toolKey: X42_ENTRY.key,
    sacrificial: { under: null, sides: { left: null, right: null, front: null, back: null }, source: 'default' },
    targetObject: goal,
  };
}

describe('#1038 — the goal plan reports its stages', () => {
  it.skipIf(TRAY_STL === null || !existsSync(TRAY_STL))(
    'the plate’s plan reports at least three planner stages to the run’s progress channel',
    async () => {
      const job = trayJob(TRAY_STL!);
      const events: EngraveProgress[] = [];
      const gen = await engraveGenerate(
        tl,
        job,
        X42,
        [],
        null,
        undefined,
        { tools: [X42_ENTRY] },
        (p) => events.push(p),
      );
      expect(gen.errors, gen.errors.map((e) => `${e.stage}: ${e.message}`).join('\n')).toEqual([]);
      const planning = events.filter((e) => /planning/i.test(e.label ?? ''));
      // The plan's own four stages per setup: features, sequence, linking, linking.
      expect(planning.length, `planner stages seen: ${planning.length} — all events: ${events.map((e) => `${e.stage}:${e.label}`).join(' | ')}`).toBeGreaterThanOrEqual(3);
      // The stage lines alone are minutes apart on a real plate: the pocket chain's own step
      // boundaries must report too (a step kind, not the four band labels).
      const ticks = events.filter((e) => e.stage === 'plan' && /planning: (pocket|contour|rest|rough|finish|pencil) —/.test(e.label ?? ''));
      expect(ticks.length, `step ticks seen: ${ticks.length}`).toBeGreaterThan(0);
    },
    600_000,
  );

  it.skipIf(TRAY_STL === null || !existsSync(TRAY_STL))(
    'a stop raised mid-plan lands within one boundary — at most one further tick, then the refusal',
    async () => {
      const job = trayJob(TRAY_STL!);
      const ctrl = new AbortController();
      const events: EngraveProgress[] = [];
      let abortedAt: number | null = null;
      let afterAbort = 0;
      const gen = await generateGoalProgram(job, job.targetObject!, X42, null, {
        shop: { tools: [X42_ENTRY] },
        signal: ctrl.signal,
        onProgress: (p) => {
          events.push(p);
          if (abortedAt !== null) {
            afterAbort++;
            return;
          }
          // MID-PLAN: the 40 % line comes before the pocket chain (the 429 s stretch on the
          // plate); a stop raised here can only land quickly if the signal is checked at the
          // boundary hooks, not only between stages.
          if (/planning: .* — setup 1, 40 %/.test(p.label ?? '')) {
            abortedAt = events.length;
            ctrl.abort();
          }
        },
      });
      expect(abortedAt, `no 40 % tick was reported; events: ${events.map((e) => e.label).join(' | ')}`).not.toBeNull();
      // One check per boundary: the hook after the abort throws before emitting, so the abort
      // costs at most one further report and the refusal follows (never the full plan).
      expect(afterAbort, `events after the abort: ${events.slice(abortedAt!).map((e) => e.label).join(' | ')}`).toBe(0);
      expect(gen.ok).toBe(false);
      expect(gen.nc).toBeNull();
      expect(gen.errors.map((e) => `${e.stage}: ${e.message}`).join(' | ')).toMatch(/abort/i);
    },
    600_000,
  );
});
