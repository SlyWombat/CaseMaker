// #710 (BM-6 of #707) — the clamps and the bracket's arms as obstacles with ONE fixture clearance,
// the bracket's fit, and the travel height over the tallest clamp. Design:
// `docs/design/bed-mounts-flow.md` §3.7 (the clearance, the travel height, the refusal sentences)
// and §6 fixture 3/4.
//
// THE TWO RULES THIS SPEC EXISTS FOR:
//   - every clamp and arm is grown per move by the tool's widest part, the mount's fit AND the
//     fixture clearance (the job's jaw clearance, which now covers the clamps and the arms too), so
//     a program keeps clear of what holds it rather than merely missing it;
//   - a bracket program TRAVELS above the clamps — the tallest clamp or arm top plus that
//     clearance — and a rapid that still passes below one is refused exactly as a cut is.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ShopDefaultsSchema, type ShopDefaults } from '@/platform/defaultsClient';
import {
  bracketObstacles,
  bracketSettings,
  clampObstacles,
  defaultClampPlacements,
  mountInPath,
  type MountObstacle,
  type PathSegment,
} from '@/engine/cnc/mounts';
import { HOP_Z, SAFE_Z, raiseTravelOver, travelHeightOver, type CamMove, type ToolpathIR } from '@/engine/cnc/cam/ir';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { generate } from './helpers/engravePipeline';
import { tl } from './helpers/manifoldExec';
import { Z1 } from '@/engine/cnc/machine';
import { flatEndMill } from '@/engine/cnc/tool';
import { rectProfile } from '@/engine/compiler/profile';
import { stubSetup } from '@/engine/cnc/setup';
import { parseGcode } from '@/engine/cnc/gcode';
import { stockDepthLimit, verifyProgram, type VerifyContext } from '@/engine/cnc/verify';
import type { MountObstacles } from '@/engine/cnc/mounts';
import type { EngraveJob } from '@/types/engraveJob';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULTS: ShopDefaults = ShopDefaultsSchema.parse(
  (JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as { defaults: unknown }).defaults,
);
const B = bracketSettings(DEFAULTS);
const TOOL_R = 3.175 / 2;
const PLATE = { x: 100, y: 60, z: 6 };
/** The design's fixture clearance: the job's jaw clearance, 1 mm. */
const CLEARANCE = 1;
/** The design's grown keep-out for a ⌀3.175 flat: 1.5875 + 0.1 + 1. */
const KEEP = Math.round((TOOL_R + B.settings.fitMm + CLEARANCE) * 1000) / 1000; // 2.688

const clamps = clampObstacles(PLATE, defaultClampPlacements(PLATE, B.settings), B.settings);
const seg = (from: [number, number, number], to: [number, number, number], mode: 'cut' | 'rapid' = 'cut', line = 7): PathSegment => ({
  line,
  mode,
  from,
  to,
});

describe('#710 the fixture clearance is part of the growth', () => {
  it('a cut inside the clearance is refused; the same cut outside it is not', () => {
    // The back-edge clamp's nose is at Y 52. With the tool and the fit the keep-out is 1.6875;
    // with the fixture clearance on top it is 2.6875 — a centre line at Y 49.4 (2.6 from the nose)
    // is inside the one and outside the other.
    const path = [seg([0, 49.4, -1], [100, 49.4, -1])];
    const without = mountInPath(path, clamps, { radius: TOOL_R, uncertainty: B.settings.fitMm });
    const withClearance = mountInPath(path, clamps, { radius: TOOL_R, uncertainty: B.settings.fitMm, clearance: CLEARANCE });
    expect(without).toEqual([]);
    expect(withClearance.map((f) => f.code)).toEqual(['clamp-in-path', 'clamp-in-path']);
  });

  it('the arm refusal quotes the same keep-out and the arm’s height above the plate (§6 fixture 4)', () => {
    // A 3.81 mm plate in the bracket: the arms stand 10 − 3.81 = 6.19 above the plate.
    const thin = { x: 100, y: 60, z: 3.81 };
    const arm = bracketObstacles(thin, B.settings)[0]!;
    expect(arm.topZ).toBeCloseTo(6.19, 3);
    // A cut whose centre line is 2 mm from the front edge, below the arm's top.
    const f = mountInPath([seg([10, 2, -1], [90, 2, -1])], [arm], { radius: TOOL_R, uncertainty: B.settings.fitMm, clearance: CLEARANCE });
    expect(f).toHaveLength(1);
    expect(f[0]!.message).toBe(
      `a cutting move comes within ${(2 - TOOL_R).toFixed(3)} mm of the bracket’s front arm, which stands 6.19 mm above the plate — ` +
        `keep the cut ${KEEP.toFixed(3)} mm inside the front edge.`,
    );
  });

  it('#727 F3 — the travel height includes the FIT, because the verifier’s top does', () => {
    // #727 F3 — the verifier compares a move with `topZ + uncertainty` (inPath.ts), while the raise
    // used to stop at `topZ + clearance`. With a fit wider than the clearance every raised rapid
    // is refused by the very check it was raised for. The schema allows clearance 0 and a fit of 2.
    const fit = 2;
    const travel = travelHeightOver(clamps, 0, fit);
    expect(travel).toBe(14);
    const at = (z: number) =>
      mountInPath([seg([10, 55, z], [90, 55, z], 'rapid')], clamps, { radius: TOOL_R, uncertainty: fit, clearance: 0 });
    expect(at(travel!)).toEqual([]);
  });

  it('a rapid at the old travel height over a clamp is refused as a cut is', () => {
    // Z 5 is above the CAM's own 1 mm hop but far below the clamps' 12 mm top.
    const f = mountInPath([seg([10, 55, 5], [90, 55, 5], 'rapid')], clamps, { radius: TOOL_R, uncertainty: B.settings.fitMm, clearance: CLEARANCE });
    expect(f.map((x) => x.code)).toEqual(['clamp-in-path', 'clamp-in-path']);
    // At the raised height it is clear.
    expect(mountInPath([seg([10, 55, 13], [90, 55, 13], 'rapid')], clamps, { radius: TOOL_R, uncertainty: B.settings.fitMm, clearance: CLEARANCE })).toEqual([]);
  });
});

describe('#710 the travel height over the tallest clamp or arm', () => {
  it('is the tallest top above the plate plus the clearance; nothing above the stock keeps the CAM’s floors', () => {
    expect(travelHeightOver(clamps, CLEARANCE)).toBe(13);
    expect(travelHeightOver([{ topZ: 6.19 }], CLEARANCE)).toBe(7.19);
    expect(travelHeightOver([], CLEARANCE)).toBeNull();
    // A tall blank pushes the arms below its top: nothing to clear.
    expect(travelHeightOver(bracketObstacles({ x: 100, y: 60, z: 20 }, B.settings), CLEARANCE)).toBeNull();
  });

  it('raises the hops and the retracts, leaves a peck retract alone, and carries safeZ/hopZ with it', () => {
    const moves: CamMove[] = [
      { kind: 'rapid', x: 0, y: 0, z: HOP_Z },
      { kind: 'feed', x: 0, y: 0, z: -2, f: 200 },
      // A drill's chip-clear peck, in the shape the drill CAM emits (#727 F4): a hop, tagged.
      { kind: 'rapid', x: 0, y: 0, z: HOP_Z, peck: true },
      { kind: 'feed', x: 0, y: 0, z: -4, f: 200 },
      { kind: 'rapid', x: 10, y: 10, z: SAFE_Z },
    ];
    const ir: ToolpathIR = {
      frame: 'flat',
      tool: flatEndMill(3.175),
      toolNumber: 1,
      spindleRpm: 12000,
      air: true,
      safeZ: SAFE_Z,
      hopZ: HOP_Z,
      operations: [{ number: 1, name: '[T1]Drill', labelId: '', depth: 4, moves, estimatedSeconds: 0 }],
    };
    const raised = raiseTravelOver(ir, travelHeightOver(clamps, CLEARANCE), Z1.rapidEstimate);
    expect(raised.hopZ).toBe(13);
    expect(raised.safeZ).toBe(13);
    expect(raised.operations[0]!.moves.map((m) => m.z)).toEqual([13, -2, HOP_Z, -4, 13]);
    // The climb is time: the estimate is recomputed rather than left at the old one.
    expect(raised.operations[0]!.estimatedSeconds).toBeGreaterThan(0);
    // Nothing to raise, or a travel below the CAM's floors, is the SAME object (no churn).
    expect(raiseTravelOver(ir, null)).toBe(ir);
    expect(raiseTravelOver(ir, SAFE_Z)).toBe(ir);
  });
});

// ---------------------------------------------------------------------------------------------------
// Through the real pipeline.

/** A bracket mount whose clamp stands 12 mm above the plate, as the shop defaults do. */
function mountWith(topZ: number): MountObstacles {
  const o: MountObstacle = {
    id: 'clamp-1',
    kind: 'clamp',
    label: 'the clamp on the back edge, 15 mm in from the left-hand corner',
    fix: 'slide the clamp along the back edge, or move it to the right edge, clear of the cut',
    min: [0, 54],
    max: [100, 60],
    topZ,
  };
  return {
    obstacles: [o],
    uncertainty: B.settings.fitMm,
    fixture: { boxes: [{ id: o.id, label: o.label, min: [o.min[0], o.min[1], -12], max: [o.max[0], o.max[1], o.topZ] }], source: 'default', uncertainty: B.settings.fitMm },
  };
}

describe('#710 a bracket program travels above the clamps', () => {
  const job = (): EngraveJob => ({ ...defaultEngraveJob(), toolKey: 'flat-1.0' });

  it('every work-frame rapid stands at the clamps’ top + fit + clearance, and the program verifies clean', () => {
    const g = generate(tl, job(), null, [], undefined, { mount: mountWith(12) });
    expect(g.ok, `${g.stage} ${JSON.stringify(g.errors)}`).toBe(true);
    expect(g.nc).not.toBeNull();
    const rapidZs = parseGcode(g.nc ?? '')
      .events.filter((e) => e.kind === 'move' && e.frame === 'work' && e.mode === 'rapid')
      .map((e) => (e.kind === 'move' ? e.to[2] : null))
      .filter((z): z is number => z !== null);
    expect(rapidZs.length).toBeGreaterThan(0);
    expect(Math.min(...rapidZs)).toBeCloseTo(12 + B.settings.fitMm + CLEARANCE, 6);
    expect(rapidZs.some((z) => Math.abs(z - (12 + B.settings.fitMm + CLEARANCE)) < 1e-6)).toBe(true);
  });

  it('without a mount standing above the stock the CAM’s own hop and safe heights stand', () => {
    const g = generate(tl, job(), null, [], undefined, { mount: mountWith(0.5) });
    expect(g.ok, `${g.stage} ${JSON.stringify(g.errors)}`).toBe(true);
    expect(g.nc).not.toBeNull();
    const rapidZs = parseGcode(g.nc ?? '')
      .events.filter((e) => e.kind === 'move' && e.frame === 'work' && e.mode === 'rapid')
      .map((e) => (e.kind === 'move' ? e.to[2] : null))
      .filter((z): z is number => z !== null);
    expect(Math.min(...rapidZs)).toBeLessThanOrEqual(SAFE_Z);
  });
});

describe('#727 F4 — a drill’s chip-clear peck is not travel', () => {
  it('the peck stays at the CAM’s hop while the hops between holes are raised over the clamps', () => {
    // A pecking hole at X 50, Y 20 — clear of the back clamp, so its own path is not refused. Its
    // chip-clear retracts are the drill's, not travel: raising them to 13.1 would turn every peck
    // into a full retract (the comment on `raiseTravelOver` promises it does not).
    const job: EngraveJob = {
      ...defaultEngraveJob(),
      labels: [],
      toolKey: 'flat-1.0',
      drills: [
        {
          id: 'hole',
          kind: 'drill',
          name: 'port',
          position: { x: 50, y: 20 },
          rotation: 0,
          depth: 4,
          peckMm: 1,
          enabled: true,
          through: false,
        } as EngraveJob['drills'][number],
      ],
    };
    const g = generate(tl, job, null, [], undefined, { mount: mountWith(12) });
    expect(g.ok, `${g.stage} ${JSON.stringify(g.errors)}`).toBe(true);
    const rapidZs = parseGcode(g.nc ?? '')
      .events.filter((e) => e.kind === 'move' && e.frame === 'work' && e.mode === 'rapid')
      .map((e) => (e.kind === 'move' ? e.to[2] : null))
      .filter((z): z is number => z !== null);
    // The chip-clear pecks hold the CAM's hop; the travel between holes clears the clamp.
    expect(rapidZs).toContain(HOP_Z);
    expect(rapidZs.some((z) => Math.abs(z - (12 + B.settings.fitMm + CLEARANCE)) < 1e-6)).toBe(true);
  });
});

describe('#710 the verifier names the item, from the program’s own header', () => {
  const ctx = (clearance: number): VerifyContext => ({
    setup: stubSetup({ kind: 'prism', outline: rectProfile(100, 60), thickness: 6 }, { kind: 'anchor-bracket', anchor: 1, offset: [0, 0] }, { startingTool: 1 }, Z1),
    machine: Z1,
    tool: flatEndMill(3.175),
    depthLimit: stockDepthLimit({ length: 100, width: 60, thickness: 6 }, 1),
    minRapidZ: 1,
    mountObstacles: { obstacles: clamps, uncertainty: B.settings.fitMm, clearance },
  });
  // The post's own records: the operation's name in the header, its number at the start of the cut.
  const prog = (body: string[]) =>
    [
      'G90 G21',
      'T1 M6',
      'M331',
      'G53 G0 Z-3',
      'S12000 M3',
      ';@MKR|TOOLPATH|number=1|tool_number=1|name=Pocket "Tray" 2.0mm',
      ';@MKR|TOOLPATH_START|toolpath_number=1',
      ...body,
      'G0 Z13',
      'M5',
      'M332',
      'M2',
    ].join('\n');

  it('the clamp refusal is the design’s sentence, with the item as its subject', () => {
    const f = verifyProgram(prog(['G0 X10 Y55', 'G0 Z1', 'G1 Z-0.5 F300', 'G1 X60 Y55']), ctx(CLEARANCE)).findings.find((x) => x.code === 'clamp-in-path');
    expect(f?.message).toBe(
      '“Tray” runs under the clamp on the back edge, 15 mm in from the left-hand corner — ' +
        'slide the clamp along the back edge, or move it to the right edge, clear of the cut.',
    );
  });

  it('without a named operation the sentence keeps the old subject rather than inventing one', () => {
    const f = verifyProgram(
      prog(['G0 X10 Y55', 'G0 Z1', 'G1 Z-0.5 F300', 'G1 X60 Y55']).replace(/^;@MKR\|TOOLPATH\|.*$/m, ''),
      ctx(0),
    ).findings.find((x) => x.code === 'clamp-in-path');
    expect(f?.message.startsWith('a cutting move runs under ')).toBe(true);
  });

  it('a rapid at the old travel height is refused, and the item is named there too', () => {
    // Z 5: above the hop, below the clamps at 12. The travel raise is the CAM's; a FILE that still
    // travels low (an older program, a hand edit) is refused here.
    const f = verifyProgram(prog(['G0 X10 Y55 Z5', 'G1 X60 Y55 F300']), ctx(CLEARANCE)).findings.find((x) => x.code === 'clamp-in-path');
    expect(f?.message.startsWith('“Tray” runs under the clamp')).toBe(true);
  });
});
