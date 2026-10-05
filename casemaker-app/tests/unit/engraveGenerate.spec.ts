// The generate → verify headless pipeline (#206). Real Manifold, plain Node — the same harness
// `engravePreview.spec.ts` uses. This is the half that must be byte-identical run to run: the
// `.nc` a user saves is the text this function returns, never a re-derivation.

import { describe, it, expect } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { engraveGenerate, engraveRegions, frameCorners } from '@/workers/sim/engraveGenerate';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { CAM_ID, CAM_NAME } from '@/engine/cnc/post/z1';
import { version as APP_VERSION } from '../../package.json';
import { presetPartOnBoard } from '@/engine/cnc/sacrificial';
import type { ToolpathIR } from '@/engine/cnc/cam/ir';
import type { Tool } from '@/engine/cnc/tool';
import type { EngraveJob } from '@/types/engraveJob';

describe('engraveGenerate (#206)', () => {
  it('takes the default job all the way to a clean .nc', () => {
    const g = engraveGenerate(tl, defaultEngraveJob());
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
    const g = engraveGenerate(tl, defaultEngraveJob());
    expect(g.nc).not.toBeNull();
    // The exact header line the app writes; a headless run must match it byte for byte.
    expect(g.nc).toContain(`;@MKR|CAM|id=${CAM_ID}|name=${CAM_NAME}|v=${APP_VERSION}`);
    expect(g.nc).not.toContain('v=dev');
  });

  it('is pure: the same job produces byte-identical nc', () => {
    const job = defaultEngraveJob();
    const a = engraveGenerate(tl, job);
    const b = engraveGenerate(tl, structuredClone(job) as EngraveJob);
    expect(a.nc).not.toBeNull();
    expect(a.nc).toBe(b.nc);
  });

  it('stops at findings for a cut deeper than the stock allows', () => {
    const job = defaultEngraveJob();
    const deep: EngraveJob = {
      ...job,
      labels: job.labels.map((l, i) => (i === 0 ? { ...l, depth: 11.5 } : l)),
    };
    const g = engraveGenerate(tl, deep);
    expect(g.ok).toBe(false);
    expect(g.stage).toBe('findings');
    expect(g.nc).toBeNull();
    expect(g.findings.some((f) => f.code === 'depth-exceeds-stock' && f.severity === 'error')).toBe(true);
  });

  it('stops at feeds for a step-over past the cutter radius (#191)', () => {
    const job: EngraveJob = { ...defaultEngraveJob(), cutOverride: { stepOver: 0.6 } }; // radius is 0.5
    const g = engraveGenerate(tl, job);
    expect(g.ok).toBe(false);
    expect(g.stage).toBe('feeds');
    expect(g.nc).toBeNull();
    expect(g.feeds?.ok).toBe(false);
    expect(g.errors.some((e) => e.stage === 'feeds')).toBe(true);
  });

  it('stops at findings when the cutter is too large for the text', () => {
    const job: EngraveJob = { ...defaultEngraveJob(), toolKey: 'flat-3.175x12-metal' };
    const g = engraveGenerate(tl, job);
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
    const without = engraveRegions(tl, shallow).findings.map((f) => f.code);
    expect(without).toContain('vise-grip-shallow');

    // A 12 mm under-board with 10 mm overhang is what the jaws bear on, so the grip is the
    // board's thickness and the warning clears — only if the argument is threaded.
    const withBoard: EngraveJob = { ...shallow, sacrificial: presetPartOnBoard() };
    const withCodes = engraveRegions(tl, withBoard).findings.map((f) => f.code);
    expect(withCodes).not.toContain('vise-grip-shallow');
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
    const g = engraveGenerate(tl, defaultEngraveJob());
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
    const g = engraveGenerate(tl, deep);
    expect(g.ok).toBe(false);
    expect(g.frameNc).toBeNull();
    expect(g.frameVerify).toBeNull();
  });
});
