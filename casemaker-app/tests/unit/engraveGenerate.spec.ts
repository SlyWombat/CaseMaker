// The generate → verify headless pipeline (#206). Real Manifold, plain Node — the same harness
// `engravePreview.spec.ts` uses. This is the half that must be byte-identical run to run: the
// `.nc` a user saves is the text this function returns, never a re-derivation.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

import { parseEngraveJob } from '@/store/engraveJobSchema';
import { tl } from './helpers/manifoldExec';
import { generate, regions } from './helpers/engravePipeline';
import { frameCorners, engraveGenerate } from '@/workers/sim/engraveGenerate';
import type { ShopDefaults } from '@/platform/defaultsClient';
import { UNMEASURED_FEEDS_TABLE, type FeedCatalogueRow } from '@/engine/cnc/feeds';
import { buildRunSheet } from '@/engine/cnc/engrave/runSheet';
import { defaultBoundaryMargin } from '@/engine/cnc/engrave/depthBounds';
import { labelGlyphMeasure, traceSelfOverlaps, voidLimitForItem } from '@/engine/cnc/engrave/partPlan';
import { bindingVoidsByRegion } from '@/workers/sim/engraveGeometry';
import { createSimSession } from '@/workers/sim/session';
import { jobTool, toSetup } from '@/engine/cnc/engrave/jobSetup';
import { Z1 } from '@/engine/cnc/machine';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { CAM_ID, CAM_NAME } from '@/engine/cnc/post/z1';
import { version as APP_VERSION } from '../../package.json';
import { presetPartOnBoard } from '@/engine/cnc/sacrificial';
import { calibrationFromReplies } from '@/engine/cnc/calibration';
import { Z1_FRAME_REPLIES } from './fixtures/z1Frame';
import { badgeBlankFor } from '@/engine/cnc/engrave/fromBadge';
import { viseForNewJob } from '@/engine/cnc/fixture';
import { defaultBadgeParams } from '@/types/badge';
import type { ToolpathIR } from '@/engine/cnc/cam/ir';
import { cuttingForTrace, cuttingRadiusForSweep, flatEndMill, isVTraceTool, traceRadiusAt, type Tool } from '@/engine/cnc/tool';
import type { EngraveDrill, EngraveJob, EngraveKeepOut, EngraveLabel, EngraveLineItem, EngraveStrokeLabelItem, EngraveThreadItem, EngraveTraceItem } from '@/types/engraveJob';

describe('engraveGenerate with a saved machine frame (#297)', () => {
  const read = calibrationFromReplies(new Map(Object.entries(Z1_FRAME_REPLIES)), {
    machineId: 'Z1',
    measuredAt: '2026-10-06T13:01:11.000Z',
    host: '192.168.10.43',
  });
  if (!read.ok) throw new Error('the fixture should read');

  it('still produces a clean program, and the same .nc, under the saved frame', () => {
    // The frame moves where M6, G28 and the probe go IN MACHINE COORDINATES. It must not move a
    // single work-coordinate cut, so the text a user saves is the same bytes either way.
    const without = generate(tl, defaultEngraveJob());
    const withFrame = generate(tl, defaultEngraveJob(), read.calibration);
    expect(withFrame.ok).toBe(true);
    expect(withFrame.nc).toBe(without.nc);
    expect(withFrame.verify!.findings.filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('ignores a frame saved for a different machine, exactly as the simulation does', () => {
    const other = { ...read.calibration, machineId: 'Z1-other' };
    const g = generate(tl, defaultEngraveJob(), other);
    expect(g.ok).toBe(true);
    expect(g.nc).toBe(generate(tl, defaultEngraveJob()).nc);
  });
});

describe('engraveGenerate (#206)', () => {
  it('takes the default job all the way to a clean .nc', () => {
    const g = generate(tl, defaultEngraveJob());
    expect(g.ok).toBe(true);
    expect(g.stage).toBe('done');
    expect(g.nc).not.toBeNull();
    expect(g.nc!.length).toBeGreaterThan(0);
    expect(g.nc!.startsWith(';@MKR|BEGIN')).toBe(true);
    expect(g.nc!.trimEnd().endsWith('M02')).toBe(true);
    expect(g.verify).not.toBeNull();
    expect(g.verify!.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(g.cam).not.toBeNull();
    expect(g.cam!.operations).toBe(3); // three enabled labels
    expect(g.cam!.cuttingMoves).toBeGreaterThan(0);
  });

  it('stamps the real package version into the CAM header, never dev (#231 item 4)', () => {
    const g = generate(tl, defaultEngraveJob());
    expect(g.nc).not.toBeNull();
    // The exact header line the app writes; a headless run must match it byte for byte.
    expect(g.nc).toContain(`;@MKR|CAM|id=${CAM_ID}|name=${CAM_NAME}|v=${APP_VERSION}`);
    expect(g.nc).not.toContain('v=dev');
  });

  it('is pure: the same job produces byte-identical nc', () => {
    const job = defaultEngraveJob();
    const a = generate(tl, job);
    const b = generate(tl, structuredClone(job) as EngraveJob);
    expect(a.nc).not.toBeNull();
    expect(a.nc).toBe(b.nc);
  });

  it('stops at findings for a cut deeper than the stock allows', () => {
    const job = defaultEngraveJob();
    const deep: EngraveJob = {
      ...job,
      labels: job.labels.map((l, i) => (i === 0 ? { ...l, depth: 11.5 } : l)),
    };
    const g = generate(tl, deep);
    expect(g.ok).toBe(false);
    expect(g.stage).toBe('findings');
    expect(g.nc).toBeNull();
    expect(g.findings.some((f) => f.code === 'depth-exceeds-stock' && f.severity === 'error')).toBe(true);
  });

  it('stops at feeds for a step-over past the cutter radius (#191)', () => {
    const job: EngraveJob = { ...defaultEngraveJob(), cutOverride: { stepOver: 0.6 } }; // radius is 0.5
    const g = generate(tl, job);
    expect(g.ok).toBe(false);
    expect(g.stage).toBe('feeds');
    expect(g.nc).toBeNull();
    expect(g.feeds?.ok).toBe(false);
    expect(g.errors.some((e) => e.stage === 'feeds')).toBe(true);
  });

  it('stops at findings when the cutter is too large for the text', () => {
    const job: EngraveJob = { ...defaultEngraveJob(), toolKey: 'flat-3.175x12-metal' };
    const g = generate(tl, job);
    expect(g.ok).toBe(false);
    expect(g.stage).toBe('findings');
    expect(g.nc).toBeNull();
    const codes = g.findings.filter((f) => f.severity === 'error').map((f) => f.code);
    expect(codes).toContain('item-chars-lost');
  });

  // #213 — `validateVise` has accepted the sacrificial stack since `454110a`, but this call never
  // passed it, so the generate path's `vise-grip-shallow` still judged the raw stock.
  it('judges vise-grip-shallow on what the jaws actually grip (#213)', () => {
    const base = defaultEngraveJob();
    // 10 mm proud on a 12 mm blank leaves 2 mm of raw stock in the jaws — under GRIP_MIN (3).
    const shallow: EngraveJob = {
      ...base,
      workholding: { ...base.workholding, vise: { ...base.workholding.vise, stockProud: 10 } },
    };
    const without = regions(tl, shallow).findings.map((f) => f.code);
    expect(without).toContain('vise-grip-shallow');

    // A 12 mm under-board with 10 mm overhang is what the jaws bear on, so the grip is the
    // board's thickness and the warning clears — only if the argument is threaded.
    const withBoard: EngraveJob = { ...shallow, sacrificial: presetPartOnBoard() };
    const withCodes = regions(tl, withBoard).findings.map((f) => f.code);
    expect(withCodes).not.toContain('vise-grip-shallow');
  });

  // #406 — a default job on a blank no taller than the 3.1 mm ledge step now carries a seated proud
  // ≤ 0. Every consumer downstream must take it without throwing, refuse it by name, and print
  // the figure without a float tail (3 − 3.1 = -0.10000000000000009).
  it('takes a 3 mm default job through the pipeline: refused by name, nothing thrown, no float tails (#406)', () => {
    const base = defaultEngraveJob();
    const thin: EngraveJob = {
      ...base,
      stock: { ...base.stock, thickness: 3 },
      workholding: { ...base.workholding, vise: viseForNewJob(undefined, { thickness: 3 }) },
    };
    expect(thin.workholding.vise.stockProud).toBeLessThanOrEqual(0);
    for (const findings of [regions(tl, thin).findings, generate(tl, thin).findings]) {
      const codes = findings.map((f) => f.code);
      expect(codes).toContain('vise-stock-not-proud');
      for (const f of findings) {
        expect(f.message).not.toMatch(/NaN/);
        expect(f.message).not.toMatch(/\d\.\d{6,}/);
      }
    }
  });
});

describe('an under-surface void limits the cut (#231 item 3)', () => {
  // A 12 mm blank with a 2 mm membrane over a pocket: the void's ceiling is at z 10 from the
  // bottom face, so the job's boundary margin (0.2 mm — no print is stated, so there is no layer
  // height to read it from) leaves a deepest cut of 1.8 mm over it. `toPartPlan` turns the
  // void into `stock.keepOuts`, and `jobDepthLimit` is what the verifier is handed.
  const pocket: EngraveKeepOut = {
    id: 'pocket',
    name: 'Magnet pocket',
    kind: 'rect',
    position: { x: 50, y: 30 },
    rotation: 0,
    enabled: true,
    zCeiling: 10,
    width: 30,
    height: 20,
    cornerRadius: 0,
  };
  const shapeA = (depth: number) => ({
    id: 'a',
    name: 'A',
    kind: 'rect' as const,
    position: { x: 50, y: 30 },
    rotation: 0,
    depth,
    enabled: true,
    width: 10,
    height: 10,
    cornerRadius: 0,
  });
  // Shape B is clear of the pocket (x 80…90 against the pocket's 35…65): the same depth over
  // solid stock. It is the control for every case below.
  const shapeB = (depth: number) => ({
    id: 'b',
    name: 'B',
    kind: 'rect' as const,
    position: { x: 85, y: 30 },
    rotation: 0,
    depth,
    enabled: true,
    width: 10,
    height: 10,
    cornerRadius: 0,
  });
  const job = (aDepth: number, keepOuts?: EngraveKeepOut[]): EngraveJob => ({
    ...defaultEngraveJob(),
    labels: [],
    shapes: [shapeA(aDepth), shapeB(2.0)],
    ...(keepOuts ? { keepOuts } : {}),
  });

  it('refuses a cut past the membrane, flagged at verify on the TEXT', () => {
    const g = generate(tl, job(2.0, [pocket]));
    expect(g.ok).toBe(false);
    expect(g.stage).toBe('verify');
    // The text existed — it is the verifier, re-reading the posted bytes, that refused it.
    expect(g.nc).not.toBeNull();
    expect(g.verify!.findings.some((f) => f.code === 'cut-too-deep' && f.severity === 'error')).toBe(true);
    // #171: the breach is the verifier's one finding. The chatter warning is suppressed over it,
    // so the user reads the refusal and its advice once, not twice.
    expect(g.findings.some((f) => f.code === 'item-over-void')).toBe(false);
  });

  it('passes the same cut when it stays within the membrane', () => {
    // 1.0 mm is exactly the limit and passes: the bound is a plane to stay clear of, not a
    // thickness to reach. The limit MOVED from 1.8 when #345 decision A gave a no-print blank's
    // void the job's 1 mm minimum floor instead of the 0.2 mm boundary margin — with no layer grid
    // the structural floor is the only number with a basis — so 2 − 1.0 = 1.0.
    const g = generate(tl, job(1.0, [pocket]));
    expect(g.ok).toBe(true);
    expect(g.stage).toBe('done');
    expect(g.verify!.findings.some((f) => f.code === 'cut-too-deep')).toBe(false);
  });

  it('passes the same cut when the job carries no void', () => {
    const g = generate(tl, job(1.5));
    expect(g.ok).toBe(true);
    expect(g.stage).toBe('done');
    expect(g.findings.some((f) => f.code === 'item-over-void')).toBe(false);
  });

  // #171: the warning is about OVERLAP, not depth, so a cut well within the membrane still gets
  // it — the blank is printed flipped, so there is nothing under that material at any depth.
  it('warns over the void at a safe depth, and names only the cut that covers it (#171)', () => {
    const g = generate(tl, job(0.8, [pocket]));
    expect(g.ok).toBe(true); // a warning is not a refusal
    const warnings = g.findings.filter((f) => f.code === 'item-over-void');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.severity).toBe('warning');
    expect(warnings[0]!.labelId).toBe('a');
    expect(warnings[0]!.message).toContain('Magnet pocket');
    expect(warnings[0]!.message).toContain('2 mm membrane');
  });

  it('does not object to the same depth clear of the void (#171)', () => {
    // The acceptance pair: 2 mm over the membrane is refused, and the same 2 mm cut on solid
    // stock is not — the depth alone is never the problem.
    const clear: EngraveJob = {
      ...defaultEngraveJob(),
      labels: [],
      shapes: [shapeB(2.0)],
      keepOuts: [pocket],
    };
    const g = generate(tl, clear);
    expect(g.ok).toBe(true);
    expect(g.stage).toBe('done');
    expect(g.findings.some((f) => f.code === 'item-over-void')).toBe(false);
  });

  it('warns for a LABEL over the void too — the item kind makes no difference (#171)', () => {
    const jobWithLabel: EngraveJob = {
      ...defaultEngraveJob(),
      labels: [
        {
          id: 'over',
          text: 'CASE',
          font: 'sans-default',
          weight: 'bold',
          size: 10,
          position: { x: 50, y: 30 },
          rotation: 0,
          depth: 0.8,
          enabled: true,
        },
      ],
      shapes: [],
      keepOuts: [pocket],
    };
    const g = generate(tl, jobWithLabel);
    const over = g.findings.find((f) => f.code === 'item-over-void');
    expect(over).toBeTruthy();
    expect(over!.labelId).toBe('over');
    expect(over!.message).toContain('CASE');
  });

  // #270 — a TRACE over a void warns, for the same reason a region does: the membrane has nothing
  // under it, so a pass across it chatters however shallow. The advice the sentence carries — move
  // the cut clear — is exactly what a one-line trace can do, which is why the drill exemption
  // below does not reach it.
  /** A two-point horizontal trace from `at`, 30 mm long, in the stock frame. */
  const traceLine = (at: { x: number; y: number }): EngraveTraceItem => ({
    kind: 'line',
    id: 'tr',
    position: at,
    rotation: 0,
    points: [
      [0, 0],
      [30, 0],
    ],
    closed: false,
    depth: 0.8,
    enabled: true,
  });
  /** The same depth, drilled straight into the void's centre. */
  const drillOver: EngraveDrill = {
    kind: 'drill',
    id: 'd',
    position: { x: 50, y: 30 },
    rotation: 0,
    depth: 0.8,
    through: false,
    enabled: true,
  };

  it('warns for a TRACE crossing the void (#270)', () => {
    // x 35…65 across the pocket's 35…65, at its centreline.
    const g = generate(tl, {
      ...defaultEngraveJob(),
      labels: [],
      shapes: [],
      traces: [traceLine({ x: 35, y: 30 })],
      keepOuts: [pocket],
    });
    const over = g.findings.filter((f) => f.code === 'item-over-void');
    expect(over).toHaveLength(1);
    expect(over[0]!.severity).toBe('warning');
    expect(over[0]!.labelId).toBe('tr');
    expect(over[0]!.message).toContain('Magnet pocket');
    // Named the way the operations list names it, not as a bare id.
    expect(over[0]!.message).toContain('Trace line');
  });

  it('leaves the same trace unwarned when it is clear of the void (#270)', () => {
    // Moved to y 52, behind the pocket's 20…40 — the only difference is where the line sits.
    const g = generate(tl, {
      ...defaultEngraveJob(),
      labels: [],
      shapes: [],
      traces: [traceLine({ x: 35, y: 52 })],
      keepOuts: [pocket],
    });
    expect(g.findings.some((f) => f.code === 'item-over-void')).toBe(false);
  });

  it('does NOT warn for a drill over the void — the #220 exemption, pinned (#270)', () => {
    // A drill into the pocket is a breach the VERIFIER owns (`cut-too-deep`); this warning is about
    // the finish of a pocketed floor, and a drilled hole has none. #270 asked for this to stay.
    const g = generate(tl, {
      ...defaultEngraveJob(),
      labels: [],
      shapes: [],
      drills: [drillOver],
      keepOuts: [pocket],
    });
    expect(g.findings.some((f) => f.code === 'item-over-void')).toBe(false);
  });
});

// #285 — a job that states its print takes its DEPTH LIMIT from the blank sliced on the printer's
// own layer grid, rather than from the nominal membrane arithmetic. The switch is
// `EngraveJob.stock.print` (`fromBadge.ts` writes it only when the badge declares one, #166), and
// the pair below is what it buys: over the pocket the nominal membrane is 1.51 mm and the layer grid
// leaves 1.4 mm of solid, so the print is the STRICTER of the two — 1.25 mm sits between them.
//
// #345 made the two comparable by putting both on the same `boundaryMargin`. Before it they were
// not: the analytic path subtracted `minFloor` (1 mm, a different quantity) while the grid subtracted
// nothing, so a printed blank appeared to permit DEEPER cuts than a plain one, which is backwards.
// The grid's answer is a refinement of the membrane's and can only be shallower.
describe('a job that states its print limits on the printer’s layer grid (#285)', () => {
  /**
   * The badge's blank as a job with one 10 × 10 pocket over the magnet cavity — the acceptance
   * case's shape, so the numbers below are the badge's own and not a fixture invented here.
   */
  function badgeJob(print: boolean, depth: number): EngraveJob {
    // `print=false` states NO print explicitly: the default badge carries one now (#368), and the
    // gate's off side has to stay reachable for the comparison this describe makes.
    const badge = defaultBadgeParams(
      print ? { print: { layerHeight: 0.2, firstLayerHeight: 0.2 } } : { print: undefined },
    );
    const blank = badgeBlankFor(badge);
    return {
      // The blank is 3.81 mm, so the vise is the stock-derived default (#231 item 2): the shipped
      // flat 4 mm is taller than the whole badge and refuses it outright.
      ...defaultEngraveJob(viseForNewJob(undefined, blank.stock)),
      stock: blank.stock,
      keepOuts: blank.pocket ? [blank.pocket] : [],
      labels: [],
      shapes: [
        {
          id: 'a',
          name: 'A',
          kind: 'rect',
          position: { x: 38.1, y: 19.05 },
          rotation: 0,
          depth,
          enabled: true,
          width: 10,
          height: 10,
          cornerRadius: 0,
        },
      ],
    };
  }

  it('refuses 1.6 mm over the pocket, naming the void the stack found', () => {
    const g = generate(tl, badgeJob(true, 1.6));
    expect(g.ok).toBe(false);
    expect(g.stage).toBe('verify');
    // The text existed — it is the verifier, re-reading the posted bytes, that refused it.
    expect(g.nc).not.toBeNull();
    const deep = g.verify!.findings.find((f) => f.code === 'cut-too-deep');
    expect(deep).toBeDefined();
    expect(deep!.severity).toBe('error');
    // 0.2 mm layers carry the 1.51 mm membrane down to a 1.4 mm solid span below the face, and
    // #345's 0.2 mm margin comes off that: 1.2 mm is the number the cutter is refused against, and
    // the sentence names the plane — the void's ceiling — in the bound's own words.
    expect(deep!.message).toContain('1.200 mm permitted there');
    expect(deep!.message).toContain("the magnet pocket's ceiling");
  });

  it('passes 1.2 mm over the same pocket — the layer grid’s own floor, to the margin', () => {
    const g = generate(tl, badgeJob(true, 1.2));
    expect(g.ok).toBe(true);
    expect(g.stage).toBe('done');
    expect(g.verify!.findings.filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('refuses 1 mm on a blank that states no print and permits it on one that does (#345 A)', () => {
    // The two limits. With a print the grid's 1.4 mm solid span less #345's 0.2 mm boundary margin
    // is 1.2. With NO print there is no grid, so #345 decision A keeps the job's 1 mm STRUCTURAL
    // floor over the design's 1.51 mm membrane — 1.51 − 1.0 = 0.51, which is byte-identical to what
    // the analytic limit returned before #345 existed. 1 mm sits between the two, so the same cut is
    // refused on the plain blank and permitted on the printed one: with the layers unknown, the
    // floor is the only number with a basis, and it is the stricter of the two.
    const without = generate(tl, badgeJob(false, 1.0));
    expect(without.ok).toBe(false);
    expect(without.stage).toBe('verify');
    const deep = without.verify!.findings.find((f) => f.code === 'cut-too-deep');
    expect(deep).toBeDefined();
    expect(deep!.message).toContain('0.510 mm permitted there');

    const withPrint = generate(tl, badgeJob(true, 1.0));
    expect(withPrint.ok).toBe(true);
    expect(withPrint.stage).toBe('done');
  });

  it('generates the same program with and without a print — the print moves the gate, not the toolpath', () => {
    // The print changes what the verifier permits; it never changes a coordinate. So a cut within
    // BOTH limits produces the same bytes either way.
    //
    // NOT the pre-#285 guarantee, though: both programs here run under the current code, so this
    // shows the print is INERT, not that a no-print job is byte-for-byte unchanged. The assertion
    // for that one is `ncSnapshot.spec.ts`, which compares the default job's posted program against
    // the committed golden `tests/unit/fixtures/default-job.nc` — a real file that fails until a
    // human deliberately regenerates it.
    const withPrint = generate(tl, badgeJob(true, 0.5));
    const without = generate(tl, badgeJob(false, 0.5));
    expect(withPrint.ok).toBe(true);
    expect(without.ok).toBe(true);
    expect(withPrint.nc).toBe(without.nc);
  });

  it('reports the colour boundary on the layer grid, and none without a print', () => {
    // 3.81 − 3.0 = 0.81 below the face; the nearest 0.2 mm layer line is 0.8.
    expect(regions(tl, badgeJob(true, 0.5)).colourBoundaryDepth).toBeCloseTo(0.8, 6);
    expect(regions(tl, badgeJob(false, 0.5)).colourBoundaryDepth).toBeNull();
  });
});

// #365 decision 4 — the void bound the PANEL advises from and the void the WORKER finds are two
// different measurements of the same overlap: the app's engine tests the line's ink box against the
// void's shape (cheap, analytic, and the honest superset), while `bindingVoidsByRegion` intersects
// the measured ink with the void's own footprint in Clipper2. They must agree where both can see the
// item, or the panel would advise a depth the generator then refuses — and where only the BOX
// reaches a void (the box is a superset, so it can), its answer may only ever be the stricter one.
// Both halves are asserted below on the LIMIT, which is where the claim lives: the advice is a
// monotone function of it, so comparing advised depths would say nothing the limits do not.
describe('the per-item void bound agrees with the region scan (#365)', () => {
  /** The badge blank with its magnet pocket, and ONE measured line over it. */
  function badgeLine(text: string, x: number, y: number, extra: EngraveKeepOut[] = []): EngraveJob {
    const blank = badgeBlankFor(defaultBadgeParams());
    const base = defaultEngraveJob(viseForNewJob(undefined, blank.stock));
    return {
      ...base,
      stock: blank.stock,
      keepOuts: [...(blank.pocket ? [blank.pocket] : []), ...extra],
      labels: [
        { ...(base.labels[0] as EngraveLabel), id: 'name', text, size: 8, position: { x, y } },
      ],
      shapes: [],
    };
  }
  const margin = (job: EngraveJob) => defaultBoundaryMargin(job);

  it('names the same void, and the same number, where the line lies inside it', () => {
    // The line is centred on the pocket (38.1, 19.05), so its whole measured ink is inside the
    // 45 × 13 pocket: the Clipper2 scan sees a full overlap and the box test sees containment.
    const job = badgeLine('Name', 38.1, 19.05);
    const r = regions(tl, job);
    const scan = bindingVoidsByRegion(tl, job, r.plan, r.cuts, margin(job)).get('name')!;
    const bound = voidLimitForItem(job, job.labels[0]!, margin(job), labelGlyphMeasure([]))!;
    expect(bound.name).toBe(scan.name);
    expect(bound.name).toBe('Magnet pocket');
    // The same arithmetic, so the two are the same number rather than merely close: this is the
    // pairing that lets the panel's advice be the depth the verifier then holds the cut to.
    expect(bound.limit).toBe(scan.limit);
    expect(bound.estimated).toBe(false);
  });

  it('never advises deeper than the scan where the line only PARTLY overlaps the void', () => {
    // The first test's line sits INSIDE the pocket: a containment. This one straddles its near edge
    // (the roof at y = 12.55), so the two measurements are compared where the overlap is partial —
    // the same question, and both have to answer it the same way.
    const pocket = badgeBlankFor(defaultBadgeParams()).pocket!;
    if (pocket.kind !== 'rect') throw new Error('the badge pocket is a rect');
    const roof = pocket.position.y - pocket.height / 2;

    // A second void with LESS material over it than the pocket, well clear of the text: the pocket
    // leaves 1.51 mm and permits 0.51, this one leaves 1.21 mm and permits 0.21.
    const shallower: EngraveKeepOut = {
      kind: 'rect', id: 'ko-bore', name: 'Test bore', enabled: true, rotation: 0,
      position: { x: 63, y: 6 }, width: 6, height: 4, cornerRadius: 0, zCeiling: 2.6,
    };

    const job = badgeLine('Name', 38.1, roof + 2.5, [shallower]);
    const m = margin(job);
    const r = regions(tl, job);
    const scan = bindingVoidsByRegion(tl, job, r.plan, r.cuts, m).get('name')!;
    // The ink never comes near the bore, so the scan's answer is the pocket — and the MEASURED box
    // test is bound the same way, name for name and number for number.
    expect(scan.name).toBe('Magnet pocket');
    const measured = voidLimitForItem(job, job.labels[0]!, m, labelGlyphMeasure([]))!;
    expect(measured.name).toBe(scan.name);
    expect(measured.limit).toBe(scan.limit);
    expect(measured.estimated).toBe(false);

    // The FALLBACK box is the honest SUPERSET, and this is the direction that matters: 1.95 of cap
    // per character makes it as wide as the blank, so it reaches the bore the ink stops 8 mm short
    // of, and its answer is the bore's smaller limit. Never larger — the panel's advice may only
    // ever be STRICTER than the generator's own bound, never deeper than a depth the scan refuses.
    const estimated = voidLimitForItem(job, job.labels[0]!, m)!;
    expect(estimated.estimated).toBe(true);
    expect(estimated.name).toBe('Test bore');
    expect(estimated.limit).toBeLessThan(scan.limit);
    expect(estimated.limit).toBeLessThanOrEqual(scan.limit);
  });
});

// #287 — a single-line trace (#219) used to reach every gate except the CAM, so a job with one
// generated a program that cut everything BUT the trace: no warning, no refusal, and a run sheet
// implying otherwise. These pin the wiring that fixes it.
describe('a trace item reaches the program (#287)', () => {
  /** A two-point horizontal trace 30 mm long starting at `x`, 0.8 mm deep. */
  const traceLine = (x: number): EngraveLineItem => ({
    kind: 'line',
    id: 'tr',
    position: { x, y: 30 },
    rotation: 0,
    points: [
      [0, 0],
      [30, 0],
    ],
    closed: false,
    depth: 0.8,
    enabled: true,
  });

  const jobWithTrace = (): EngraveJob => {
    const base = defaultEngraveJob();
    return { ...base, labels: [base.labels[0]!], shapes: [], traces: [traceLine(10)] };
  };

  it('emits an operation for the trace, appended after the region operations', () => {
    const g = generate(tl, jobWithTrace());
    expect(g.ok).toBe(true);
    expect(g.stage).toBe('done');
    // One label region + one trace: the trace is not silently dropped.
    expect(g.cam!.operations).toBe(2);
    expect(g.cam!.cuttingMoves).toBeGreaterThan(0);
    expect(g.nc).toContain('Engrave "CASE"');
    // Named the way `traceOperationName` words it, with the depth `generateTrace` appends.
    expect(g.nc).toContain('Trace line (2 points) 0.8mm');
    expect(g.nc!.indexOf('Trace line')).toBeGreaterThan(g.nc!.indexOf('Engrave "CASE"'));
    // The verifier reads the posted text, so it sees the trace moves too.
    expect(g.verify!.findings.filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('predicts the trace cutter SWEEP, or the oracle would read its own groove as an over-cut', () => {
    const g = generate(tl, jobWithTrace());
    // A 30 mm capsule on a 1.0 mm cutter: 30 + π·0.5² ≈ 30.785 mm², minus the polygonisation of
    // the two round caps — so a band, not a closed form to the last digit.
    const trace = g.predicted.find((p) => Math.abs(p.depth - 0.8) < 1e-9);
    expect(trace).toBeDefined();
    const cs = tl.CrossSection.ofPolygons(trace!.polygons);
    const area = cs.area();
    cs.delete();
    expect(area).toBeGreaterThan(30);
    expect(area).toBeLessThan(31);
    // ...and the label's own region is predicted too, so the two depths both appear.
    expect(g.predicted.some((p) => Math.abs(p.depth - 2.0) < 1e-9)).toBe(true);
  });

  it('leaves a job with no traces alone', () => {
    // The identity the byte-identity of every pre-#287 program rests on: no trace, no extra
    // operation, no extra predicted level.
    const g = generate(tl, defaultEngraveJob());
    expect(g.cam!.operations).toBe(3);
    expect(g.predicted).toHaveLength(3);
    expect(g.nc).not.toContain('Trace');
  });

  // The tests above would all pass if the trace's moves went somewhere arbitrary. The verifier's
  // own parse of the posted text gives the program's depth and move count, so this pins WHERE the
  // cut lands: a trace-only job (no region items at all — which the post used to refuse outright)
  // must carry the trace's own endpoints at the item's depth, negative Z.
  it('cuts the trace where the item says, at the item depth', () => {
    const g = generate(tl, {
      ...defaultEngraveJob(),
      labels: [],
      shapes: [],
      // 15 mm long from x 80 to 95 at y 10, 0.8 mm deep: the whole job, so every coordinate in
      // the program belongs to the trace (the extent check below is why).
      traces: [{ ...traceLine(80), position: { x: 80, y: 10 }, points: [[0, 0], [15, 0]] }],
    });
    expect(g.ok).toBe(true);
    expect(g.nc).not.toBeNull();
    expect(g.cam!.operations).toBe(1);
    // The endpoints, as the machine reads them. The post trims trailing zeros, so `X95` is the
    // whole program's far end; the lookahead keeps `X950` out of the match.
    expect(g.nc).toMatch(/X80(?![.\d])/);
    expect(g.nc).toMatch(/X95(?![.\d])/);
    expect(g.nc).toMatch(/Y10(?![.\d])/);
    // Cut BELOW the top face (work Z is negative down) to the item's depth. The program's bbox is
    // not usable here: the post's own ending is `G28`, a machine home, which the verifier counts
    // as a move and which reaches far past the work.
    expect(g.verify!.stats.deepestZ).toBeCloseTo(-0.8, 6);
    expect(g.verify!.stats.cuttingMoves).toBeGreaterThan(0);
  });
});

// #324 — the catalogue has to reach the WORKER, not just the panel. `feeds.ts` holds Makera's rows
// as module state the main thread owns; the sim worker is a separate module realm whose copy of
// that state is always empty, so a generate that resolved feeds in there posted the STARTING
// TABLE's numbers — and the run sheet, built from the same result, printed them too — while the
// panel showed the catalogue's. These two cases are that pair: the same job, hand-built ×2.
describe('the feed catalogue reaches the worker (#324)', () => {
  /** The vendor's id for the 3.175 × 12 mm flat end, which the built-in tier also carries. */
  const VENDOR_ID = '112111313812';
  /** Makera's numbers for that cutter in hardwood. Hand-built, never vendor data (§3, #186). */
  const HARDWOOD_ROW: FeedCatalogueRow = {
    cutterId: VENDOR_ID,
    material: 'Hardwood',
    rpm: 9800,
    feed: 700,
    plungeFeed: 250,
    stepDown: 0.7,
  };
  /** What the STARTING table says for the same cutter and material — the numbers this must not use. */
  const starting = UNMEASURED_FEEDS_TABLE.find(
    (e) => e.material === 'hardwood' && e.minDiameter <= 3.175 && 3.175 <= e.maxDiameter,
  );
  if (!starting || starting.params.rpm === HARDWOOD_ROW.rpm) throw new Error('the fixture must differ');

  /**
   * A hardwood job in the ⌀3.175 flat end, cutting one 10 × 10 pocket 1.0 mm deep. The cutter is
   * the vendor id the row names — that is what this case is about — under a plain name: the built-in
   * row's own `(Metal)` spelling is on Makera's metal line, and a hardwood job carrying it is now
   * refused by `tool-metal-line` (#407), which would mask the catalogue question under test.
   */
  function job(): EngraveJob {
    return {
      ...defaultEngraveJob(),
      toolKey: 'flat-3.175x12-metal',
      tool: flatEndMill(3.175, {
        id: VENDOR_ID,
        name: '3.175*12mm Flat End',
        fluteLength: 12,
        shoulderLength: 12,
      }),
      stock: { ...defaultEngraveJob().stock, material: 'hardwood' },
      labels: [],
      shapes: [
        {
          id: 'a',
          name: 'A',
          kind: 'rect',
          position: { x: 50, y: 30 },
          rotation: 0,
          depth: 1.0,
          enabled: true,
          width: 10,
          height: 10,
          cornerRadius: 0,
        },
      ],
    };
  }

  it('posts the catalogue’s S and F into the .nc, not the starting table’s', () => {
    const g = generate(tl, job(), null, [HARDWOOD_ROW]);
    expect(g.ok).toBe(true);
    expect(g.feeds?.ok).toBe(true);
    if (!g.feeds?.ok) throw new Error('feeds should resolve');
    expect(g.feeds.catalogue).toEqual(HARDWOOD_ROW);
    expect(g.feeds.params.rpm).toBe(HARDWOOD_ROW.rpm);
    expect(g.feeds.params.stepDown).toBe(HARDWOOD_ROW.stepDown);

    // What the machine runs: the spindle word and the two feed words, as the post writes them.
    const nc = g.nc!;
    expect(nc).toContain(`S${HARDWOOD_ROW.rpm} M3`);
    expect(nc).toContain(`F${HARDWOOD_ROW.feed}`);
    expect(nc).toContain(`F${HARDWOOD_ROW.plungeFeed}`);
    // …and NOT the row this job would have resolved with no catalogue at all.
    expect(nc).not.toContain(`S${starting.params.rpm}`);
    expect(nc).not.toContain(`F${starting.params.feed}`);
    expect(nc).not.toContain(`F${starting.params.plungeFeed}`);
  });

  it('prints those same numbers on the run sheet the operator reads', () => {
    const g = generate(tl, job(), null, [HARDWOOD_ROW]);
    const cut = buildRunSheet(job(), g, null).sections.find((s) => s.id === 'cut');
    expect(cut).toBeTruthy();
    const value = cut!.steps.map((s) => s.value ?? '').join(' ');
    expect(value).toContain(`${HARDWOOD_ROW.rpm} RPM`);
    expect(value).toContain(`${HARDWOOD_ROW.feed} mm/min feed`);
    expect(value).toContain(`${HARDWOOD_ROW.plungeFeed} mm/min plunge`);
    expect(value).toContain(`${HARDWOOD_ROW.stepDown} mm passes`);
  });

  it('with no rows handed over, is exactly what the worker used to produce', () => {
    // The control, and the defect itself: `[]` is the worker's own module state, which is why the
    // panel and the program disagreed before #324.
    const g = generate(tl, job(), null, []);
    expect(g.ok).toBe(true);
    expect(g.nc).toContain(`S${starting.params.rpm} M3`);
    expect(g.nc).toContain(`F${starting.params.feed}`);
  });
});

describe('the frame file (#244)', () => {
  /** An IR with two positioned moves, for the pure geometry. Only `operations` is read. */
  function miniIr(moves: ToolpathIR['operations'][number]['moves']): ToolpathIR {
    return {
      frame: 'flat',
      tool: { id: 0, name: 't' } as unknown as Tool,
      toolNumber: 1,
      spindleRpm: 12000,
      air: false,
      safeZ: 5,
      hopZ: 1,
      operations: [{ number: 1, name: 'x', labelId: '', depth: 0, moves, estimatedSeconds: 0 }],
    };
  }

  it('traces a closed rectangle of rapids around the cut footprint, grown by the radius', () => {
    const ir = miniIr([
      { kind: 'rapid', x: 0, y: 0, z: 0 },
      { kind: 'feed', x: 10, y: 6, z: -1, f: 100 },
    ]);
    const corners = frameCorners(ir, 0.5, 20);
    expect(corners).not.toBeNull();
    expect(corners!.map((m) => [m.x, m.y] as [number, number])).toEqual([
      [-0.5, -0.5],
      [10.5, -0.5],
      [10.5, 6.5],
      [-0.5, 6.5],
      [-0.5, -0.5],
    ]);
    // Rapids only — the frame cuts nothing — and all at the frame height.
    expect(corners!.every((m) => m.kind === 'rapid' && m.z === 20)).toBe(true);
  });

  it('has no trace when the toolpath has no positioned move', () => {
    expect(frameCorners(miniIr([]), 0.5, 20)).toBeNull();
  });

  it('produces a verified frame program beside a clean job', () => {
    const g = generate(tl, defaultEngraveJob());
    expect(g.ok).toBe(true);
    expect(g.frameNc).not.toBeNull();
    expect(g.frameNc!.startsWith(';@MKR|BEGIN')).toBe(true);
    expect(g.frameNc!.trimEnd().endsWith('M02')).toBe(true);
    // Verified by the SAME verifier, and it cuts nothing.
    expect(g.frameVerify).not.toBeNull();
    expect(g.frameVerify!.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(g.frameVerify!.stats.cuttingMoves).toBe(0);
    // The trace sits at FRAME_Z (20) above the work; the program's own retract is lower but still
    // positive, so the whole body is clear of the stock.
    expect(g.frameVerify!.stats.bbox.max[2]).toBeCloseTo(20, 6);
    expect(g.frameVerify!.stats.bbox.min[2]).toBeGreaterThan(0);
  });

  it('offers no frame when the job is refused', () => {
    const deep: EngraveJob = {
      ...defaultEngraveJob(),
      labels: defaultEngraveJob().labels.map((l, i) => (i === 0 ? { ...l, depth: 11.5 } : l)),
    };
    const g = generate(tl, deep);
    expect(g.ok).toBe(false);
    expect(g.frameNc).toBeNull();
    expect(g.frameVerify).toBeNull();
  });
});

// #405 — a V-bit TRACE job, end to end. Two rules hold the whole feature up, and both are here: a
// V-bit is NEVER swept as a flat end mill (its groove is the cone's, and the column engine is the
// authority for it), and a V-bit is never a stand-in for a flat end mill on a REGION (opening a
// glyph needs ONE cutting width; the V-carve that would lift that stays in #221).
describe('a V-bit trace job (#405)', () => {
  /** The text job's default cutter: the 30° engraving bit, 0.3 mm tip, 3.175 mm shank. */
  const bit30 = (over: Partial<Tool> = {}): Tool =>
    flatEndMill(0.3, {
      name: 'Single Flute Engraving Bit 30 x 0.3',
      typeText: 'Engraving',
      shape: 'engraving',
      handleDiameter: 3.175,
      diameter: 3.175,
      tipDiameter: 0.3,
      angle: 30,
      halfAngle: 15,
      ...over,
    });

  /**
   * The bench blank with `traces` as the only enabled items: 38.1 × 76.2 × 3.81 mm PLA, a 1.0 mm
   * floor and a 1.0 mm edge margin, and the vise seated so the blank stands proud — the job's own
   * numbers from `docs/bench/single-barrel.job.json`.
   */
  const traceJob = (traces: EngraveTraceItem[], over: Partial<EngraveJob> = {}): EngraveJob => {
    const base = defaultEngraveJob();
    return {
      ...base,
      name: 'single barrel',
      stock: { length: 38.1, width: 76.2, thickness: 3.81, material: 'pla' },
      labels: [],
      shapes: [],
      toolKey: 'inv:kz-engrave-30-0-3',
      tool: bit30(),
      minFloor: 1,
      edgeMargin: 1,
      breakthrough: 0.3,
      workholding: { ...base.workholding, vise: { ...base.workholding.vise, stockProud: 1.2 } },
      traces,
      ...over,
    };
  };

  /** A Hershey stroke-label trace, reading along +Y (rotation 90°) like the bench job's two lines. */
  const label = (
    id: string,
    text: string,
    size: number,
    x: number,
    depth = 1,
    over: Partial<EngraveStrokeLabelItem> = {},
  ): EngraveStrokeLabelItem => ({
    id,
    kind: 'stroke-label',
    text,
    font: 'hershey-simplex',
    size,
    position: { x, y: 38.1 },
    rotation: 90,
    depth,
    enabled: true,
    ...over,
  });

  /** The COMMITTED bench job, straight off disk — the real document, not a re-typed copy. */
  const benchJob = (): EngraveJob => {
    const raw = readFileSync(new URL('../../../docs/bench/single-barrel.job.json', import.meta.url), 'utf8');
    const parsed = parseEngraveJob(JSON.parse(raw));
    if (!parsed.ok) throw new Error(parsed.errors.join('; '));
    return parsed.job;
  };

  /** Motion lines only: the header carries the app version and the tool record, not geometry. */
  const motionLines = (nc: string): string[] =>
    nc
      .split('\n')
      .filter((l) => /^\s*G[01]\b/.test(l))
      .map((l) => l.trim());

  /**
   * A #409-PREVIEW variant of the title line. This is NOT what `docs/bench/single-barrel.job.json`
   * states — that job carries none of the new fields and is the plain V-bit job (see the committed
   * job test below). These are the values the #409 preview was cut from: bigger, bold, condensed and
   * spaced so the letters stay a groove apart and the line stays inside the blank's edge margin. The
   * line runs along +Y, so the length the margin bounds is Y.
   */
  const title = (x = 13.69): EngraveTraceItem =>
    label('title', 'Single Barrel', 8.6, x, 1, { widthScale: 0.78, weight: 1.5, spacing: 'cut-width' });

  it('cuts the COMMITTED bench job end to end and regenerates its motion lines byte-for-byte', () => {
    // The plain V-bit path, against the real document. `docs/bench/single-barrel.job.json` states
    // none of the #409 fields, so it must produce exactly the .nc committed beside it — the default
    // identity the #409 review asked for, pinned on the MOTION lines.
    const g = generate(tl, benchJob());
    expect(g.ok).toBe(true);
    expect(g.verify!.findings.filter((f) => f.severity === 'error')).toEqual([]);
    // Two operations, one per trace (#219's CAM appends after the region CAM's — here there is none).
    expect(g.cam!.operations).toBe(2);
    // The hand file's own numbers (#185), now reached through the feeds row.
    expect(g.nc).toContain('S12000');
    expect(g.nc).toContain('G1 Z-1 F200');
    expect(g.nc).toContain('F500');
    // The header states the CONE — a reader that only saw `diameter=3.175` would picture a shank-wide
    // cutter. `type=Engraving` is OUR word for a non-flat cutter (#268/#187, see `post/z1.ts`).
    expect(g.nc).toContain('tipdiameter=0.3');
    expect(g.nc).toContain('|angle=30|halfAngle=15');
    expect(g.nc).toContain('type=Engraving');
    // The tool record the app writes names the cutter it was written for (#332).
    expect(g.nc).toContain(';@CM|TOOL|key=inv:kz-engrave-30-0-3');
    const committed = readFileSync(new URL('../../../docs/bench/single-barrel.nc', import.meta.url), 'utf8');
    expect(motionLines(g.nc!)).toEqual(motionLines(committed));
  });

  it('cuts two BOLD, condensed, spaced stroke-label traces with the same bit (#409 fields)', () => {
    const job = traceJob([
      title(),
      label('sub', '(Like the Whiskey)', 5.4, 25.64, 1, { widthScale: 0.94, spacing: 'cut-width' }),
    ]);
    const g = generate(tl, job);
    expect(g.ok).toBe(true);
    expect(g.verify!.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(g.cam!.operations).toBe(2);
    expect(g.nc).toContain('S12000');
    expect(g.nc).toContain('G1 Z-1 F200');
    expect(g.nc).toContain('F500');
    // ONE pass straight to depth: EVERY plunge line lands on -1 and no intermediate depth is cut.
    // (A Hershey label is many separate strokes — one plunge each, ~50 for these two lines together
    // — so the count is not the pass count; the DEPTHS are, and there is only one of them.)
    const plunges = g.nc!.match(/G1 Z-[\d.]+ F\d+/g) ?? [];
    expect(plunges.length).toBeGreaterThan(0);
    expect(plunges.every((line) => line.includes('Z-1 F200'))).toBe(true);
    expect(g.nc).not.toMatch(/G1 Z-0\./);
    expect(g.nc).toContain('tipdiameter=0.3');
    expect(g.nc).toContain('|angle=30|halfAngle=15');
    expect(g.nc).toContain('type=Engraving');
    expect(g.nc).toContain(';@CM|TOOL|key=inv:kz-engrave-30-0-3');
    // Bold really widened the strokes: more motion than the one-pass-per-stroke default.
    expect(motionLines(g.nc!).length).toBeGreaterThan(0);
  });

  it('never takes the flat path: `cuttingRadiusForSweep` refuses the cone, the trace path takes it', () => {
    // This is the hard rule. The exact 2.5D sweeper has ONE radius and a cone has none, so it must
    // keep refusing — and the trace path, which knows the depth, is where a V-bit is accepted.
    const v = cuttingRadiusForSweep(bit30());
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error('a V-bit must not have a single sweep radius');
    expect(v.reason).toContain('flat end mill only');

    const trace = cuttingForTrace(bit30());
    expect(trace.ok).toBe(true);
    if (!trace.ok) throw new Error(trace.reason);
    expect(trace.tool.shape).toBe('v');
    expect(isVTraceTool(bit30())).toBe(true);
    // A flat end mill still answers the same shape it always did.
    expect(cuttingForTrace(flatEndMill(1.0))).toMatchObject({ ok: true, tool: { shape: 'flat', radius: 0.5 } });
  });

  it('refuses a REGION cut with a V-bit by name, pointing at #221', () => {
    const job = traceJob([title()], {
      labels: defaultEngraveJob().labels.slice(0, 1),
    });
    const g = generate(tl, job);
    expect(g.ok).toBe(false);
    expect(g.stage).toBe('findings');
    expect(g.nc).toBeNull();
    const refusal = g.findings.find((f) => f.code === 'region-v-carve-unavailable');
    expect(refusal).toBeDefined();
    expect(refusal!.severity).toBe('error');
    expect(refusal!.message).toContain('#221');
    // A refusal of the REGION, not of the cutter: the same tool cuts the same job's trace.
    expect(g.nc).toBeNull();
  });

  it('REFUSES a METAL-line V-bit on a PLA job, by name', () => {
    // The 30°/60° engravers Makera lists for metal are not the cutters for a PLA blank — the
    // maintainer's ruling, and the claim is about the PAIR — so the job stops rather than being
    // cut on numbers nobody measured (#405 review). The name alone states the line here.
    const metal = bit30({ name: 'Engraving V-bit 30 x 0.5 (Metal)', tipDiameter: 0.5, diameter: 3.175 });
    const job = traceJob([title()], { tool: metal });
    const g = generate(tl, job);
    expect(g.ok).toBe(false);
    expect(g.stage).toBe('findings');
    expect(g.nc).toBeNull();
    const refusal = g.findings.find((f) => f.code === 'tool-metal-line');
    expect(refusal).toBeDefined();
    expect(refusal!.severity).toBe('error');
    expect(refusal!.message).toContain(metal.name); // the refusal NAMES the cutter
    expect(refusal!.message).toContain('PLA');
  });

  it('refuses a metal-line V-bit named by its BOX CODE too — the `-M-` segment', () => {
    // `C1-BIT-ENGRAVE-M-60-0.1` states the line in its code as well as in its name: the code is the
    // half that survives a renamed or shortened cutter, and a job carrying a code files it as the
    // `Tool`'s `id` (our post writes `id=…`). This cutter's name is a STUB — the real label's
    // "…for Metal…" phrase is not in it — so the code half is the only thing that can catch it here.
    const byCode = bit30({
      name: 'Single Flute Engraving Bit 60 x 0.1',
      id: 'C1-BIT-ENGRAVE-M-60-0.1',
      tipDiameter: 0.1,
      angle: 60,
      halfAngle: 30,
    });
    const job = traceJob([title()], { tool: byCode });
    const g = generate(tl, job);
    expect(g.ok).toBe(false);
    const refusal = g.findings.find((f) => f.code === 'tool-metal-line');
    expect(refusal).toBeDefined();
    expect(refusal!.severity).toBe('error');
    // …and the same cutter on a METAL blank is exactly what that bit is for: no refusal.
    const onMetal = generate(tl, traceJob([title()], {
      tool: byCode,
      stock: { length: 38.1, width: 76.2, thickness: 3.81, material: 'aluminium-6061' },
    }));
    expect(onMetal.findings.some((f) => f.code === 'tool-metal-line')).toBe(false);
  });

  it('refuses an OWNED metal-line V-bit as the inventory actually files it — label name, id null', () => {
    // The shape a job really carries for `inv:kz-engrave-m-60-0-1`: `toolRegistry.inventoryEntryFor`
    // hands the job the inventory's own snapshot, whose `id` is `null` (the box code lives on the
    // possession as `codes[].value`, not on the cutter). The label names the line as the phrase
    // "for Metal", which does NOT end in `(Metal)` and is the only statement left — so a reading
    // that needed the code, or only the `(Metal)` suffix, would let the 60° bit this house owns cut
    // PLA (#405 review). This is the cutter the review named.
    const owned = bit30({
      name: 'Single Flute Engraving Bit for Metal - 1/8" Shank 60° * 0.1mm',
      id: null,
      tipDiameter: 0.1,
      angle: 60,
      halfAngle: 30,
    });
    const g = generate(tl, traceJob([title()], { tool: owned }));
    expect(g.ok).toBe(false);
    expect(g.stage).toBe('findings');
    expect(g.nc).toBeNull();
    const refusal = g.findings.find((f) => f.code === 'tool-metal-line');
    expect(refusal).toBeDefined();
    expect(refusal!.severity).toBe('error');
    expect(refusal!.message).toContain('60'); // the refusal NAMES the cutter it stopped
    expect(refusal!.message).toContain('PLA');
  });

  // #407 — the metal-line refusal is about the PAIR (the bit's line and the blank's material), so
  // it is judged for EVERY cutter, not only the cones `vCutterFindings` runs for. Makera's built-in
  // `flat-3.175x12-metal` row is the cutter the scoping gap let through: a flat end mill ground and
  // coated for metal, cutting PLA on numbers nobody measured for it.
  /** Makera's built-in metal FLAT end mill, named exactly as its catalogue row spells it. */
  const metalFlat = (over: Partial<Tool> = {}): Tool =>
    flatEndMill(3.175, {
      id: '112111313812',
      name: '3.175*12mm Flat End(Metal)',
      fluteLength: 12,
      shoulderLength: 12,
      ...over,
    });

  it('REFUSES Makera’s metal FLAT end mill on PLA — the check is not V-scoped (#407)', () => {
    const flat = metalFlat();
    const job = traceJob([title()], { toolKey: 'flat-3.175x12-metal', tool: flat });
    const g = generate(tl, job);
    expect(g.ok).toBe(false);
    expect(g.stage).toBe('findings');
    expect(g.nc).toBeNull();
    const refusal = g.findings.find((f) => f.code === 'tool-metal-line');
    expect(refusal).toBeDefined();
    expect(refusal!.severity).toBe('error');
    expect(refusal!.message).toContain(flat.name); // the refusal NAMES the cutter
    expect(refusal!.message).toContain('PLA');
  });

  it('does not refuse the same metal FLAT on a metal blank (#407)', () => {
    // The pair is what the finding judges: the same cutter is exactly the one aluminium wants.
    const job = traceJob([title()], {
      toolKey: 'flat-3.175x12-metal',
      tool: metalFlat(),
      stock: { length: 38.1, width: 76.2, thickness: 3.81, material: 'aluminium-6061' },
    });
    const g = generate(tl, job);
    expect(g.findings.some((f) => f.code === 'tool-metal-line')).toBe(false);
  });

  it('refuses a `-M-`-coded FLAT end mill on WOOD too (#407)', () => {
    // The code half of `isMetalTool` was already correct; the reach is what #407 fixes. A flat whose
    // NAME says nothing about the line is still refused when its box code carries the segment.
    const coded = flatEndMill(3.175, { id: 'C1-BIT-FLAT-M-3.175-12', name: 'Flat End 3.175' });
    const job = traceJob([title()], {
      toolKey: 'flat-3.175x12-metal',
      tool: coded,
      stock: { length: 38.1, width: 76.2, thickness: 3.81, material: 'hardwood' },
    });
    const g = generate(tl, job);
    expect(g.ok).toBe(false);
    expect(g.stage).toBe('findings');
    const refusal = g.findings.find((f) => f.code === 'tool-metal-line');
    expect(refusal).toBeDefined();
    expect(refusal!.severity).toBe('error');
    expect(refusal!.message).toContain(coded.name);
  });

  it('is swept by the COLUMN engine, and the run sheet says so (#405)', () => {
    const job = traceJob([title()]);
    const g = generate(tl, job);
    expect(g.ok).toBe(true);
    const session = createSimSession(tl);
    try {
      const load = session.load(g.nc as string, toSetup(job, Z1), jobTool(job)!, Z1.id);
      expect(load.ok).toBe(true);
      if (!load.ok) throw new Error(JSON.stringify(load.diagnostics));
      // The one vocabulary for which backend produced the numbers. A V trace can never read 'exact'.
      expect(load.stats.engine).toBe('column');
      expect(load.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      const sheet = buildRunSheet(job, g, { diagnostics: load.diagnostics, outcome: 'swept', engine: load.stats.engine });
      expect(JSON.stringify(sheet)).toContain('sampled column engine');
      // A trace-only job steps over nothing, so the sheet must not instruct a step-over (#191's
      // `stepOverFraction` is inert for a cone — see the PLA V row in `feeds.ts`).
      const cut = sheet.sections.find((s) => s.id === 'cut');
      const value = cut!.steps.map((s) => s.value ?? '').join(' ');
      expect(value).toContain('no step-over');
      expect(value).not.toContain('mm step-over');
    } finally {
      session.dispose();
    }
  });

  it('reads the merge threshold off the groove WIDTH at the trace’s depth, not the tip', () => {
    // The width oracle the whole feature turns on: `w(d) = tip + 2·d·tan(halfAngle)`. Two strokes
    // 0.5 mm apart merge at 1.0 mm deep (0.836 mm wide) and do not at 0.1 mm (0.354 mm wide) — so
    // the radius handed to the check has to be a function of depth, which is what `traceRadiusAt` is.
    const r1 = traceRadiusAt(bit30(), 1);
    const r01 = traceRadiusAt(bit30(), 0.1);
    expect(r1).toBeCloseTo(0.8359 / 2, 4);
    expect(r01).toBeCloseTo(0.1768, 4);
    const paths: [number, number][][] = [
      [[0, 0], [30, 0]],
      [[0, 0.5], [30, 0.5]],
    ];
    expect(traceSelfOverlaps(paths, [false, false], r1!)).toHaveLength(1);
    expect(traceSelfOverlaps(paths, [false, false], r01!)).toHaveLength(0);
    // A flat end mill's opening does not depend on the depth, which is why one number used to do.
    expect(traceRadiusAt(flatEndMill(1.0), 1)).toBe(0.5);
    expect(traceRadiusAt(flatEndMill(1.0), 2.5)).toBe(0.5);
  });
});

/**
 * A milled thread through the whole pipeline (#445, #434 phase 2). The thread branch sits BEFORE
 * `cuttingForTrace` and `feedsFor` — a thread mill is refused by both, correctly for the
 * region/trace CAM — and resolves `threadSettings` instead. The `thread.*` seeds are not registered
 * yet, so the settings are the caller's: a stored map, which `readDefault` accepts without asking
 * `KNOWN_DEFAULTS` (that registry is the coordinator's to land).
 */
describe('engraveGenerate with a milled thread (#445)', () => {
  const MILL: Tool = flatEndMill(4, {
    name: '4 mm thread mill',
    typeText: 'Thread Mill',
    shape: 'thread',
    tipDiameter: 4,
    diameter: 4,
    fluteLength: 20,
  });
  const THREAD = (over: Partial<EngraveThreadItem> = {}): EngraveThreadItem => ({
    kind: 'thread',
    id: 'thr-a',
    position: { x: 50, y: 30 },
    enabled: true,
    size: 'M5',
    standard: 'metric',
    classFit: '6H',
    depth: 5,
    through: false,
    ...over,
  });
  const DEFAULTS = {
    'thread.radialStepoverMm': { value: 0.2, source: 'seeded' },
    'thread.entryRampMm': { value: 0.5, source: 'seeded' },
    'thread.bottomClearancePitches': { value: 1, source: 'seeded' },
    'thread.pilotTipClearanceMm': { value: 0.5, source: 'seeded' },
    'thread.feed': { value: 300, source: 'seeded' },
    'thread.plungeFeed': { value: 100, source: 'seeded' },
    'thread.spindleRpm': { value: 10000, source: 'seeded' },
    'thread.chordToleranceMm': { value: 0.01, source: 'seeded' },
  } as unknown as ShopDefaults;
  const job = (threads: EngraveThreadItem[]): EngraveJob => ({
    ...defaultEngraveJob(),
    labels: [],
    shapes: [],
    traces: [],
    drills: [],
    tool: MILL,
    threads,
  });
  const gen = (threads: EngraveThreadItem[]) => engraveGenerate(tl, job(threads), MILL, [], null, undefined, { defaults: DEFAULTS });

  it('takes a thread-only job all the way to a clean .nc', () => {
    const g = gen([THREAD()]);
    expect(g.stage).toBe('done');
    expect(g.ok).toBe(true);
    // The thread's plan is what the panel and the sim's load read — not a fabricated disc.
    expect(g.threads).toHaveLength(1);
    expect(g.threads![0]!.simThreads).toEqual([{ x: 50, y: 30, majorMm: 5, minorMm: 4.134, pitchMm: 0.8, threadDepthMm: 5, through: false }]);
    // #445 phase B — the run sheet prints the numbers AND their provenance, so the worker carries
    // the resolved settings across instead of letting the sheet resolve them a second time.
    expect(g.threadMachining).not.toBeNull();
    expect(g.threadMachining!.settings.feed).toBe(300);
    expect(typeof g.threadMachining!.sources.feed).toBe('string');
    expect(g.cam!.operations).toBe(1);
    expect(g.nc).not.toBeNull();
    expect(g.verify!.findings.filter((f) => f.severity === 'error')).toEqual([]);
    // The helical cutting moves are on the wire; the tip runs a pitch of run-out past the thread.
    expect(g.verify!.stats.deepestZ).toBeCloseTo(-5.8, 3);
  });

  it('two threads are ONE program, one tool, and operations renumbered', () => {
    const g = gen([THREAD(), THREAD({ id: 'thr-b', position: { x: 70, y: 30 } })]);
    expect(g.ok).toBe(true);
    expect(g.threads).toHaveLength(2);
    expect(g.cam!.operations).toBe(2);
    expect(g.verify!.findings.filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('a thread beside another cut is refused by the findings gate before any CAM', () => {
    const g = gen([THREAD()]);
    const mixed: EngraveJob = { ...job([THREAD()]), labels: defaultEngraveJob().labels };
    const out = engraveGenerate(tl, mixed, MILL, [], null, undefined, { defaults: DEFAULTS });
    expect(out.ok).toBe(false);
    expect(out.stage).toBe('findings');
    expect(out.threads).toBeNull();
    // Nothing was resolved, so nothing is claimed: the sheet says the source is not recorded.
    expect(out.threadMachining).toBeNull();
    expect(g.ok).toBe(true); // the thread alone still passes — the refusal is the mixing
  });

  it('a tool that is not a thread mill is refused before the branch is taken', () => {
    const out = engraveGenerate(tl, { ...job([THREAD()]), tool: flatEndMill(4) }, flatEndMill(4), [], null, undefined, { defaults: DEFAULTS });
    expect(out.ok).toBe(false);
    expect(out.stage).toBe('findings');
    expect(out.findings.some((f) => f.code === 'thread-wrong-tool')).toBe(true);
  });
});
