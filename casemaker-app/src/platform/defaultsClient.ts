/**
 * The shop's own defaults (the maintainer's rule, 2026-10-15: "That type of setting should be
 * something we keep in our own database and not compiled in"). Tunable values — a threshold, a wait,
 * a chosen margin — live in `location.json`'s `defaults` section, each with where it came from. The
 * service's half is `src-tauri/src/defaults.rs`.
 *
 * OPEN TO NEW KEYS, VALIDATED. The section maps a dotted lowerCamel key (`power.onWaitSeconds`) to
 * `{ value, source, setAt?, unit? }`. Any well-formed key is kept and served; a key listed in
 * {@link KNOWN_DEFAULTS} is ALSO held to its own rule here. A new consumer adds its key to that
 * registry — its rule and its labelled fallback — and nothing else about the section changes. #436's
 * rest-machining pair went in that way and needed no other edit.
 *
 * THE FALLBACK IS FOR NO SERVICE, AND SAYS SO. {@link readDefault} answers the stored value with its
 * source when the location has one, and the registry's fallback marked `fallback` when it does not
 * (the hosted web build, or a service that could not be read). A fallback is never written back.
 */

import { z } from 'zod';
import { GRIP_MIN } from '@/engine/cnc/fixture';
import { REST_MACHINING_FALLBACK } from '@/engine/cnc/engrave/restSettings';
import {
  houseRequest,
  setHouseRequestTimeoutMs,
  type HouseFailure,
  type HouseReadFailure,
  type HouseRequestOptions,
  type HouseWrite,
} from './houseClient';

export const DEFAULT_SOURCES = ['seeded', 'chosen', 'measured'] as const;
export type DefaultSource = (typeof DEFAULT_SOURCES)[number];

/** `segment(.segment)+`, each lowerCamel ASCII — `defaults.rs`'s `valid_key`. */
export const DEFAULT_KEY = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;

const filled = z.string().refine((v) => v.trim().length > 0, 'is empty');

export const ShopDefaultSchema = z
  .object({
    value: z.union([
      z.number().finite(),
      z.boolean(),
      // eslint-disable-next-line no-control-regex
      z.string().max(200).refine((v) => !/[\u0000-\u001f\u007f-\u009f]/.test(v), 'has a control character'),
    ]),
    source: z.enum(DEFAULT_SOURCES),
    setAt: filled.nullable().default(null),
    unit: z.string().max(16).nullable().default(null),
    /** Where a measured value came from, in a sentence (#430 review). */
    note: z
      .string()
      .max(400)
      // eslint-disable-next-line no-control-regex
      .refine((v) => !/[\u0000-\u001f\u007f-\u009f]/.test(v), 'has a control character')
      .nullable()
      .default(null),
  })
  .strict()
  .superRefine((d, ctx) => {
    if (d.source !== 'seeded' && d.setAt === null) {
      ctx.addIssue({ code: 'custom', path: ['setAt'], message: 'a chosen or measured value says when it was set' });
    }
  });

export type ShopDefault = z.infer<typeof ShopDefaultSchema>;

/** What the surface tolerance must leave below the park height, mm — `defaults.rs`'s `PARK_CLEARANCE_MM`. */
export const PARK_CLEARANCE_MM = 0.5;

/** A key this build knows: its rule, and the value used when there is no location to read. */
export interface KnownDefault {
  label: string;
  unit: string;
  /** The bound, stated once — the same as `defaults.rs`'s `known_rule`. */
  rule: z.ZodType<number>;
  /** Used only with no service. Labelled `fallback` wherever it is shown. */
  fallback: number;
}

export const KNOWN_DEFAULTS: Readonly<Record<string, KnownDefault>> = {
  // #416 — how long switching on waits for the controller to answer.
  'power.onWaitSeconds': {
    label: 'power-on wait',
    unit: 's',
    rule: z.number().min(10).max(1800),
    fallback: 180,
  },
  // #430 — the stepped edge scan and the surface touch, as the 2026-10-15 bench ran them.
  'registration.capBelowSurfaceMm': { label: 'touch cap below the surface', unit: 'mm', rule: z.number().min(0.1).max(1), fallback: 0.5 },
  'registration.coarseStepMm': { label: 'scan coarse step', unit: 'mm', rule: z.number().min(0.1).max(10), fallback: 1.0 },
  'registration.fineStepMm': { label: 'scan fine step', unit: 'mm', rule: z.number().min(0.05).max(5), fallback: 0.5 },
  'registration.parkAboveSurfaceMm': { label: 'park height above the surface', unit: 'mm', rule: z.number().min(2).max(30), fallback: 3.0 },
  'registration.scanInsideMm': { label: 'scan start inside the edge', unit: 'mm', rule: z.number().min(0.5).max(30), fallback: 3.0 },
  'registration.scanReachMm': { label: 'scan reach past the edge', unit: 'mm', rule: z.number().min(0.5).max(50), fallback: 5.0 },
  'registration.cornerClearanceMm': { label: 'clearance from a rounded corner', unit: 'mm', rule: z.number().min(0).max(30), fallback: 2.0 },
  'registration.surfaceBandMm': { label: 'surface band', unit: 'mm', rule: z.number().min(0.01).max(1), fallback: 0.25 },
  // MEASURED 2026-10-15 — the effective rim offset; the note in location.json says how. The fallback is that measurement.
  'registration.tipRadiusMm': { label: 'probe rim offset (measured)', unit: 'mm', rule: z.number().min(0).max(3), fallback: 0.7 },
  // MEASURED 2026-10-15 with the rim offset (#429): its spread, and the tip's outside diameter.
  'registration.tipRadiusUncertaintyMm': { label: 'probe rim offset spread (measured)', unit: 'mm', rule: z.number().min(0).max(2), fallback: 0.25 },
  'registration.tipDiameterMm': { label: 'probe tip diameter (measured)', unit: 'mm', rule: z.number().min(0.2).max(10), fallback: 2.0 },
  'registration.surfaceToleranceMm': { label: 'surface tolerance', unit: 'mm', rule: z.number().min(0.05).max(10), fallback: 0.4 },
  'registration.edgeMarginMm': { label: 'registration margin', unit: 'mm', rule: z.number().min(0.01).max(20), fallback: 0.5 },
  'registration.surfaceSeekMm': { label: 'surface seek travel, at most', unit: 'mm', rule: z.number().min(1).max(100), fallback: 60.0 },
  'registration.touchFeed': { label: 'scan touch feed', unit: 'mm/min', rule: z.number().min(10).max(1000), fallback: 150.0 },
  'registration.surfaceFastFeed': { label: 'surface touch, fast', unit: 'mm/min', rule: z.number().min(10).max(1000), fallback: 300.0 },
  'registration.surfaceSlowFeed': { label: 'surface touch, slow', unit: 'mm/min', rule: z.number().min(5).max(500), fallback: 100.0 },
  // #428 — the setups planner.
  // The fallback is fixture.ts's GRIP_MIN — the one compiled figure, shared with validateVise.
  'setups.minGripMm': { label: 'least stock to grip', unit: 'mm', rule: z.number().min(0.5).max(50), fallback: GRIP_MIN },
  'setups.remountMinutes': { label: 'remount estimate', unit: 'min', rule: z.number().min(0.5).max(120), fallback: 3 },
  'setups.reregisterMinutes': { label: 're-registration estimate', unit: 'min', rule: z.number().min(0.5).max(120), fallback: 2 },
  // #423 — the run screen's watch. 2000 ms is the poll's floor (0.6 s faulted the controller, #386).
  'run.pollMs': { label: 'run status poll', unit: 'ms', rule: z.number().min(2000).max(60000), fallback: 2000 },
  'run.noProgressMs': { label: 'no-progress timeout', unit: 'ms', rule: z.number().min(15000).max(600000), fallback: 30000 },
  'run.missLimit': { label: 'missed polls before unreachable', unit: 'polls', rule: z.number().int().min(1).max(10), fallback: 3 },
  // ── #449 (begin) — the probe, scan, console, stop and power timing. CHOSEN, not measured: each seed
  // is the number the code compiled before, and each fallback is that seed. The 2000 ms poll floors
  // (`RUN_POLL_FLOOR_MS`, `STOP_POLL_FLOOR_MS`, `MIN_STATUS_POLL_MS`) stay compiled; a rule here can
  // only sit at or above them. `tools/z1/benchDefaults.mjs` restates the keys the bench tools read,
  // and `benchDefaults.spec.ts` holds it to these rules and fallbacks.
  // The slow surface touch's travel: it starts 1 mm above the fast hit (`G0 Z1`), so it must travel
  // more than that to reach the surface, and at most 2 mm — never more than 1 mm past the fast hit —
  // so it stays a capped touch (#449 review: 3 mm let it go 2 mm past).
  'registration.surfaceSlowSeekMm': { label: 'surface touch, slow travel (chosen)', unit: 'mm', rule: z.number().min(1.2).max(2), fallback: 2 },
  'registration.idlePollLimit': { label: 'status polls waiting for Idle before a touch (chosen)', unit: 'polls', rule: z.number().int().min(1).max(120), fallback: 30 },
  // The run sheet's down-touch scan (#391, #452): how far past the jaw tops a touch may travel, and
  // the depth two readings are told apart by. Its step, start gap and tip are the planner's own keys.
  'registration.scanMissMarginMm': { label: 'scan touch travel past the jaw tops (chosen)', unit: 'mm', rule: z.number().min(0.2).max(3), fallback: 1 },
  'registration.readingResolutionMm': { label: 'depth two touch readings are told apart by (chosen)', unit: 'mm', rule: z.number().min(0.005).max(0.5), fallback: 0.05 },
  // The typed console's reply window. The first-reply floor sits above the slowest line timed on the
  // bench (M491 ~32 s, $H ~31 s, 2026-10-15): a shorter window would call a moving machine timed out.
  'console.firstReplyMs': { label: 'console line, first reply wait (chosen)', unit: 'ms', rule: z.number().min(40_000).max(300_000), fallback: 60_000 },
  'console.quietMs': { label: 'console reply, quiet gap that ends it (chosen)', unit: 'ms', rule: z.number().min(200).max(5000), fallback: 800 },
  'console.maxMs': { label: 'console line, longest reply (chosen)', unit: 'ms', rule: z.number().min(40_000).max(600_000), fallback: 120_000 },
  // Never under 3000 (#449 review): Stop's first `?` uses this window, and a timeout there returns
  // before `abort` is sent. The controller answers in 0.6–0.7 s; 3 s is the compiled window it had.
  'run.statusReplyMs': { label: 'status poll, reply wait (chosen)', unit: 'ms', rule: z.number().min(3000).max(10_000), fallback: 3000 },
  // After `abort`: the Idle polls before `M332`, and the app's wait between them (never under the 2 s
  // floor, #386). The bench harness reads `stop.idlePolls` but not the wait: its idle polls are paced
  // by `run.pollMs`, and its own compiled number there is each poll's reply window, a different thing.
  'stop.idlePolls': { label: 'status polls after Stop before giving up on Idle (chosen)', unit: 'polls', rule: z.number().int().min(1).max(20), fallback: 3 },
  'stop.idlePollMs': { label: 'wait between those polls (chosen)', unit: 'ms', rule: z.number().min(2000).max(60_000), fallback: 5000 },
  // How long `abort` gets to answer (~18 s observed, #303). ONE number for both the app's Stop and the
  // bench harness's `run` (maintainer, 2026-10-16: Stop's abort wait is the shop setting, so the two
  // share a value). At least 20 s (#449 review): above the ~18 s drain observed before `abort` answered.
  'stop.abortReplyMs': { label: 'abort reply wait (chosen)', unit: 'ms', rule: z.number().min(20_000).max(300_000), fallback: 60_000 },
  'power.probeTries': { label: 'probes before a machine counts as silent (chosen)', unit: 'tries', rule: z.number().int().min(1).max(10), fallback: 3 },
  // Each probe and each check sends `?`: never closer than the 2 s status floor (#386), which
  // `powerStore.ts`'s POWER_POLL_FLOOR_MS also applies in code.
  'power.probeGapSeconds': { label: 'wait between those probes (chosen)', unit: 's', rule: z.number().min(2).max(30), fallback: 2 },
  'power.cyclePauseSeconds': { label: 'plug cycle, time off (chosen)', unit: 's', rule: z.number().min(3).max(120), fallback: 10 },
  'power.pollSeconds': { label: 'power-on, wait between checks (chosen)', unit: 's', rule: z.number().min(2).max(60), fallback: 3 },
  // The desktop machine transport's four windows (#449, "smaller timings"): the TCP connect, the
  // UDP discovery listen, the identify reply, and how long an upload waits for the machine's next
  // frame. CHOSEN, not measured: each is the number `protocol.ts` / `machineBridge.ts` compiled
  // before, and each is the labelled no-service fallback there. `machineTiming` reads all four,
  // and the web-side wrappers pass them into the pure protocol calls.
  'machine.connectTimeoutMs': { label: 'machine TCP connect timeout (chosen)', unit: 'ms', rule: z.number().min(500).max(30_000), fallback: 3000 },
  'machine.discoveryWindowMs': { label: 'UDP discovery listen window (chosen)', unit: 'ms', rule: z.number().min(500).max(60_000), fallback: 3000 },
  'machine.identifyWindowMs': { label: 'identify reply window (chosen)', unit: 'ms', rule: z.number().min(250).max(30_000), fallback: 1500 },
  'machine.uploadInactivityMs': { label: 'upload inactivity window (chosen)', unit: 'ms', rule: z.number().min(1000).max(120_000), fallback: 9000 },
  // The house service's own request timeout (#449). CHOSEN, not measured: a service on this machine
  // or this LAN answers in single-digit milliseconds, and 2 s is where the client called it gone.
  // `houseClient.ts` must never import this registry (this module imports IT), so the client keeps
  // the fallback and `houseDefaults` hands it the stored value.
  'house.requestTimeoutMs': { label: 'house service request timeout (chosen)', unit: 'ms', rule: z.number().min(250).max(30_000), fallback: 2000 },
  // ── #449 (end)
  // #415 — past how many minutes of runtime a cutter gets "check this bit". It only warns.
  'tools.runtimeWarnMinutes': {
    label: 'runtime before "check this bit"',
    unit: 'min',
    rule: z.number().gt(0).max(100_000),
    fallback: 600,
  },
  // #427 — the anchor bracket and its top clamps. NONE IS MEASURED: each is seeded with a note saying
  // so and naming what to caliper (`defaults.rs`'s UNMEASURED_SEEDS); a fallback is the same default.
  'bracket.originOffsetXMm': { label: 'bracket corner from anchor, X (not measured)', unit: 'mm', rule: z.number().min(-20).max(20), fallback: 0 },
  'bracket.originOffsetYMm': { label: 'bracket corner from anchor, Y (not measured)', unit: 'mm', rule: z.number().min(-20).max(20), fallback: 0 },
  'bracket.fitMm': { label: 'bracket fit (not measured)', unit: 'mm', rule: z.number().min(0.01).max(2), fallback: 0.1 },
  'bracket.armLengthXMm': { label: 'bracket front arm length (not measured)', unit: 'mm', rule: z.number().min(5).max(300), fallback: 100 },
  'bracket.armLengthYMm': { label: 'bracket left arm length (not measured)', unit: 'mm', rule: z.number().min(5).max(300), fallback: 100 },
  'bracket.armWidthMm': { label: 'bracket arm thickness (not measured)', unit: 'mm', rule: z.number().min(1).max(50), fallback: 10 },
  'bracket.heightMm': { label: 'bracket height (not measured)', unit: 'mm', rule: z.number().min(1).max(80), fallback: 10 },
  'clamps.topLengthMm': { label: 'top clamp length (not measured)', unit: 'mm', rule: z.number().min(5).max(150), fallback: 30 },
  'clamps.topWidthMm': { label: 'top clamp width (not measured)', unit: 'mm', rule: z.number().min(3).max(80), fallback: 15 },
  'clamps.topHeightMm': { label: 'top clamp height above the stock (not measured)', unit: 'mm', rule: z.number().min(1).max(80), fallback: 12 },
  'clamps.topReachMm': { label: 'top clamp reach onto the stock (not measured)', unit: 'mm', rule: z.number().min(1).max(50), fallback: 8 },
  'clamps.topInFromCornerMm': { label: 'top clamp in from the corner', unit: 'mm', rule: z.number().min(0).max(200), fallback: 15 },
  // #414 — runtime is weighted by the material cut (the maintainer, 2026-10-16). Chosen, not measured.
  'tools.wearWeight.plastic': { label: 'wear weight, plastic', unit: 'x', rule: z.number().min(0.1).max(20), fallback: 1 },
  'tools.wearWeight.wood': { label: 'wear weight, wood', unit: 'x', rule: z.number().min(0.1).max(20), fallback: 1 },
  'tools.wearWeight.aluminium': { label: 'wear weight, aluminium', unit: 'x', rule: z.number().min(0.1).max(20), fallback: 3 },
  'tools.wearWeight.brass': { label: 'wear weight, brass', unit: 'x', rule: z.number().min(0.1).max(20), fallback: 2 },
  'tools.wearWeight.copper': { label: 'wear weight, copper', unit: 'x', rule: z.number().min(0.1).max(20), fallback: 3 },
  // #434 — peck drilling with drill bits. The pecks are chosen; the feeds are our own placeholders.
  'drill.peckDiameters': { label: 'peck depth, in drill diameters (chosen)', unit: 'x', rule: z.number().min(0.1).max(10), fallback: 1 },
  'drill.peckClearanceMm': { label: 'peck re-entry clearance (chosen)', unit: 'mm', rule: z.number().min(0.05).max(5), fallback: 0.5 },
  'drill.pointAngleDeg': { label: 'drill point angle when unstated (chosen)', unit: 'deg', rule: z.number().min(60).max(150), fallback: 118 },
  'drill.plungeFeed': { label: 'drilling feed (placeholder)', unit: 'mm/min', rule: z.number().min(5).max(2000), fallback: 100 },
  'drill.spindleRpm': { label: 'drilling spindle speed (placeholder)', unit: 'rpm', rule: z.number().min(1000).max(30000), fallback: 10000 },
  // #431 — the laser point-to-origin's accuracy: ±1 mm, chosen, not measured.
  // #433 — adaptive clearing for metal pockets. The engagement, step-down, helix and ramp are chosen; the
  // feeds and the spindle speed are our own placeholders. None measured, none a vendor number.
  'adaptive.engagementFraction': { label: 'adaptive engagement cap, in cutter diameters (chosen)', unit: 'x', rule: z.number().min(0.02).max(0.5), fallback: 0.1 },
  'adaptive.stepDownMm': { label: 'adaptive step-down (chosen)', unit: 'mm', rule: z.number().min(0.05).max(10), fallback: 1 },
  'adaptive.helixDiameterFraction': { label: 'helix entry diameter, in cutter diameters (chosen)', unit: 'x', rule: z.number().min(0.1).max(0.95), fallback: 0.5 },
  'adaptive.rampAngleDeg': { label: 'helix and ramp entry angle (chosen)', unit: 'deg', rule: z.number().min(0.5).max(30), fallback: 2 },
  // ── #451 adaptive settings (begin) — the entry clearance and the planner's three refusal limits.
  // CHOSEN, not measured: `adaptive.ts` plans a pocket, and each of these is where it gives up rather
  // than a number the machine reads. The clearance is the step ABOVE the floor just cut that a rapid
  // down a cleared column stops at; the rest bound the grid it may build and the material it may leave.
  // Fallbacks = adaptive.ts's shipped defaults.
  'adaptive.entryClearanceMm': { label: 'adaptive entry clearance above the cut floor (chosen)', unit: 'mm', rule: z.number().min(0.05).max(5), fallback: 0.5 },
  'adaptive.maxCells': { label: 'adaptive material grid cap (chosen)', unit: 'cells', rule: z.number().int().min(1000).max(100_000_000), fallback: 12_000_000 },
  'adaptive.residualShare': { label: 'adaptive residual tolerance, as a share of the area to clear (chosen)', unit: 'x', rule: z.number().min(0).max(0.5), fallback: 0.005 },
  'adaptive.neckAreaMm2': { label: 'adaptive sub-grid neck area (chosen)', unit: 'mm²', rule: z.number().min(0).max(100), fallback: 0.05 },
  // ── #451 adaptive settings (end)
  'adaptive.cutFeed': { label: 'adaptive clearing feed (placeholder)', unit: 'mm/min', rule: z.number().min(5).max(1200), fallback: 600 },
  'adaptive.entryFeed': { label: 'adaptive entry feed (placeholder)', unit: 'mm/min', rule: z.number().min(5).max(1200), fallback: 200 },
  'adaptive.spindleRpm': { label: 'adaptive spindle speed (placeholder)', unit: 'rpm', rule: z.number().min(1000).max(30000), fallback: 12000 },
  'laser.originUncertaintyMm': { label: 'laser point-to-origin accuracy (chosen)', unit: 'mm', rule: z.number().min(0.05).max(10), fallback: 1 },
  // ── #438 (begin) — the column engine's FLAT grid Y pitch. Chosen, not measured: the oracle's grid
  // term is half a cell diagonal, and cost grows as 1/pitch. Read by simStore at a load; the worker
  // gets the number, never this module. Fallback = columnEngine's COLUMN_FLAT_PITCH_Y_FALLBACK_MM.
  // ── #451 (begin) — the DXF arc chord error, mm: accuracy against point count. Chosen.
  'import.dxfChordToleranceMm': { label: 'DXF arc chord error (chosen)', unit: 'mm', rule: z.number().min(0.001).max(0.5), fallback: 0.02 },
  // ── #451 (end)
  'sim.columnFlatPitchYMm': { label: 'flat simulation grid Y pitch (chosen)', unit: 'mm', rule: z.number().min(0.05).max(0.5), fallback: 0.1 },
  // ── #438 (end)
  // ── #451 sim resolutions (begin) — the exact sweeper's spindle-off clearance and the column
  // engine's X and rotary pitches. Each is CHOSEN, not measured: the oracle's band grows with the
  // cell and the sim's memory and time with 1/pitch. Read by simStore at a load; the worker gets
  // the numbers, never this module. Fallbacks = sweep.ts's SPINDLE_OFF_PROXIMITY_FALLBACK_MM and
  // columnEngine's COLUMN_PITCH_X_FALLBACK_MM / COLUMN_ROTARY_PITCH_FALLBACK_DEG.
  'sim.spindleOffProximityMm': { label: 'spindle-off clearance to material (chosen)', unit: 'mm', rule: z.number().min(0.05).max(5), fallback: 1.0 },
  'sim.columnPitchXMm': { label: 'simulation grid X pitch (chosen)', unit: 'mm', rule: z.number().min(0.05).max(0.5), fallback: 0.1 },
  'sim.rotaryPitchDeg': { label: 'rotary simulation grid pitch (chosen)', unit: 'deg', rule: z.number().min(0.05).max(5), fallback: 0.25 },
  // ── #451 sim resolutions (end)
  // ── #451 new-item starting depths (begin) — where an item the panel just added begins. CHOSEN,
  // not measured: nobody measured what depth a new item should start at, and the person who asked
  // for it is about to set the number that matters. Read by `engraveJobStore` (its `newItemDepthMm`
  // / `newDrillDepthMm`, which the panel's outline import also goes through), once per add.
  'engrave.newItemDepthMm': { label: 'depth a new item starts at (chosen)', unit: 'mm', rule: z.number().min(0.05).max(20), fallback: 0.5 },
  'engrave.newDrillDepthMm': { label: 'depth a new hole starts at (chosen)', unit: 'mm', rule: z.number().min(0.05).max(20), fallback: 1.0 },
  // ── #451 new-item starting depths (end)
  // ── #451 engrave findings (begin) — the share of an item's area a cutter must reach before
  // `item-detail-lost` is raised. CHOSEN, not measured: 0.9 is the point past which the surviving
  // strokes stop reading as the character, and nobody has cut the matrix. Read by the engrave
  // stores and sent to the sim worker as plain data (a worker cannot read the location). Fallback =
  // `engraveGeometry.ts`'s LOST_DETAIL_RATIO_FALLBACK.
  'engrave.lostDetailWarnRatio': { label: 'share of an item a cutter must keep before detail is lost (chosen)', unit: 'x', rule: z.number().min(0.1).max(1), fallback: 0.9 },
  // ── #451 engrave findings (end)
  // ── #451 blank band fill (begin) — how much of a free band the seeded line takes. CHOSEN, not
  // measured: it trades cap height against the clearance the dome and the print want. Read by
  // `engraveJobStore`'s two seed routes and passed in; Fallback = `blankLabelSeed.ts`'s
  // BLANK_BAND_FILL_FALLBACK. Bounded above 0: zero would size the line to no band at all.
  'engrave.blankBandFill': { label: 'blank band fill, as a share of the free band (chosen)', unit: 'x', rule: z.number().min(0.05).max(1), fallback: 0.7 },
  // ── #451 blank band fill (end)
  // ── #421 (begin) — the run plan's phase times (§5.8). Two were TIMED in the 2026-10-15 console
  // trace and are seeded `measured` with a note (`defaults.rs`'s MEASURED_SEEDS): `$H` and `M491`. The
  // rest are chosen — the touch time too: its series came from a console script, not the app runner. Each fallback is its seed. The remount and re-registration
  // are the setups planner's own keys (`setups.*`, above), not restated here.
  'plan.homeSeconds': { label: 'home ($H) (measured)', unit: 's', rule: z.number().min(5).max(300), fallback: 27.5 },
  'plan.toolLengthSeconds': { label: 'tool-length touch, M491 (measured)', unit: 's', rule: z.number().min(5).max(300), fallback: 31.4 },
  'plan.touchSeconds': { label: 'one registration touch (chosen)', unit: 's', rule: z.number().min(1).max(120), fallback: 15 },
  'plan.fitProbeSeconds': { label: 'fitting the probe by hand (chosen)', unit: 's', rule: z.number().min(5).max(1800), fallback: 45 },
  'plan.fitCutterSeconds': { label: 'fitting a cutter by hand (chosen)', unit: 's', rule: z.number().min(5).max(1800), fallback: 60 },
  'plan.clearanceSeconds': { label: 'vacuum off and clearance after a cut (chosen)', unit: 's', rule: z.number().min(0).max(300), fallback: 10 },
  'plan.finishSeconds': { label: 'end of the job (chosen)', unit: 's', rule: z.number().min(0).max(600), fallback: 15 },
  'plan.autoLevelPoints': { label: 'auto-level grid points (chosen)', unit: 'points', rule: z.number().int().min(4).max(400), fallback: 9 },
  'plan.autoLevelPointSeconds': { label: 'one auto-level point (chosen)', unit: 's', rule: z.number().min(1).max(120), fallback: 10 },
  'plan.autoLevelShallowMm': { label: 'a cut shallower than this wants a grid (chosen)', unit: 'mm', rule: z.number().min(0.05).max(10), fallback: 0.5 },
  // ── #421 (end)
  // #414 — Q3: an offcut is offered only when both its sides reach this. Chosen, not measured.
  'offcut.minSideMm': { label: 'smallest offcut worth keeping (each side)', unit: 'mm', rule: z.number().min(1).max(1000), fallback: 20 },
  // #436 — rest machining's two numbers. The maintainer moved them out of code on 2026-10-16 ("That
  // type of setting should be something we keep in our own database and not compiled in"), so the
  // only literal left in TypeScript is `restSettings.ts`'s no-service fallback, and the fallbacks
  // below are that same pair. Both are CHOSEN, not measured (Q19) — the first two-tool cut replaces
  // them. `rest.overlapMm` is the LEAST the band both programs cut may be: the band itself is
  // re-derived per job from the job's own two cutters (`overlapForJob`), and this is the floor the
  // derivation sits on — a pair that needs a wider band gets one, and a pair that needs less keeps
  // this. `rest.thirdToolPct` is the leftover share above which a third cutter is suggested, in
  // PERCENT because that is the unit an operator reads it in.
  'rest.overlapMm': {
    label: 'rest-machining overlap, at least',
    unit: 'mm',
    rule: z.number().min(0).max(20),
    fallback: REST_MACHINING_FALLBACK.overlap,
  },
  'rest.thirdToolPct': {
    label: 'leftover share that suggests a third cutter (chosen)',
    unit: '%',
    rule: z.number().min(0.1).max(50),
    fallback: REST_MACHINING_FALLBACK.thirdToolFraction * 100,
  },
  // #417 — how deep a cut may go into the wasteboard before it is warned about.
  'wasteboard.depthLimitMm': {
    label: 'wasteboard depth limit',
    unit: 'mm',
    rule: z.number().min(0).max(50),
    fallback: 0.5,
  },
  // ── #447 (begin) — the house depth margins (#345), out of browser storage and into the location.
  // CHOSEN, not measured. The two Z-error margins a job COPIES (`boundaryMarginMm`, `zToleranceMm`),
  // the four that SEED a new job's own fields, and the ± on a caliper-measured stock thickness. The
  // bounds start at 0 and stay generous because `settingsStore.parseMargins` accepts any finite value
  // ≥ 0: a number someone already saved must not be refused on its way in (`shopMargins.ts`). Each
  // fallback is `depthBounds.ts`'s MARGIN_DEFAULTS / MEASURED_THICKNESS_TOLERANCE_MM (a spec holds
  // them equal; importing depthBounds here would pull the geometry evaluator into every client).
  'margins.boundaryMarginMm': { label: 'boundary margin (chosen)', unit: 'mm', rule: z.number().min(0).max(100), fallback: 0.2 },
  'margins.zToleranceMm': { label: 'Z tolerance (chosen)', unit: 'mm', rule: z.number().min(0).max(100), fallback: 0.05 },
  'margins.minFloorMm': { label: 'minimum floor a new job starts from (chosen)', unit: 'mm', rule: z.number().min(0).max(100), fallback: 1.0 },
  'margins.edgeMarginMm': { label: 'edge margin a new job starts from (chosen)', unit: 'mm', rule: z.number().min(0).max(100), fallback: 1.0 },
  'margins.jawClearanceMm': { label: 'jaw clearance a new job starts from (chosen)', unit: 'mm', rule: z.number().min(0).max(100), fallback: 1.0 },
  'margins.breakthroughMm': { label: 'breakthrough a new job starts from (chosen)', unit: 'mm', rule: z.number().min(0).max(100), fallback: 0.3 },
  'margins.measuredThicknessToleranceMm': { label: '± on a measured stock thickness (not measured)', unit: 'mm', rule: z.number().min(0).max(10), fallback: 0.05 },
  // ── #447 (end)
};

/**
 * Keys with NO seed and no fallback: a value that only means something once it is measured on this
 * machine (#427). Held to their rule when present; {@link readMeasured} answers null when absent.
 */
export const MEASURED_ONLY: Readonly<Record<string, Omit<KnownDefault, 'fallback'>>> = {
  // The machine Z of the surface the stock sits on beside the bracket — what the surface touch expects
  // the stock's top above. `defaults.rs` bounds it the same way.
  'bracket.seatMachineZ': { label: 'surface beside the bracket, machine Z', unit: 'mm', rule: z.number().min(-150).max(0) },
};

/**
 * Yes/no keys this build knows (#414), with the value used when there is no location — `defaults.rs`'s
 * FLAG_SEEDS. A stored value that is not true/false is refused by the section's schema.
 */
export const KNOWN_FLAGS: Readonly<Record<string, { label: string; fallback: boolean }>> = {
  // The maintainer, 2026-10-16: "plus option to ignore scrap" — false turns offcut offers off.
  'offcut.offer': { label: 'offer offcuts at the end of a run', fallback: true },
};

/** A flag's value and where it came from — `fallback` with no location or no readable entry. */
export function readFlag(map: ShopDefaults | null, key: string): { value: boolean; source: DefaultSource | 'fallback' } {
  const known = KNOWN_FLAGS[key];
  if (!known) throw new Error(`${key} is not a known flag`);
  const d = map?.[key];
  if (d && typeof d.value === 'boolean') return { value: d.value, source: d.source };
  return { value: known.fallback, source: 'fallback' };
}

/** A measured-only key's value with its provenance, or null when the location has none. */
export function readMeasured(map: ShopDefaults | null, key: string): { value: number; source: DefaultSource; setAt: string | null; note: string | null } | null {
  const rule = MEASURED_ONLY[key];
  if (!rule) throw new Error(`${key} is not a measured-only key`);
  const d = map?.[key];
  if (!d || typeof d.value !== 'number' || !rule.rule.safeParse(d.value).success) return null;
  return { value: d.value, source: d.source, setAt: d.setAt, note: d.note };
}

/** The whole section: well-formed keys, each value valid, and each known key within its rule. */
export const ShopDefaultsSchema = z.record(z.string(), ShopDefaultSchema).superRefine((map, ctx) => {
  if (Object.keys(map).length > 200) {
    ctx.addIssue({ code: 'custom', message: 'the shop defaults hold more than 200 keys' });
  }
  // #430 review: the surface band inside the touch cap, as `defaults.rs` checks it.
  const band = map['registration.surfaceBandMm']?.value;
  const cap = map['registration.capBelowSurfaceMm']?.value;
  if (typeof band === 'number' && typeof cap === 'number' && band >= cap) {
    ctx.addIssue({ code: 'custom', message: `registration.surfaceBandMm (${band}) must be less than registration.capBelowSurfaceMm (${cap})` });
  }
  // The surface tolerance inside the park height less a clearance — `defaults.rs`'s PARK_CLEARANCE_MM.
  const tol = map['registration.surfaceToleranceMm']?.value;
  const park = map['registration.parkAboveSurfaceMm']?.value;
  if (typeof tol === 'number' && typeof park === 'number' && tol >= park - PARK_CLEARANCE_MM) {
    ctx.addIssue({ code: 'custom', message: `registration.surfaceToleranceMm (${tol}) must be less than registration.parkAboveSurfaceMm (${park}) less ${PARK_CLEARANCE_MM}` });
  }
  for (const [key, d] of Object.entries(map)) {
    if (!DEFAULT_KEY.test(key)) {
      ctx.addIssue({ code: 'custom', path: [key], message: 'a key is dotted lowerCamel words, like power.onWaitSeconds' });
      continue;
    }
    if (KNOWN_FLAGS[key] && typeof d.value !== 'boolean') {
      ctx.addIssue({ code: 'custom', path: [key], message: `${key} must be true or false` });
      continue;
    }
    const known = KNOWN_DEFAULTS[key] ?? MEASURED_ONLY[key];
    if (known && !known.rule.safeParse(d.value).success) {
      ctx.addIssue({ code: 'custom', path: [key], message: `${key} is outside its bounds` });
    }
  }
});

export type ShopDefaults = z.infer<typeof ShopDefaultsSchema>;

/** A default as a consumer reads it: the value, and where it came from — `fallback` with no location. */
export interface ReadDefault {
  value: number;
  source: DefaultSource | 'fallback';
}

/**
 * The number a consumer uses for `key`: the location's, or — only when there is no location, or its
 * entry does not hold a number within the key's rule — the registry's labelled fallback.
 */
export function readDefault(map: ShopDefaults | null, key: string): ReadDefault {
  const known = KNOWN_DEFAULTS[key];
  const stored = map?.[key];
  if (stored && typeof stored.value === 'number' && (!known || known.rule.safeParse(stored.value).success)) {
    return { value: stored.value, source: stored.source };
  }
  if (!known) throw new Error(`${key} has no fallback in KNOWN_DEFAULTS`);
  return { value: known.fallback, source: 'fallback' };
}

// ── The live section, for platform modules that cannot import the store ────────────────────────
type DefaultsSource = () => ShopDefaults | null;
let liveSource: DefaultsSource = () => null;

/**
 * Point the platform modules at the section the store currently holds (#449). The store calls this
 * once; `machineProbe`, `machineUpload` and the console read {@link liveShopDefaults} rather than
 * importing the zustand store, which would drag React and the whole store graph into modules the
 * protocol specs and the desktop boundary load on their own.
 */
export function setLiveDefaultsSource(source: DefaultsSource): void {
  liveSource = source;
}

/**
 * The section as it stands now, or null when nothing has read one — `readDefault` then answers the
 * labelled fallback, which is the no-service behaviour the hosted build wants anyway.
 */
export function liveShopDefaults(): ShopDefaults | null {
  try {
    return liveSource();
  } catch {
    // A source that throws (a store torn down mid-request) is no service, not a crash.
    return null;
  }
}

/** The desktop machine transport's four windows, ms (#449, "smaller timings"). */
export interface MachineTiming {
  connectTimeoutMs: number;
  discoveryWindowMs: number;
  identifyWindowMs: number;
  uploadInactivityMs: number;
}

/**
 * Read the machine transport's four windows from the section — the location's number where it has
 * one within the rule, the registry's labelled fallback otherwise. One reading, so a caller cannot
 * mix a stored window with a compiled one for the same connect.
 */
export function machineTiming(map: ShopDefaults | null): MachineTiming {
  return {
    connectTimeoutMs: readDefault(map, 'machine.connectTimeoutMs').value,
    discoveryWindowMs: readDefault(map, 'machine.discoveryWindowMs').value,
    identifyWindowMs: readDefault(map, 'machine.identifyWindowMs').value,
    uploadInactivityMs: readDefault(map, 'machine.uploadInactivityMs').value,
  };
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'unrecognised shape';
  const at = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  return `${at}${issue.message}`;
}

export type DefaultsRead = { kind: 'ok'; etag: string | null; defaults: ShopDefaults } | HouseReadFailure;

/** Read the section. A 404 is a service from before it: no defaults there. */
export async function houseDefaults(opts?: HouseRequestOptions): Promise<DefaultsRead> {
  const res = await houseRequest('GET', '/defaults', undefined, opts);
  if (res.kind === 'refused') {
    return res.status === 404 ? { kind: 'absent', reason: res.message } : { kind: 'error', detail: res.message };
  }
  if (res.kind !== 'ok') return res;
  let json: unknown;
  try {
    json = JSON.parse(res.text);
  } catch {
    return { kind: 'error', detail: 'the shop defaults are not readable JSON' };
  }
  const parsed = ShopDefaultsSchema.safeParse(json);
  if (!parsed.success) return { kind: 'error', detail: `the shop defaults do not match this build: ${firstIssue(parsed.error)}` };
  // The section's own request timeout (#449) applies from the NEXT request: the read that fetches it
  // had to run on the compiled fallback. `houseClient` never imports this module — this is the one
  // call that hands it the stored number, keeping the dependency one-way.
  setHouseRequestTimeoutMs(readDefault(parsed.data, 'house.requestTimeoutMs').value);
  return { kind: 'ok', etag: res.etag ?? null, defaults: parsed.data };
}

/** Set one default (checked here first). GUARDED on the section's `ETag`. */
export async function housePutDefault(
  key: string,
  value: ShopDefault,
  ifMatch: string | null,
  opts?: HouseRequestOptions,
): Promise<HouseWrite> {
  const check = ShopDefaultsSchema.safeParse({ [key]: value });
  if (!check.success) return { kind: 'refused', status: 400, message: firstIssue(check.error) };
  // `seeded` is the app's word for its own starting value; a value set here is chosen or measured.
  if (value.source === 'seeded') {
    return { kind: 'refused', status: 400, message: 'a value you set is `chosen` (or `measured`), with the date — not `seeded`' };
  }
  const res = await houseRequest('PUT', `/defaults/${encodeURIComponent(key)}`, value, { ...opts, ifMatch });
  return res.kind === 'ok' ? { kind: 'ok' } : (res as HouseFailure);
}

/** Reset one default to its seed (a key with no seed is removed). Guarded. */
export async function houseResetDefault(
  key: string,
  ifMatch: string | null,
  opts?: HouseRequestOptions,
): Promise<HouseWrite> {
  const res = await houseRequest('DELETE', `/defaults/${encodeURIComponent(key)}`, undefined, { ...opts, ifMatch });
  return res.kind === 'ok' ? { kind: 'ok' } : (res as HouseFailure);
}
