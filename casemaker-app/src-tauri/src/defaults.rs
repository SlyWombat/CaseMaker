// The shop's own defaults (#416/#417, and the maintainer's rule of 2026-10-15: "That type of setting
// should be something we keep in our own database and not compiled in"). Tunable values — a
// threshold, a wait, a chosen margin — live HERE, in `location.json`, each with where it came from;
// code keeps only a labelled fallback for a build with no house service.
//
// OPEN TO NEW KEYS, VALIDATED. The section is a map from a dotted key (`power.onWaitSeconds`,
// `wasteboard.depthLimitMm`, `rest.overlapMm`) to a value with provenance. A key this build does not
// know is KEPT and served — a newer build's setting survives an older build's write — as long as it
// is well-formed: a dotted lowerCamel key, a scalar value (a finite number, a boolean or a short
// string), a source, and a date for anything that is not the seed. The keys this build does know are
// also held to their own rule (`known_rule`); the client restates both in `defaultsClient.ts`, and
// a new consumer adds its key there (and, if it wants a server-side bound, here) without changing
// the section's shape.
//
// SEEDED, AND SAID SO. A fresh location is written with the seed values (`SEEDS`), each marked
// `seeded`; a location from before this section gets any missing seed in memory at load, so it reads
// the same values and the next write stores them. A seed is a starting value somebody chose for
// this app, not a measurement — the source says which.

use crate::house::HouseError;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DefaultSource {
    /// The starting value this app writes into a new location.
    Seeded,
    /// The user's choice.
    Chosen,
    /// Measured on this shop's own equipment.
    Measured,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShopDefault {
    /// A finite number, a boolean, or a short string.
    pub value: serde_json::Value,
    pub source: DefaultSource,
    /// When a chosen or measured value was set. Absent on a seed.
    #[serde(default)]
    pub set_at: Option<String>,
    /// The unit, for a person reading the file (`mm`, `s`).
    #[serde(default)]
    pub unit: Option<String>,
    /// Where a measured value came from, in a sentence (#430 review). Left out of the JSON when
    /// absent, so a section with no note reads as it did before the field existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

pub type ShopDefaults = BTreeMap<String, ShopDefault>;

/// Values a fresh location starts with that were MEASURED, not chosen: written with `measured`, the
/// date, and a note saying how (#430 review). `(key, value, unit, measured at, how)`.
pub const MEASURED_SEEDS: &[(&str, f64, &str, &str, &str)] = &[
    (
    "registration.tipRadiusMm",
    0.7,
    "mm",
    "2026-10-15T19:03:20.874Z",
    "effective rim offset of the wired probe, from the 2026-10-15 bench scan (trace 18:59-19:03): \
     the 38.1 mm blank read 39.5 mm wide, (39.5 - 38.1) / 2 = 0.70 mm, +/- 0.25 at a 0.5 mm step; \
     the tip's outside diameter is 2.0 mm",
    ),
    (
        "registration.tipRadiusUncertaintyMm",
        0.25,
        "mm",
        "2026-10-15T19:03:20.874Z",
        "the rim offset's own spread from the same 2026-10-15 bench scan: +/- 0.25 mm at a 0.5 mm step. \
         It cancels in a centre between two walls, and doubles in a width between them",
    ),
    (
        "registration.tipDiameterMm",
        2.0,
        "mm",
        "2026-10-15T19:03:20.874Z",
        "the wired probe tip's outside diameter, as recorded with the 2026-10-15 bench scan: an opening must \
         be wider than this to be entered at all",
    ),
    // ── #451 (begin) — the wired probe's repeatability in Z, measured on the PRINTER'S blank in
    // the vise: this is the figure #345's Z budget is built on.
    (
        "registration.wiredProbeZResidualMm",
        0.001,
        "mm",
        "2026-10-08T00:00:00.000Z",
        "the wired probe's repeatability in Z: five slow (F100) touches on the printed blank in the vise \
         triggered within 0.001 mm of each other, fast (F300) within 0.004 mm and 2-6 um deep \
         (/Z1-Firmware-Dialect.md §11.7, runbook C4, 2026-10-08)",
    ),
    // ── #451 (end)
    // ── #421 (begin) — the run plan's phase times, timed in docs/bench/traces/2026-10-15-console.log.
    (
        "plan.homeSeconds",
        27.5,
        "s",
        "2026-10-15T23:37:01.349Z",
        "the mean of the five $H homes in the 2026-10-15 console trace: 27.0, 27.7, 29.4, 22.3 and 31.2 s (send to reply, 16:55, 17:14, 17:25, 19:14, 23:37)",
    ),
    (
        "plan.toolLengthSeconds",
        31.4,
        "s",
        "2026-10-15T18:53:49.247Z",
        "the four complete M491 tool-length touches on the wired probe in the 2026-10-15 console trace, sent to Done ATC: 31.36, 31.25, 32.18 and 31.35 s (16:34, 16:55, 17:15, 18:53); a fifth at 18:58 ended early and is not counted",
    ),
    // ── #421 (end)
];

/// What a fresh location starts with. Each is a value somebody chose for this app; the source says so.
pub const SEEDS: &[(&str, f64, &str)] = &[
    // #416 — how long switching on waits for the controller to answer (port 2222, then `?`). The
    // bench script's own default (`tools/z1/power.sh --wait`).
    ("power.onWaitSeconds", 180.0, "s"),
    // #417 — how deep a cut may go into the wasteboard before it is warned about.
    ("wasteboard.depthLimitMm", 0.5, "mm"),
    // #415 — past how many minutes of runtime a cutter gets a "check this bit" note. Ten hours, as a
    // starting point nobody measured; runtime only warns, it never retires a cutter (Q4).
    ("tools.runtimeWarnMinutes", 600.0, "min"),
    // #430 — the stepped edge scan and the surface touch, as the 2026-10-15 bench ran them: a touch
    // never lower than surface − cap, parked a few mm above, stepped coarse then fine, kept clear of
    // the blank's rounded corners. The probe's effective rim offset is MEASURED (`MEASURED_SEEDS`,
    // 0.70 mm, 2026-10-15); the rest are the bench's own values, chosen, not measured.
    ("registration.capBelowSurfaceMm", 0.5, "mm"),
    ("registration.coarseStepMm", 1.0, "mm"),
    ("registration.fineStepMm", 0.5, "mm"),
    ("registration.parkAboveSurfaceMm", 3.0, "mm"),
    ("registration.scanInsideMm", 3.0, "mm"),
    ("registration.scanReachMm", 5.0, "mm"),
    ("registration.cornerClearanceMm", 2.0, "mm"),
    ("registration.surfaceBandMm", 0.25, "mm"),
    ("registration.edgeMarginMm", 0.5, "mm"),
    // #475 - the surface touches across the cut regions' extents: a centre plus both extents on each
    // axis. CHOSEN, not measured; `defaultsClient.ts` states the same 5..=9 whole-number bound.
    ("registration.surfaceTouchCount", 5.0, "touches"),
    ("registration.surfaceSeekMm", 60.0, "mm"),
    // How far the surface may sit from where the job expects it (stock thickness, the mount, G54 Z):
    // the surface touch only travels within this band, and refuses a reading outside it.
    // Below BOTH the park height (less a clearance) and the bench vise's jaw drop (0.47 mm): a seek
    // that misses the stock and lands on a jaw, or a park that would sit below the band, is refused.
    ("registration.surfaceToleranceMm", 0.4, "mm"),
    ("registration.touchFeed", 150.0, "mm/min"),
    ("registration.surfaceFastFeed", 300.0, "mm/min"),
    ("registration.surfaceSlowFeed", 100.0, "mm/min"),
    // #423 — the run screen's watch, as the harness's `run` keeps it: `?` every 2 s at most (0.6 s
    // faulted the controller on 2026-10-12, #386 — 2000 ms is also the floor), a job that shows no
    // progress field for 30 s is not a job, and three unanswered polls in a row are "unreachable".
    ("run.pollMs", 2000.0, "ms"),
    ("run.noProgressMs", 30000.0, "ms"),
    ("run.missLimit", 3.0, "polls"),
    // #428 — the setups planner: the least stock left to grip (today's provisional GRIP_MIN), and the
    // phase estimates for a remount and the re-registration after it — chosen, not measured.
    ("setups.minGripMm", 3.0, "mm"),
    ("setups.remountMinutes", 3.0, "min"),
    ("setups.reregisterMinutes", 2.0, "min"),
];

/// #427 — the anchor bracket and its top clamps. NOT MEASURED: starting values written `seeded` WITH a
/// note that says so and names what to caliper, so nobody mistakes one for a measurement. Measuring one
/// replaces it with a `measured` value, dated, through the same section. `(key, value, unit, note)`.
pub const UNMEASURED_SEEDS: &[(&str, f64, &str, &str)] = &[
    (
        "bracket.originOffsetXMm",
        0.0,
        "mm",
        "default, not measured: the stock's corner in the bracket from anchor 1 along X. 0 is Makera's own \
         (Z1 QuickStart: work origin relative to Anchor 1, X offset 0); caliper the bracket's inside face to the anchor",
    ),
    (
        "bracket.originOffsetYMm",
        0.0,
        "mm",
        "default, not measured: the stock's corner in the bracket from anchor 1 along Y. 0 is Makera's own \
         (Z1 QuickStart: Y offset 0); caliper the bracket's inside face to the anchor",
    ),
    (
        "bracket.fitMm",
        0.1,
        "mm",
        "default, not measured: how closely a corner pushed into the bracket repeats (the design's +/-0.1)",
    ),
    (
        "bracket.armLengthXMm",
        100.0,
        "mm",
        "default, not measured: the bracket arm along the stock's front edge, from the inside corner to its end (100: the 100 mm plate Makera ships for it)",
    ),
    (
        "bracket.armLengthYMm",
        100.0,
        "mm",
        "default, not measured: the bracket arm along the stock's left edge, from the inside corner to its end (100: the 100 mm plate Makera ships for it)",
    ),
    (
        "bracket.armWidthMm",
        10.0,
        "mm",
        "default, not measured: how thick each arm is, from the face the stock touches to its outside",
    ),
    (
        "bracket.heightMm",
        10.0,
        "mm",
        "default, not measured: the top of the bracket (and its screw heads) above the surface the stock sits on",
    ),
    // ── #451 (begin) — how closely a bracket seated on the anchor pins repeats: provisional.
    (
        "bracket.repeatMm",
        0.05,
        "mm",
        "provisional, not measured: how closely a bracket seated on the anchor pins repeats; #208 B1 owes the pin-to-face measurement",
    ),
    // ── #451 (end)
    (
        "clamps.topLengthMm",
        30.0,
        "mm",
        "default, not measured: a top clamp's length, pointing onto the stock",
    ),
    ("clamps.topWidthMm", 15.0, "mm", "default, not measured: a top clamp's width, along the edge it holds"),
    (
        "clamps.topHeightMm",
        12.0,
        "mm",
        "default, not measured: a fitted top clamp's highest point (screw head included) above the stock's top",
    ),
    (
        "clamps.topReachMm",
        8.0,
        "mm",
        "default, not measured: how far a top clamp's nose reaches in over the stock from its edge",
    ),
    (
        "clamps.topInFromCornerMm",
        15.0,
        "mm",
        "chosen placement, not a measurement: a clamp's side this far in from the corner of the edge it holds",
    ),    // #434 — peck drilling with drill bits: the pecks chosen, the feeds placeholders. None measured.
    ("drill.peckDiameters", 1.0, "x", "chosen, not measured: each peck goes this many drill diameters deep before the drill retracts to clear chips"),
    ("drill.peckClearanceMm", 0.5, "mm", "chosen, not measured: after a peck the drill rapids back down to this far above the floor it just cut"),
    ("drill.pointAngleDeg", 118.0, "deg", "chosen, not measured: a twist drill's included point angle, used only when the drill's own record states none"),
    ("drill.plungeFeed", 100.0, "mm/min", "placeholder, not measured; not a vendor number: the drilling feed until a measured row replaces it"),
    ("drill.spindleRpm", 10000.0, "rpm", "placeholder, not measured; not a vendor number: the drilling spindle speed until a measured row replaces it"),
    // #445 — thread milling: the pass, the ramp, the run-out and the chord chosen, the feeds and the
    // spindle speed placeholders. None measured, none a vendor number.
    ("thread.radialStepoverMm", 0.2, "mm", "chosen, not measured: the most radial depth one thread pass takes; the last pass always lands on the major radius"),
    ("thread.entryRampMm", 0.5, "mm", "chosen, not measured: the axial drop over which the entry ramp reaches the pass radius; 0 is a flat radial entry"),
    ("thread.bottomClearancePitches", 1.0, "x", "chosen, not measured: how many pitches the tool tip runs below the last full thread"),
    ("thread.pilotTipClearanceMm", 0.5, "mm", "chosen, not measured: the pilot floor must sit this far below the tool tip so the tip does not bottom"),
    ("thread.feed", 300.0, "mm/min", "placeholder, not measured; not a vendor number: the helical cutting feed until a measured row replaces it"),
    ("thread.plungeFeed", 100.0, "mm/min", "placeholder, not measured; not a vendor number: the feed down the open pilot and the entry ramp until a measured row replaces it"),
    ("thread.spindleRpm", 10000.0, "rpm", "placeholder, not measured; not a vendor number: the thread-milling spindle speed until a measured row replaces it"),
    ("thread.chordToleranceMm", 0.01, "mm", "chosen, not measured: the most a G1 chord may stray from the true helix; it sets the move count and the file size"),
    ("engrave.newThreadDepthMm", 5.0, "mm", "chosen, not measured: the threaded length a new thread item starts at"),
    // #433 — adaptive clearing for metal pockets: the engagement, step-down, helix and ramp chosen, the
    // feeds and the spindle speed placeholders. None measured, none a vendor number.
    ("adaptive.engagementFraction", 0.1, "x", "chosen, not measured: the most new material a clearing move may take per mm of travel, as a fraction of the cutter diameter"),
    ("adaptive.stepDownMm", 1.0, "mm", "chosen, not measured: the deepest level adaptive clearing cuts at once"),
    ("adaptive.helixDiameterFraction", 0.5, "x", "chosen, not measured: the helix entry's diameter as a fraction of the cutter diameter; the helix is refused where its bore does not fit"),
    ("adaptive.rampAngleDeg", 2.0, "deg", "chosen, not measured: the descent angle of the helix and ramp entries"),
    ("adaptive.cutFeed", 600.0, "mm/min", "placeholder, not measured; not a vendor number: the adaptive clearing feed until a measured row replaces it"),
    ("adaptive.entryFeed", 200.0, "mm/min", "placeholder, not measured; not a vendor number: the helix and ramp entry feed until a measured row replaces it"),
    ("adaptive.spindleRpm", 12000.0, "rpm", "placeholder, not measured; not a vendor number: the adaptive spindle speed until a measured row replaces it"),
    // ── #451 adaptive settings (begin) — the entry clearance and the planner's three refusal limits:
    // chosen, not measured, and `defaultsClient.ts` states the same bounds and fallbacks.
    ("adaptive.entryClearanceMm", 0.5, "mm", "chosen, not measured: how far above the floor just cut a rapid down a cleared column stops, and the clearance every entry starts from"),
    ("adaptive.maxCells", 12000000.0, "cells", "chosen, not measured: the largest material grid adaptive clearing will build; a pocket needing more cells at the planned engagement is refused rather than ground through"),
    ("adaptive.residualShare", 0.005, "x", "chosen, not measured: the material adaptive clearing may leave as grid noise along the walls, as a share of the area to clear"),
    ("adaptive.neckAreaMm2", 0.05, "mm²", "chosen, not measured: material in a neck narrower than the grid can see, above this area, refuses the plan rather than being left standing"),
    // ── #451 adaptive settings (end)
    // ── #438 (begin) — the column engine's FLAT grid Y pitch: chosen, not measured.
    // ── #451 (begin) — the DXF arc chord error: chosen, not measured.
    ("import.dxfChordToleranceMm", 0.02, "mm", "chosen, not measured: the most a flattened DXF arc may stray from the true arc; smaller is more points"),
    // ── #451 (end)
    ("sim.columnFlatPitchYMm", 0.1, "mm", "chosen, not measured: the flat simulation grid's Y pitch; the oracle's band grows with the cell and the sim's memory and time with 1/pitch"),
    // ── #438 (end)
    // ── #451 sim resolutions (begin) — the exact sweeper's spindle-off clearance and the column
    // engine's X and rotary pitches: chosen, not measured.
    ("sim.spindleOffProximityMm", 1.0, "mm", "chosen, not measured: how close a feed move with the spindle off may come to material still present at that point, or to the bed, before it is a fault"),
    ("sim.columnPitchXMm", 0.1, "mm", "chosen, not measured: the simulation grid's X pitch; the sim's memory and time grow with 1/pitch"),
    ("sim.rotaryPitchDeg", 0.25, "deg", "chosen, not measured: the rotary simulation grid's theta pitch; the sim's memory and time grow with 1/pitch"),
    // ── #451 sim resolutions (end)
    // ── #451 runSheet (begin) — the blank-size tolerance the sheet prints in its first instruction.
    ("runSheet.blankToleranceMm", 0.5, "mm", "chosen, not measured: how far a measured blank may differ from the job's stated size before the sheet tells the operator to change the job and regenerate"),
    // ── #451 runSheet (end)
    // ── #451 sim starting values (begin) — what a session begins with: chosen, not measured.
    ("sim.playbackSpeed", 20.0, "x", "chosen, not measured: the playback multiplier a fresh simulation session starts at, as a multiple of wall-clock time; one of 1, 5, 20 or 100"),
    ("sim.defaultStockLengthMm", 100.0, "mm", "chosen, not measured: the blank a simulation starts with when the file states no stock, along X; 100 x 100 x 10 is the documented default (/Simulation.md §6)"),
    ("sim.defaultStockWidthMm", 100.0, "mm", "chosen, not measured: the blank a simulation starts with when the file states no stock, along Y; 100 x 100 x 10 is the documented default (/Simulation.md §6)"),
    ("sim.defaultStockThicknessMm", 10.0, "mm", "chosen, not measured: the blank a simulation starts with when the file states no stock, in Z; 100 x 100 x 10 is the documented default (/Simulation.md §6)"),
    ("sim.budgetMs", 60000.0, "ms", "chosen, not measured: the wall-clock limit one simulation load starts with. Past it the load is refused (or the worker killed), and Retry starts a load with twice this"),
    // ── #451 sim starting values (end)
    // ── #451 new-item starting depths (begin) — where an item the Engrave panel just added begins.
    // CHOSEN, not measured: nobody measured what depth a new item should start at, and the person who
    // asked for it is about to set the number that matters. A hole starts deeper than an item because
    // a hole that begins as shallow as a label shows nothing on the preview.
    ("engrave.newItemDepthMm", 0.5, "mm", "chosen, not measured: the depth a new label, shape, combined shape, traced line or imported outline starts at, in the panel where the person then sets the depth that matters"),
    ("engrave.newDrillDepthMm", 1.0, "mm", "chosen, not measured: the depth a new hole starts at — deeper than an item's own starting depth because a hole that shallow shows nothing on the preview"),
    // ── #451 new-item starting depths (end)
    // ── #451 engrave findings (begin) — the `item-detail-lost` bar: chosen, not measured.
    ("engrave.lostDetailWarnRatio", 0.9, "x", "chosen, not measured: the share of an item's area a cutter must reach before the item is called detail-lost"),
    // ── #451 engrave findings (end)
    // ── #451 blank band fill (begin) — chosen, not measured, and `defaultsClient.ts` states the same
    // bounds and fallback. It trades cap height against the clearance the dome and the print want.
    ("engrave.blankBandFill", 0.7, "x", "chosen, not measured: how much of a free band the seeded line takes, as a share of it; more fill means a taller cap and less clearance"),
    // ── #451 blank band fill (end)
    // ── #432 facing (begin) — the depth a facing pass arrives filled in with. CHOSEN, not measured:
    // the maintainer's decision of 2026-10-17 asks the depth every time facing is on and fills in
    // the probed top's spread plus the margin, or one of these two fallbacks without a probe.
    // General practice is a light 0.2 to 0.5 mm skim; `defaultsClient.ts` states the same bounds.
    ("facing.roughMm", 0.5, "mm", "chosen, not measured: the facing depth filled in for rough stock — the heavy end of the 0.2 to 0.5 mm skim general practice uses; the person is asked and can change it"),
    ("facing.unknownMm", 0.2, "mm", "chosen, not measured: the facing depth filled in when the stock's finish is unknown — the light end of the same 0.2 to 0.5 mm skim"),
    ("facing.marginMm", 0.1, "mm", "chosen, not measured: added to a probed top's high-to-low spread to fill in the facing depth, so the skim clears the highest point of the face"),
    ("facing.retouchToleranceMm", 0.1, "mm", "chosen, not measured: the +/- band around the top a facing skim was posted to leave; the post-facing re-touch accepts a measurement inside it, because a skim never removes exactly its nominal depth"),
    // ── #432 facing (end)
    // ── #421 (begin) — the run plan's phase times that the app has not timed: chosen.
    ("plan.touchSeconds", 15.0, "s", "chosen, not measured as the app's runner would take it: 15 s a touch, from the 2026-10-15 console trace's edge scans, driven by a console script, not the app runner. 32 touch-to-touch intervals under 20 s (G38.2 Z-5, 16:35:59 to 16:50:34): median 13.3 s, mean 14.0 s, range 10.4 to 19.7 s; the round trips between touches are included"),
    ("plan.fitProbeSeconds", 45.0, "s", "chosen, not measured: fitting the wired probe by hand, from the plan of section 5.8; the first timed run replaces it"),
    ("plan.fitCutterSeconds", 60.0, "s", "chosen, not measured: fitting a cutter by hand at a bit change, from the plan of section 5.8; the first timed run replaces it"),
    ("plan.clearanceSeconds", 10.0, "s", "chosen, not measured: the vacuum off and the clearance move after a cut (observed, not timed)"),
    ("plan.finishSeconds", 15.0, "s", "chosen, not measured: the end of a job, M332, spindle off, G28 (observed, not timed)"),
    ("plan.autoLevelPoints", 9.0, "points", "chosen, not measured: the auto-level grid's point count, Makera Studio's own 3 x 3 default"),
    ("plan.autoLevelPointSeconds", 10.0, "s", "chosen, not measured: one auto-level point; an estimate until #176 runs a grid here"),
    ("plan.autoLevelShallowMm", 0.5, "mm", "chosen, not measured: on stock not known flat, a cut shallower than this wants an auto-level grid (Makera Studio's own rule)"),
    // ── #421 (end)
    // #431 — the laser point-to-origin's accuracy, ±1 mm, until the dot is measured.
    ("laser.originUncertaintyMm", 1.0, "mm", "chosen, not measured: how far the laser dot's origin may be from the stock's corner (the dot's size, and its offset from the spindle axis, are not measured); point-to-origin is refused for a job whose edge margin is tighter"),
    // ── #449 (begin) — the probe, scan, console, stop and power timing. Chosen, not measured: each is
    // the number the code compiled before (`defaultsClient.ts` states the same bounds and fallbacks).
    // The 2000 ms poll floors stay compiled in the code that polls; these may only sit above them.
    ("registration.surfaceSlowSeekMm", 2.0, "mm", "chosen, not measured: how far the slow surface touch may travel. It starts 1 mm above the fast touch's hit, so it must travel more than that, and at most 2 mm (never more than 1 mm past the hit), so it stays a capped touch"),
    ("registration.idlePollLimit", 30.0, "polls", "chosen, not measured: how many status polls the registration waits for Idle before a touch, about a second each, before it stops"),
    ("registration.scanMissMarginMm", 1.0, "mm", "chosen, not measured: how far past the jaw tops a run-sheet scan touch may travel before it is called nothing; the cap that keeps a touch with nothing under it off the bed"),
    ("registration.readingResolutionMm", 0.05, "mm", "chosen, not measured: the depth two touch readings are told apart by (the machine's dial, not the probe's spec)"),
    // ── #451 probe residuals (begin) — what a touch leaves and what each fixture already holds.
    // The 3D probe's 0.02 is still an assumption; the chuck and jaw figures are provisional stubs
    // (#208), and the wired probe's measured Z figure is in MEASURED_SEEDS.
    ("registration.probeResidualMm", 0.02, "mm", "assumed, not measured: the 3D probe's ball-contact scatter in X, Y and Z, and what is left after a touch. The wired probe measured 0.001 mm in Z (registration.wiredProbeZResidualMm); this stays the conservative figure until the 3D probe is measured the same way (2026-10-08, /Z1-Firmware-Dialect.md §11.7)"),
    ("registration.chuckAxisResidualMm", 0.05, "mm", "provisional, not measured: the chuck's runout where it locates the axis; #208 owes the bench measurement"),
    ("registration.viseJawResidualMm", 0.05, "mm", "provisional, not measured: the vise jaws' squareness across the jaws; #208 owes the bench measurement"),
    // ── #451 probe residuals (end)
    ("console.firstReplyMs", 60000.0, "ms", "chosen, not measured: how long a typed console line waits for its first reply. Above the slowest lines timed on the bench (M491 about 32 s, $H about 31 s, 2026-10-15)"),
    ("console.quietMs", 800.0, "ms", "chosen, not measured: the quiet gap that ends a console reply"),
    ("console.maxMs", 120000.0, "ms", "chosen, not measured: the longest a console reply may run; never shorter than the first-reply wait"),
    ("run.statusReplyMs", 3000.0, "ms", "chosen, not measured: how long a status poll waits for its reply; the controller answers in 0.6 to 0.7 s (#386)"),
    ("stop.idlePolls", 3.0, "polls", "chosen, not measured: after abort, how many status polls look for Idle before M332; none reading Idle leaves the vacuum on and says so"),
    ("stop.idlePollMs", 5000.0, "ms", "chosen, not measured: the wait between those polls; never under the 2 s status floor (#386)"),
    ("stop.abortReplyMs", 60000.0, "ms", "chosen, not measured as a bound: how long abort is given to answer (about 18 s observed on 2026-10-12, #303). The app's Stop and the bench harness's run share this one number (maintainer, 2026-10-16)"),
    ("power.probeTries", 3.0, "tries", "chosen, not measured: how many machine probes, all silent, before a powered machine counts as not answering (#416 review: one silent probe is a Wi-Fi blip as often as a dead controller)"),
    ("power.probeGapSeconds", 2.0, "s", "chosen, not measured: the wait between those probes"),
    ("power.cyclePauseSeconds", 10.0, "s", "chosen, not measured: how long a plug cycle leaves the machine off before switching it on again (power.sh on --cycle)"),
    ("power.pollSeconds", 3.0, "s", "chosen, not measured: the wait between checks while switching on waits for the controller to answer"),
    // The desktop machine transport's four windows (#449, "smaller timings"), and the house
    // service's own request timeout. Each is the number the code compiled before; `protocol.ts`,
    // `machineBridge.ts` and `houseClient.ts` keep each as a labelled no-service fallback.
    ("machine.connectTimeoutMs", 3000.0, "ms", "chosen, not measured: how long a TCP connect to the machine's command port may take before it is called unreachable; the bridge compiled 3 s"),
    ("machine.discoveryWindowMs", 3000.0, "ms", "chosen, not measured: how long the app listens for the machine's UDP broadcast before deciding it is not announcing itself; the protocol compiled 3 s"),
    ("machine.identifyWindowMs", 1500.0, "ms", "chosen, not measured: how long each reply to the identify asks (M482.5, then M482.4) is waited for; the protocol compiled 1.5 s"),
    ("machine.uploadInactivityMs", 9000.0, "ms", "chosen, not measured: how long an upload waits for the machine's next frame before it cancels the transfer; the protocol compiled 9 s"),
    ("house.requestTimeoutMs", 2000.0, "ms", "chosen, not measured: how long a house service request gets before it is called dead; a service on this machine or LAN answers in single-digit milliseconds, and the client compiled 2 s"),
    // ── #449 (end)
    // #414 — Q3's minimum offcut, 20 x 20 mm at the stock's thickness.
    // #414 — the maintainer, 2026-10-16: runtime is weighted by the material cut. Chosen, not measured.
    ("tools.wearWeight.plastic", 1.0, "x", "chosen, not measured: a minute cutting PLA, ABS, acrylic: the baseline"),
    ("tools.wearWeight.wood", 1.0, "x", "chosen, not measured: a minute cutting softwood, hardwood, MDF: about as hard on a cutter as plastic"),
    ("tools.wearWeight.aluminium", 3.0, "x", "chosen, not measured: a minute cutting 6061, 7075: three times the wear of plastic"),
    ("tools.wearWeight.brass", 2.0, "x", "chosen, not measured: a minute cutting brass: free-cutting, twice plastic"),
    ("tools.wearWeight.copper", 3.0, "x", "chosen, not measured: a minute cutting copper: gummy, as hard on a cutter as aluminium"),
    // #456 — fibre-filled nylon (PA-CF, PA-GF) is abrasive, so it gets its own class rather than
    // plastic's weight. Chosen, not measured: the maintainer asked for a heavier class; the number
    // is ours until a bench comparison replaces it.
    ("tools.wearWeight.abrasive", 5.0, "x", "chosen, not measured: a minute cutting PA-CF or PA-GF. Fibre-filled nylon is abrasive; five times plastic's wear is this app's choice (the maintainer asked for a heavier class in #456), not a bench measurement"),
    ("offcut.minSideMm", 20.0, "mm", "chosen, not measured: an offcut is offered back to the shelf only when both its sides are at least this (Q3: only leftover stock that has some size to it)"),
    // #436 — rest machining's two numbers, out of the code and into the document (the maintainer,
    // 2026-10-16: "That type of setting should be something we keep in our own database and not
    // compiled in"). Both chosen, not measured (Q19); the first two-tool cut replaces them.
    ("rest.overlapMm", 0.5, "mm", "chosen, not measured: the LEAST the band both programs cut at the seam may be. The band itself is worked out per job from that job's own two cutters, and this is the floor under it — a 2 mm cutter at a 0.9 mm step-over leaves slivers 0.107 mm wide and a 0.6 mm rest cutter closes anything narrower, so the badge's pair needs about 0.493 mm. The first two-tool cut replaces this"),
    ("rest.thirdToolPct", 2.0, "%", "chosen, not measured: the share of a job's own removal area that may still be standing after both programs have run before a third cutter is suggested"),
    // #250 — the finish pass's stock-to-leave. Chosen, not measured: about one printed layer at the
    // common layer height, and small enough that a 1 mm flat still has a roughing cut. The first
    // bench cut that inspects a finished floor replaces it.
    ("finish.stockToLeaveMm", 0.2, "mm", "chosen, not measured: how much stock the roughing pass leaves on the walls and the floor for the finishing pass. 0.2 mm is about one printed layer at the common layer height. The first bench cut that inspects a finished floor replaces this"),
    // #218 — holding tabs. Three PROVISIONAL numbers (4 tabs, 4 mm wide, 1 mm of kept material);
    // the first tabbed cut replaces all three. A job stores its own spec, so these seed a NEW
    // cut-out rather than overriding an existing one.
    ("tabs.count", 4.0, "tabs", "chosen, not measured: holding tabs per cut-out. Four is provisional — the first part cut with tabs replaces it"),
    ("tabs.widthMm", 4.0, "mm", "chosen, not measured: holding-tab width in material. The cutter's centre path stops two tool radii further apart. Provisional until the first tabbed cut"),
    ("tabs.heightMm", 1.0, "mm", "chosen, not measured: material a holding tab leaves below the tab top. Provisional; on a 3.81 mm badge blank it leaves 1 mm under a 2.81 mm cut"),
    // ── #447 (begin) — the house depth margins (#345), out of browser storage. Chosen, not measured:
    // the numbers `depthBounds.ts`'s MARGIN_DEFAULTS shipped with, which a job copies or seeds from.
    ("margins.boundaryMarginMm", 0.2, "mm", "chosen, not measured: how far every floor stays clear of a plane it must not cross; 0.2 is one printed layer at the common layer height. While it is the seed, a blank that states its print uses its own layer height instead"),
    ("margins.zToleranceMm", 0.05, "mm", "chosen, not measured: how far this machine is expected to put the blank and the registration out in Z; a job's recommendation adds the blank's own dome to it"),
    ("margins.minFloorMm", 1.0, "mm", "chosen, not measured: material that must remain under the deepest cut; seeds each new job, which then owns its own value"),
    ("margins.edgeMarginMm", 1.0, "mm", "chosen, not measured: how close an item may come to a stock edge; seeds each new job"),
    ("margins.jawClearanceMm", 1.0, "mm", "chosen, not measured: how far a cut's floor must stay above the vise jaws' tops; seeds each new job"),
    ("margins.breakthroughMm", 0.3, "mm", "chosen, not measured: how far a through-cut may pass below the part's underside; seeds each new job"),
    ("margins.measuredThicknessToleranceMm", 0.05, "mm", "not measured: the +/- a caliper-measured stock thickness adds to a job's Z budget; provisional until the bench measures it (#208)"),
    // ── #447 (end)
];

/// Yes/no starting values, seeded `chosen`-in-spirit with a note (#414: the maintainer's "option to
/// ignore scrap"). `(key, value, note)`.
pub const FLAG_SEEDS: &[(&str, bool, &str)] = &[(
    "offcut.offer",
    true,
    "chosen, not measured: offer an offcut back to the shelf at the end of a run that split the stock (false: never ask)",
)];

/// The flags this build knows: a key here must hold true or false.
fn is_flag(key: &str) -> bool {
    FLAG_SEEDS.iter().any(|(k, ..)| *k == key)
}

pub fn seeded() -> ShopDefaults {
    let mut map = ShopDefaults::new();
    add_missing_seeds(&mut map);
    map
}

/// Fill in any seed the map does not have. Returns whether anything was added.
pub fn add_missing_seeds(map: &mut ShopDefaults) -> bool {
    let mut added = false;
    for (key, value, note) in FLAG_SEEDS {
        if !map.contains_key(*key) {
            map.insert(
                (*key).to_string(),
                ShopDefault {
                    value: serde_json::json!(value),
                    source: DefaultSource::Seeded,
                    set_at: None,
                    unit: None,
                    note: Some((*note).to_string()),
                },
            );
            added = true;
        }
    }
    for (key, value, unit) in SEEDS {
        if !map.contains_key(*key) {
            map.insert(
                (*key).to_string(),
                ShopDefault {
                    value: serde_json::json!(value),
                    source: DefaultSource::Seeded,
                    set_at: None,
                    unit: Some((*unit).to_string()),
                    note: None,
                },
            );
            added = true;
        }
    }
    for (key, value, unit, note) in UNMEASURED_SEEDS {
        if !map.contains_key(*key) {
            map.insert(
                (*key).to_string(),
                ShopDefault {
                    value: serde_json::json!(value),
                    source: DefaultSource::Seeded,
                    set_at: None,
                    unit: Some((*unit).to_string()),
                    note: Some((*note).to_string()),
                },
            );
            added = true;
        }
    }
    for (key, value, unit, at, how) in MEASURED_SEEDS {
        if !map.contains_key(*key) {
            map.insert(
                (*key).to_string(),
                ShopDefault {
                    value: serde_json::json!(value),
                    source: DefaultSource::Measured,
                    set_at: Some((*at).to_string()),
                    unit: Some((*unit).to_string()),
                    note: Some((*how).to_string()),
                },
            );
            added = true;
        }
    }
    added
}

/// `segment(.segment)+`, each segment lowerCamel ASCII: `power.onWaitSeconds`.
pub fn valid_key(key: &str) -> bool {
    let parts: Vec<&str> = key.split('.').collect();
    key.len() <= 80
        && parts.len() >= 2
        && parts.iter().all(|p| {
            let mut chars = p.chars();
            chars.next().is_some_and(|c| c.is_ascii_lowercase())
                && chars.all(|c| c.is_ascii_alphanumeric())
        })
}

/// The bounds of the keys this build knows. `None` for a key it does not: kept, held to the general
/// rule only.
fn known_rule(key: &str, n: Option<f64>) -> Option<Result<(), String>> {
    let need = |ok: bool, what: &str| {
        if ok {
            Ok(())
        } else {
            Err(format!("{key} must be {what}"))
        }
    };
    match key {
        "power.onWaitSeconds" => Some(need(
            n.is_some_and(|v| (10.0..=1800.0).contains(&v)),
            "10 to 1800 seconds",
        )),
        "wasteboard.depthLimitMm" => Some(need(
            n.is_some_and(|v| (0.0..=50.0).contains(&v)),
            "0 to 50 mm",
        )),
        "registration.capBelowSurfaceMm" => Some(need(
            n.is_some_and(|v| (0.1..=1.0).contains(&v)),
            "0.1 to 1 mm",
        )),
        "registration.coarseStepMm" => Some(need(
            n.is_some_and(|v| (0.1..=10.0).contains(&v)),
            "0.1 to 10 mm",
        )),
        "registration.fineStepMm" => Some(need(
            n.is_some_and(|v| (0.05..=5.0).contains(&v)),
            "0.05 to 5 mm",
        )),
        "registration.parkAboveSurfaceMm" => Some(need(
            n.is_some_and(|v| (2.0..=30.0).contains(&v)),
            "2 to 30 mm",
        )),
        "registration.scanInsideMm" => Some(need(
            n.is_some_and(|v| (0.5..=30.0).contains(&v)),
            "0.5 to 30 mm",
        )),
        "registration.scanReachMm" => Some(need(
            n.is_some_and(|v| (0.5..=50.0).contains(&v)),
            "0.5 to 50 mm",
        )),
        "registration.surfaceTouchCount" => Some(need(
            n.is_some_and(|v| (5.0..=9.0).contains(&v) && v.fract() == 0.0),
            "a whole number of touches, 5 to 9",
        )),
        "registration.cornerClearanceMm" => Some(need(
            n.is_some_and(|v| (0.0..=30.0).contains(&v)),
            "0 to 30 mm",
        )),
        "registration.surfaceBandMm" => Some(need(
            n.is_some_and(|v| (0.01..=1.0).contains(&v)),
            "0.01 to 1 mm",
        )),
        "registration.tipRadiusUncertaintyMm" => Some(need(
            n.is_some_and(|v| (0.0..=2.0).contains(&v)),
            "0 to 2 mm",
        )),
        // #436 — rest machining. A band wider than any cutter is not a band; a third-cutter
        // threshold is a share, so it never reaches the whole job.
        "rest.overlapMm" => Some(need(
            n.is_some_and(|v| (0.0..=20.0).contains(&v)),
            "0 to 20 mm",
        )),
        "rest.thirdToolPct" => Some(need(
            n.is_some_and(|v| (0.1..=50.0).contains(&v)),
            "0.1 to 50 percent",
        )),
        // #250 — an allowance wider than a millimetre is a second roughing cut, not a finish
        // allowance; zero is allowed and turns the split off.
        "finish.stockToLeaveMm" => Some(need(
            n.is_some_and(|v| (0.0..=1.0).contains(&v)),
            "0 to 1 mm",
        )),
        // #218 — the same rules `defaultsClient.ts` restates for the three tab numbers.
        "tabs.count" => Some(need(
            n.is_some_and(|v| (0.0..=64.0).contains(&v) && v.fract() == 0.0),
            "a whole number of tabs from 0 to 64",
        )),
        "tabs.widthMm" => Some(need(
            n.is_some_and(|v| (0.1..=50.0).contains(&v)),
            "0.1 to 50 mm",
        )),
        "tabs.heightMm" => Some(need(
            n.is_some_and(|v| (0.1..=20.0).contains(&v)),
            "0.1 to 20 mm",
        )),
        "registration.tipDiameterMm" => Some(need(
            n.is_some_and(|v| (0.2..=10.0).contains(&v)),
            "0.2 to 10 mm",
        )),
        "registration.tipRadiusMm" => Some(need(
            n.is_some_and(|v| (0.0..=3.0).contains(&v)),
            "0 to 3 mm",
        )),
        "registration.surfaceToleranceMm" => Some(need(
            n.is_some_and(|v| (0.05..=10.0).contains(&v)),
            "0.05 to 10 mm",
        )),
        "registration.edgeMarginMm" => Some(need(
            n.is_some_and(|v| (0.01..=20.0).contains(&v)),
            "0.01 to 20 mm",
        )),
        "registration.surfaceSeekMm" => Some(need(
            n.is_some_and(|v| (1.0..=100.0).contains(&v)),
            "1 to 100 mm",
        )),
        "registration.touchFeed" => Some(need(
            n.is_some_and(|v| (10.0..=1000.0).contains(&v)),
            "10 to 1000 mm/min",
        )),
        "registration.surfaceFastFeed" => Some(need(
            n.is_some_and(|v| (10.0..=1000.0).contains(&v)),
            "10 to 1000 mm/min",
        )),
        "setups.minGripMm" => Some(need(
            n.is_some_and(|v| (0.5..=50.0).contains(&v)),
            "0.5 to 50 mm",
        )),
        "setups.remountMinutes" => Some(need(
            n.is_some_and(|v| (0.5..=120.0).contains(&v)),
            "0.5 to 120 min",
        )),
        "setups.reregisterMinutes" => Some(need(
            n.is_some_and(|v| (0.5..=120.0).contains(&v)),
            "0.5 to 120 min",
        )),
        "run.pollMs" => Some(need(
            n.is_some_and(|v| (2000.0..=60000.0).contains(&v)),
            "2000 to 60000 ms — never faster than 2 s (#386)",
        )),
        "run.noProgressMs" => Some(need(
            n.is_some_and(|v| (15000.0..=600000.0).contains(&v)),
            "15000 to 600000 ms",
        )),
        "run.missLimit" => Some(need(
            n.is_some_and(|v| (1.0..=10.0).contains(&v) && v.fract() == 0.0),
            "a whole number of polls, 1 to 10",
        )),
        // ── #449 (begin) — the probe, scan, console, stop and power timing (`defaultsClient.ts` states
        // the same bounds). The slow surface seek must out-travel the 1 mm lift before it; the console
        // wait stays above the slowest timed line; nothing polls under the 2 s floor (#386).
        "registration.surfaceSlowSeekMm" => Some(need(
            n.is_some_and(|v| (1.2..=2.0).contains(&v)),
            "1.2 to 2 mm — more than the 1 mm lift before the slow touch, and never more than 1 mm past the fast hit",
        )),
        "registration.idlePollLimit" => Some(need(
            n.is_some_and(|v| (1.0..=120.0).contains(&v) && v.fract() == 0.0),
            "a whole number of polls, 1 to 120",
        )),
        "registration.scanMissMarginMm" => Some(need(
            n.is_some_and(|v| (0.2..=3.0).contains(&v)),
            "0.2 to 3 mm",
        )),
        "registration.readingResolutionMm" => Some(need(
            n.is_some_and(|v| (0.005..=0.5).contains(&v)),
            "0.005 to 0.5 mm",
        )),
        "console.firstReplyMs" => Some(need(
            n.is_some_and(|v| (40000.0..=300000.0).contains(&v)),
            "40000 to 300000 ms — above the slowest line timed on the bench",
        )),
        "console.quietMs" => Some(need(
            n.is_some_and(|v| (200.0..=5000.0).contains(&v)),
            "200 to 5000 ms",
        )),
        "console.maxMs" => Some(need(
            n.is_some_and(|v| (40000.0..=600000.0).contains(&v)),
            "40000 to 600000 ms",
        )),
        // Stop's first `?` uses this window; a timeout there returns before `abort` is sent.
        "run.statusReplyMs" => Some(need(
            n.is_some_and(|v| (3000.0..=10000.0).contains(&v)),
            "3000 to 10000 ms",
        )),
        "stop.idlePolls" => Some(need(
            n.is_some_and(|v| (1.0..=20.0).contains(&v) && v.fract() == 0.0),
            "a whole number of polls, 1 to 20",
        )),
        "stop.idlePollMs" => Some(need(
            n.is_some_and(|v| (2000.0..=60000.0).contains(&v)),
            "2000 to 60000 ms — never faster than 2 s (#386)",
        )),
        // The app's Stop and the harness's run both read this for the `abort` reply window.
        "stop.abortReplyMs" => Some(need(
            n.is_some_and(|v| (20000.0..=300000.0).contains(&v)),
            "20000 to 300000 ms — above the ~18 s drain observed before abort answered (#303)",
        )),
        "power.probeTries" => Some(need(
            n.is_some_and(|v| (1.0..=10.0).contains(&v) && v.fract() == 0.0),
            "a whole number of tries, 1 to 10",
        )),
        // Each probe and each check sends `?`: never closer than the 2 s status floor (#386).
        "power.probeGapSeconds" => Some(need(
            n.is_some_and(|v| (2.0..=30.0).contains(&v)),
            "2 to 30 seconds — never faster than the 2 s status floor (#386)",
        )),
        "power.cyclePauseSeconds" => Some(need(
            n.is_some_and(|v| (3.0..=120.0).contains(&v)),
            "3 to 120 seconds",
        )),
        "power.pollSeconds" => Some(need(
            n.is_some_and(|v| (2.0..=60.0).contains(&v)),
            "2 to 60 seconds — never faster than the 2 s status floor (#386)",
        )),
        // The desktop machine transport's four windows, and the house service's request timeout
        // (#449, "smaller timings"). Bounds match `defaultsClient.ts`'s KNOWN_DEFAULTS exactly.
        "machine.connectTimeoutMs" => Some(need(
            n.is_some_and(|v| (500.0..=30000.0).contains(&v)),
            "500 to 30000 ms",
        )),
        "machine.discoveryWindowMs" => Some(need(
            n.is_some_and(|v| (500.0..=60000.0).contains(&v)),
            "500 to 60000 ms",
        )),
        "machine.identifyWindowMs" => Some(need(
            n.is_some_and(|v| (250.0..=30000.0).contains(&v)),
            "250 to 30000 ms",
        )),
        "machine.uploadInactivityMs" => Some(need(
            n.is_some_and(|v| (1000.0..=120000.0).contains(&v)),
            "1000 to 120000 ms",
        )),
        "house.requestTimeoutMs" => Some(need(
            n.is_some_and(|v| (250.0..=30000.0).contains(&v)),
            "250 to 30000 ms",
        )),
        // ── #449 (end)
        // ── #451 probe residuals (begin) — `defaultsClient.ts` states the same bounds. Kept out of
        // the #449 block: `benchDefaults.spec` pairs that block's arms with the #449 key list.
        "registration.probeResidualMm" => Some(need(
            n.is_some_and(|v| (0.0..=1.0).contains(&v)),
            "0 to 1 mm",
        )),
        "registration.wiredProbeZResidualMm" => Some(need(
            n.is_some_and(|v| (0.0..=0.5).contains(&v)),
            "0 to 0.5 mm",
        )),
        "registration.chuckAxisResidualMm" | "registration.viseJawResidualMm" => Some(need(
            n.is_some_and(|v| (0.0..=2.0).contains(&v)),
            "0 to 2 mm",
        )),
        // ── #451 probe residuals (end)
        "registration.surfaceSlowFeed" => Some(need(
            n.is_some_and(|v| (5.0..=500.0).contains(&v)),
            "5 to 500 mm/min",
        )),
        "bracket.originOffsetXMm" | "bracket.originOffsetYMm" => Some(need(
            n.is_some_and(|v| (-20.0..=20.0).contains(&v)),
            "-20 to 20 mm",
        )),
        "bracket.fitMm" => Some(need(
            n.is_some_and(|v| (0.01..=2.0).contains(&v)),
            "0.01 to 2 mm",
        )),
        "bracket.armLengthXMm" | "bracket.armLengthYMm" => Some(need(
            n.is_some_and(|v| (5.0..=300.0).contains(&v)),
            "5 to 300 mm",
        )),
        "bracket.armWidthMm" => Some(need(
            n.is_some_and(|v| (1.0..=50.0).contains(&v)),
            "1 to 50 mm",
        )),
        "bracket.heightMm" => Some(need(
            n.is_some_and(|v| (1.0..=80.0).contains(&v)),
            "1 to 80 mm",
        )),
        // #451 — how closely the bracket repeats; `defaultsClient.ts` states the same bound.
        "bracket.repeatMm" => Some(need(
            n.is_some_and(|v| (0.0..=2.0).contains(&v)),
            "0 to 2 mm",
        )),
        // Measured only — no seed: the machine Z of the surface the stock sits on beside the bracket.
        "bracket.seatMachineZ" => Some(need(
            n.is_some_and(|v| (-150.0..=0.0).contains(&v)),
            "-150 to 0 (machine Z)",
        )),
        "clamps.topLengthMm" => Some(need(
            n.is_some_and(|v| (5.0..=150.0).contains(&v)),
            "5 to 150 mm",
        )),
        "clamps.topWidthMm" => Some(need(
            n.is_some_and(|v| (3.0..=80.0).contains(&v)),
            "3 to 80 mm",
        )),
        "clamps.topHeightMm" => Some(need(
            n.is_some_and(|v| (1.0..=80.0).contains(&v)),
            "1 to 80 mm",
        )),
        "clamps.topReachMm" => Some(need(
            n.is_some_and(|v| (1.0..=50.0).contains(&v)),
            "1 to 50 mm",
        )),
        "clamps.topInFromCornerMm" => Some(need(
            n.is_some_and(|v| (0.0..=200.0).contains(&v)),
            "0 to 200 mm",
        )),
        "tools.wearWeight.plastic"
        | "tools.wearWeight.wood"
        | "tools.wearWeight.aluminium"
        | "tools.wearWeight.brass"
        | "tools.wearWeight.copper"
        | "tools.wearWeight.abrasive" => Some(need(
            n.is_some_and(|v| (0.1..=20.0).contains(&v)),
            "0.1 to 20",
        )),
        "drill.peckDiameters" => Some(need(
            n.is_some_and(|v| (0.1..=10.0).contains(&v)),
            "0.1 to 10 diameters",
        )),
        "drill.peckClearanceMm" => Some(need(
            n.is_some_and(|v| (0.05..=5.0).contains(&v)),
            "0.05 to 5 mm",
        )),
        "drill.pointAngleDeg" => Some(need(
            n.is_some_and(|v| (60.0..=150.0).contains(&v)),
            "60 to 150 degrees",
        )),
        "drill.plungeFeed" => Some(need(
            n.is_some_and(|v| (5.0..=2000.0).contains(&v)),
            "5 to 2000 mm/min",
        )),
        "drill.spindleRpm" => Some(need(
            n.is_some_and(|v| (1000.0..=30000.0).contains(&v)),
            "1000 to 30000 rpm",
        )),
        // ── #445 thread milling (begin)
        "thread.radialStepoverMm" => Some(need(
            n.is_some_and(|v| (0.02..=2.0).contains(&v)),
            "0.02 to 2 mm",
        )),
        "thread.entryRampMm" => Some(need(
            n.is_some_and(|v| (0.0..=5.0).contains(&v)),
            "0 to 5 mm",
        )),
        "thread.bottomClearancePitches" => Some(need(
            n.is_some_and(|v| (0.0..=5.0).contains(&v)),
            "0 to 5 pitches",
        )),
        "thread.pilotTipClearanceMm" => Some(need(
            n.is_some_and(|v| (0.0..=5.0).contains(&v)),
            "0 to 5 mm",
        )),
        "thread.feed" => Some(need(
            n.is_some_and(|v| (5.0..=1200.0).contains(&v)),
            "5 to 1200 mm/min",
        )),
        "thread.plungeFeed" => Some(need(
            n.is_some_and(|v| (5.0..=1200.0).contains(&v)),
            "5 to 1200 mm/min",
        )),
        "thread.spindleRpm" => Some(need(
            n.is_some_and(|v| (1000.0..=30000.0).contains(&v)),
            "1000 to 30000 rpm",
        )),
        "thread.chordToleranceMm" => Some(need(
            n.is_some_and(|v| (0.001..=0.1).contains(&v)),
            "0.001 to 0.1 mm",
        )),
        "engrave.newThreadDepthMm" => Some(need(
            n.is_some_and(|v| (0.05..=20.0).contains(&v)),
            "0.05 to 20 mm",
        )),
        // ── #445 thread milling (end)
        // ── #438 (begin)
        // ── #451 (begin)
        "import.dxfChordToleranceMm" => Some(need(
            n.is_some_and(|v| (0.001..=0.5).contains(&v)),
            "0.001 to 0.5 mm",
        )),
        // ── #451 (end)
        "sim.columnFlatPitchYMm" => Some(need(
            n.is_some_and(|v| (0.05..=0.5).contains(&v)),
            "0.05 to 0.5 mm",
        )),
        // ── #438 (end)
        // ── #451 sim resolutions (begin) — `defaultsClient.ts` states the same bounds.
        "sim.spindleOffProximityMm" => Some(need(
            n.is_some_and(|v| (0.05..=5.0).contains(&v)),
            "0.05 to 5 mm",
        )),
        "sim.columnPitchXMm" => Some(need(
            n.is_some_and(|v| (0.05..=0.5).contains(&v)),
            "0.05 to 0.5 mm",
        )),
        "sim.rotaryPitchDeg" => Some(need(
            n.is_some_and(|v| (0.05..=5.0).contains(&v)),
            "0.05 to 5 degrees",
        )),
        // ── #451 sim resolutions (end)
        // ── #451 sim starting values (begin) — `defaultsClient.ts` states the same bounds. The
        // playback speed is one of the transport's multipliers, not any number in a range.
        "sim.playbackSpeed" => Some(need(
            n.is_some_and(|v| [1.0, 5.0, 20.0, 100.0].contains(&v)),
            "one of 1, 5, 20 or 100",
        )),
        "sim.defaultStockLengthMm" | "sim.defaultStockWidthMm" => Some(need(
            n.is_some_and(|v| (1.0..=1000.0).contains(&v)),
            "1 to 1000 mm",
        )),
        "sim.defaultStockThicknessMm" => Some(need(
            n.is_some_and(|v| (0.1..=100.0).contains(&v)),
            "0.1 to 100 mm",
        )),
        "sim.budgetMs" => Some(need(
            n.is_some_and(|v| (5000.0..=600000.0).contains(&v)),
            "5000 to 600000 ms",
        )),
        // ── #451 sim starting values (end)
        // ── #451 new-item starting depths (begin) — `defaultsClient.ts` states the same bounds. Not
        // 0: the job's schema refuses a depth of zero or less, so a starting depth under this would
        // be an item that cannot be added.
        "engrave.newItemDepthMm" | "engrave.newDrillDepthMm" => Some(need(
            n.is_some_and(|v| (0.05..=20.0).contains(&v)),
            "0.05 to 20 mm",
        )),
        // ── #451 new-item starting depths (end)
        // ── #451 engrave findings (begin) — `defaultsClient.ts` states the same bounds. A share of
        // the item's area, so it runs to 1 (the whole item kept): zero would call every cut lost.
        "engrave.lostDetailWarnRatio" => Some(need(
            n.is_some_and(|v| (0.1..=1.0).contains(&v)),
            "0.1 to 1, the share of the item's area kept",
        )),
        // ── #451 blank band fill — a share of the band, so it runs to 1; above 0, or no line is seeded.
        "engrave.blankBandFill" => Some(need(
            n.is_some_and(|v| (0.05..=1.0).contains(&v)),
            "0.05 to 1, the share of the free band the line takes",
        )),
        // ── #451 engrave findings (end)
        // ── #432 facing — `defaultsClient.ts` states the same bounds. Above 0: a facing depth of
        // zero is the job saying it does not face, not a shop seed for how far a skim goes.
        "facing.roughMm" | "facing.unknownMm" => Some(need(
            n.is_some_and(|v| (0.05..=5.0).contains(&v)),
            "0.05 to 5 mm",
        )),
        "facing.marginMm" => Some(need(
            n.is_some_and(|v| (0.0..=2.0).contains(&v)),
            "0 to 2 mm",
        )),
        // ── #473 — the re-touch band; `defaultsClient.ts` states the same bounds. Above 0: a band
        // of zero would accept only an exact nominal removal, which a real skim never makes.
        "facing.retouchToleranceMm" => Some(need(
            n.is_some_and(|v| (0.01..=1.0).contains(&v)),
            "0.01 to 1 mm",
        )),
        // ── #421 (begin) — the run plan's phase times (`defaultsClient.ts` states the same bounds).
        "plan.homeSeconds" | "plan.toolLengthSeconds" => Some(need(
            n.is_some_and(|v| (5.0..=300.0).contains(&v)),
            "5 to 300 seconds",
        )),
        "plan.touchSeconds" | "plan.autoLevelPointSeconds" => Some(need(
            n.is_some_and(|v| (1.0..=120.0).contains(&v)),
            "1 to 120 seconds",
        )),
        "plan.fitProbeSeconds" | "plan.fitCutterSeconds" => Some(need(
            n.is_some_and(|v| (5.0..=1800.0).contains(&v)),
            "5 to 1800 seconds",
        )),
        "plan.clearanceSeconds" => Some(need(
            n.is_some_and(|v| (0.0..=300.0).contains(&v)),
            "0 to 300 seconds",
        )),
        "plan.finishSeconds" => Some(need(
            n.is_some_and(|v| (0.0..=600.0).contains(&v)),
            "0 to 600 seconds",
        )),
        "plan.autoLevelPoints" => Some(need(
            n.is_some_and(|v| v.fract() == 0.0 && (4.0..=400.0).contains(&v)),
            "a whole number of points, 4 to 400",
        )),
        "plan.autoLevelShallowMm" => Some(need(
            n.is_some_and(|v| (0.05..=10.0).contains(&v)),
            "0.05 to 10 mm",
        )),
        // ── #421 (end)
        "laser.originUncertaintyMm" => Some(need(
            n.is_some_and(|v| (0.05..=10.0).contains(&v)),
            "0.05 to 10 mm",
        )),
        "offcut.minSideMm" => Some(need(
            n.is_some_and(|v| (1.0..=1000.0).contains(&v)),
            "1 to 1000 mm",
        )),
        "adaptive.engagementFraction" => Some(need(
            n.is_some_and(|v| (0.02..=0.5).contains(&v)),
            "0.02 to 0.5 diameters",
        )),
        "adaptive.stepDownMm" => Some(need(
            n.is_some_and(|v| (0.05..=10.0).contains(&v)),
            "0.05 to 10 mm",
        )),
        "adaptive.helixDiameterFraction" => Some(need(
            n.is_some_and(|v| (0.1..=0.95).contains(&v)),
            "0.1 to 0.95 diameters",
        )),
        "adaptive.rampAngleDeg" => Some(need(
            n.is_some_and(|v| (0.5..=30.0).contains(&v)),
            "0.5 to 30 degrees",
        )),
        "adaptive.cutFeed" => Some(need(
            n.is_some_and(|v| (5.0..=1200.0).contains(&v)),
            "5 to 1200 mm/min (the Z1's cutting ceiling)",
        )),
        "adaptive.entryFeed" => Some(need(
            n.is_some_and(|v| (5.0..=1200.0).contains(&v)),
            "5 to 1200 mm/min (the Z1's cutting ceiling)",
        )),
        "adaptive.spindleRpm" => Some(need(
            n.is_some_and(|v| (1000.0..=30000.0).contains(&v)),
            "1000 to 30000 rpm",
        )),
        // ── #451 adaptive settings (begin) — `defaultsClient.ts` states the same bounds.
        "adaptive.entryClearanceMm" => Some(need(
            n.is_some_and(|v| (0.05..=5.0).contains(&v)),
            "0.05 to 5 mm",
        )),
        "adaptive.maxCells" => Some(need(
            n.is_some_and(|v| v.fract() == 0.0 && (1000.0..=100_000_000.0).contains(&v)),
            "a whole number of cells, 1000 to 100000000",
        )),
        "adaptive.residualShare" => Some(need(
            n.is_some_and(|v| (0.0..=0.5).contains(&v)),
            "0 to 0.5 of the area to clear",
        )),
        "adaptive.neckAreaMm2" => Some(need(
            n.is_some_and(|v| (0.0..=100.0).contains(&v)),
            "0 to 100 mm²",
        )),
        // ── #451 adaptive settings (end)
        "tools.runtimeWarnMinutes" => Some(need(
            n.is_some_and(|v| v > 0.0 && v <= 100_000.0),
            "above 0, up to 100000 minutes",
        )),
        // ── #447 (begin) — the house depth margins (`defaultsClient.ts` states the same bounds). From
        // 0, because the browser setting they migrate from accepted any value of 0 or more.
        "margins.boundaryMarginMm"
        | "margins.zToleranceMm"
        | "margins.minFloorMm"
        | "margins.edgeMarginMm"
        | "margins.jawClearanceMm"
        | "margins.breakthroughMm" => Some(need(
            n.is_some_and(|v| (0.0..=100.0).contains(&v)),
            "0 to 100 mm",
        )),
        "margins.measuredThicknessToleranceMm" => Some(need(
            n.is_some_and(|v| (0.0..=10.0).contains(&v)),
            "0 to 10 mm",
        )),
        // ── #447 (end)
        _ => None,
    }
}

/// What the surface tolerance must leave between itself and the park height, mm (#430 re-review).
pub const PARK_CLEARANCE_MM: f64 = 0.5;

/// The most keys the section holds, and the longest unit. Caps, so a client cannot grow the
/// document without bound (#416/#417 review).
pub const MAX_KEYS: usize = 200;
pub const MAX_UNIT: usize = 16;

/// The seed for `key`, if it has one.
pub fn seed_of(key: &str) -> Option<f64> {
    SEEDS
        .iter()
        .find(|(k, _, _)| *k == key)
        .map(|(_, v, _)| *v)
        .or_else(|| {
            UNMEASURED_SEEDS
                .iter()
                .find(|(k, ..)| *k == key)
                .map(|(_, v, ..)| *v)
        })
}

/// A WRITE's extra rule (#416/#417 review): `seeded` is the app's own word for its starting value, so
/// a client may only say it about a key that HAS a seed, with exactly the seed's value. Anything else
/// it sets is `chosen` or `measured`, dated.
pub fn validate_write(key: &str, d: &ShopDefault) -> Result<(), HouseError> {
    validate_one(key, d)?;
    let flag_seed = FLAG_SEEDS
        .iter()
        .find(|(k, ..)| *k == key)
        .map(|(_, v, _)| *v);
    let is_the_seed = match flag_seed {
        Some(seed) => d.value.as_bool() == Some(seed),
        None => seed_of(key).is_some_and(|seed| d.value.as_f64() == Some(seed)),
    };
    if d.source == DefaultSource::Seeded && !is_the_seed {
        return Err(HouseError::BadEntry(format!(
            "default {key}: only the app's own starting value is `seeded` — a value you set is `chosen` (or `measured`), with the date"
        )));
    }
    Ok(())
}

pub fn validate_one(key: &str, d: &ShopDefault) -> Result<(), HouseError> {
    let bad = |why: String| Err(HouseError::BadEntry(format!("default {key}: {why}")));
    if !valid_key(key) {
        return bad("a key is dotted lowerCamel words, like power.onWaitSeconds".into());
    }
    let n = d.value.as_f64();
    match &d.value {
        serde_json::Value::Number(_) if n.is_some_and(f64::is_finite) => {}
        serde_json::Value::Bool(_) => {}
        serde_json::Value::String(s) if s.len() <= 200 && !s.chars().any(char::is_control) => {}
        _ => return bad("a value is a finite number, true/false or a short string".into()),
    }
    if d.note
        .as_deref()
        .is_some_and(|n| n.len() > 400 || n.chars().any(char::is_control))
    {
        return bad("a note is a sentence of at most 400 characters".into());
    }
    if d.unit
        .as_deref()
        .is_some_and(|u| u.len() > MAX_UNIT || u.chars().any(char::is_control))
    {
        return bad(format!(
            "a unit is a short word ({MAX_UNIT} characters at most)"
        ));
    }
    if d.source != DefaultSource::Seeded && d.set_at.as_deref().is_none_or(|s| s.trim().is_empty())
    {
        return bad("a chosen or measured value says when it was set".into());
    }
    if is_flag(key) && !d.value.is_boolean() {
        return bad(format!("{key} must be true or false"));
    }
    if let Some(Err(why)) = known_rule(key, n) {
        return bad(why);
    }
    Ok(())
}

pub fn validate_all(map: &ShopDefaults) -> Result<(), HouseError> {
    if map.len() > MAX_KEYS {
        return Err(HouseError::BadEntry(format!(
            "the shop defaults hold {} keys; {MAX_KEYS} is the most",
            map.len()
        )));
    }
    map.iter().try_for_each(|(k, d)| validate_one(k, d))?;
    // #430 review: the surface band must be inside the touch cap, or a hit at the cap's depth could
    // read as "on the stock".
    let num = |k: &str| map.get(k).and_then(|d| d.value.as_f64());
    if let (Some(band), Some(cap)) = (
        num("registration.surfaceBandMm"),
        num("registration.capBelowSurfaceMm"),
    ) {
        if band >= cap {
            return Err(HouseError::BadEntry(format!(
                "registration.surfaceBandMm ({band}) must be less than registration.capBelowSurfaceMm ({cap})"
            )));
        }
    }
    // The surface tolerance inside the park height, less a clearance: a surface found at the top of
    // the band must still leave the park above it (#430 re-review).
    if let (Some(tol), Some(park)) = (
        num("registration.surfaceToleranceMm"),
        num("registration.parkAboveSurfaceMm"),
    ) {
        if tol >= park - PARK_CLEARANCE_MM {
            return Err(HouseError::BadEntry(format!(
                "registration.surfaceToleranceMm ({tol}) must be less than registration.parkAboveSurfaceMm ({park}) less {PARK_CLEARANCE_MM}"
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chosen(v: serde_json::Value) -> ShopDefault {
        ShopDefault {
            value: v,
            source: DefaultSource::Chosen,
            set_at: Some("2026-10-15T00:00:00.000Z".into()),
            unit: None,
            note: None,
        }
    }

    #[test]
    fn the_seeds_are_valid_and_labelled() {
        let s = seeded();
        validate_all(&s).unwrap();
        // Every chosen seed is `seeded`; the measured one says it was measured, when, and how.
        for (k, d) in &s {
            if let Some((_, _, _, at, _)) = MEASURED_SEEDS.iter().find(|(m, ..)| m == k) {
                assert_eq!(d.source, DefaultSource::Measured, "{k}");
                // The note names the day the value was taken: one seed was measured on the 15th and
                // the wired probe's Z figure on the 8th, so the day comes from the seed's own row.
                let day = &at[..10];
                assert!(
                    d.set_at.is_some() && d.note.as_deref().is_some_and(|n| n.contains(day)),
                    "{k}"
                );
            } else {
                assert_eq!(d.source, DefaultSource::Seeded, "{k}");
            }
            // #427: an unmeasured accessory size says so, in its note.
            if UNMEASURED_SEEDS.iter().any(|(u, ..)| u == k) {
                assert!(
                    d.note.as_deref().is_some_and(
                        |n| n.contains("not measured") || n.contains("not a measurement")
                    ),
                    "{k}"
                );
            }
        }
        let mut band_over_cap = s.clone();
        band_over_cap.insert(
            "registration.surfaceBandMm".into(),
            ShopDefault {
                value: serde_json::json!(0.5),
                ..s["registration.surfaceBandMm"].clone()
            },
        );
        assert!(
            validate_all(&band_over_cap).is_err(),
            "a band as deep as the cap"
        );
        let mut tol_over_park = s.clone();
        tol_over_park.insert(
            "registration.surfaceToleranceMm".into(),
            ShopDefault {
                value: serde_json::json!(2.6),
                ..s["registration.surfaceToleranceMm"].clone()
            },
        );
        assert!(
            validate_all(&tol_over_park).is_err(),
            "a tolerance that reaches the park height"
        );
        assert_eq!(s["power.onWaitSeconds"].value, serde_json::json!(180.0));
        // The bracket's seat is measured only: never seeded, bounded when set.
        assert!(!s.contains_key("bracket.seatMachineZ"));
        assert!(validate_one("bracket.seatMachineZ", &chosen(serde_json::json!(5.0))).is_err());
        validate_one("bracket.seatMachineZ", &chosen(serde_json::json!(-70.2))).unwrap();
        validate_write(
            "bracket.armWidthMm",
            &ShopDefault {
                note: None,
                ..s["bracket.armWidthMm"].clone()
            },
        )
        .unwrap();
    }

    #[test]
    fn an_unknown_key_is_kept_when_well_formed() {
        // A key this build has never heard of — the peer's, or a newer build's — is kept as long as
        // its shape is right. `rest.overlapMm` used to be the example here and is now KNOWN (#436
        // seeds it), so the example is a key no build claims, which is what the name promises.
        validate_one("shop.exampleMm", &chosen(serde_json::json!(0.5))).unwrap();
        validate_one("rest.thirdToolEnabled", &chosen(serde_json::json!(true))).unwrap();
        for (k, v) in [
            ("Rest.overlap", serde_json::json!(1)),
            ("overlap", serde_json::json!(1)),
            ("rest.overlap-mm", serde_json::json!(1)),
            ("shop.exampleMm", serde_json::json!({ "a": 1 })),
            ("shop.exampleMm", serde_json::json!([1])),
        ] {
            assert!(validate_one(k, &chosen(v)).is_err(), "{k} accepted");
        }
        let undated = ShopDefault {
            set_at: None,
            ..chosen(serde_json::json!(1))
        };
        assert!(validate_one("shop.exampleMm", &undated).is_err());
    }

    #[test]
    fn a_known_key_is_held_to_its_bounds() {
        assert!(validate_one("power.onWaitSeconds", &chosen(serde_json::json!(5))).is_err());
        assert!(validate_one("power.onWaitSeconds", &chosen(serde_json::json!("soon"))).is_err());
        assert!(validate_one("wasteboard.depthLimitMm", &chosen(serde_json::json!(-1))).is_err());
        validate_one("wasteboard.depthLimitMm", &chosen(serde_json::json!(1.2))).unwrap();
    }

    #[test]
    fn seeded_is_the_apps_word_and_the_section_is_capped() {
        let seeded = |v: serde_json::Value| ShopDefault {
            value: v,
            source: DefaultSource::Seeded,
            set_at: None,
            unit: None,
            note: None,
        };
        validate_write("power.onWaitSeconds", &seeded(serde_json::json!(180.0))).unwrap();
        assert!(
            validate_write("power.onWaitSeconds", &seeded(serde_json::json!(600))).is_err(),
            "a faked seed"
        );
        assert!(
            validate_write("bracket.seatMachineZ", &seeded(serde_json::json!(-70.2))).is_err(),
            "no seed to claim"
        );
        let long_unit = ShopDefault {
            unit: Some("millimetres-per-minute".into()),
            ..chosen(serde_json::json!(1))
        };
        assert!(validate_one("rest.overlapMm", &long_unit).is_err());
        let mut many = seeded_map();
        for i in 0..MAX_KEYS {
            many.insert(format!("x.k{i}"), chosen(serde_json::json!(1)));
        }
        assert!(validate_all(&many).is_err());
    }

    #[test]
    fn the_offer_flag_is_seeded_true_and_must_stay_a_flag() {
        let s = seeded();
        assert_eq!(s["offcut.offer"].value, serde_json::json!(true));
        assert!(validate_one("offcut.offer", &chosen(serde_json::json!(false))).is_ok());
        assert!(validate_one("offcut.offer", &chosen(serde_json::json!(1))).is_err());
        let seeded_false = ShopDefault {
            value: serde_json::json!(false),
            ..s["offcut.offer"].clone()
        };
        assert!(
            validate_write("offcut.offer", &seeded_false).is_err(),
            "a faked seed"
        );
        validate_write("offcut.offer", &s["offcut.offer"]).unwrap();
    }

    #[test]
    fn a_reset_bracket_size_comes_back_with_its_note() {
        // `reset_default` removes the key and re-adds the missing seeds: the "not measured" note returns.
        let mut map = seeded();
        map.insert("bracket.heightMm".into(), chosen(serde_json::json!(14.0)));
        map.remove("bracket.heightMm");
        assert!(add_missing_seeds(&mut map));
        let d = &map["bracket.heightMm"];
        assert_eq!(d.source, DefaultSource::Seeded);
        assert_eq!(d.value, serde_json::json!(10.0));
        assert!(d
            .note
            .as_deref()
            .is_some_and(|n| n.contains("not measured")));
    }

    fn seeded_map() -> ShopDefaults {
        seeded()
    }
}
