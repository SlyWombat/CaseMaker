// The generate → verify headless pipeline (#206). Real Manifold, plain Node — the same harness
// `engravePreview.spec.ts` uses. This is the half that must be byte-identical run to run: the
// `.nc` a user saves is the text this function returns, never a re-derivation.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

import { parseEngraveJob } from '@/store/engraveJobSchema';
import { tl } from './helpers/manifoldExec';
import { generate, regions } from './helpers/engravePipeline';
import { frameCorners, engraveGenerate } from '@/workers/sim/engraveGenerate';
import type { EngraveShopOpts } from '@/workers/sim/engraveGenerate';
import type { MountObstacle, MountObstacles } from '@/engine/cnc/mounts';
import { TOOL_LIBRARY, type ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { ShopDefaults } from '@/platform/defaultsClient';
import { UNMEASURED_FEEDS_TABLE, type FeedCatalogueRow } from '@/engine/cnc/feeds';
import { buildRunSheet } from '@/engine/cnc/engrave/runSheet';
import { defaultBoundaryMargin } from '@/engine/cnc/engrave/depthBounds';
import { labelGlyphMeasure, traceSelfOverlaps, voidLimitForItem } from '@/engine/cnc/engrave/partPlan';
import { effectiveMargins, MARGIN_DEFAULTS } from '@/engine/cnc/engrave/depthBounds';
import { bindingVoidsByRegion } from '@/workers/sim/engraveGeometry';
import { createSimSession } from '@/workers/sim/session';
import { jobTool, setupProgramFindings, toSetup } from '@/engine/cnc/engrave/jobSetup';
import { setupPrograms } from '@/engine/cnc/engrave/programs';
import { Z1 } from '@/engine/cnc/machine';
import {
  itemConditionSummary,
  type Condition,
  type ConditionSummary,
  type ToolCopy,
} from '@/engine/cnc/toolCondition';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { CAM_ID, CAM_NAME } from '@/engine/cnc/post/z1';
import { programHash } from '@/engine/cnc/programHash';
import { version as APP_VERSION } from '../../package.json';
import { presetPartOnBoard } from '@/engine/cnc/sacrificial';
import { calibrationFromReplies } from '@/engine/cnc/calibration';
import { Z1_FRAME_REPLIES } from './fixtures/z1Frame';
import { badgeBlankFor } from '@/engine/cnc/engrave/fromBadge';
import { viseForNewJob } from '@/engine/cnc/fixture';
import { defaultBadgeParams } from '@/types/badge';
import type { ToolpathIR } from '@/engine/cnc/cam/ir';
import { cuttingForTrace, cuttingRadiusForSweep, flatEndMill, isVTraceTool, traceRadiusAt, type Tool } from '@/engine/cnc/tool';
import { toolDisplayName } from '@/engine/cnc/toolDisplay';
import type { EngraveCutout, EngraveDrill, EngraveJob, EngraveKeepOut, EngraveLabel, EngraveLineItem, EngraveStrokeLabelItem, EngraveThreadItem, EngraveTraceItem, EngraveVectorShape } from '@/types/engraveJob';

/**
 * #516 item 5 — the default job no longer seeds a cutter; the recommendation names `flat-1.0` for
 * the default job's three labels. These tests exercise the ENGINE, which requires the job to name
 * its cutter (the panel applies the recommendation before the engine runs), so `dj()` is the
 * default job with that recommendation applied.
 */
function dj(...args: Parameters<typeof defaultEngraveJob>): EngraveJob {
  const job = defaultEngraveJob(...args);
  job.toolKey = 'flat-1.0';
  return job;
}

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
    const without = generate(tl, dj());
    const withFrame = generate(tl, dj(), read.calibration);
    expect(withFrame.ok).toBe(true);
    expect(withFrame.nc).toBe(without.nc);
    expect(withFrame.verify!.findings.filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('ignores a frame saved for a different machine, exactly as the simulation does', () => {
    const other = { ...read.calibration, machineId: 'Z1-other' };
    const g = generate(tl, dj(), other);
    expect(g.ok).toBe(true);
    expect(g.nc).toBe(generate(tl, dj()).nc);
  });
});

describe('engraveGenerate (#206)', () => {
  it('takes the default job all the way to a clean .nc', () => {
    const g = generate(tl, dj());
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
    const g = generate(tl, dj());
    expect(g.nc).not.toBeNull();
    // The exact header line the app writes; a headless run must match it byte for byte.
    expect(g.nc).toContain(`;@MKR|CAM|id=${CAM_ID}|name=${CAM_NAME}|v=${APP_VERSION}`);
    expect(g.nc).not.toContain('v=dev');
  });

  it('is pure: the same job produces byte-identical nc', () => {
    const job = dj();
    const a = generate(tl, job);
    const b = generate(tl, structuredClone(job) as EngraveJob);
    expect(a.nc).not.toBeNull();
    expect(a.nc).toBe(b.nc);
  });

  it('stops at findings for a cut deeper than the stock allows', () => {
    const job = dj();
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
    const job: EngraveJob = { ...dj(), cutOverride: { stepOver: 0.6 } }; // radius is 0.5
    const g = generate(tl, job);
    expect(g.ok).toBe(false);
    expect(g.stage).toBe('feeds');
    expect(g.nc).toBeNull();
    expect(g.feeds?.ok).toBe(false);
    expect(g.errors.some((e) => e.stage === 'feeds')).toBe(true);
  });

  it('stops at findings when the cutter is too large for the text', () => {
    // The built-in row is Makera's `(Metal)` cutter, refused on a softwood blank (#407) — so the
    // job carries the same cutter under a plain name, and this case is about the SIZE that fails
    // the text rather than about a refusal it did not ask for.
    const job: EngraveJob = {
      ...dj(),
      toolKey: 'flat-3.175x12-metal',
      tool: flatEndMill(3.175, {
        id: '112111313812',
        name: '3.175*12mm Flat End',
        fluteLength: 12,
        shoulderLength: 12,
      }),
    };
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
    const base = dj();
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
  // ≤ 0. Every consumer downstream must take it without throwing, note it by name (#488 — the
  // height alone is no longer a refusal), and print the figure without a float tail
  // (3 − 3.1 = -0.10000000000000009).
  it('takes a 3 mm default job through the pipeline: noted by name, nothing thrown, no float tails (#406, #488)', () => {
    const base = dj();
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
    ...dj(),
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
      ...dj(),
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
      ...dj(),
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
      ...dj(),
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
      ...dj(),
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
      ...dj(),
      labels: [],
      shapes: [],
      drills: [drillOver],
      keepOuts: [pocket],
    });
    expect(g.findings.some((f) => f.code === 'item-over-void')).toBe(false);
  });

  // #218 — a THROUGH cut over a void is not a finish warning. It leaves the blank and breaks into
  // the cavity, and the membrane over the void is the only material holding the freed piece.
  const REACH = flatEndMill(3.175, {
    name: '3.175 mm flat end',
    fluteLength: 20,
    shoulderLength: 20,
  });

  it('refuses a through REGION over the void, naming the membrane (#218)', () => {
    const throughA = { ...shapeA(1.0), through: true };
    const g = generate(tl, {
      ...job(1.0, [pocket]),
      toolKey: 'inv:reach',
      tool: REACH,
      sacrificial: presetPartOnBoard(),
      shapes: [throughA, shapeB(2.0)],
    });
    expect(g.ok).toBe(false);
    expect(g.stage).toBe('findings');
    const over = g.findings.find((f) => f.code === 'item-over-void');
    expect(over?.severity).toBe('error');
    expect(over?.labelId).toBe('a');
    expect(over?.message).toContain('Magnet pocket');
    expect(over?.message).toContain('only thing holding the piece');
  });

  it('refuses a cut-out whose KERF crosses the void, naming the membrane (#218)', () => {
    // Shape A (10 × 10 at 50, 30) is wholly over the pocket, and its outside kerf is wider still:
    // every point of the profile leaves the blank inside the cavity.
    const g = generate(tl, {
      ...job(1.0, [pocket]),
      toolKey: 'inv:reach',
      tool: REACH,
      sacrificial: presetPartOnBoard(),
      cutouts: [
        {
          kind: 'cutout',
          id: 'cut-1',
          name: 'Badge',
          enabled: true,
          of: 'a',
          side: 'outside',
          inset: 0,
          tabs: { count: 4, width: 4, height: 1 },
        },
      ],
    });
    expect(g.ok).toBe(false);
    expect(g.stage).toBe('findings');
    const over = g.findings.find((f) => f.code === 'item-over-void' && f.labelId === 'cut-1');
    expect(over?.severity).toBe('error');
    expect(over?.message).toContain('Cut-out');
    expect(over?.message).toContain('Magnet pocket');
    expect(over?.message).toContain('only thing holding the piece');
  });
});

// #285 — a job that states its print takes its DEPTH LIMIT from the blank sliced on the printer's
// own layer grid, rather than from the nominal membrane arithmetic. The switch is
// `EngraveJob.stock.colour` (`fromBadge.ts` writes it only when the badge declares one, #166), and
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
      ...dj(viseForNewJob(undefined, blank.stock)),
      stock: blank.stock,
      keepOuts: blank.pocket ? [blank.pocket] : [],
      labels: [],
      shapes: [
        {
          id: 'a',
          name: 'A',
          kind: 'rect',
          // #383 — the badge blank is turned: the pocket (and so this 10 × 10 patch) sits at the
          // middle of the 38.1 × 76.2 stock.
          position: { x: 19.05, y: 38.1 },
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
    const base = dj(viseForNewJob(undefined, blank.stock));
    return {
      ...base,
      stock: blank.stock,
      keepOuts: [...(blank.pocket ? [blank.pocket] : []), ...extra],
      labels: [
        // #383 — reading along Y, the way the badge route seeds a name on the turned blank.
        {
          ...(base.labels[0] as EngraveLabel),
          id: 'name',
          text,
          size: 8,
          position: { x, y },
          rotation: 90,
        },
      ],
      shapes: [],
    };
  }
  const margin = (job: EngraveJob) => defaultBoundaryMargin(job);

  it('names the same void, and the same number, where the line lies inside it', () => {
    // The line is centred on the pocket (19.05, 38.1) and reads along Y (#383), so its whole
    // measured ink — 8 mm wide, 28 mm long, the way it sits on the turned blank — is inside the
    // 13 × 45 pocket: the Clipper2 scan sees a full overlap and the box test sees containment.
    const job = badgeLine('Name', 19.05, 38.1);
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
    // (the roof at y = 15.6 on the turned blank), so the two measurements are compared where the
    // overlap is partial — the same question, and both have to answer it the same way.
    const pocket = badgeBlankFor(defaultBadgeParams()).pocket!;
    if (pocket.kind !== 'rect') throw new Error('the badge pocket is a rect');
    const roof = pocket.position.y - pocket.height / 2;

    // A second void with LESS material over it than the pocket, well clear of the text: the pocket
    // leaves 1.51 mm and permits 0.51, this one leaves 1.21 mm and permits 0.21. It sits in the
    // strip between the pocket's X edge and the jaw, where the MEASURED box (8 mm across on the
    // turned blank) stops short of it but the estimated one — as wide as the blank — reaches.
    const shallower: EngraveKeepOut = {
      kind: 'rect', id: 'ko-bore', name: 'Test bore', enabled: true, rotation: 0,
      position: { x: 10, y: 40 }, width: 4, height: 4, cornerRadius: 0, zCeiling: 2.6,
    };

    const job = badgeLine('Name', 19.05, roof + 2.5, [shallower]);
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
    const base = dj();
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
    const g = generate(tl, dj());
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
      ...dj(),
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
      ...dj(),
      toolKey: 'flat-3.175x12-metal',
      tool: flatEndMill(3.175, {
        id: VENDOR_ID,
        name: '3.175*12mm Flat End',
        fluteLength: 12,
        shoulderLength: 12,
      }),
      stock: { ...dj().stock, material: 'hardwood' },
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
    const g = generate(tl, dj());
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
      ...dj(),
      labels: dj().labels.map((l, i) => (i === 0 ? { ...l, depth: 11.5 } : l)),
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
    const base = dj();
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

  /**
   * A filled-text REGION (not a trace) centred on the blank, small enough for the bench stock:
   * the default job's `CASE` label, re-laid at 8 mm on a 38.1 × 76.2 mm blank.
   */
  const regionLabel = (over: Partial<EngraveLabel> = {}): EngraveLabel => ({
    ...dj().labels[0]!,
    position: { x: 19, y: 28 },
    size: 8,
    depth: 1,
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

  it('accepts a REGION cut with a V-bit, and takes its offset from the colour plane (#221)', () => {
    // The same job that was refused before #221, now with the colour-plane model: no film, so the
    // plane IS the floor and the offset is the 0.15 mm tip radius.
    const job = traceJob([], {
      labels: [regionLabel()],
    });
    const g = generate(tl, job);
    expect(g.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(g.ok).toBe(true);
    expect(g.cam!.operations).toBe(1);
    expect(g.nc).toMatch(/G1 Z-1\b/);

    const r = regions(tl, job);
    const cut = r.cuts.find((c) => c.id === job.labels[0]!.id)!;
    expect(cut.vCarve).toBeDefined();
    expect(cut.vCarve!.planeRadius).toBeCloseTo(0.15, 12);
    expect(cut.vCarve!.planeDepth).toBeCloseTo(1, 12);
    // No film: the plane is the floor, so the design IS the floor and the cone widens only upward.
    expect(cut.vCarve!.floorInset).toBe(0);
    expect(cut.vCarve!.surfaceOutset).toBeCloseTo(1 * Math.tan(Math.PI / 12), 12);
  });

  it('refuses a groove narrower than the machine step, by name, and says the way out (#221)', () => {
    // A pointed bit with no film: the plane IS the floor and the tip has no width there, so the
    // groove is 0 µm — under the Z1's 2 × 0.625 µm bar. `regions` stops before feeds, so the
    // geometry refusal is what answers.
    const pointed = bit30({ tipDiameter: 0, diameter: 3.175 });
    const job = traceJob([], {
      labels: [regionLabel({ depth: 0.002 })],
      tool: pointed,
    });
    const r = regions(tl, job);
    const refusal = r.findings.find((f) => f.code === 'vcarve-groove-too-narrow');
    expect(refusal).toBeDefined();
    expect(refusal!.severity).toBe('error');
    expect(refusal!.message).toContain('0 µm');
    expect(refusal!.message).toContain('1.25 µm');
    expect(refusal!.message).toContain('go deeper or widen the stroke');
  });

  it('warns when two items’ surface openings merge, and NAMES the pair (#221)', () => {
    // Two labels on the same spot: their colour-plane designs are separate items but their surface
    // openings coincide, so the V leaves a ridge of top colour between walls that are one cavity.
    const first = regionLabel({ id: 'pair-a' });
    const second = regionLabel({ id: 'pair-b' });
    const job = traceJob([], {
      labels: [first, second],
      stock: { length: 38.1, width: 76.2, thickness: 3.81, material: 'petg', colour: { kind: 'printed', capMm: 0.2, layerHeight: 0.2 } },
      minFloor: 1,
    });
    const r = regions(tl, job);
    const merge = r.findings.find((f) => f.code === 'vcarve-surface-merge');
    expect(merge).toBeDefined();
    expect(merge!.severity).toBe('warning');
    expect(merge!.labelId).toBe(first.id);
    expect(merge!.message).toContain('CASE');
    // A warning, not a refusal: the colour line at the plane is still correct.
    expect(r.findings.filter((f) => f.severity === 'error' && f.code === 'vcarve-surface-merge')).toEqual([]);
  });

  it('warns when two strokes of ONE item merge, closing a gap narrower than the surface outset (#221)', () => {
    // Two 1 × 1 lobes of ONE vector, 0.08 mm apart. The design keeps the gap at the colour plane
    // (their plane openings are disjoint), but each wall's opening at the top face spreads
    // 0.2·tan15 = 0.0536 mm per side, so 0.107 mm of total spread closes the 0.08 mm gap: the
    // warning is about the item, not a pair.
    const lobes: EngraveVectorShape = {
      id: 'lobe-item',
      kind: 'vector',
      sourceName: 'spec',
      contours: [
        [[-1.04, -0.5], [-0.04, -0.5], [-0.04, 0.5], [-1.04, 0.5]],
        [[0.04, -0.5], [1.04, -0.5], [1.04, 0.5], [0.04, 0.5]],
      ],
      fillRule: 'NonZero',
      width: 2.08,
      height: 1,
      position: { x: 19, y: 28 },
      rotation: 0,
      depth: 0.394,
      enabled: true,
    };
    const job = traceJob([], {
      labels: [],
      vectors: [lobes],
      stock: { length: 38.1, width: 76.2, thickness: 1.5, material: 'petg', colour: { kind: 'printed', capMm: 0.2, layerHeight: 0.2 } },
    });
    const r = regions(tl, job);
    const merge = r.findings.find((f) => f.code === 'vcarve-surface-merge' && f.labelId === 'lobe-item');
    expect(merge).toBeDefined();
    expect(merge!.severity).toBe('warning');
    expect(merge!.message).toContain('0.107');
  });

  it('does NOT refuse the 30° engraving bit on PLA — the (Metal) name is a false signal (#575)', () => {
    // The 30° engraver is dual-use (the maintainer's 2026-10-22 bench ruling). Its "(Metal)" name
    // does not make it metal-ONLY, so a PLA job with it generates on the starting table's PLA V row.
    const metal = bit30({ name: 'Engraving V-bit 30 x 0.5 (Metal)', tipDiameter: 0.5, diameter: 3.175 });
    const g = generate(tl, traceJob([title()], { tool: metal }));
    expect(g.findings.some((f) => f.code === 'tool-metal-line')).toBe(false);
    expect(g.ok).toBe(true);
    expect(g.stage).toBe('done');
  });

  it('does not metal-refuse an engraving bit however the line is stated — the feeds gate stands (#575)', () => {
    // Box code (`-M-`) and owned-label ("for Metal") both name the line, but neither refuses a
    // V-profile bit now. The feeds resolution is the gate that stops a genuinely-no-row tip: 0.1 mm
    // is outside the starting table's 0.3–0.5 V band.
    const byCode = bit30({
      name: 'Single Flute Engraving Bit 60 x 0.1',
      id: 'C1-BIT-ENGRAVE-M-60-0.1',
      tipDiameter: 0.1,
      angle: 60,
      halfAngle: 30,
    });
    const g = generate(tl, traceJob([title()], { tool: byCode }));
    expect(g.findings.some((f) => f.code === 'tool-metal-line')).toBe(false);
    expect(g.ok).toBe(false); // feeds: no V row for a 0.1 mm tip

    const owned = bit30({
      name: 'Single Flute Engraving Bit for Metal - 1/8" Shank 60° * 0.1mm',
      id: null,
      tipDiameter: 0.1,
      angle: 60,
      halfAngle: 30,
    });
    const g2 = generate(tl, traceJob([title()], { tool: owned }));
    expect(g2.findings.some((f) => f.code === 'tool-metal-line')).toBe(false);
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
    // #690 — the refusal NAMES the cutter, in the one display form the app prints.
    expect(refusal!.message).toContain(toolDisplayName(flat));
    expect(refusal!.message).toContain('PLA');
  });

  it('downgrades a FLAT metal cutter refusal to a warning and unblocks when overridden (#572)', () => {
    // A FLAT cutter's "(Metal)" name still refuses (its geometry IS ground for metal). This bit's
    // 1.0 mm diameter sits inside the starting table's 0.8–1.6 flat band, so the feeds resolve; the
    // double-confirmed override is what lets it cut PLA.
    const flat = metalFlat({ name: '1.0mm Flat End(Metal)', tipDiameter: 1.0, diameter: 1.0 });
    const refused = generate(tl, traceJob([title()], { toolKey: 'flat-1.0-metal', tool: flat }));
    expect(refused.ok).toBe(false);
    expect(refused.findings.find((f) => f.code === 'tool-metal-line')!.severity).toBe('error');

    const overridden = generate(tl, traceJob([title()], { toolKey: 'flat-1.0-metal', tool: flat, metalLineOverride: true }));
    expect(overridden.ok).toBe(true);
    const finding = overridden.findings.find((f) => f.code === 'tool-metal-line');
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('warning');
    expect(finding!.message).toContain('chosen despite the material mismatch');
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
    expect(refusal!.message).toContain(toolDisplayName(coded));
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
    ...dj(),
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
    // #445 — the oracle's prediction for a thread is the same profile swept along the program's
    // own helix: the item's dimensions, the cutter's diameter, and the feed segments the sim will
    // compare its slice against. The depth is the TIP depth, not the thread's nominal depth.
    const predicted = g.predicted.find((p) => p.thread !== undefined);
    expect(predicted, 'one thread prediction').toBeTruthy();
    expect(predicted!.depth).toBeCloseTo(5.8, 6);
    expect(predicted!.thread).toMatchObject({
      x: 50, y: 30, majorMm: 5, minorMm: 4.134, pitchMm: 0.8,
      threadDepthMm: 5, tipDepthMm: 5.8, cuttingDiameterMm: 4,
    });
    // The first revolution of each radial pass: the helix chords climb exactly one pitch.
    const firstTurn = predicted!.thread!.moves.filter(
      (m) => Math.hypot(m.x1 - m.x0, m.y1 - m.y0) > 1e-9 && m.z <= -5.8 + 0.8 + 1e-6,
    );
    expect(firstTurn.length).toBeGreaterThan(0);
    expect(Math.max(...firstTurn.map((m) => m.z)) - Math.min(...firstTurn.map((m) => m.z))).toBeCloseTo(0.8, 2);
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
    const mixed: EngraveJob = { ...job([THREAD()]), labels: dj().labels };
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

describe('facing the stock’s top (#432 slices 1–2)', () => {
  const faced = (over: Partial<EngraveJob> = {}): EngraveJob => ({
    ...dj(),
    facing: { enabled: true, depth: 0.5 },
    ...over,
  });

  // The facing pass's OWN cutter: a 3.175 mm flat that is not Makera's metal line, so it is the
  // largest eligible flat for this softwood blank and the job's own cutter (`flat-1.0`) stays the
  // engraving tool. Its station (T2) is what proves the facing file is a separate program with a
  // separate cutter, not the job's program with a skim prepended.
  const FACING: ToolLibraryEntry = {
    key: 'user:facing-3.175',
    tool: flatEndMill(3.175, { number: 2, name: '3.175 mm flat (facing)' }),
    provenance: 'this spec’s own facing cutter',
  };
  const SHOP: EngraveShopOpts = { tools: [FACING, ...TOOL_LIBRARY] };

  /** One described copy, and the summary table the run store hands the worker (#442's pattern). */
  function copy(condition: Condition): ToolCopy {
    return {
      id: `copy-${condition}`,
      condition,
      whereabouts: { kind: 'box' },
      runtimeWarnMinutes: null,
      notes: null,
      runtimeMinutes: null,
    };
  }
  function conditionsOf(...rows: [string, Condition][]): ReadonlyMap<string, ConditionSummary> {
    return new Map(
      rows.map(([key, condition]) => [
        key,
        itemConditionSummary({ id: key, quantity: 1, copies: [copy(condition)] }),
      ]),
    );
  }

  it('emits the facing pass as its own verified program and leaves the engraving byte-identical', () => {
    const plain = generate(tl, dj());
    const g = generate(tl, faced(), null, [], undefined, SHOP);
    expect(
      g.ok,
      JSON.stringify(
        {
          stage: g.stage,
          errors: g.errors,
          findings: g.findings.filter((f) => f.severity === 'error'),
          verify: g.verify?.findings.slice(0, 6),
          facingError: g.facingError,
        },
        null,
        2,
      ),
    ).toBe(true);
    expect(g.stage).toBe('done');

    // The engraving program is UNTOUCHED: no facing operation, no Z shift. The two files meet in
    // the machine because the re-touch re-zeros Z on the faced surface between them (#432 slice 4),
    // so lowering the cuts here would double-count the skim.
    //
    // ONE thing does differ, and it is not a Z shift: the vacuum words belong to the RUN (#419
    // decision 4), and the facing file is now its first program — it takes `M331` and the
    // engraving program takes `M332` (#432 review R3). With both files' words stripped the
    // engraving is byte-identical to the plain job's.
    const stripVacuum = (nc: string) => nc.replace(/^[ \t]*M33[12][ \t]*\r?\n/gim, '');
    expect(stripVacuum(g.nc!)).toBe(stripVacuum(plain.nc!));
    expect(g.cam).toEqual(plain.cam);
    expect(g.verify!.stats.deepestZ).toBe(plain.verify!.stats.deepestZ);
    expect(g.verify!.findings.filter((f) => f.severity === 'error')).toEqual([]);

    // The facing file is a program in its own right: the post's preamble, its own cutter's station,
    // the one operation, and the post's ending.
    expect(g.facingNc, `${g.facingError} ${JSON.stringify(g.facingVerify?.findings.slice(0, 3))}`).not.toBeNull();
    expect(g.facingNc!.startsWith(';@MKR|BEGIN')).toBe(true);
    expect(g.facingNc!.trimEnd().endsWith('M02')).toBe(true);
    const names = g.facingNc!.split('\n').filter((l) => l.startsWith(';@MKR|TOOLPATH|'));
    expect(names).toHaveLength(1);
    expect(names[0]).toContain('name=[T2]Face stock top 0.5mm');
    expect(g.facingToolKey).toBe('user:facing-3.175');
    expect(g.facingError).toBeNull();
    expect(g.facingVerify).not.toBeNull();
    expect(g.facingVerify!.findings.filter((f) => f.severity === 'error')).toEqual([]);
    // The skim really removes 0.5 mm, from the probed top down.
    expect(g.facingVerify!.stats.deepestZ).toBeCloseTo(-0.5, 6);

    // #473 — the face file is PROGRAM 1 of the run, not a file beside it: the release step plays
    // `generated.programs` in order, so the skim has to be in that list for the engraving that
    // follows to be posted to a faced top. Its kind is `'facing'` and it is the file that carried
    // the run's `M331`; the engraving entry is the job's own program and is posted `M332` (last).
    expect(g.programs).toHaveLength(2);
    expect(g.programs[0]!.kind).toBe('facing');
    expect(g.programs[0]!.nc).toBe(g.facingNc);
    expect(g.programs[0]!.verify).toBe(g.facingVerify);
    expect(g.programs[0]!.toolKey).toBe(g.facingToolKey);
    expect(g.programs[0]!.setupIndex).toBe(1);
    expect(g.programs[1]!.kind).toBe('engrave');
    expect(g.programs[1]!.nc).toBe(g.nc);
    expect(g.programs[1]!.verify).toBe(g.verify);
    expect(g.programs[1]!.programHash).not.toBe(g.programs[0]!.programHash);
    expect(vacuumWords(g.programs[0]!.nc)).toEqual(['M331']);
    expect(vacuumWords(g.programs[1]!.nc)).toEqual(['M332']);
  });

  // #432 review R3 — the vacuum words belong to the RUN (#419 decision 4), and the facing file is
  // its FIRST program: it switches the vacuum on before the skim, and the engraving program that
  // follows switches it off. The mode therefore stays on across the bit change between them.
  const vacuumWords = (nc: string): string[] => [...nc.matchAll(/\bM33[12]\b/g)].map((m) => m[0]);

  it('gives the facing file the run’s first vacuum word and the engraving the last', () => {
    const g = generate(tl, faced(), null, [], undefined, SHOP);
    expect(g.ok, JSON.stringify({ errors: g.errors, facingError: g.facingError })).toBe(true);
    expect(g.facingNc, g.facingError ?? '').not.toBeNull();
    expect(vacuumWords(g.facingNc!)).toEqual(['M331']);
    expect(vacuumWords(g.nc!)).toEqual(['M332']);
  });

  it('leaves the engraving as the run’s only program, carrying BOTH words, when the facing file is withheld', () => {
    // The skim is refused by the verifier — it would run into the clamp — so no facing file exists.
    // The engraving is then the whole run, and it must write both words itself: a share worked out
    // for a file that was never produced would leave the vacuum on for ever.
    const clamp: MountObstacle = {
      id: 'clamp-test',
      kind: 'clamp',
      label: 'the clamp on the back edge',
      fix: 'move it clear of the cut',
      min: [0, 54],
      max: [100, 60],
      topZ: 0.5,
    };
    const mount: MountObstacles = {
      obstacles: [clamp],
      uncertainty: 0.1,
      fixture: {
        boxes: [{ id: clamp.id, label: clamp.label, min: [0, 54, -12], max: [100, 60, 0.5] }],
        source: 'default',
        uncertainty: 0.1,
      },
    };
    const g = generate(tl, faced(), null, [], undefined, { ...SHOP, mount });
    expect(g.ok).toBe(true);
    expect(g.facingNc).toBeNull();
    expect(g.facingError).toContain('could not be faced');
    expect(vacuumWords(g.nc!)).toEqual(['M331', 'M332']);
  });

  // #432 review — `job.cutOverride` is the hand-entered S/F for the job's ENGRAVING cutter (#205).
  // Someone who typed numbers for a 1 mm flat has said nothing about the mill that skims the top,
  // so the facing file resolves its own row and the override never reaches it.
  it('resolves the facing file’s S/F from the facing cutter’s row, not the job’s cut override', () => {
    const words = (nc: string, letter: 'S' | 'F'): string[] =>
      [...nc.matchAll(new RegExp(`\\b${letter}(\\d+)`, 'g'))].map((m) => m[1]!);

    const plain = generate(tl, faced(), null, [], undefined, SHOP);
    const overridden = generate(
      tl,
      faced({ cutOverride: { rpm: 9000, feed: 300, plungeFeed: 150 } }),
      null,
      [],
      undefined,
      SHOP,
    );
    for (const g of [plain, overridden]) {
      expect(g.ok, `${g.stage} ${JSON.stringify(g.errors)}`).toBe(true);
      expect(g.facingNc).not.toBeNull();
      expect(g.facingError).toBeNull();
    }

    // The override IS live on the job — the engraving program carries the numbers that were typed.
    // (Compared rather than quoted: the starting table's own values are not this spec's business.)
    expect(words(overridden.nc!, 'S')).not.toEqual(words(plain.nc!, 'S'));
    expect(words(overridden.nc!, 'F')).not.toEqual(words(plain.nc!, 'F'));

    // …and the facing file is exactly what it was: same spindle, same feeds, to the word.
    expect(words(overridden.facingNc!, 'S')).toEqual(words(plain.facingNc!, 'S'));
    expect(words(overridden.facingNc!, 'F')).toEqual(words(plain.facingNc!, 'F'));
    expect(words(overridden.facingNc!, 'S')).not.toContain('9000');
    expect(words(overridden.facingNc!, 'F')).not.toContain('300');
  });

  it('emits no facing file when facing is off or its depth is zero', () => {
    const plain = generate(tl, dj());
    for (const facing of [
      undefined,
      { enabled: false, depth: 0.5 },
      { enabled: true, depth: 0 },
    ]) {
      const g = generate(tl, { ...dj(), facing }, null, [], undefined, SHOP);
      expect(g.ok).toBe(true);
      expect(g.nc).toBe(plain.nc);
      expect(g.facingNc).toBeNull();
      expect(g.facingVerify).toBeNull();
      expect(g.facingToolKey).toBeNull();
      // "Not asked for" is not "refused": the reason channel stays empty.
      expect(g.facingError).toBeNull();
    }
  });

  // #474/#493/#473 — the class-wide rule is the worker's too: the panel and the seed only keep
  // honest jobs honest, and a legacy or hand-edited job with facing on must not get a face file for
  // ANY non-wood, non-metal material. #473 makes that a refusal of the RUN: a face file that exists
  // would be program 1, and every later program is posted from the top it leaves. So the job stops
  // before the setups and the CAM, and the finding names the material, the rule and the way out.
  // The worker case runs PLA because it is the one plastic the starting feed table covers — an
  // acrylic job is refused earlier for feeds, which would mask the facing half under test.
  it('refuses the whole run on a material facing is not offered for, and keeps facing for wood', () => {
    const plastic = faced({ stock: { ...dj().stock, material: 'pla' } });
    const g = generate(tl, plastic, null, [], undefined, SHOP);
    expect(g.ok).toBe(false);
    expect(g.stage).toBe('findings');
    const finding = g.findings.find((f) => f.code === 'facing-plastic');
    expect(finding?.severity).toBe('error');
    expect(finding?.message).toBe(
      'facing is not offered on PLA: a flat cutter smears a plastic top. ' +
        'Turn facing off in the Cut panel and generate again.',
    );
    // Nothing was posted: not the face file, not the engraving, and no program list to release.
    expect(g.facingNc).toBeNull();
    expect(g.nc).toBeNull();
    expect(g.cam).toBeNull();
    expect(g.programs).toEqual([]);

    // The material is the rule, not the plastic job: with facing OFF the same stock generates.
    const off = generate(tl, { ...plastic, facing: undefined }, null, [], undefined, SHOP);
    expect(off.ok, JSON.stringify(off.errors)).toBe(true);
    expect(off.nc).not.toBeNull();
    expect(off.facingNc).toBeNull();

    // A wood job with the same facing choice still gets its file, first in the run.
    const wood = generate(tl, faced(), null, [], undefined, SHOP);
    expect(wood.facingNc).not.toBeNull();
    expect(wood.programs[0]!.kind).toBe('facing');
  });

  it('refuses a facing depth that eats the minimum floor, before any CAM', () => {
    const thickness = 3;
    const g = generate(tl, faced({ stock: { ...dj().stock, thickness }, minFloor: 1, facing: { enabled: true, depth: 2.5 } }));
    expect(g.ok).toBe(false);
    expect(g.stage).toBe('findings');
    const finding = g.findings.find((f) => f.code === 'facing-too-deep');
    expect(finding?.severity).toBe('error');
    expect(g.cam).toBeNull();
  });

  it('round-trips the facing choice, its depth and its own cutter key through the schema', () => {
    // The document is what survives a save: the schema STRIPS keys it does not know, so the
    // facing cutter would silently disappear from every saved job if it were only on the type.
    const job = faced({ facing: { enabled: true, depth: 0.5, toolKey: 'user:facing-3.175' } });
    const parsed = parseEngraveJob(structuredClone(job) as unknown);
    expect(parsed.ok, parsed.ok ? '' : parsed.errors.join('; ')).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job.facing).toEqual({ enabled: true, depth: 0.5, toolKey: 'user:facing-3.175' });
  });

  it('refuses the facing FILE, not the run, when no flat cutter can face the blank', () => {
    const plain = generate(tl, dj());
    const g = generate(tl, faced(), null, [], undefined, { tools: [] });
    expect(g.ok).toBe(true);
    expect(g.stage).toBe('done');
    // The engraving is what the run produced: it is untouched, and still savable.
    expect(g.nc).toBe(plain.nc);
    expect(g.facingNc).toBeNull();
    expect(g.facingVerify).toBeNull();
    expect(g.facingToolKey).toBeNull();
    expect(g.facingError).toMatch(/no flat end mill/);
  });

  it('will not default to a metal-line cutter on a non-metal blank', () => {
    // The built-in 3.175 flat is `3.175*12mm Flat End(Metal)` — bigger than the 1 mm, and still not
    // the facing default on softwood. With it as the ONLY flat, the file is refused by name.
    const metalOnly = TOOL_LIBRARY.filter((e) => e.key === 'flat-3.175x12-metal');
    const g = generate(tl, faced(), null, [], undefined, { tools: metalOnly });
    expect(g.ok).toBe(true);
    expect(g.facingNc).toBeNull();
    expect(g.facingError).toMatch(/for Metal/);
  });

  // #432 review R10 — the condition table reaches the pick THROUGH the shop options. The store
  // reads `inventoryConditions()` on the main thread (the worker's map is empty), so these cases
  // pass it the way `engraveRunStore` does and read the file the worker actually posted.
  it('skips the facing cutter the bench marks broken, through `shop.conditions`', () => {
    const g = generate(tl, faced(), null, [], undefined, {
      tools: [FACING, ...TOOL_LIBRARY],
      conditions: conditionsOf(['user:facing-3.175', 'broken']),
    });
    expect(g.ok, JSON.stringify({ errors: g.errors, facingError: g.facingError })).toBe(true);
    expect(g.facingNc, g.facingError ?? '').not.toBeNull();
    // The 3.175 mm facing cutter is skipped; the 1 mm built-in is the only other non-metal flat.
    expect(g.facingToolKey).toBe('flat-1.0');
    expect(g.facingError).toBeNull();
  });

  it('still faces with a worn cutter — the condition is not a priority', () => {
    const g = generate(tl, faced(), null, [], undefined, {
      ...SHOP,
      conditions: conditionsOf(['user:facing-3.175', 'worn']),
    });
    expect(g.ok, JSON.stringify({ errors: g.errors, facingError: g.facingError })).toBe(true);
    expect(g.facingNc, g.facingError ?? '').not.toBeNull();
    expect(g.facingToolKey).toBe('user:facing-3.175');
  });

  it('withholds the facing file, naming broken, when every flat has no usable copy', () => {
    const g = generate(tl, faced(), null, [], undefined, {
      tools: [FACING],
      conditions: conditionsOf(['user:facing-3.175', 'broken']),
    });
    // The engraving still generates: a skim that cannot be cut does not stop the job.
    expect(g.ok).toBe(true);
    expect(g.stage).toBe('done');
    expect(g.facingNc).toBeNull();
    expect(g.facingToolKey).toBeNull();
    expect(g.facingError).toMatch(/marked broken/);
    expect(g.facingError).toContain('3.175 mm flat (facing)');
  });

  it('faces a thread job with its own flat, and leaves the thread program to the thread mill', () => {
    const MILL: Tool = flatEndMill(4, { name: '4 mm thread mill', typeText: 'Thread Mill', shape: 'thread', tipDiameter: 4, diameter: 4, fluteLength: 20 });
    const job: EngraveJob = {
      ...dj(),
      labels: [],
      shapes: [],
      traces: [],
      drills: [],
      tool: MILL,
      threads: [
        { kind: 'thread', id: 'thr-a', position: { x: 50, y: 30 }, enabled: true, size: 'M5', standard: 'metric', classFit: '6H', depth: 5, through: false },
      ],
      facing: { enabled: true, depth: 0.5 },
    };
    const g = engraveGenerate(tl, job, MILL, [], null, undefined, { tools: [FACING, ...TOOL_LIBRARY] });
    expect(g.ok).toBe(true);
    expect(g.facingNc, `${g.facingError} ${JSON.stringify(g.facingVerify?.findings.slice(0, 3))}`).not.toBeNull();
    expect(g.facingToolKey).toBe('user:facing-3.175');
  });
});

// #442's #427 item — the mount's boxes, resolved on the caller's side (the worker cannot read the
// location) and handed to BOTH programs' verifiers, and to `toSetup` as the fixture. The clamp here
// is a plain `MountObstacle`, because what is under test is the wiring, not the bracket's sizes
// (their own spec is `bracketMount.spec.ts`).
describe('the mount reaches the verifier and the facing pass (#442)', () => {
  /** A clamp that only a pass cutting where the labels are (or the whole top) can reach. */
  const clamp = (min: [number, number], max: [number, number]): MountObstacle => ({
    id: 'clamp-test',
    kind: 'clamp',
    label: 'the clamp on the back edge',
    fix: 'move it clear of the cut',
    min,
    max,
    // Below `HOP_Z` (1 mm), so rapids clear it and only a CUTTING move can be refused.
    topZ: 0.5,
  });
  const OVER_LABELS = clamp([0, 38], [100, 44]);
  const OVER_BACK_EDGE = clamp([0, 54], [100, 60]);
  // The facing pass needs its own cutter in the shop list (the worker's registry is empty).
  const FACING_TOOL: ToolLibraryEntry = {
    key: 'user:facing-3.175',
    tool: flatEndMill(3.175, { number: 2, name: '3.175 mm flat (facing)' }),
    provenance: 'this spec’s own facing cutter',
  };
  const mountOf = (o: MountObstacle): MountObstacles => ({
    obstacles: [o],
    uncertainty: 0.1,
    fixture: {
      boxes: [{ id: o.id, label: o.label, min: [o.min[0], o.min[1], -12], max: [o.max[0], o.max[1], o.topZ] }],
      source: 'default',
      uncertainty: 0.1,
    },
  });

  it('a cut over the clamp is refused, and the same job without the mount passes', () => {
    expect(generate(tl, dj()).ok).toBe(true);
    const g = generate(tl, dj(), null, [], undefined, { mount: mountOf(OVER_LABELS) });
    expect(g.ok).toBe(false);
    expect(g.stage).toBe('verify');
    const f = g.verify!.findings.find((x) => x.code === 'clamp-in-path');
    expect(f?.message).toContain('the clamp on the back edge');
  });

  it('a skim that would run into the mount is refused, and names the band it could not face', () => {
    const faced: EngraveJob = { ...dj(), facing: { enabled: true, depth: 0.5 } };
    const g = generate(tl, faced, null, [], undefined, { tools: [FACING_TOOL, ...TOOL_LIBRARY], mount: mountOf(OVER_BACK_EDGE) });
    // The engraving is untouched and the run still succeeded — only the skim is withheld (#432).
    expect(g.ok, `${g.stage} ${JSON.stringify(g.errors)}`).toBe(true);
    expect(g.facingNc).toBeNull();
    expect(g.facingError).toContain('could not be faced');
    expect(g.facingError).toContain('the clamp on the back edge stands over it');
    // …and the strip is measured, not guessed: from the clamp’s nose, grown by the cutter and the fit.
    expect(g.facingError).toMatch(/a 100 mm × 7\.6\d\d mm band of the top/);
  });
});

// #419 J3 — A JOB IS A LIST OF PROGRAMS.
//
// One file per setup, each cut with that setup's own cutter, each posted and verified on its own.
// The vacuum words are spread across the RUN (decision 4): `M331` in the first program only, `M332`
// in the last only, so the mode stays on across the bit change; the frame file carries neither
// (Q-F). A job with no `setups[]` is the same single program it always was, which is what the rest
// of this file's cases (all legacy jobs) already proves by passing unchanged.
describe('engraveGenerate — one program per setup (#419 J3)', () => {
  const IDENTITY = {
    top: 'top',
    bottom: 'bottom',
    left: 'left',
    right: 'right',
    front: 'front',
    back: 'back',
  } as const;
  /** The second setup's cutter: same geometry as the job's, a DIFFERENT key, so routing is visible. */
  const TOOL_B: ToolLibraryEntry = {
    key: 'user:flat-1-b',
    tool: flatEndMill(1.0, { name: '1 mm flat (setup B)' }),
    provenance: 'test',
  };
  /** #472 — the finer cutter a two-tool setup's rest pass runs with. */
  const TOOL_REST: ToolLibraryEntry = {
    key: 'user:flat-0.6-rest',
    tool: flatEndMill(0.6, { name: '0.6 mm flat (rest)' }),
    provenance: 'test',
  };
  const setUp = (job: EngraveJob, groups: string[][], tools: string[]): EngraveJob => ({
    ...job,
    setups: groups.map((itemIds, i) => ({
      id: `setup-${i + 1}`,
      orientation: { ...IDENTITY },
      mount: { kind: 'vise' },
      itemIds,
      tools: tools[i] === undefined ? [] : [tools[i]!],
    })),
  });
  const vacuumWords = (nc: string): string[] => [...nc.matchAll(/\bM33[12]\b/g)].map((m) => m[0]);

  it('posts one program per setup, with the vacuum spanning the run and not each file', () => {
    const job = dj();
    const [a, b] = job.labels.map((l) => l.id);
    const two = setUp(job, [[a!], [b!]], [job.toolKey, TOOL_B.key]);
    const g = generate(tl, two, null, [], undefined, { tools: [TOOL_B, ...TOOL_LIBRARY] });
    expect(g.ok, JSON.stringify({ errors: g.errors, findings: g.findings.filter((f) => f.severity === 'error').map((f) => f.code) })).toBe(true);
    expect(g.programs).toHaveLength(2);

    const [first, last] = g.programs;
    expect(first!.setupIndex).toBe(1);
    expect(first!.toolKey).toBe(job.toolKey);
    expect(last!.setupIndex).toBe(2);
    expect(last!.toolKey).toBe(TOOL_B.key);

    // Decision 4: on in the first, off in the last, and each file has exactly one of the two.
    expect(vacuumWords(first!.nc)).toEqual(['M331']);
    expect(vacuumWords(last!.nc)).toEqual(['M332']);

    // Q-F: an air trace cuts nothing and must not move the mode either way.
    expect(vacuumWords(first!.frameNc!)).toEqual([]);
    expect(vacuumWords(last!.frameNc!)).toEqual([]);

    // The two are genuinely different programs, keyed by their own text.
    expect(first!.nc).not.toBe(last!.nc);
    expect(first!.programHash).not.toBe(last!.programHash);
    expect(first!.programHash).toBe(programHash(first!.nc));

    // A setup cuts its own items and nothing else: one operation each, not three.
    expect(first!.cam!.operations).toBe(1);
    expect(last!.cam!.operations).toBe(1);
  });

  it('keeps the single-program fields pointing at the first program', () => {
    const job = dj();
    const [a, b] = job.labels.map((l) => l.id);
    const g = generate(tl, setUp(job, [[a!], [b!]], [job.toolKey, TOOL_B.key]), null, [], undefined, {
      tools: [TOOL_B, ...TOOL_LIBRARY],
    });
    expect(g.nc).toBe(g.programs[0]!.nc);
    expect(g.verify).toBe(g.programs[0]!.verify);
    expect(g.cam).toBe(g.programs[0]!.cam);
  });

  it('writes both vacuum words when the job is one program, whatever the setups say', () => {
    const job = dj();
    const ids = job.labels.map((l) => l.id);
    const g = generate(tl, setUp(job, [ids], [job.toolKey]));
    expect(g.ok).toBe(true);
    expect(g.programs).toHaveLength(1);
    expect(vacuumWords(g.programs[0]!.nc)).toEqual(['M331', 'M332']);
  });

  it('cuts a middle program with neither vacuum word', () => {
    const job = dj();
    const [a, b, c] = job.labels.map((l) => l.id);
    const g = generate(tl, setUp(job, [[a!], [b!], [c!]], [job.toolKey, TOOL_B.key, job.toolKey]), null, [], undefined, {
      tools: [TOOL_B, ...TOOL_LIBRARY],
    });
    expect(g.ok, JSON.stringify({ errors: g.errors, findings: g.findings.filter((f) => f.severity === 'error').map((f) => f.code) })).toBe(true);
    expect(g.programs).toHaveLength(3);
    expect(vacuumWords(g.programs[0]!.nc)).toEqual(['M331']);
    expect(vacuumWords(g.programs[1]!.nc)).toEqual([]);
    expect(vacuumWords(g.programs[2]!.nc)).toEqual(['M332']);
  });

  it('cuts a setup naming two cutters as a clearing program and a measured rest program', () => {
    // PLA: the 0.6 mm cutter's feeds row (#410) is plastic, and this case is about the rest pass,
    // not about a material's feed table.
    const job: EngraveJob = {
      ...dj(),
      stock: { ...dj().stock, material: 'pla' },
    };
    const ids = job.labels.map((l) => l.id);
    const base = setUp(job, [ids], [job.toolKey]);
    const two: EngraveJob = {
      ...base,
      setups: [{ ...base.setups![0]!, tools: [job.toolKey, TOOL_REST.key] }],
    };
    const g = generate(tl, two, null, [], undefined, { tools: [TOOL_REST, ...TOOL_LIBRARY] });
    expect(
      g.ok,
      JSON.stringify({
        stage: g.stage,
        errors: g.errors,
        findings: g.findings.filter((f) => f.severity === 'error'),
      }),
    ).toBe(true);
    expect(g.programs).toHaveLength(2);

    const [rough, rest] = g.programs;
    expect(rough!.setupIndex).toBe(1);
    expect(rest!.setupIndex).toBe(1);
    expect(rough!.toolKey).toBe(job.toolKey);
    expect(rest!.toolKey).toBe(TOOL_REST.key);
    // Decision 4: the run opens with the clearing program and closes with the rest program.
    expect(vacuumWords(rough!.nc)).toEqual(['M331']);
    expect(vacuumWords(rest!.nc)).toEqual(['M332']);

    // The sheet's program-2 facts are the measurements this run made, not a re-derivation.
    expect(g.restPass).not.toBeNull();
    expect(g.restPass!.rough.key).toBe(job.toolKey);
    expect(g.restPass!.rest.key).toBe(TOOL_REST.key);
    expect(g.restPass!.regions.length).toBeGreaterThan(0);
    expect(g.restPass!.restArea).toBeGreaterThan(0);
    expect(g.restPass!.overlap).toBeGreaterThan(0);
    expect(g.restPass!.restRemovedVolume).toBeGreaterThan(0);
    expect(g.restPass!.rest.nc).toMatch(/\.nc$/);
  });

  it('splits a single-cutter setup into rough and finish operations in one program (#250)', () => {
    const job = dj();
    const ids = job.labels.map((l) => l.id);
    const one = setUp(job, [ids], [job.toolKey]);
    const g = generate(tl, one, null, [], undefined, {
      finish: { stockToLeaveMm: { value: 0.2, source: 'chosen' } },
    });
    expect(g.ok, JSON.stringify({ stage: g.stage, errors: g.errors })).toBe(true);
    expect(g.programs).toHaveLength(1);
    const program = g.programs[0]!;
    expect(program.finish).not.toBeNull();
    expect(program.finish!.mode).toBe('rough-and-finish');
    expect(program.finish!.stockToLeaveMm).toEqual({ value: 0.2, source: 'chosen' });
    expect([...program.finish!.itemIds].sort()).toEqual([...ids].sort());
    expect(program.cam!.roughOperations).toBe(ids.length);
    expect(program.cam!.finishOperations).toBe(ids.length);
    expect(program.cam!.operations).toBe(ids.length * 2);
    expect(program.nc).toContain('(rough)');
    expect(program.nc).toContain('(finish)');
    // #667 — a single program reaches FULL depth in the same file, so its prediction keeps the
    // item depths; only a rough-only pair program is asked for its rough floors.
    for (const p of g.predicted.filter((x) => x.polygons.length > 0)) {
      expect([...new Set(job.labels.map((l) => l.depth))]).toContain(Number(p.depth.toFixed(6)));
    }
    // The single-program adapter describes the same first file.
    expect(g.finish).toEqual(program.finish);
    expect(g.cam!.operations).toBe(program.cam!.operations);
  });

  it('roughs with the first cutter and finishes with the rest cutter (#250)', () => {
    const job: EngraveJob = {
      ...dj(),
      stock: { ...dj().stock, material: 'pla' },
    };
    const ids = job.labels.map((l) => l.id);
    const base = setUp(job, [ids], [job.toolKey]);
    const two: EngraveJob = {
      ...base,
      setups: [{ ...base.setups![0]!, tools: [job.toolKey, TOOL_REST.key] }],
    };
    const g = generate(tl, two, null, [], undefined, {
      tools: [TOOL_REST, ...TOOL_LIBRARY],
      finish: { stockToLeaveMm: { value: 0.2, source: 'chosen' } },
    });
    expect(
      g.ok,
      JSON.stringify({ stage: g.stage, errors: g.errors, findings: g.findings.filter((f) => f.severity === 'error') }),
    ).toBe(true);
    expect(g.programs).toHaveLength(2);
    const [rough, rest] = g.programs;
    expect(rough!.finish!.mode).toBe('rough-only');
    expect(rest!.finish!.mode).toBe('finish-only');
    // #667 — the rough-only file's prediction asks for what IT removes: each split item's floor
    // less the allowance, never the full depth the second file finishes. The run's oracle reads
    // the top-level prediction (program 1), so the finishing stock is not "material it left".
    const fullDepths = [...new Set(job.labels.map((l) => l.depth))].sort((a, b) => a - b);
    const roughFloors = fullDepths.map((d) => Math.max(0, d - 0.2));
    const polygonDepths = g.predicted.filter((p) => p.polygons.length > 0).map((p) => p.depth);
    expect(polygonDepths.length).toBeGreaterThan(0);
    for (const depth of polygonDepths) {
      expect(roughFloors.some((d) => Math.abs(d - depth) < 1e-9)).toBe(true);
    }
    // The full depths are NOT what program 1 is asked for.
    for (const depth of polygonDepths) {
      expect(fullDepths.some((d) => Math.abs(d - depth) < 1e-9)).toBe(false);
    }
    expect(rough!.cam!.roughOperations).toBeGreaterThan(0);
    expect(rough!.cam!.finishOperations).toBe(0);
    expect(rest!.cam!.roughOperations).toBe(0);
    expect(rest!.cam!.finishOperations).toBeGreaterThan(0);
    // Each file names the half it cuts, so the two removals are legible in the sender.
    expect(rough!.nc).toContain('(rough)');
    expect(rough!.nc).not.toContain('(finish)');
    expect(rest!.nc).toContain('(finish)');
    expect(rest!.nc).not.toContain('(rough)');
  });

  it('#667 — the rough-only file’s prediction is what the run’s oracle sweeps', () => {
    // The app's preflight compares PROGRAM 1's removal against the top-level prediction before
    // anything may be saved or sent. For a rest pair that program leaves the allowance on every
    // split item, so the prediction has to be the rough region at the rough floor — not the item's
    // full depth — or the gate refuses a pair that cut exactly as planned.
    const job: EngraveJob = {
      ...dj(),
      stock: { ...dj().stock, material: 'pla' },
    };
    const ids = job.labels.map((l) => l.id);
    const base = setUp(job, [ids], [job.toolKey]);
    const two: EngraveJob = {
      ...base,
      setups: [{ ...base.setups![0]!, tools: [job.toolKey, TOOL_REST.key] }],
    };
    const g = generate(tl, two, null, [], undefined, {
      tools: [TOOL_REST, ...TOOL_LIBRARY],
      finish: { stockToLeaveMm: { value: 0.2, source: 'chosen' } },
    });
    expect(g.ok).toBe(true);
    expect(g.programs).toHaveLength(2);

    const session = createSimSession(tl);
    try {
      const load = session.load(g.nc!, toSetup(two, Z1), jobTool(two)!, two.machineId, {
        breakthroughMm: two.breakthrough,
      });
      expect(load.ok, JSON.stringify(load.ok ? [] : load.diagnostics)).toBe(true);
      const report = session.oracle(g.predicted);
      expect(
        report.ok,
        JSON.stringify({ worst: report.worst, levels: report.levels.map((l) => ({ z: l.z, under: l.underCut, over: l.overCut })) }),
      ).toBe(true);
    } finally {
      session.dispose();
    }
  });

  it('#667 — a rest pair mixed with a drill, a trace and a cut-out passes the run’s oracle', () => {
    // The motivating job: a pocket job with holes and a profile cut with the same flat cutter, then
    // finished with a smaller one. Only the flat REGIONS are split by the rough pass; the drill
    // disc, the trace kerf and the cut-out kerf run at full geometry in the rough-only program, so
    // their predictions must stay full — eroding them (the first cut of the #667 fix) made the
    // oracle call those real cuts over-cuts and refused the pair.
    const base = dj();
    // A 1 mm bit with real reach: the demo labels are cut at their own size, and the through cut
    // is 12.3 mm deep.
    const profiler = flatEndMill(1, { name: '1 mm flat end (reach)', fluteLength: 20, shoulderLength: 20 });
    const trace: EngraveTraceItem = {
      kind: 'line',
      id: 'line-1',
      position: { x: 8, y: 8 },
      rotation: 0,
      points: [
        [0, 0],
        [24, 0],
      ],
      closed: false,
      depth: 0.8,
      enabled: true,
    };
    const drill: EngraveDrill = {
      kind: 'drill',
      id: 'drill-1',
      position: { x: 82, y: 48 },
      rotation: 0,
      depth: 13,
      through: true,
      enabled: true,
    };
    const cutout: EngraveCutout = {
      kind: 'cutout',
      id: 'cut-1',
      name: 'Badge',
      enabled: true,
      of: 'stock-inset',
      side: 'inside',
      inset: 5,
      tabs: { count: 4, width: 4, height: 1 },
    };
    const job: EngraveJob = {
      ...base,
      stock: { ...base.stock, material: 'pla' },
      toolKey: 'inv:flat-1x20',
      tool: profiler,
      sacrificial: presetPartOnBoard(),
      breakthrough: 0.3,
      traces: [trace],
      drills: [drill],
      cutouts: [cutout],
    };
    const ids = [...job.labels.map((l) => l.id), trace.id, drill.id, cutout.id];
    const one = setUp(job, [ids], [job.toolKey]);
    const two: EngraveJob = {
      ...one,
      setups: [{ ...one.setups![0]!, tools: [job.toolKey, TOOL_REST.key] }],
    };
    const g = generate(tl, two, null, [], undefined, {
      tools: [TOOL_REST, ...TOOL_LIBRARY],
      finish: { stockToLeaveMm: { value: 0.2, source: 'chosen' } },
    });
    expect(
      g.ok,
      JSON.stringify({ stage: g.stage, errors: g.errors, findings: g.findings.filter((f) => f.severity === 'error') }),
    ).toBe(true);
    expect(g.programs).toHaveLength(2);

    // The unsplit kinds keep their FULL depth in program 1's prediction. A through drill's plan
    // depth is the blank plus the breakthrough (12.3 mm), whatever depth the item states.
    const byItem = new Map(g.predicted.map((p) => [p.itemId, p]));
    expect(byItem.get(drill.id)?.depth).toBeCloseTo(12.3, 6);
    expect(byItem.get(trace.id)?.depth).toBeCloseTo(0.8, 6);
    expect(byItem.get(cutout.id)?.depth).toBeCloseTo(12.3, 6);
    // …while the split labels are asked for their rough floors.
    for (const label of job.labels) {
      const predicted = byItem.get(label.id);
      expect(predicted, label.id).toBeDefined();
      expect(predicted!.depth).toBeCloseTo(label.depth - 0.2, 6);
    }

    const session = createSimSession(tl);
    try {
      const load = session.load(g.nc!, toSetup(two, Z1), profiler, two.machineId, {
        breakthroughMm: two.breakthrough,
      });
      expect(load.ok, JSON.stringify(load.ok ? [] : load.diagnostics)).toBe(true);
      const report = session.oracle(g.predicted);
      expect(
        report.ok,
        JSON.stringify({ worst: report.worst, levels: report.levels.map((l) => ({ z: l.z, under: l.underCut, over: l.overCut })) }),
      ).toBe(true);
    } finally {
      session.dispose();
    }
  });

  it('leaves items assigned to a later cutter out of the clearing program', () => {
    const job: EngraveJob = {
      ...dj(),
      stock: { ...dj().stock, material: 'pla' },
    };
    const [a, b] = job.labels.map((l) => l.id);
    const base = setUp(job, [[a!, b!]], [job.toolKey]);
    const two: EngraveJob = {
      ...base,
      setups: [
        {
          ...base.setups![0]!,
          tools: [job.toolKey, TOOL_REST.key],
          toolItems: { [job.toolKey]: [a!], [TOOL_REST.key]: [b!] },
        },
      ],
    };
    const g = generate(tl, two, null, [], undefined, { tools: [TOOL_REST, ...TOOL_LIBRARY] });
    expect(
      g.ok,
      JSON.stringify({
        stage: g.stage,
        errors: g.errors,
        findings: g.findings.filter((f) => f.severity === 'error'),
      }),
    ).toBe(true);
    expect(g.programs).toHaveLength(2);
    // The first program cuts only the item assigned to it; the second is measured over the whole
    // setup, so the item the first never touched is entirely its work.
    expect(g.programs[0]!.cam!.operations).toBe(1);
    expect(g.restPass!.rest.nc).toMatch(/\.nc$/);
  });

  it('refuses an assignment that names an item twice, or leaves one unassigned', () => {
    const job = dj();
    const [a, b] = job.labels.map((l) => l.id);
    const base = setUp(job, [[a!, b!]], [job.toolKey]);
    const duplicated: EngraveJob = {
      ...base,
      setups: [
        {
          ...base.setups![0]!,
          tools: [job.toolKey, TOOL_B.key],
          toolItems: { [job.toolKey]: [a!], [TOOL_B.key]: [a!, b!] },
        },
      ],
    };
    const g = generate(tl, duplicated, null, [], undefined, { tools: [TOOL_B, ...TOOL_LIBRARY] });
    expect(g.ok).toBe(false);
    expect(g.stage).toBe('findings');
    expect(g.programs).toEqual([]);
    expect(g.findings.some((f) => f.code === 'setup-items-duplicated' && f.severity === 'error')).toBe(true);

    const unassigned: EngraveJob = {
      ...base,
      setups: [
        {
          ...base.setups![0]!,
          tools: [job.toolKey, TOOL_B.key],
          toolItems: { [job.toolKey]: [a!] },
        },
      ],
    };
    const u = generate(tl, unassigned, null, [], undefined, { tools: [TOOL_B, ...TOOL_LIBRARY] });
    expect(u.ok).toBe(false);
    expect(u.findings.some((f) => f.code === 'setup-items-unassigned' && f.severity === 'error')).toBe(true);
  });

  it('refuses a setup naming no cutter', () => {
    const job = dj();
    const ids = job.labels.map((l) => l.id);
    const g = generate(tl, setUp(job, [ids], []), null, [], undefined, { tools: [TOOL_B] });
    expect(g.ok).toBe(false);
    expect(g.stage).toBe('findings');
    expect(g.findings.some((f) => f.code === 'setup-no-tool')).toBe(true);
  });

  it('a legacy job is one program, and its frame file still carries no vacuum word', () => {
    const g = generate(tl, dj());
    expect(g.ok).toBe(true);
    expect(g.programs).toHaveLength(1);
    expect(g.programs[0]!.nc).toBe(g.nc);
    expect(g.programs[0]!.setupIndex).toBe(1);
    // The file itself still turns the vacuum on and off — it is the whole run.
    expect(vacuumWords(g.programs[0]!.nc)).toEqual(['M331', 'M332']);
    // The frame file never did cut anything; since #419 Q-F it says nothing about the vacuum.
    expect(vacuumWords(g.frameNc!)).toEqual([]);
  });
});

// #472 — the assignment itself: `setupPrograms` is the one split, and `setupProgramFindings` is
// the one reading of the map. Tested directly, without a wasm run, because these are the rules
// every later program (and the sheet) is derived from.
describe('the per-cutter assignment (#472)', () => {
  const ORIENTATION = {
    top: 'top',
    bottom: 'bottom',
    left: 'left',
    right: 'right',
    front: 'front',
    back: 'back',
  } as const;
  const TOOL_B: ToolLibraryEntry = {
    key: 'user:flat-1-b',
    tool: flatEndMill(1.0, { name: '1 mm flat (setup B)' }),
    provenance: 'test',
  };
  const setupWith = (
    job: EngraveJob,
    tools: string[],
    toolItems?: Record<string, string[]>,
  ): EngraveJob => ({
    ...job,
    setups: [
      {
        id: 'setup-1',
        orientation: { ...ORIENTATION },
        mount: { kind: 'vise' },
        itemIds: job.labels.map((l) => l.id),
        tools,
        ...(toolItems === undefined ? {} : { toolItems }),
      },
    ],
  });

  it('makes one ref per (setup, tool), each with the items that cutter owns', () => {
    const job = dj();
    const [a, b] = job.labels.map((l) => l.id);
    const refs = setupPrograms(
      setupWith(job, [job.toolKey, TOOL_B.key], { [job.toolKey]: [a!], [TOOL_B.key]: [b!] }),
    );
    expect(refs.map((r) => [r.setupIndex, r.toolKey, r.itemIds])).toEqual([
      [1, job.toolKey, [a]],
      [1, TOOL_B.key, [b]],
    ]);
  });

  it('gives the first cutter every item when a multi-tool setup states no map', () => {
    const job = dj();
    const ids = job.labels.map((l) => l.id);
    const refs = setupPrograms(setupWith(job, [job.toolKey, TOOL_B.key]));
    expect(refs.map((r) => r.itemIds)).toEqual([ids, []]);
  });

  it('drops an assignment that names a cutter or item the setup no longer holds', () => {
    const job = dj();
    const [a, b] = job.labels.map((l) => l.id);
    const findings = setupProgramFindings(
      setupWith(job, [job.toolKey], {
        [job.toolKey]: [a!],
        'user:ghost': [b!],
        removed: [a!],
      }),
    );
    // A single-cutter setup's map is stale by definition: the tool key no longer listed is
    // `setup-tool-unknown`, and the setup's own item b is then unassigned.
    expect(findings.some((f) => f.code === 'setup-tool-unknown' && f.severity === 'error')).toBe(true);
    expect(findings.some((f) => f.code === 'setup-items-unassigned' && f.severity === 'error')).toBe(true);
  });

  it('refuses a first cutter with nothing assigned', () => {
    const job = dj();
    const ids = job.labels.map((l) => l.id);
    const findings = setupProgramFindings(
      setupWith(job, [job.toolKey, TOOL_B.key], { [job.toolKey]: [], [TOOL_B.key]: ids }),
    );
    expect(findings.some((f) => f.code === 'setup-tool-no-items' && f.severity === 'error')).toBe(true);
  });
});

/**
 * Through-cuts and cut-outs (#218): a tabbed cut-out all the way to a verified program, the tab
 * that cannot be placed, the cutter that cannot reach the board, and the through cut that leaves
 * a piece of the blank loose. Real Manifold, real verifier.
 */
describe('through-cuts and cut-outs (#218)', () => {
  /** A 3.175 mm flat with real reach: 20 mm of flute and shoulder clears a 12.3 mm through cut. */
  const PROFILER = flatEndMill(3.175, {
    name: '3.175 mm flat end',
    fluteLength: 20,
    shoulderLength: 20,
  });

  /** The default 100 × 60 × 12 blank with ONE cut-out and a 12 mm board under it. */
  function cutoutJob(
    cutoutOver: Partial<EngraveCutout> = {},
    jobOver: Partial<EngraveJob> = {},
  ): EngraveJob {
    const base = dj();
    return {
      ...base,
      labels: [],
      shapes: [],
      toolKey: 'inv:flat-3.175x20',
      tool: PROFILER,
      sacrificial: presetPartOnBoard(),
      breakthrough: 0.3,
      cutouts: [
        {
          kind: 'cutout',
          id: 'cut-1',
          name: 'Badge',
          enabled: true,
          of: 'stock-inset',
          side: 'inside',
          inset: 5,
          tabs: { count: 4, width: 4, height: 1 },
          ...cutoutOver,
        },
      ],
      ...jobOver,
    };
  }

  /** A small rect pocket, for a cut-out to follow. */
  const RECT = { kind: 'rect' as const, id: 'rect-1', enabled: true, position: { x: 50, y: 30 }, rotation: 0, cornerRadius: 0, depth: 1 };

  it('cuts a tabbed cut-out through the blank and reports its facts on the program and the sheet', () => {
    const job = cutoutJob();
    const g = generate(tl, job);
    expect(g.ok).toBe(true);
    expect(g.stage).toBe('done');
    expect(g.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(g.verify!.findings.filter((f) => f.severity === 'error')).toEqual([]);

    // One operation, and it is the full-depth pass the shared IR vocabulary calls 'through'.
    expect(g.cam!.operations).toBe(1);
    expect(g.cam!.throughOperations).toBe(1);

    // The facts the run sheet reads: the breakthrough, the board it lands in, and the tab spec
    // the file was cut with (all four requested tabs placed).
    expect(g.through).toEqual({
      breakthroughMm: 0.3,
      boardThicknessMm: 12,
      cutouts: [
        {
          id: 'cut-1',
          name: 'Cut out "Badge" inside stock inset 5mm',
          tabs: { count: 4, widthMm: 4, heightMm: 1 },
          spans: 4,
          unplaceable: 0,
        },
      ],
    });
    // The same facts travel on the program entry — the sheet's per-program section reads them.
    expect(g.programs).toHaveLength(1);
    expect(g.programs[0]!.through).toEqual(g.through);

    const sheet = buildRunSheet(job, g, null);
    const cut = sheet.sections.find((s) => s.id === 'cut')!;
    const text = cut.steps.map((s) => `${s.text} ${s.value ?? ''}`).join('\n');
    expect(text).toContain('through into the board, 0.3 mm past the blank');
    expect(text).toContain('the board is 12 mm thick');
    // The tab removal is its OWN step and names the count and dimensions.
    expect(text).toContain('Only after the program ends');
    expect(text).toContain('4 tabs to cut by hand');
    expect(text).toContain('Cut out "Badge" inside stock inset 5mm: 4 tabs, 4 mm wide and 1 mm high');
  });

  it('the oracle predicts the material an interrupted pass LEAVES, not a square tab (#218)', () => {
    // The sweep stops with the cutter's CENTRE at the span ends, so at a deep pass the standing
    // tab is the span band less the two round end discs. Predicting the plain `tabRectangles`
    // (which is what the void scan and the run sheet describe) leaves the disc-overhang as an
    // under-cut and refuses the save with "the simulation does not match the prediction".
    const job = cutoutJob();
    const g = generate(tl, job);
    expect(g.ok).toBe(true);
    const session = createSimSession(tl);
    try {
      const load = session.load(g.nc as string, toSetup(job, Z1), jobTool(job)!, Z1.id);
      expect(load.ok).toBe(true);
      if (!load.ok) throw new Error(JSON.stringify(load.diagnostics));
      const report = session.oracle(g.predicted);
      expect(report.ok).toBe(true);

      // The pin: the deepest level must REMOVE LESS than the level at the tab top, because that
      // is where the tabs stand. With the square-rectangle prediction both areas were equal.
      const deepest = report.levels.reduce((a, b) => (a.z < b.z ? a : b));
      const tabTop = report.levels.find((l) => l.z === -(job.stock.thickness - 1))!;
      expect(tabTop).toBeDefined();
      expect(deepest.z).toBeCloseTo(-(job.stock.thickness + job.breakthrough), 6);
      expect(deepest.predictedArea).toBeLessThan(tabTop.predictedArea);
      expect(deepest.underCut).toBeLessThan(0.001);
    } finally {
      session.dispose();
    }
  });

  it('frees a tabless cut-out onto the board without calling the released part loose', () => {
    const job = cutoutJob({ tabs: { count: 0, width: 4, height: 1 } });
    const g = generate(tl, job);
    expect(g.ok).toBe(true); // `released-onto-board` is a warning, not a refusal.
    expect(g.findings.some((f) => f.code === 'released-onto-board' && f.severity === 'warning')).toBe(true);
    // The operator ASKED for the part to be freed, so the loose-piece check excludes it.
    expect(g.findings.some((f) => f.code === 'loose-piece')).toBe(false);
    expect(g.through!.cutouts[0]!.spans).toBe(0);
    // And the sheet has no tab-removal step to give.
    const sheet = buildRunSheet(job, g, null);
    const text = sheet.sections
      .find((s) => s.id === 'cut')!
      .steps.map((s) => `${s.text} ${s.value ?? ''}`)
      .join('\n');
    expect(text).toContain('through into the board');
    expect(text).not.toContain('Only after the program ends');
  });

  it('refuses a tab with no straight edge long enough to hold it, before any program is posted', () => {
    // A 3 × 3 rect's outside path has 6.175 mm edges; a 4 mm tab needs 7.175 mm of centre path.
    const job = cutoutJob(
      { of: 'rect-1', side: 'outside', inset: 0, tabs: { count: 4, width: 4, height: 1 } },
      { shapes: [{ ...RECT, width: 3, height: 3 }] },
    );
    const g = generate(tl, job);
    expect(g.ok).toBe(false);
    expect(g.stage).toBe('findings');
    expect(g.nc).toBeNull();
    const f = g.findings.find((x) => x.code === 'tab-unplaceable');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('error');
    expect(f!.labelId).toBe('cut-1');
    expect(f!.message).toContain('4 holding tabs');
  });

  it('refuses a through cut the cutter cannot reach above its shank', () => {
    // 12 mm of blank plus the 0.3 mm breakthrough is 12.3 mm; this cutter states 5 mm of shoulder.
    const short = flatEndMill(3.175, { name: 'short flat end', fluteLength: 20, shoulderLength: 5 });
    const g = generate(tl, cutoutJob({}, { tool: short, toolKey: 'inv:short' }));
    expect(g.ok).toBe(false);
    expect(g.stage).toBe('findings');
    const f = g.findings.find((x) => x.code === 'through-tool-reach');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('error');
    expect(f!.labelId).toBe('cut-1');
    expect(f!.message).toContain('12.3');
  });

  it('refuses a through cut that leaves a piece of the blank disconnected', () => {
    // A 100 × 4 through slot spanning the blank edge to edge severs the front strip.
    const job = cutoutJob(
      {},
      { cutouts: [], shapes: [{ ...RECT, width: 100, height: 4, id: 'slit', through: true }] },
    );
    const g = generate(tl, job);
    expect(g.ok).toBe(false);
    expect(g.stage).toBe('findings');
    expect(g.nc).toBeNull();
    const f = g.findings.find((x) => x.code === 'loose-piece');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('error');
    expect(f!.message).toMatch(/disconnected from the material the mount holds/);
  });

  it('refuses a cut-out whose inset leaves no path, instead of silently dropping it (#218)', () => {
    // A 100 mm inset on the 100 × 60 blank shrinks the profile past the cutter radius: the old
    // behaviour was `profilePath` returning [] and the cut-out simply vanishing from the program.
    const g = generate(tl, cutoutJob({ inset: 100 }));
    expect(g.ok).toBe(false);
    expect(g.stage).toBe('findings');
    expect(g.nc).toBeNull();
    const f = g.findings.find((x) => x.code === 'cutout-empty' && x.labelId === 'cut-1');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('error');
    expect(f!.message).toContain('100 mm inset');
    expect(f!.message).toContain('no path');
  });
});

// #608 — a fitted surface plane is posted against: the program's FEED moves' Z follows the plane,
// so a tilted blank's colour plane stays at the programmed depth under the tilt. The flat program
// (no `shop.surface`) is byte-identical to before.
describe('the fitted surface plane is posted against (#608)', () => {
  /** Every G1 feed move's resolved XYZ, tracking the modal words the post omits. */
  function feedMoves(nc: string): { x: number; y: number; z: number }[] {
    const out: { x: number; y: number; z: number }[] = [];
    let x = 0;
    let y = 0;
    let z = 0;
    for (const raw of nc.split('\n')) {
      const line = raw.trim();
      const isG0 = /^G0\b/.test(line);
      const isG1 = /^G1\b/.test(line);
      if (!isG0 && !isG1) continue;
      const xm = /(?:^|\s)X(-?[\d.]+)/.exec(line);
      const ym = /(?:^|\s)Y(-?[\d.]+)/.exec(line);
      const zm = /(?:^|\s)Z(-?[\d.]+)/.exec(line);
      if (xm) x = Number(xm[1]);
      if (ym) y = Number(ym[1]);
      if (zm) z = Number(zm[1]);
      if (isG1) out.push({ x, y, z });
    }
    return out;
  }

  it('lifts every feed move by the plane at its XY, and leaves the flat program unchanged', () => {
    const job = dj();
    const margins = effectiveMargins(job, MARGIN_DEFAULTS);
    // A realistic tilt: bounded by the depth band (≤ ~0.4 mm over the stock), so even the shallowest
    // 0.5 mm cut stays below the top face once the lift is applied.
    const plane = { offset: -55, slopeX: 0.002, slopeY: -0.003 };
    const z0 = -55; // the reference reading, so the lift at the origin is 0
    const flat = engraveGenerate(tl, job, jobTool(job), [], null, margins, {});
    const fitted = engraveGenerate(tl, job, jobTool(job), [], null, margins, { surface: { plane, z0 } });

    expect(flat.ok).toBe(true);
    expect(fitted.ok).toBe(true);
    expect(flat.nc).not.toBeNull();
    expect(fitted.nc).not.toBeNull();
    // The flat program is untouched — the same bytes as a run with no surface option.
    expect(fitted.nc).not.toBe(flat.nc);

    const flatMoves = feedMoves(flat.nc!);
    const fitMoves = feedMoves(fitted.nc!);
    expect(fitMoves.length).toBe(flatMoves.length);
    expect(fitMoves.length).toBeGreaterThan(0);

    // Each feed move lands at the flat Z plus the plane's lift at its own XY.
    const lift = (x: number, y: number): number => plane.offset - z0 + plane.slopeX * x + plane.slopeY * y;
    const zs = new Set<number>();
    for (let i = 0; i < fitMoves.length; i++) {
      const f = flatMoves[i]!;
      const g = fitMoves[i]!;
      expect(g.x).toBeCloseTo(f.x, 6);
      expect(g.y).toBeCloseTo(f.y, 6);
      expect(g.z).toBeCloseTo(f.z + lift(g.x, g.y), 2);
      zs.add(Number(g.z.toFixed(3)));
    }
    // The posted Z actually VARIES with XY: the tilt spreads one flat depth across many Zs.
    expect(zs.size).toBeGreaterThan(new Set(flatMoves.map((m) => Number(m.z.toFixed(3)))).size);
    // #608 — the frame file is an air trace at FRAME_Z and never follows the surface: it is
    // byte-identical whether or not the program was posted against the tilt.
    expect(fitted.frameNc).toBe(flat.frameNc);
  });
});
