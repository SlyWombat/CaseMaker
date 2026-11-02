// #841 — external threads and imperial (UNC/UNF) sizes: the thread table against its cited
// standards, the M8×1.25 external on an 8 mm boss (the helix radius, the depth, the post, the
// verifier and the oracle), the 1/4-20 UNC internal, the mismatched cutter that informs and offers
// the nearest owned one, and the internal metric output that must not move by a byte.

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { planThreadMill, threadMillIR, type ThreadMillInput, type ThreadSettings } from '@/engine/cnc/cam/threadMill';
import { HOP_Z } from '@/engine/cnc/cam/ir';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { ORACLE_AREA_FLOOR } from '@/engine/cnc/engrave/oracle';
import { toSetup, validateJob } from '@/engine/cnc/engrave/jobSetup';
import { nearestThreadMill, threadBoss, threadMillFit } from '@/engine/cnc/engrave/threadFit';
import { Z1 } from '@/engine/cnc/machine';
import { postZ1 } from '@/engine/cnc/post/z1';
import { stubSetup } from '@/engine/cnc/setup';
import {
  EXTERNAL_MINOR_COEFF,
  INTERNAL_MINOR_COEFF,
  threadMillPitchOf,
  threadSpec,
  UNIFIED_THREAD_SIZES,
} from '@/engine/cnc/threadTable';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import { stockDepthLimit, verifyProgram } from '@/engine/cnc/verify';
import { rectProfile } from '@/engine/compiler/profile';
import type { ShopDefaults } from '@/platform/defaultsClient';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import type { EngraveJob, EngraveThreadItem } from '@/types/engraveJob';
import { createSimSession } from '@/workers/sim/session';
import { generate } from './helpers/engravePipeline';
import { tl } from './helpers/manifoldExec';

const HERE = dirname(fileURLToPath(import.meta.url));
const r3 = (n: number) => Math.round(n * 1000) / 1000;

const S: ThreadSettings = {
  radialStepoverMm: 0.2,
  entryRampMm: 0.5,
  bottomClearancePitches: 1,
  pilotTipClearanceMm: 0.5,
  feed: 300,
  plungeFeed: 100,
  spindleRpm: 10000,
  chordToleranceMm: 0.01,
};
const DEFAULTS = Object.fromEntries(
  Object.entries({
    radialStepoverMm: 0.2,
    entryRampMm: 0.5,
    bottomClearancePitches: 1,
    pilotTipClearanceMm: 0.5,
    feed: 300,
    plungeFeed: 100,
    spindleRpm: 10000,
    chordToleranceMm: 0.01,
  }).map(([k, v]) => [`thread.${k}`, { value: v, source: 'seeded' }]),
) as unknown as ShopDefaults;

function mill(name: string, d: number, fluteLength = 20): Tool {
  return flatEndMill(d, { name, typeText: 'Thread Mill', shape: 'thread', tipDiameter: d, diameter: d, fluteLength });
}

/** A single-form M8×1.25 thread mill, ⌀6 mm cutting. */
const M8_MILL = mill('Thread mill M8x1.25 (d6mm)', 6);
/** Makera's own M3 thread mill (its name is the only place its pitch is stated). */
const M3_MILL = mill('Thread Milling Bit - 1/8" Shank M3(d2.4mm) * 9mm', 2.4, 9);
/** A 1/4-20 single-form thread mill, ⌀4 mm cutting. */
const UNC_MILL = mill('Thread mill 1/4-20 UNC (d4.0mm)', 4);

describe('#841 the thread table against its cited standards', () => {
  // ASME B1.1-2003 Table 2 "basic minor diameter" (in), D − 1.082532/n, to four places.
  it.each([
    ['#4-40', 0.112, 40, 0.0849],
    ['#10-32', 0.19, 32, 0.1562],
    ['1/4-20', 0.25, 20, 0.1959],
    ['3/8-24', 0.375, 24, 0.3299],
    ['1/2-13', 0.5, 13, 0.4167],
  ] as const)('%s: major %s in, %s TPI, basic minor %s in (ASME B1.1)', (size, majorIn, tpi, minorIn) => {
    const s = threadSpec(size);
    expect(s.standard).toBe('imperial');
    expect(s.majorIn).toBe(majorIn);
    expect(s.tpi).toBe(tpi);
    expect(s.pitch).toBeCloseTo(25.4 / tpi, 12);
    expect(s.major).toBeCloseTo(majorIn * 25.4, 3);
    expect(s.minor / 25.4).toBeCloseTo(minorIn, 4);
  });

  it('carries UNC and UNF from #4 to 1/2"', () => {
    expect(UNIFIED_THREAD_SIZES[0]).toBe('#4-40');
    expect(UNIFIED_THREAD_SIZES[UNIFIED_THREAD_SIZES.length - 1]).toBe('1/2-20');
    expect(threadSpec('1/4-20').series).toBe('UNC');
    expect(threadSpec('1/4-28').series).toBe('UNF');
  });

  // ISO 724 (from ISO 68-1 / ISO 965-1): D1 and d3 for the added metric sizes.
  it.each([
    ['M8', 8, 1.25, 6.647, 6.466],
    ['M10', 10, 1.5, 8.376, 8.16],
    ['M12', 12, 1.75, 10.106, 9.853],
  ] as const)('%s × %s: D1 %s, d3 %s (ISO 724)', (size, major, pitch, d1, d3) => {
    const s = threadSpec(size);
    expect(s.major).toBe(major);
    expect(s.pitch).toBe(pitch);
    expect(s.minor).toBeCloseTo(d1, 3);
    expect(s.externalMinor).toBeCloseTo(d3, 3);
    expect(s.externalMinor).toBeCloseTo(major - EXTERNAL_MINOR_COEFF * pitch, 3);
    expect(s.minor).toBeCloseTo(major - INTERNAL_MINOR_COEFF * pitch, 3);
  });

  it('reads a thread mill’s pitch from its name, and nothing from a name that states none', () => {
    expect(threadMillPitchOf(M3_MILL.name)).toBe(0.5);
    expect(threadMillPitchOf(M8_MILL.name)).toBe(1.25);
    expect(threadMillPitchOf(UNC_MILL.name)).toBeCloseTo(1.27, 12);
    expect(threadMillPitchOf('#10-32 thread mill')).toBeCloseTo(25.4 / 32, 12);
    expect(threadMillPitchOf('single-form mill, 18 TPI')).toBeCloseTo(25.4 / 18, 12);
    expect(threadMillPitchOf('4 mm thread mill')).toBeNull();
  });
});

/** The boss: a ⌀8 mm rod standing on its end in the vise, 20 mm tall, 12 mm proud of the jaws. */
function bossJob(thread: Partial<EngraveThreadItem> = {}, tool: Tool = M8_MILL): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    stock: { ...base.stock, length: 8, width: 8, thickness: 20, shape: 'cylinder', diameter: 8 },
    // The rod stands 12 mm proud of the jaws: the thread (6 mm + a pitch of run-out) works above them.
    workholding:
      base.workholding.kind === 'vise'
        ? { ...base.workholding, vise: { ...base.workholding.vise, stockProud: 12 } }
        : base.workholding,
    labels: [],
    shapes: [],
    traces: [],
    drills: [],
    tool,
    threads: [
      {
        kind: 'thread',
        id: 'thr-ext',
        position: { x: 4, y: 4 },
        enabled: true,
        size: 'M8',
        standard: 'metric',
        classFit: '6h',
        side: 'external',
        depth: 6,
        through: false,
        ...thread,
      },
    ],
  };
}

describe('#841 M8×1.25 external on an 8 mm boss', () => {
  const input: ThreadMillInput = {
    tool: M8_MILL,
    position: [4, 4],
    size: 'M8',
    side: 'external',
    depth: 6,
    through: false,
    settings: S,
  };
  const r = planThreadMill(input);
  if (!r.ok) throw new Error(r.reason);
  const p = r.plan;
  const helix = p.moves.filter((m) => m.kind === 'feed' && m.f === S.feed);

  it('lands the tooth tip on d3 = 8 − 1.226869 × 1.25 = 6.466 mm: radial depth 0.767 mm', () => {
    expect(p.external).toBe(true);
    expect(p.major).toBe(8);
    expect(p.pitch).toBe(1.25);
    expect(p.minor).toBe(6.466);
    expect(r3((p.major - p.minor) / 2)).toBe(0.767);
  });

  it('the helix radius: the last pass orbits at (d3 + dc)/2 = 6.233 mm, the first just inside the boss’s major', () => {
    const last = p.passRadii[p.passRadii.length - 1]!;
    expect(last).toBeCloseTo((6.466 + 6) / 2, 9);
    expect(p.passRadii[0]!).toBeLessThanOrEqual((8 + 6) / 2 + 1e-9);
    // Outermost first, stepping in by the shop's step-over: ceil(0.767 / 0.2) = 4 passes.
    expect(p.passRadii.length).toBe(4);
    for (let i = 1; i < p.passRadii.length; i++) expect(p.passRadii[i]!).toBeLessThan(p.passRadii[i - 1]!);
    // The helix never comes nearer the axis than the final pass, and the final chord is on it.
    const radii = helix.map((m) => Math.hypot(m.x - 4, m.y - 4));
    expect(Math.min(...radii)).toBeCloseTo(last, 6);
    expect(radii[radii.length - 1]!).toBeCloseTo(last, 6);
  });

  it('climbs: clockwise and DOWN, one pitch per turn, from the top to the tip depth', () => {
    expect(p.tipDepth).toBeCloseTo(6 + 1.25, 9);
    const first = helix.slice(0, 12);
    for (let i = 1; i < first.length; i++) {
      const a = first[i - 1]!;
      const b = first[i]!;
      expect(b.z).toBeLessThan(a.z);
      const cross = (a.x - 4) * (b.y - 4) - (a.y - 4) * (b.x - 4);
      expect(cross).toBeLessThan(0); // clockwise seen from above
    }
    // One full pass descends tipDepth over tipDepth / pitch turns.
    const perPass = helix.length / p.passRadii.length;
    const turns = p.tipDepth / p.pitch;
    expect(perPass / turns).toBeCloseTo(p.chordsPerTurn, -1);
  });

  it('never crosses the boss: every move stays outside the major radius plus the cutter radius less the depth', () => {
    for (const m of p.moves) {
      if (m.z >= 0) continue;
      expect(Math.hypot(m.x - 4, m.y - 4) + 1e-9).toBeGreaterThanOrEqual((p.minor + 6) / 2);
    }
  });

  it('posts and verifies clean', () => {
    const ir = threadMillIR({ ...input, descriptor: 'Thread M8×1.25 external', labelId: 'thr-ext', air: true, rapid: Z1.rapidEstimate });
    if (!ir.ok) throw new Error(ir.reason);
    const stock = { length: 40, width: 40, thickness: 20 };
    const posted = postZ1(ir.ir, { jobName: 'boss', stock, materialName: 'PLA', zDatum: 'probed-top-face', origin: 'topFrontLeft', camVersion: 'test', toolKey: 'inv:m8' }, Z1);
    if (!posted.ok) throw new Error(posted.errors.join('; '));
    const setup = stubSetup({ kind: 'prism', outline: rectProfile(40, 40), thickness: 20 }, { kind: 'tape-down', contact: rectProfile(40, 40) }, { startingTool: 1 }, Z1);
    // The boss at (4, 4) sits near the corner of a 40 mm square; the helix is shifted onto it.
    const shifted = threadMillIR({ ...input, position: [20, 20], descriptor: 'x', labelId: 'x', air: true, rapid: Z1.rapidEstimate });
    if (!shifted.ok) throw new Error(shifted.reason);
    const posted2 = postZ1(shifted.ir, { jobName: 'boss', stock, materialName: 'PLA', zDatum: 'probed-top-face', origin: 'topFrontLeft', camVersion: 'test', toolKey: 'inv:m8' }, Z1);
    if (!posted2.ok) throw new Error(posted2.errors.join('; '));
    const report = verifyProgram(posted2.text, { setup, machine: Z1, tool: M8_MILL, depthLimit: stockDepthLimit(stock, 1), minRapidZ: HOP_Z });
    expect(report.findings).toEqual([]);
    expect(report.stats.deepestZ).toBeCloseTo(-p.tipDepth, 3);
    expect(posted.text).not.toMatch(/G0?2\b|G0?3\b/);
  });

  it('the boss is the round stock; the job generates, and the oracle passes on the profile the simulator swept', async () => {
    const job = bossJob();
    expect(threadBoss(job, { x: 4, y: 4 })?.source).toBe('stock');
    const findings = validateJob(job);
    expect(findings.filter((f) => f.code === 'thread-boss-missing')).toEqual([]);
    expect(findings.find((f) => f.code === 'thread-boss-unproven')?.severity).toBe('info');
    expect(findings.some((f) => f.code === 'thread-pilot-unproven')).toBe(false);
    // The thread IS the rod's rim: no "keep it inside the circle" sentence on it.
    expect(findings.some((f) => f.code === 'item-off-round-stock')).toBe(false);

    const g = await generate(tl, job, null, [], undefined, { defaults: DEFAULTS });
    expect(g.ok, `${g.stage}: ${JSON.stringify(g.errors)} ${JSON.stringify(g.findings.filter((f) => f.severity === 'error'))}`).toBe(true);
    expect(g.threads?.[0]?.external).toBe(true);
    const session = createSimSession(tl);
    const loaded = session.load(g.nc!, toSetup(job, Z1), M8_MILL, Z1.id, { threads: g.threads!.flatMap((t) => t.simThreads) });
    expect(loaded.ok, JSON.stringify(loaded.ok ? null : loaded.diagnostics)).toBe(true);
    try {
      const report = session.oracle(g.predicted);
      for (const level of report.levels) expect(level.predictedArea).toBeGreaterThan(0);
      expect(report.ok).toBe(true);
      expect(report.worst.underCut).toBeLessThanOrEqual(ORACLE_AREA_FLOOR);
      expect(report.worst.overCut).toBeLessThanOrEqual(ORACLE_AREA_FLOOR);
    } finally {
      session.dispose();
    }
  });

  it('no boss at the axis is informed, not refused', () => {
    const base = bossJob();
    const job: EngraveJob = { ...base, stock: { ...defaultEngraveJob().stock, thickness: 20 }, threads: [{ ...base.threads![0]!, position: { x: 30, y: 20 } }] };
    const f = validateJob(job).find((x) => x.code === 'thread-boss-missing');
    expect(f?.severity).toBe('warning');
    expect(f?.message).toMatch(/Add a ⌀8 mm boss here/);
  });
});

describe('#841 1/4-20 UNC internal', () => {
  it('pitch 1.27 mm, pilot ⌀4.975 mm, and it posts', async () => {
    const r = planThreadMill({ tool: UNC_MILL, position: [15, 12], size: '1/4-20', depth: 6, through: false, settings: S });
    if (!r.ok) throw new Error(r.reason);
    expect(r.plan.pitch).toBeCloseTo(1.27, 12);
    expect(r.plan.minor).toBe(4.975);
    expect(r.plan.major).toBe(6.35);
    expect(r.plan.external).toBeUndefined();
    expect(r.plan.notes[0]).toMatch(/^1\/4-20 UNC: /);

    const base = defaultEngraveJob();
    const job: EngraveJob = {
      ...base,
      labels: [],
      shapes: [],
      traces: [],
      drills: [],
      tool: UNC_MILL,
      threads: [
        { kind: 'thread', id: 'thr-unc', position: { x: 50, y: 30 }, enabled: true, size: '1/4-20', standard: 'imperial', classFit: '3B', depth: 6, through: false },
      ],
    };
    const g = await generate(tl, job, null, [], undefined, { defaults: DEFAULTS });
    expect(g.ok, `${g.stage}: ${JSON.stringify(g.errors)}`).toBe(true);
    expect(g.threads?.[0]?.pitch).toBeCloseTo(1.27, 12);
    expect(validateJob(job).some((f) => f.code === 'thread-pitch-mismatch')).toBe(false);
  });

  it('the schema keeps the system honest: an imperial size must say imperial', () => {
    const job = { ...defaultEngraveJob(), threads: [{ kind: 'thread', id: 't', position: { x: 1, y: 1 }, enabled: true, size: '1/4-20', standard: 'metric', classFit: '6H', depth: 2, through: false }] };
    const parsed = parseEngraveJob(JSON.parse(JSON.stringify(job)));
    expect(parsed.ok).toBe(false);
  });
});

describe('#841 a mismatched cutter informs and offers the nearest owned one', () => {
  const entries: ToolLibraryEntry[] = [
    { key: 'inv:m3', provenance: 'test', tool: M3_MILL },
    { key: 'inv:m8', provenance: 'test', tool: M8_MILL },
    { key: 'inv:unc', provenance: 'test', tool: UNC_MILL },
  ];

  it('the M3 mill on an M8 external: a pitch WARNING, and the M8 mill as the one press', () => {
    const job = bossJob({}, M3_MILL);
    const findings = validateJob(job);
    const pitch = findings.find((f) => f.code === 'thread-pitch-mismatch');
    expect(pitch?.severity).toBe('warning');
    expect(pitch?.message).toMatch(/1\.25 mm pitch/);
    expect(pitch?.message).toMatch(/0\.5 mm pitch/);
    expect(findings.some((f) => f.severity === 'error' && f.code.startsWith('thread-'))).toBe(false);
    const near = nearestThreadMill(job.threads![0]!, entries, M3_MILL, 'inv:m3');
    expect(near?.key).toBe('inv:m8');
    expect(near?.pitchMm).toBe(1.25);
  });

  it('a mill too wide for the 1/4-20 pilot: the fit error names it, and the 1/4-20 mill is offered', () => {
    const base = defaultEngraveJob();
    const thread: EngraveThreadItem = { kind: 'thread', id: 't', position: { x: 50, y: 30 }, enabled: true, size: '1/4-20', standard: 'imperial', classFit: '3B', depth: 6, through: false };
    const job: EngraveJob = { ...base, labels: [], shapes: [], traces: [], drills: [], tool: M8_MILL, threads: [thread] };
    const fit = validateJob(job).find((f) => f.code === 'thread-cutter-fit');
    expect(fit?.message).toMatch(/cannot enter the ⌀4\.975 mm pilot/);
    expect(threadMillFit(M8_MILL, thread).refusal).toMatch(/too wide/);
    expect(nearestThreadMill(thread, entries, M8_MILL, 'inv:m8')?.key).toBe('inv:unc');
  });

  it('a fitting cutter is never "fixed" with one named for another pitch', () => {
    const thread: EngraveThreadItem = { kind: 'thread', id: 't', position: { x: 50, y: 30 }, enabled: true, size: 'M5', standard: 'metric', classFit: '6H', depth: 5, through: false };
    const only: ToolLibraryEntry[] = [{ key: 'inv:m3', provenance: 'test', tool: M3_MILL }];
    expect(nearestThreadMill(thread, only, mill('4 mm thread mill', 4), 'inv:4')).toBeNull();
  });
});

describe('#841 the internal metric thread is byte-identical to before', () => {
  // sha256(posted program + JSON(plan notes)), computed on main at 6dac1161 before #841 and
  // re-pinned by #927: the only changed line in each program is its `;@MKR|TIME` record.
  const BEFORE: Record<string, string> = {
    'M2.5': 'b784cf5d1e61609d9f24b672b03301863b408e3f55f4ab9a06231d6afd9f935b',
    M3: '336b77dd54fb892b0676ada4c57592ab3c13edce6ddbf06fab20d2a01809268e',
    M5: 'f2b78ade4a11342303a8b5fd88b76a910ddec6358b62b581f767704210074468',
    M6: '48e4e17f6a01f560814bc83a28d30134fff5f8607c749cf15bd9965bf11a0abc',
  };
  it.each([
    ['M2.5', 1.6],
    ['M3', 2.4],
    ['M5', 4],
    ['M6', 4.8],
  ] as const)('%s with a ⌀%s mm mill posts the same bytes', (size, d) => {
    const tool = mill(`${d} mm thread mill`, d);
    const ir = threadMillIR({ tool, position: [15, 12], size, depth: 5, through: false, settings: S, stock: { length: 40, width: 30 }, descriptor: `Thread ${size}`, labelId: 't', air: true, rapid: Z1.rapidEstimate });
    if (!ir.ok) throw new Error(ir.reason);
    const posted = postZ1(ir.ir, { jobName: 'threads', stock: { length: 40, width: 30, thickness: 8 }, materialName: 'PLA', zDatum: 'probed-top-face', origin: 'topFrontLeft', camVersion: 'test', toolKey: 'inv:thread' }, Z1);
    if (!posted.ok) throw new Error(posted.errors.join(';'));
    expect(createHash('sha256').update(posted.text + JSON.stringify(ir.plan.notes)).digest('hex')).toBe(BEFORE[size]);
  });

  it('the bench’s j18 thread job generates the same program through the whole pipeline', async () => {
    const parsed = parseEngraveJob(JSON.parse(readFileSync(resolve(HERE, '../../../docs/bench/2026-10-27-z1-typical-jobs/jobs/j18-thread-b-mill-proxy.json'), 'utf8')));
    if (!parsed.ok) throw new Error('the bench fixture no longer parses');
    // The cutter `threadCatalogue735.spec.ts` pins for this fixture.
    const tool = flatEndMill(2.4, { id: null, name: M3_MILL.name, typeText: 'Thread mill', shape: 'thread', tipDiameter: 2.4, diameter: 3.175, fluteLength: 9, cornerRadius: null });
    const g = await generate(tl, { ...parsed.job, tool });
    expect(g.ok).toBe(true);
    expect(createHash('sha256').update(g.nc!).digest('hex')).toBe('e6b843a7eb62721d7435252ffb5d16887333bce8a5fb186c1894ca441fcf08b1');
  });
});

describe('#841 the store keeps a thread consistent', () => {
  it('a system switch keeps the size near, and the class follows the system and side', async () => {
    const { useEngraveJobStore } = await import('@/store/engraveJobStore');
    const store = useEngraveJobStore.getState();
    const id = store.addThread('external');
    const added = useEngraveJobStore.getState().job.threads!.find((t) => t.id === id)!;
    expect(added.side).toBe('external');
    expect(added.classFit).toBe('6h');
    useEngraveJobStore.getState().updateThread(id, { size: 'M6' });
    useEngraveJobStore.getState().updateThread(id, { standard: 'imperial' });
    let t = useEngraveJobStore.getState().job.threads!.find((x) => x.id === id)!;
    expect(t.size).toBe('1/4-20');
    expect(t.classFit).toBe('3A');
    useEngraveJobStore.getState().updateThread(id, { side: undefined });
    t = useEngraveJobStore.getState().job.threads!.find((x) => x.id === id)!;
    expect('side' in t).toBe(false);
    expect(t.classFit).toBe('3B');
  });
});
