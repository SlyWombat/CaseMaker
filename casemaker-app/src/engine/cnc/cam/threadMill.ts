/**
 * THREAD MILLING (#445, #434 phase 2) — a helical orbit inside a pilot that already exists.
 *
 * THE OPERATION. A thread mill is a small-diameter cutter with a V tooth on a reduced neck. It
 * cannot enter solid material: the item assumes a pilot at the thread's basic minor diameter, and
 * every move here starts at the axis of an OPEN hole (D1). One program has one tool
 * (`ToolpathIR.tool`), so this module plans the THREAD program — the pilot is cut in a prior
 * program/setup, and nothing here pretends to have cut it.
 *
 * THE THREAD IS THE ITEM'S #445 D2 says the ITEM states the thread and the cutter supplies only
 * its own geometry: the catalogue's `pitch`/`thread_angle`/`thread_specification` extras are
 * stripped before the wire (`house.rs`), so the pitch and the basic minor come from the ISO 261
 * table in `engine/compiler/fasteners.ts` (`D1 = D − 1.0825P`). A cutter whose own pitch differs
 * from the item's is not checkable in phase 2 — open decision 1.
 *
 * THE PATH D3, and the IR is LINEAR by contract (`ir.ts`) — no arcs. One pass is:
 *
 *   1. rapid to the axis at `HOP_Z`, then (pure Z) to stock top `0`, in the open pilot;
 *   2. feed down the axis to `−tipDepth + entryRampMm`;
 *   3. a straight ramp out to the pass radius while descending to `−tipDepth` (a flat radial
 *      entry when `entryRampMm` is 0);
 *   4. the main helix UP at constant radius, ONE PITCH PER REVOLUTION, from `−tipDepth` to `0`,
 *      emitted as G1 chords at `chordToleranceMm`;
 *   5. a pure-Z rapid to `HOP_Z` at the current XY, then an XY rapid back to the axis.
 *
 * The tool tip runs `bottomClearancePitches` pitches below the last full thread; the last full
 * thread is cut when the tip passes `−threadDepth`. Every rapid below `HOP_Z` moves Z alone, so
 * the verifier's rule 9 has nothing to see; every cutting move is a feed.
 *
 * PASS RADII. `rFinal = (D − d)/2` — the orbit radius whose outer edge is exactly the major
 * diameter. The passes step back by `radialStepoverMm` each, `n = max(1, ceil(radialDepth /
 * stepover))` of them, so the last lands on the major and the first clears the pilot wall. With
 * `d = 4.0` in M5 that is three passes at 0.1 / 0.3 / 0.5 mm.
 *
 * THE NUMBERS ARE THE SHOP'S (D6). Every geometric and feed number is a `thread.*` shop default
 * read through `readDefault`, exactly as `cam/drillBit.ts` reads the drill's. When the synced
 * catalogue has a row for THIS cutter and material, its feed, plunge feed and spindle speed
 * replace the placeholders (RPM and feed through `clampToMachine`); a catalogue that cannot vouch
 * for the cutter leaves the seeded placeholders in place, labelled by their source. There is
 * deliberately no duplicate fallback constant here: `readDefault` owns the fallback.
 *
 * WHAT IT CONTRIBUTES TO THE ORACLE: nothing (D7). `threadMillIR` makes no `OraclePredicted`
 * entry, and the simulator states the envelope's over-removal instead (§4).
 */

import { readDefault, type ShopDefaults } from '@/platform/defaultsClient';
import { FASTENERS, type FastenerSize } from '@/engine/compiler/fasteners';
import { catalogueCoverageFor, type FeedCatalogueRow } from '@/engine/cnc/feeds';
import { clampToMachine, type ClampDiagnostic, type MillProfile } from '@/engine/cnc/machine';
import { cuttingDiameter, type Tool } from '@/engine/cnc/tool';
import type { StockMaterial } from '@/types/engraveJob';
import {
  HOP_Z,
  SAFE_Z,
  estimateCycleSeconds,
  toolNumberFor,
  type CamMove,
  type CamOperation,
  type RapidEstimate,
  type ToolpathIR,
} from './ir';

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** The eight numbers a thread path needs, all shop defaults (D6, #445 §6). */
export interface ThreadSettings {
  /** The most radial depth one pass takes, mm. The last pass always lands on the major radius. */
  radialStepoverMm: number;
  /** The axial drop over which the entry ramp reaches the pass radius, mm; 0 is a flat entry. */
  entryRampMm: number;
  /** How many pitches the tool tip runs below the last full thread. */
  bottomClearancePitches: number;
  /** The pilot floor must sit this far below the tool tip, mm (stated by the findings, not a move). */
  pilotTipClearanceMm: number;
  /** The helical cutting feed, mm/min — a placeholder until a measured row replaces it. */
  feed: number;
  /** The feed down the open pilot and along the entry ramp, mm/min — a placeholder. */
  plungeFeed: number;
  /** The thread-milling spindle speed — a placeholder. */
  spindleRpm: number;
  /** The most a G1 chord may stray from the true helix, mm. It sets the move count and file size. */
  chordToleranceMm: number;
}

const KEYS: Record<keyof ThreadSettings, string> = {
  radialStepoverMm: 'thread.radialStepoverMm',
  entryRampMm: 'thread.entryRampMm',
  bottomClearancePitches: 'thread.bottomClearancePitches',
  pilotTipClearanceMm: 'thread.pilotTipClearanceMm',
  feed: 'thread.feed',
  plungeFeed: 'thread.plungeFeed',
  spindleRpm: 'thread.spindleRpm',
  chordToleranceMm: 'thread.chordToleranceMm',
};

export interface ThreadSettingsResult {
  settings: ThreadSettings;
  /** Per field, where the value came from: the location, or the labelled fallback. */
  sources: Record<keyof ThreadSettings, string>;
  /** What the machine did to a catalogue row, if one answered (#325's clamp vocabulary). */
  diagnostics: ClampDiagnostic[];
}

/**
 * The thread settings from the shop defaults, then the catalogue's own row when it covers this
 * cutter and material (#445 D6).
 *
 * The catalogue wins over the three PLACEHOLDER keys — feed, plunge feed and spindle — because a
 * vendor row for the actual cutter is evidence and a seed is not. It never wins over the six
 * geometric numbers: a catalogue row has no step-over, entry ramp or chord tolerance.
 *
 * A row whose numbers the machine REFUSES (`clampToMachine` answers null for a gross overage) is
 * not adopted at all: falling back to the seeds is the labelled fallback the settings already
 * carry, and the refusal is reported as an error for the panel/run sheet to show. A modest
 * overage is clamped and adopted with the warning `clampToMachine` produced.
 */
export function threadSettings(
  defaults: ShopDefaults | null,
  catalogue: readonly FeedCatalogueRow[],
  material: StockMaterial,
  tool: Tool,
  machine: MillProfile,
): ThreadSettingsResult {
  const settings = {} as ThreadSettings;
  const sources = {} as Record<keyof ThreadSettings, string>;
  for (const [field, key] of Object.entries(KEYS) as [keyof ThreadSettings, string][]) {
    const d = readDefault(defaults, key);
    settings[field] = d.value;
    sources[field] = d.source;
  }

  const diagnostics: ClampDiagnostic[] = [];
  const coverage = catalogueCoverageFor(catalogue, material, tool);
  if (coverage.kind === 'covered') {
    const row = coverage.row;
    const running = clampToMachine(row.feed, row.rpm, machine);
    const plunging = clampToMachine(row.plungeFeed, null, machine);
    diagnostics.push(...running.diagnostics, ...plunging.diagnostics);
    if (running.feed !== null && running.rpm !== null && plunging.feed !== null && !diagnostics.some((d) => d.severity === 'error')) {
      settings.feed = running.feed;
      settings.plungeFeed = plunging.feed;
      settings.spindleRpm = running.rpm;
      const from = `catalogue: ${row.material}`;
      sources.feed = from;
      sources.plungeFeed = from;
      sources.spindleRpm = from;
    }
  }
  return { settings, sources, diagnostics };
}

/** The thread's ISO 261 coarse geometry: major `D`, pitch `P`, basic minor `D1`. */
export interface ThreadGeometry {
  major: number;
  pitch: number;
  minor: number;
}

/**
 * The geometry of a metric coarse thread, from the ONE table.
 *
 * Only the table's metric coarse sizes exist here; UNC/UNF and a 6G allowance are refused by
 * their absence (D5), not approximated. `FastenerSize` is what makes the table total.
 *
 * #460 option (a), maintainer 2026-10-17: the CUTTER's pitch is still not on the wire, so a
 * cutter/thread pitch mismatch cannot be refused here. The run sheet prints the thread and the
 * cutter on one line so a person can catch a wrong pairing, and the load's `thread-cutter-fit`
 * checks the diameters. Revisit as option (b) — a served `pitch` field plus a
 * `thread-wrong-pitch` refusal — when a third thread mill arrives or the first wrong pairing is
 * seen. #460 is closed on that trigger, not on a silent assumption that it never happens.
 */
export function threadGeometry(size: FastenerSize): ThreadGeometry {
  const f = FASTENERS[size];
  return { major: f.major, pitch: f.pitch, minor: f.minor };
}

/**
 * The thread's dimensions as PLAIN DATA for the simulator (§4) — the same pattern as
 * `DrillBitPlan.simDrillPoint`. The column engine must not import this CAM module at runtime, and
 * a type-only import is erased, so this carries no table, no defaults access and no store.
 */
export interface SimThreadSpec {
  /** The hole's axis, work XY. */
  x: number;
  y: number;
  majorMm: number;
  minorMm: number;
  pitchMm: number;
  /** The threaded length below the top face. */
  threadDepthMm: number;
  through: boolean;
}

export interface ThreadMillInput {
  tool: Tool;
  /** The hole's axis, work XY. */
  position: readonly [number, number];
  size: FastenerSize;
  /** Threaded length below the top face, mm. Positive. */
  depth: number;
  through: boolean;
  settings: ThreadSettings;
  /** The stock's XY size, to refuse a thread whose major rim leaves it. Optional. */
  stock?: { length: number; width: number };
}

export interface ThreadMillPlan {
  position: [number, number];
  size: FastenerSize;
  major: number;
  pitch: number;
  minor: number;
  /** The cutter's cutting diameter, `d`. */
  cuttingDiameter: number;
  /** The threaded length the item states. */
  threadDepth: number;
  /** `threadDepth + runOut`: how far below the top the tip goes. */
  tipDepth: number;
  /** `bottomClearancePitches × P`, mm. */
  runOut: number;
  /** The pass radii, innermost first; the last lands the tooth on the major radius. */
  passRadii: number[];
  /** Helix chords per revolution. */
  chordsPerTurn: number;
  moves: CamMove[];
  /** What the simulator needs: this thread's real dimensions, as plain numbers. */
  simThreads: SimThreadSpec[];
  notes: string[];
}

export type ThreadMillResult = { ok: true; plan: ThreadMillPlan } | { ok: false; reason: string };

/**
 * The half of `ThreadMillPlan` a READER needs (#445 phase B): what the thread is, how wide the
 * passes are, and how far the tip runs — never `moves`, the IR, or the simulator's spec.
 *
 * It exists so the run sheet can print a thread without importing the CAM's plan type into a
 * module whose job is prose. `ThreadMillPlan` is structurally assignable to it, so the worker's
 * `threads` reaches the sheet unchanged.
 */
export type ThreadPlanFacts = Pick<
  ThreadMillPlan,
  | 'position'
  | 'size'
  | 'major'
  | 'pitch'
  | 'minor'
  | 'cuttingDiameter'
  | 'threadDepth'
  | 'tipDepth'
  | 'runOut'
  | 'passRadii'
  | 'chordsPerTurn'
>;

/**
 * Chords per revolution for an orbit of radius `r` at sagitta `tol`:
 * `ceil(π / acos(1 − min(tol, r/4) / r))`, floored at 12.
 *
 * The sagitta of a chord subtending `Δ` is `r(1 − cos(Δ/2))`, so `Δ ≤ 2·acos(1 − tol/r)` and a
 * full turn needs `2π/Δ` chords. `min(tol, r/4)` keeps the argument of `acos` well inside its
 * domain on a tiny radius and caps the count from exploding. The same construction `adaptive.ts`
 * uses for its arcs, with the tolerance a shop default because it sets the move count.
 */
export function chordsPerTurn(radius: number, tolerance: number): number {
  if (!(radius > 0)) return 12;
  const tol = Math.min(Math.max(tolerance, 0), radius / 4);
  if (!(tol > 0)) return 12;
  return Math.max(12, Math.ceil(Math.PI / Math.acos(1 - tol / radius)));
}

/**
 * Plan ONE thread operation: the pass radii, the helix, the moves — or a refusal naming the
 * number. The pipeline calls it per item and concatenates the IRs (`concatToolpathIR` renumbers).
 */
export function planThreadMill(input: ThreadMillInput): ThreadMillResult {
  const { tool, settings: s } = input;
  if (tool.shape !== 'thread') {
    return { ok: false, reason: `${tool.name} is a ${tool.shape} cutter, not a thread mill — a thread is cut by orbiting a small cutter inside a pilot` };
  }
  const d = cuttingDiameter(tool);
  if (d === null || !(d > 0)) return { ok: false, reason: `${tool.name} states no cutting diameter` };
  if (input.through) {
    return { ok: false, reason: 'a through thread is unavailable until the through-cut gate lands' };
  }
  if (!(input.depth > 0)) return { ok: false, reason: 'the thread has no depth' };

  const { major, pitch, minor } = threadGeometry(input.size);
  // D2's two physical checks, in the order that makes the message actionable: can it get in,
  // then can it reach.
  if (d >= minor) {
    return {
      ok: false,
      reason: `the ${d} mm cutting diameter cannot enter the ⌀${minor} mm pilot of ${input.size}: a thread mill must be smaller than the thread's minor diameter`,
    };
  }
  const radialDepth = (major - minor) / 2;
  if (d < radialDepth) {
    return {
      ok: false,
      reason: `the ${d} mm cutting diameter spans only ${r3(d)} mm, less than the ${r3(radialDepth)} mm radial depth of ${input.size} (⌀${major} over ⌀${minor})`,
    };
  }
  const [cx, cy] = input.position;
  // #786 slice 1 part 2 — a thread's rim off the stock cuts air there; `thread-off-stock` states
  // the edge and the overhang on the job, and the sweep's checks judge real contact. The orbit
  // still posts.

  const runOut = r3(s.bottomClearancePitches * pitch);
  const tipDepth = r3(input.depth + runOut);
  if (tool.fluteLength !== null && tool.fluteLength > 0 && tipDepth > tool.fluteLength) {
    return {
      ok: false,
      reason: `the thread needs ${tipDepth} mm of flute (${input.depth} mm plus ${runOut} mm of run-out), past the ${tool.fluteLength} mm flute of ${tool.name}`,
    };
  }
  if (!(s.radialStepoverMm > 0)) return { ok: false, reason: 'the thread.radialStepoverMm setting is not positive' };

  // The pass radii. `rFinal` is the orbit whose OUTER EDGE is the major diameter; the passes step
  // back by the shop's radial step-over, and the innermost is clamped to the pilot wall's own
  // radius so no pass starts outside the pilot.
  const rFinal = (major - d) / 2;
  const rMin = (minor - d) / 2;
  const n = Math.max(1, Math.ceil(radialDepth / s.radialStepoverMm));
  const passRadii: number[] = [];
  for (let k = 1; k <= n; k++) passRadii.push(Math.max(rMin, rFinal - (n - k) * s.radialStepoverMm));

  const entryRamp = Math.min(Math.max(s.entryRampMm, 0), tipDepth);
  const turns = tipDepth / pitch;
  const totalAngle = 2 * Math.PI * turns;
  const moves: CamMove[] = [];

  for (const r of passRadii) {
    // 1. The axis, at the hop height and then at the stock top. Both are pure Z in the open pilot.
    moves.push({ kind: 'rapid', x: cx, y: cy, z: HOP_Z });
    moves.push({ kind: 'rapid', x: cx, y: cy, z: 0 });
    // 2. Feed down the open pilot to where the entry ramp starts.
    moves.push({ kind: 'feed', x: cx, y: cy, z: -(tipDepth - entryRamp), f: s.plungeFeed });
    // 3. The ramp out to `r` at angle 0, descending the ramp length. `entryRamp = 0` is a flat
    //    radial entry at `-tipDepth`.
    moves.push({ kind: 'feed', x: cx + r, y: cy, z: -tipDepth, f: s.plungeFeed });

    // 4. The main helix, up at constant radius, one pitch per revolution, starting at angle 0.
    const perTurn = chordsPerTurn(r, s.chordToleranceMm);
    const segments = Math.max(1, Math.ceil(perTurn * turns));
    const dTheta = totalAngle / segments;
    for (let i = 1; i <= segments; i++) {
      const theta = i * dTheta;
      moves.push({
        kind: 'feed',
        x: cx + r * Math.cos(theta),
        y: cy + r * Math.sin(theta),
        z: -tipDepth + (i / segments) * tipDepth,
        f: s.feed,
      });
    }

    // 5. Out of the hole: pure Z to the hop, then XY back to the axis for the next pass.
    const end = moves[moves.length - 1]!;
    moves.push({ kind: 'rapid', x: end.x, y: end.y, z: HOP_Z });
    moves.push({ kind: 'rapid', x: cx, y: cy, z: HOP_Z });
  }
  moves.push({ kind: 'rapid', x: cx, y: cy, z: SAFE_Z });

  return {
    ok: true,
    plan: {
      position: [cx, cy],
      size: input.size,
      major,
      pitch,
      minor,
      cuttingDiameter: d,
      threadDepth: input.depth,
      tipDepth,
      runOut,
      passRadii,
      chordsPerTurn: chordsPerTurn(passRadii[passRadii.length - 1]!, s.chordToleranceMm),
      moves,
      simThreads: [
        { x: cx, y: cy, majorMm: major, minorMm: minor, pitchMm: pitch, threadDepthMm: input.depth, through: false },
      ],
      notes: [
        `${input.size}×${pitch}: ⌀${major} major over ⌀${minor} basic minor, ${input.depth} mm of thread`,
        `${passRadii.length} pass(es) at r = ${passRadii.map((r) => r3(r)).join(' / ')} mm, stepping ${s.radialStepoverMm} mm (thread.radialStepoverMm)`,
        `the tip runs ${runOut} mm below the last full thread (${s.bottomClearancePitches} × pitch, thread.bottomClearancePitches)`,
        `the helix is ${r3(turns)} turn(s) of G1 chords at ${s.chordToleranceMm} mm sagitta (thread.chordToleranceMm)`,
        `feed ${s.feed} mm/min and ${s.spindleRpm} rpm; the entry at ${s.plungeFeed} mm/min`,
        `the pilot at ⌀${minor} mm is assumed to exist and is not cut by this program (D1)`,
      ],
    },
  };
}

/** The thread operation as a postable IR: one operation, the thread mill as its tool. */
export function threadMillIR(
  input: ThreadMillInput & { descriptor: string; labelId: string; air: boolean; rapid: RapidEstimate },
): { ok: true; ir: ToolpathIR; plan: ThreadMillPlan } | { ok: false; reason: string } {
  const r = planThreadMill(input);
  if (!r.ok) return r;
  const toolNumber = toolNumberFor(input.tool);
  const op: CamOperation = {
    number: 1,
    // `[T1]Thread "port" M5×0.8 6.0mm` — the operation name the panel, the sheet and the file share.
    name: `[T${toolNumber}]${input.descriptor} ${r.plan.threadDepth.toFixed(1)}mm`,
    labelId: input.labelId,
    depth: r.plan.tipDepth,
    // #735 — the helix climbs one PITCH per revolution, so each revolution is a depth pass; the
    // radial passes repeat them. The climb's G1 chords are not passes (j18's 530 read 22).
    depthPasses: Math.max(1, Math.ceil(r.plan.tipDepth / r.plan.pitch - 1e-9)) * r.plan.passRadii.length,
    passStepMm: r.plan.pitch,
    moves: r.plan.moves,
    estimatedSeconds: estimateCycleSeconds(r.plan.moves, input.rapid),
  };
  return {
    ok: true,
    plan: r.plan,
    ir: {
      frame: 'flat',
      tool: input.tool,
      toolNumber,
      spindleRpm: input.settings.spindleRpm,
      air: input.air,
      safeZ: SAFE_Z,
      hopZ: HOP_Z,
      operations: [op],
    },
  };
}
