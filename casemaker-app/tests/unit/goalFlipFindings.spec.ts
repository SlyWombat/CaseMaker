/**
 * #872 — THE SENTENCE AND THE OFFER, spoken on the corpus: a relief gets the split and NO
 * proposal (its remainder is one flat face); a sphere gets the plan with the sides named. The
 * finding is inform-only — it carries the share and the sides, and nothing about it refuses.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { buildRunSheet, type RunSheetGenerated } from '@/engine/cnc/engrave/runSheet';
import { clearTargetObjectMeshCache, readTargetObjectFile } from '@/engine/import/targetObject';
import { FLIP_ACTION_LABEL, goalFlipFindings, goalSurfaceOffer } from '@/engine/cnc/engrave/goalFlipFindings';
import { flatEndMill } from '@/engine/cnc/tool';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';

afterEach(() => clearTargetObjectMeshCache());

const here = (name: string): string => fileURLToPath(new URL(`../fixtures/goals/${name}`, import.meta.url));

async function goalOf(name: string): Promise<{ job: EngraveJob; goal: EngraveTargetObject }> {
  const bytes = readFileSync(here(name));
  const read = await readTargetObjectFile(new File([bytes], name), `goal-${name}`);
  if (!read.ok) throw new Error(read.error);
  const goal: EngraveTargetObject = {
    id: read.id,
    name: read.name,
    format: read.format,
    sha256: read.sha256,
    data: read.data,
    size: read.size,
    position: { x: 50, y: 30, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
  };
  const job = { ...defaultEngraveJob(), labels: [], shapes: [], drills: [], targetObject: goal };
  return { job, goal };
}

/** A board under the stock, mm — the material a flip's locating holes would enter. */
function withBoard(job: EngraveJob, thickness: number): EngraveJob {
  return {
    ...job,
    sacrificial: {
      ...job.sacrificial,
      under: { thickness, overhang: { left: 0, right: 0, front: 0, back: 0 }, attach: 'tape' },
    },
  };
}

/** A cutter a locating bore is made with: a 3 mm flat, which `ownedBoreCutter` accepts as a pin mill. */
const PIN = { key: 'user:pin-3', tool: flatEndMill(3) };

describe('#872 the goal-unreached finding', () => {
  it('a relief: the split is stated, and no flip is proposed — its remainder is a flat face', async () => {
    const { job, goal } = await goalOf('relief-plate.stl');
    const offer = goalSurfaceOffer(job, goal);
    expect(offer).not.toBeNull();
    // The flat back is a large share of the plate; the plan refuses a setup for it.
    expect(offer!.first.facingAwayMm2).toBeGreaterThan(0);

    const [finding] = goalFlipFindings(job, goal);
    expect(finding).toBeDefined();
    expect(finding!.code).toBe('goal-unreached');
    expect(finding!.targetId).toBe(goal.id);
    expect(finding!.message).toMatch(/The top setup reproduces \d/);
    expect(finding!.message).toMatch(/faces away from this setup and is left as stock/);
    expect(finding!.message).toMatch(/flat face/);
    expect(finding!.goalFlipSides).toBeUndefined();
    expect(finding!.goalFlipAction).toBeUndefined();
    expect(finding!.goalFlipNeed).toBeUndefined();
  });

  it('a sphere: the fact is the sentence, and the offer is ONE action with its detail folded away', async () => {
    const { job, goal } = await goalOf('near-sphere.stl');
    // #1068 — the offer is validated before it is made: the locating holes go through the stock
    // into a board, so the job carries one, and a cutter the shop owns can drill it.
    const [finding] = goalFlipFindings(withBoard(job, 6), goal, [PIN]);
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('warning');
    expect(finding!.goalFlipSides).toEqual(['top', 'bottom']);
    expect(finding!.goalReachedFraction).toBeGreaterThan(0.9);
    // THE SENTENCE IS THE FACT — no proposal, no steps, no numbered setups.
    expect(finding!.message).toMatch(/faces away from this setup and is left as stock/);
    expect(finding!.message).not.toMatch(/Setup 1 drills|A flip finishes it|locating holes/);
    // THE PROPOSAL IS ONE ACTION, and what it involves lives in the action's own expansion.
    expect(finding!.goalFlipAction).toBe(FLIP_ACTION_LABEL);
    expect(finding!.goalFlipNeed).toBeUndefined();
    expect(finding!.goalFlipDetail).toMatch(/^top, then bottom/);
    expect(finding!.goalFlipDetail).toMatch(/2 setups reach \d+ % of the surface/);
    expect(finding!.goalFlipDetail).toMatch(/how much of it the chosen cutter reproduces is the run's own simulation verdict/);
    // #1073 — 12 mm stock + the 0.3 mm breakthrough + the 0.2 mm chip clearance = 12.5 mm.
    expect(finding!.goalFlipDetail).toMatch(/bores two ⌀6 mm locating holes 12\.5 mm deep — through the blank and 0\.5 mm into the board/);
    expect(finding!.goalFlipDetail).toMatch(/in the margin, clear of the part/);
    expect(finding!.goalFlipDetail).toMatch(/the flipped setup registers on them/);
  });

  it('a bare bed: no action is offered — the row states what the flip needs', async () => {
    const { job, goal } = await goalOf('near-sphere.stl');
    // 27 mm holes in a 25 mm blank: the same shape as the M1 tray's own case. With no board the
    // holes would post below the bed, and an offer that refuses when accepted is a false offer.
    const trayLike: EngraveJob = {
      ...job,
      stock: { ...job.stock, thickness: 25 },
      sacrificial: { ...job.sacrificial, under: null },
    };
    const [finding] = goalFlipFindings(trayLike, goal, [PIN], 0);
    expect(finding!.goalFlipAction).toBeUndefined();
    expect(finding!.goalFlipNeed).toBe('needs a sacrificial board under the blank');
    // The fact still stands, and the plan's sides still ride (the panel's press reads them).
    expect(finding!.goalFlipSides).toEqual(['top', 'bottom']);
    expect(finding!.message).toMatch(/faces away from this setup and is left as stock/);
    // A board thinner than the bore's own drop (breakthrough 0.3 + chip 0.2 = 0.5 mm) is the same need.
    expect(goalFlipFindings(withBoard(trayLike, 0.4), goal, [PIN], 0.4)[0]!.goalFlipNeed).toBe(
      'needs a sacrificial board under the blank',
    );
    // …and a board that can take the breakthrough turns the need into the action.
    expect(goalFlipFindings(withBoard(trayLike, 6), goal, [PIN], 6)[0]!.goalFlipAction).toBe(FLIP_ACTION_LABEL);
  });

  it('no cutter that can drill: no action is offered — the row says which cutter is missing', async () => {
    const { job, goal } = await goalOf('near-sphere.stl');
    const [finding] = goalFlipFindings(withBoard(job, 6), goal, []);
    expect(finding!.goalFlipAction).toBeUndefined();
    expect(finding!.goalFlipNeed).toBe('needs a cutter for the ⌀5–6 locating bores — record one in Manage › Tools');
  });

  it('the accepted fact is the sheet’s line too — its warnings section states it verbatim', async () => {
    const { job, goal } = await goalOf('near-sphere.stl');
    const sheetJob = withBoard(job, 6);
    const findings = goalFlipFindings(sheetJob, goal, [PIN]);
    const generated: RunSheetGenerated = { findings, feeds: null, cam: null, nc: '', verify: null, frameNc: null };
    const sheet = buildRunSheet(sheetJob, generated, null);
    const warnings = sheet.sections.find((s) => s.id === 'warnings');
    expect(warnings, 'the sheet carries the run’s findings').toBeDefined();
    const text = warnings!.steps.map((s) => s.text).join('\n');
    expect(text).toContain('faces away from this setup and is left as stock');
    expect(text).not.toContain('Setup 1 drills');
  });

  it('a reference object is not a goal and gets no finding', async () => {
    const { job, goal } = await goalOf('relief-plate.stl');
    expect(goalFlipFindings(job, { ...goal, role: 'reference' })).toEqual([]);
  });
});
