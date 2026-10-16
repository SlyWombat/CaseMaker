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
    // #433 — adaptive clearing for metal pockets: the engagement, step-down, helix and ramp chosen, the
    // feeds and the spindle speed placeholders. None measured, none a vendor number.
    ("adaptive.engagementFraction", 0.1, "x", "chosen, not measured: the most new material a clearing move may take per mm of travel, as a fraction of the cutter diameter"),
    ("adaptive.stepDownMm", 1.0, "mm", "chosen, not measured: the deepest level adaptive clearing cuts at once"),
    ("adaptive.helixDiameterFraction", 0.5, "x", "chosen, not measured: the helix entry's diameter as a fraction of the cutter diameter; the helix is refused where its bore does not fit"),
    ("adaptive.rampAngleDeg", 2.0, "deg", "chosen, not measured: the descent angle of the helix and ramp entries"),
    ("adaptive.cutFeed", 600.0, "mm/min", "placeholder, not measured; not a vendor number: the adaptive clearing feed until a measured row replaces it"),
    ("adaptive.entryFeed", 200.0, "mm/min", "placeholder, not measured; not a vendor number: the helix and ramp entry feed until a measured row replaces it"),
    ("adaptive.spindleRpm", 12000.0, "rpm", "placeholder, not measured; not a vendor number: the adaptive spindle speed until a measured row replaces it"),
    // ── #438 (begin) — the column engine's FLAT grid Y pitch: chosen, not measured.
    ("sim.columnFlatPitchYMm", 0.1, "mm", "chosen, not measured: the flat simulation grid's Y pitch; the oracle's band grows with the cell and the sim's memory and time with 1/pitch"),
    // ── #438 (end)
    // #431 — the laser point-to-origin's accuracy, ±1 mm, until the dot is measured.
    ("laser.originUncertaintyMm", 1.0, "mm", "chosen, not measured: how far the laser dot's origin may be from the stock's corner (the dot's size, and its offset from the spindle axis, are not measured); point-to-origin is refused for a job whose edge margin is tighter"),
    // #414 — Q3's minimum offcut, 20 x 20 mm at the stock's thickness.
    // #414 — the maintainer, 2026-10-16: runtime is weighted by the material cut. Chosen, not measured.
    ("tools.wearWeight.plastic", 1.0, "x", "chosen, not measured: a minute cutting PLA, ABS, acrylic: the baseline"),
    ("tools.wearWeight.wood", 1.0, "x", "chosen, not measured: a minute cutting softwood, hardwood, MDF: about as hard on a cutter as plastic"),
    ("tools.wearWeight.aluminium", 3.0, "x", "chosen, not measured: a minute cutting 6061, 7075: three times the wear of plastic"),
    ("tools.wearWeight.brass", 2.0, "x", "chosen, not measured: a minute cutting brass: free-cutting, twice plastic"),
    ("tools.wearWeight.copper", 3.0, "x", "chosen, not measured: a minute cutting copper: gummy, as hard on a cutter as aluminium"),
    ("offcut.minSideMm", 20.0, "mm", "chosen, not measured: an offcut is offered back to the shelf only when both its sides are at least this (Q3: only leftover stock that has some size to it)"),
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
        | "tools.wearWeight.copper" => Some(need(
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
        // ── #438 (begin)
        "sim.columnFlatPitchYMm" => Some(need(
            n.is_some_and(|v| (0.05..=0.5).contains(&v)),
            "0.05 to 0.5 mm",
        )),
        // ── #438 (end)
        "laser.originUncertaintyMm" => Some(need(
            n.is_some_and(|v| (0.05..=10.0).contains(&v)),
            "0.05 to 10 mm",
        )),
        "offcut.minSideMm" => Some(need(
            n.is_some_and(|v| (1.0..=1000.0).contains(&v)),
            "1 to 1000 mm",
        )),
        "tools.runtimeWarnMinutes" => Some(need(
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
            n.is_some_and(|v| v > 0.0 && v <= 100_000.0),
            "above 0, up to 100000 minutes",
        )),
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
            if MEASURED_SEEDS.iter().any(|(m, ..)| m == k) {
                assert_eq!(d.source, DefaultSource::Measured, "{k}");
                assert!(
                    d.set_at.is_some()
                        && d.note.as_deref().is_some_and(|n| n.contains("2026-10-15")),
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
        validate_one("rest.overlapMm", &chosen(serde_json::json!(0.5))).unwrap();
        validate_one("rest.thirdToolEnabled", &chosen(serde_json::json!(true))).unwrap();
        for (k, v) in [
            ("Rest.overlap", serde_json::json!(1)),
            ("overlap", serde_json::json!(1)),
            ("rest.overlap-mm", serde_json::json!(1)),
            ("rest.overlapMm", serde_json::json!({ "a": 1 })),
            ("rest.overlapMm", serde_json::json!([1])),
        ] {
            assert!(validate_one(k, &chosen(v)).is_err(), "{k} accepted");
        }
        let undated = ShopDefault {
            set_at: None,
            ..chosen(serde_json::json!(1))
        };
        assert!(validate_one("rest.overlapMm", &undated).is_err());
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
            validate_write("rest.overlapMm", &seeded(serde_json::json!(0.5))).is_err(),
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
