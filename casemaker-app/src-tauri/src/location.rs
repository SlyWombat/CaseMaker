// The location (#412, `docs/design/cnc-job-workflow.md` §3, decisions Q1/Q2): one physical place,
// one document — `location.json` — holding its machines and the user's own tools.
//
// WHAT MOVED IN. `house.json` held the house's two user tiers (`user:` definitions and the `inv:`
// inventory). Decision Q2 puts them inside the location, so `HouseStore` now keeps THIS document in
// memory and on disk and serves `/tools` and `/inventory` from its `tools` and `inventory` — the
// same types, the same validation, the same bytes on the wire. What is new is the machine record:
// the "my machine" file's sections (#247: the saved fixtures and the depth margins) and the
// calibration a check read back (#279), plus the machine's own identity, beside the tools.
//
// THE MIGRATION IS ONE-WAY AND LEAVES `house.json` ALONE. On open, a missing `location.json` and a
// readable, valid `house.json` become a location holding that house's tools and inventory, written
// at once. `house.json` is never deleted or renamed (the user's file, and the only copy if the
// location is ever lost); from then on `location.json` existing is the marker that the migration
// happened, and the location is the authority. A `house.json` that cannot be read is NOT migrated:
// the preserve-and-refuse rule `house.rs` has always had still holds, and the problem names it.
//
// THE MACHINE'S SECTIONS ARE STORED, NOT INTERPRETED. `fixtures`, `margins` and `calibration` are
// the client's records (`settingsStore`'s `FixturesSettings` and `MarginSettings`,
// `engine/cnc/calibration.ts`'s `MachineCalibration`), each already carrying its own `source` and
// `measuredAt`. The client is the one shape authority for them — it validates with the strict
// parsers the "my machine" import already uses — so this side checks only that each is an object
// and keeps it verbatim. A second, Rust-side copy of those shapes would be a second place to drift.
//
// PRODUCT CONSTANTS ARE NOT IN HERE (§3.2). The Z1's envelope and the vise's jaw widths live in
// code (`MACHINES.Z1`, `DEFAULT_VISE`) and a machine record names its profile by `profileId`; only
// per-unit numbers — this machine's calibration, its saved vise and sacrificial setup — are stored.
//
// THE STOCK SHELF (#413) is `stock`, its entries' rules in `stock.rs`. THE FEEDS TABLE (#450) is
// `feeds`, its rows' rules in `feeds.rs`. A FRESH location starts with the twelve placeholder rows
// (`feeds::seeded_rows`, labelled `seeded` and unmeasured) so the panel's numbers are the shop's
// own from the first run; an EMPTY table is still omitted from the document, so a location written
// before the table existed — including the shared fixture, which another workstream holds —
// round-trips byte for byte. An existing location with no rows is seeded in memory on load
// (`feeds::add_missing_seeds`, called by `house.rs`), never rewritten behind the user's back.
//
// A MACHINE'S POWER SWITCH (#416) AND WASTEBOARD (#417) are optional fields on its record, each
// with its own endpoint (`power.rs`, `wasteboard.rs`). ITS FINISHED PROGRAMS (#419 §4.5) are the
// append-only FNV hashes of the programs it has finished cleanly (`finished_programs.rs`), also with
// their own endpoint and kept across a machine PUT.
//
// WHAT IS NOT HERE YET, ON PURPOSE. Anything else is a later, additive key on this document or on a
// machine record; no placeholder shapes are stubbed for it. A document that carries one of those keys before this
// build knows it is refused by `deny_unknown_fields`, exactly as a misspelled key is (#339).

use crate::feeds::{validate_table, FeedRow};
use crate::house::{validate_tiers, HouseDoc, HouseError, InventoryItem, UserTool};
use crate::stock::{validate_shelf, StockItem};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// Magic string that says "this is a Case Maker location file".
pub const LOCATION_KIND: &str = "casemaker-location";
/// The location document's own version. NOT `HOUSE_SCHEMA_VERSION`, which is the wire contract
/// `/health` reports and the client checks; the two move independently.
pub const LOCATION_SCHEMA_VERSION: u32 = 1;
pub const LOCATION_FILE: &str = "location.json";
/// The name a location starts with. Labelled as a default in the UI rather than presented as one
/// the user chose.
pub const DEFAULT_LOCATION_NAME: &str = "My shop";

/// Where a machine was last reached on the network.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MachineAddress {
    pub host: String,
    pub port: u16,
}

// ── #510: the bed — fixtures, profiles and the active one ──────────────────────────────────────
//
// THE BED IS PART OF THE MACHINE, NOT OF A JOB. `docs/design/bed-profiles.md` §2: what surface the
// stock stands on, which accessories are on it and where, the datums measured on it, and the
// mountings the shop prefers on it. A machine keeps many named profiles and exactly one ACTIVE
// profile; a job binds to that id rather than to a copy of the numbers (#509; the job side is a
// later slice). The migration below is the first-run shape: an existing machine's `wasteboard` and
// vise become one profile named "Current bed (migrated <date>)", made active.
//
// WHY THE FIXTURE RECORDS ARE `bedFixtures` AND NOT §2's `fixtures`. `machines[].fixtures` has held
// the client's `FixturesSettings` record (`{vise?, sacrificial?}`) since #412, and that record is
// the SOURCE of the vise migration. Replacing it would delete the data being migrated and break
// every reader of the settings section, so the new list lives beside it and `fixtures` is left
// untouched — "nothing is deleted", the migration rule in the design. The key is the one place this
// build differs from §2's literal spelling.
//
// A DATUM IS NEVER TYPED. The design's rule is enforced here and in the client: a datum carries the
// value, when it was measured, and by what; `by: "typed"` is refused, as is a datum with no date.
// A profile may be saved with every datum `null`, and each consumer refuses by name until it is
// measured (as `bracket.seatMachineZ` does today).
//
// OPEN QUESTION A, DECIDED. The vise and the 4th-axis module share the locating pins, so one
// profile may not place both: validation refuses a profile that has a `vise` and a `rotary-module`
// placement (or both pin kinds), with a plain sentence rather than a silent overwrite.

/// One accessory the shop owns, as the design's *fixture record* (§1): the product's constants,
/// THIS unit's measurements, and where every number came from.
///
/// `kind` is an open string (`vise`, `bracket`, `top-clamp`, `side-clamp`, `rotary-module`,
/// `vacuum-bed`, `probe`, …): another accessory is additive and must not need a schema version.
/// `constants` and `unit` are open maps because the accessory families carry different dimensions;
/// `provenance` maps each key (`"*"` for "all of them") to a location provenance word, optionally
/// with its date or instrument (`measured:2026-10-15`, `vendor:config.anchor_length`, `default`).
/// #597 — where an accessory is: in the box, or checked out to one machine since a date. A STRUCT
/// variant for `Box`, not a unit one, so `{"kind":"box","x":1}` is refused as an unknown key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind", deny_unknown_fields)]
pub enum AccessoryWhereabouts {
    Box {},
    #[serde(rename_all = "camelCase")]
    Machine { machine_id: String, since: String },
}

impl Default for AccessoryWhereabouts {
    fn default() -> Self {
        AccessoryWhereabouts::Box {}
    }
}

/// #597 — one line of an accessory's history, the same vocabulary the cutter copies use.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccessoryHistory {
    pub at: String,
    pub what: String,
}

/// One accessory the shop owns. `constants` and `unit` are open maps because the accessory families
/// carry different dimensions; `provenance` maps each key (`"*"` for "all of them") to a location
/// provenance word, optionally with its date or instrument (`measured:2026-10-15`,
/// `vendor:config.anchor_length`, `default`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FixtureRecord {
    pub id: String,
    pub kind: String,
    /// `makera-z1-low-profile-vise`, `makera-z1-bracket`, … — null when nobody named it.
    pub product: Option<String>,
    /// `thin` / `thick` for the bracket, `wired-touch` / `3d` / `tool-setter` for a probe, null elsewhere.
    pub variant: Option<String>,
    #[serde(default)]
    pub constants: serde_json::Map<String, serde_json::Value>,
    #[serde(default)]
    pub unit: serde_json::Map<String, serde_json::Value>,
    #[serde(default)]
    pub provenance: std::collections::BTreeMap<String, String>,
    /// #597 — in the box by default; a hoisted record is checked out to its machine.
    #[serde(default)]
    pub whereabouts: AccessoryWhereabouts,
    #[serde(default)]
    pub history: Vec<AccessoryHistory>,
}

/// A datum measured ON this bed (§1). There is no "typed" constructor: `validate` refuses
/// `by: "typed"` in any case, and all four fields are required so an unmeasured datum is `null`
/// rather than a shape with a value and no provenance.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MeasuredDatum {
    pub value: f64,
    pub measured_at: String,
    /// The instrument: `wired-probe`, `calipers`, … — never `typed`.
    pub by: String,
    /// Where on the bed, in machine XY, when the measurement named a point.
    pub at: Option<[f64; 2]>,
    /// #1070 (C8) — the SEAT says it is the surface the stock rests on (the seat press touches the
    /// wasteboard the blank itself stands on): the expected surface then does not add the job's
    /// under-board again. Omitted when the datum predates the statement, and never set on the
    /// surface-top fallback.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rests_on_stock: Option<bool>,
}

/// #1059 — A DATUM MEASURED IN DEGREES, not millimetres: the A work zero of a square stock's OWN
/// face, as the face-angle step left it. Its own struct rather than {@link MeasuredDatum} so no
/// reader can take its `value` for a machine Z; `at` is the touch column (machine X and the axis
/// line's Y) and `residual_mm` is the last touch pair's |Z+ − Z−|.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MeasuredAngleDatum {
    /// The signed total A turn the step made, degrees.
    pub value: f64,
    pub measured_at: String,
    /// The instrument: `wired-probe`, `fx-probe-3d`, … — never `typed`.
    pub by: String,
    /// The touch column, machine XY, when the measurement named one.
    pub at: Option<[f64; 2]>,
    /// How level the last pair read, mm. Absent on a reading that did not record one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub residual_mm: Option<f64>,
}

/// The five datums a profile describes; each is `null` until measured (open question E's bare bed
/// carries only `surfaceTopZ` when someone measures it). `rotaryFaceAngle` is `null` on every
/// profile whose square stock has never been levelled in the 4th axis (#1059).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BedDatums {
    pub surface_top_z: Option<MeasuredDatum>,
    pub vise_jaw_top_z: Option<MeasuredDatum>,
    pub bracket_seat_z: Option<MeasuredDatum>,
    pub rotary_axis: Option<MeasuredDatum>,
    #[serde(default)]
    pub rotary_face_angle: Option<MeasuredAngleDatum>,
}

/// What the stock or the fixtures stand on (§1, open question E).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SurfaceKind {
    BareBed,
    Wasteboard,
    FixturePlate,
    VacuumBed,
}

/// The wasteboard's front-left corner in machine XY, with its frame stated so it cannot be read as
/// work coordinates (the work origin moves with every job).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BedPosition {
    pub front_left: [f64; 2],
    /// Only `machine` today; stated rather than implied, because a work-frame position would move
    /// with G54 and describe a different place tomorrow.
    pub frame: String,
}

/// The surface record of one profile. The #417 wasteboard's thickness, scars and dates move here
/// whole; the dimensions and position are the design's additions and are absent until known.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BedSurface {
    pub kind: SurfaceKind,
    pub material: Option<String>,
    pub length: Option<f64>,
    pub width: Option<f64>,
    pub thickness: Option<f64>,
    pub position: Option<BedPosition>,
    #[serde(default)]
    pub provenance: std::collections::BTreeMap<String, String>,
    /// Through-cut rectangles the board carries, machine XY — the same `Scar` #417 defines, so a
    /// migrated board's scars keep one shape.
    #[serde(default)]
    pub scars: Vec<crate::wasteboard::Scar>,
    pub last_resurfaced_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PlacementKind {
    Pins,
    Anchor,
    Free,
}

/// The shared locating pins: the vise and the 4th-axis module are mutually exclusive (open
/// question A, decided 2026-10-18).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LocatingPins {
    Vise,
    Rotary,
}

/// How a placement holds its fixture: on the pins, at one of the bracket's two anchors, or merely
/// standing on the bed (the clamps).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlacementWhere {
    pub kind: PlacementKind,
    pub pins: Option<LocatingPins>,
    /// 1 or 2 — the bracket's two anchors. Null for the other kinds.
    pub anchor: Option<u8>,
}

/// Machine XY of a placement's locating feature: the fixed jaw face and where the bar starts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlacementFrame {
    pub fixed_jaw_face_x: Option<f64>,
    pub jaw_start_y: Option<f64>,
}

/// #1070 (C8) — a PLACED bracket's inside corner, as the bed profile states it. A fact of the
/// bench: `by: "grid"` when the bed's hole pattern admits exactly one position and the bracket
/// was found on it, `by: "touch"` when it was measured and confirmed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BracketSeed {
    pub x: f64,
    pub y: f64,
    pub by: BracketSeedBy,
    pub measured_at: String,
    pub at: Option<[f64; 2]>,
    pub probe: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BracketSeedBy {
    Grid,
    Touch,
}

/// One fixture PUT ON the bed (§1). It adds position and orientation only; the drawn shape is the
/// fixture record's.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BedPlacement {
    pub id: String,
    /// A `FixtureRecord.id` on the same machine.
    pub fixture: String,
    #[serde(rename = "where")]
    pub place: PlacementWhere,
    /// Two top clamps are one placement with `count: 2`.
    pub count: Option<u32>,
    pub frame: Option<PlacementFrame>,
    /// #1070 (C8) — the placed bracket's stated position; absent until measured, and absent on
    /// every other fixture's placement.
    #[serde(default)]
    pub seed: Option<BracketSeed>,
    #[serde(default)]
    pub provenance: std::collections::BTreeMap<String, String>,
}

/// How a stock class is held (§1): a placement, or none when the manner needs no fixture (tape on
/// the surface).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MountingChoice {
    pub placement: Option<String>,
    pub manner: MountingManner,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MountingManner {
    Jaws,
    /// The design's spelling is `corner+clamps`; the plus is part of the word.
    #[serde(rename = "corner+clamps")]
    CornerClamps,
    Tape,
    Vacuum,
    Chuck,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreferredMounting {
    /// The design's stock-class expression (`sheet<=3mm`, `plate|block`, …), kept as the shop
    /// wrote it.
    pub stock: String,
    pub mount: MountingChoice,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConsumableTape {
    pub width_mm: f64,
    pub thickness_mm: f64,
    pub provenance: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConsumableBoard {
    pub material: String,
    /// `[length, width, thickness]`, mm.
    pub size: [f64; 3],
    pub count: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Consumables {
    pub tape: Option<ConsumableTape>,
    #[serde(default)]
    pub boards: Vec<ConsumableBoard>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileHistoryEntry {
    pub at: String,
    pub what: String,
}

/// One named description of the machine's bed (§2).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BedProfile {
    pub id: String,
    pub name: String,
    pub created_at: String,
    /// The shipped profile it started from (`default:z1-vise`), or null.
    pub based_on: Option<String>,
    pub surface: BedSurface,
    pub datums: BedDatums,
    #[serde(default)]
    pub placements: Vec<BedPlacement>,
    #[serde(default)]
    pub preferred_mounting: Vec<PreferredMounting>,
    pub consumables: Option<Consumables>,
    #[serde(default)]
    pub history: Vec<ProfileHistoryEntry>,
}

fn finite_positive(v: f64) -> bool {
    v.is_finite() && v > 0.0
}

impl FixtureRecord {
    pub(crate) fn validate(&self, machine: &str) -> Result<(), HouseError> {
        validate_id(&self.id, "fixture")?;
        if self.kind.trim().is_empty() {
            return Err(HouseError::BadEntry(format!(
                "machine {machine}'s fixture {} does not say what kind it is",
                self.id
            )));
        }
        if let Some(product) = &self.product {
            if product.trim().is_empty() {
                return Err(HouseError::BadEntry(format!(
                    "machine {machine}'s fixture {} names an empty product",
                    self.id
                )));
            }
        }
        if let Some(variant) = &self.variant {
            if variant.trim().is_empty() {
                return Err(HouseError::BadEntry(format!(
                    "machine {machine}'s fixture {} names an empty variant",
                    self.id
                )));
            }
        }
        // Numbers in the open maps are dimensions or counts: refuse a non-finite one so a bad
        // record cannot reach a consumer as NaN. `serde_json` cannot hold NaN, but a future writer
        // could hand us a float that overflowed; the check is cheap and states the rule.
        for (what, map) in [("constants", &self.constants), ("unit", &self.unit)] {
            for (key, value) in map {
                if key.trim().is_empty() {
                    return Err(HouseError::BadEntry(format!(
                        "machine {machine}'s fixture {} has a {what} key with no name",
                        self.id
                    )));
                }
                if let Some(n) = value.as_f64() {
                    if !n.is_finite() {
                        return Err(HouseError::BadEntry(format!(
                            "machine {machine}'s fixture {} has a non-finite {what}.{key}",
                            self.id
                        )));
                    }
                }
            }
        }
        validate_provenance(machine, "fixture", &self.id, &self.provenance)
    }
}

impl MeasuredDatum {
    fn validate(&self, machine: &str, profile: &str, what: &str) -> Result<(), HouseError> {
        if !self.value.is_finite() {
            return Err(HouseError::BadEntry(format!(
                "machine {machine}'s bed profile {profile}: {what} is not a number"
            )));
        }
        if self.measured_at.trim().is_empty() {
            return Err(HouseError::BadEntry(format!(
                "machine {machine}'s bed profile {profile}: {what} does not say when it was measured"
            )));
        }
        let by = self.by.trim();
        if by.is_empty() || by.eq_ignore_ascii_case("typed") {
            return Err(HouseError::BadEntry(format!(
                "machine {machine}'s bed profile {profile}: {what} must be measured, never typed"
            )));
        }
        if let Some(at) = self.at {
            if !at.iter().all(|v| v.is_finite()) {
                return Err(HouseError::BadEntry(format!(
                    "machine {machine}'s bed profile {profile}: {what} names a point that is not a number"
                )));
            }
        }
        Ok(())
    }
}

impl MeasuredAngleDatum {
    fn validate(&self, machine: &str, profile: &str, what: &str) -> Result<(), HouseError> {
        if !self.value.is_finite() {
            return Err(HouseError::BadEntry(format!(
                "machine {machine}'s bed profile {profile}: {what} is not a number"
            )));
        }
        if self.measured_at.trim().is_empty() {
            return Err(HouseError::BadEntry(format!(
                "machine {machine}'s bed profile {profile}: {what} does not say when it was measured"
            )));
        }
        let by = self.by.trim();
        if by.is_empty() || by.eq_ignore_ascii_case("typed") {
            return Err(HouseError::BadEntry(format!(
                "machine {machine}'s bed profile {profile}: {what} must be measured, never typed"
            )));
        }
        if let Some(at) = self.at {
            if !at.iter().all(|v| v.is_finite()) {
                return Err(HouseError::BadEntry(format!(
                    "machine {machine}'s bed profile {profile}: {what} names a point that is not a number"
                )));
            }
        }
        if self.residual_mm.is_some_and(|v| !v.is_finite()) {
            return Err(HouseError::BadEntry(format!(
                "machine {machine}'s bed profile {profile}: {what} carries a residual that is not a number"
            )));
        }
        Ok(())
    }
}

impl BedDatums {
    fn validate(&self, machine: &str, profile: &str) -> Result<(), HouseError> {
        for (what, datum) in [
            ("surfaceTopZ", &self.surface_top_z),
            ("viseJawTopZ", &self.vise_jaw_top_z),
            ("bracketSeatZ", &self.bracket_seat_z),
            ("rotaryAxis", &self.rotary_axis),
        ] {
            if let Some(d) = datum {
                d.validate(machine, profile, what)?;
            }
        }
        if let Some(d) = &self.rotary_face_angle {
            d.validate(machine, profile, "rotaryFaceAngle")?;
        }
        Ok(())
    }
}

impl BedSurface {
    fn validate(&self, machine: &str, profile: &str) -> Result<(), HouseError> {
        let bad = |why: &str| {
            Err(HouseError::BadEntry(format!(
                "machine {machine}'s bed profile {profile}: the surface {why}"
            )))
        };
        for (what, v) in [("length", self.length), ("width", self.width), ("thickness", self.thickness)] {
            if v.is_some_and(|n| !finite_positive(n)) {
                return bad(&format!("has a {what} that is not a positive number of mm"));
            }
        }
        if self.material.as_ref().is_some_and(|m| m.trim().is_empty()) {
            return bad("names an empty material");
        }
        if self
            .last_resurfaced_at
            .as_ref()
            .is_some_and(|d| d.trim().is_empty())
        {
            return bad("has an empty resurfacing date");
        }
        if let Some(pos) = &self.position {
            if pos.frame != "machine" {
                return bad(&format!("is positioned in {:?}, not machine XY", pos.frame));
            }
            if !pos.front_left.iter().all(|v| v.is_finite()) {
                return bad("has a front-left corner that is not a number");
            }
        }
        crate::wasteboard::validate_scars(&self.scars, "the bed surface")?;
        match self.kind {
            SurfaceKind::BareBed => {
                if self.material.is_some()
                    || self.length.is_some()
                    || self.width.is_some()
                    || self.thickness.is_some()
                    || self.position.is_some()
                    || self.last_resurfaced_at.is_some()
                    || !self.scars.is_empty()
                {
                    return bad("is the bare bed: it has no size, position, scars or resurfacing (open question E)");
                }
            }
            SurfaceKind::Wasteboard => {
                if self.thickness.is_none() {
                    return bad("is a wasteboard but does not say how thick it is");
                }
            }
            SurfaceKind::FixturePlate | SurfaceKind::VacuumBed => {}
        }
        validate_provenance(machine, "bed profile", profile, &self.provenance)
    }

    /// #509 — THE SCARS MUST LIE ON THE BOARD. A scar outside the surface's own footprint was
    /// recorded against a different board (or one whose stated size has since changed), and a cut
    /// planned against it would be watched in the wrong place.
    ///
    /// THIS IS A WRITE RULE, NOT A READ RULE. `validate` (which runs when the document is LOADED as
    /// well as written) deliberately does not call it: a location saved before this rule existed —
    /// with a board that states a size and a stray scar — keeps loading, so the rule can never lock
    /// a shop out of its own house. `MachineRecord::validate_bed_footprints` runs it on the write
    /// path, where a new scar can be answered with a sentence instead.
    ///
    /// A surface that states no footprint (`length`/`width`/`position` absent — the migrated #417
    /// board has only a thickness) has nothing to hold a scar to, and passes.
    fn validate_scar_footprints(&self, machine: &str, profile: &str) -> Result<(), HouseError> {
        let (Some(length), Some(width), Some(position)) = (self.length, self.width, self.position.as_ref()) else {
            return Ok(());
        };
        let [x0, y0] = position.front_left;
        let (x1, y1) = (x0 + length, y0 + width);
        // A millimetre alone is 1e-6 of a micron; a scar exactly on the edge is ON the board.
        const EPS: f64 = 1e-6;
        for scar in &self.scars {
            let inside = scar.x >= x0 - EPS
                && scar.y >= y0 - EPS
                && scar.x + scar.width <= x1 + EPS
                && scar.y + scar.height <= y1 + EPS;
            if !inside {
                return Err(HouseError::BadEntry(format!(
                    "machine {machine}'s bed profile {profile}: the surface has a scar at ({}, {}) outside its {} × {} mm footprint — resurface the board, or correct the board\'s size and position",
                    scar.x, scar.y, length, width
                )));
            }
        }
        Ok(())
    }
}

impl BedProfile {
    fn validate_scar_footprints(&self, machine: &str) -> Result<(), HouseError> {
        self.surface.validate_scar_footprints(machine, &self.id)
    }
}

impl PlacementWhere {
    fn validate(&self, machine: &str, profile: &str, placement: &str) -> Result<(), HouseError> {
        let bad = |why: String| {
            Err(HouseError::BadEntry(format!(
                "machine {machine}'s bed profile {profile}, placement {placement}: {why}"
            )))
        };
        match self.kind {
            PlacementKind::Pins => {
                if self.pins.is_none() {
                    return bad("is on the pins but does not say which fixture's pins".into());
                }
                if self.anchor.is_some() {
                    return bad("is on the pins and also names an anchor".into());
                }
            }
            PlacementKind::Anchor => {
                if self.pins.is_some() {
                    return bad("is at an anchor and also names the pins".into());
                }
                if !matches!(self.anchor, Some(1 | 2)) {
                    return bad("is at an anchor that is not 1 or 2".into());
                }
            }
            PlacementKind::Free => {
                if self.pins.is_some() || self.anchor.is_some() {
                    return bad("stands free but names pins or an anchor".into());
                }
            }
        }
        Ok(())
    }
}

impl BedProfile {
    fn validate(
        &self,
        machine: &str,
        fixtures: Option<&[FixtureRecord]>,
    ) -> Result<(), HouseError> {
        validate_id(&self.id, "bed profile")?;
        let bad = |why: String| {
            Err(HouseError::BadEntry(format!(
                "machine {machine}'s bed profile {}: {why}",
                self.id
            )))
        };
        if self.name.trim().is_empty() {
            return bad("has no name".into());
        }
        if self.created_at.trim().is_empty() {
            return bad("does not say when it was created".into());
        }
        self.surface.validate(machine, &self.id)?;
        self.datums.validate(machine, &self.id)?;

        let mut placement_ids = HashSet::new();
        let mut placed_kinds: Vec<&str> = Vec::new();
        let mut pin_kinds = HashSet::new();
        for p in &self.placements {
            validate_id(&p.id, "placement")?;
            if !placement_ids.insert(p.id.as_str()) {
                return bad(format!("has two placements called {}", p.id));
            }
            p.place.validate(machine, &self.id, &p.id)?;
            // #597 — the accessories are the house's; the machine-level validate passes `None` and
            // `LocationDoc::validate` checks the placements against the location's `accessories`.
            if let Some(list) = fixtures {
                let Some(fixture) = list.iter().find(|f| f.id == p.fixture) else {
                    return bad(format!(
                        "places fixture {} which this machine does not own",
                        p.fixture
                    ));
                };
                placed_kinds.push(fixture.kind.as_str());
            }
            if let Some(pins) = p.place.pins {
                pin_kinds.insert(pins);
            }
            if p.count == Some(0) {
                return bad(format!("places {} zero times", p.fixture));
            }
            if let Some(frame) = &p.frame {
                for (what, v) in [
                    ("fixedJawFaceX", frame.fixed_jaw_face_x),
                    ("jawStartY", frame.jaw_start_y),
                ] {
                    if v.is_some_and(|n| !n.is_finite()) {
                        return bad(format!("has a frame {what} that is not a number"));
                    }
                }
            }
        }
        // Open question A, decided 2026-10-18: the vise and the 4th-axis module share the pins and
        // one of them is on the bed at a time. Refuse both, whether the conflict is in the fixture
        // kinds or directly in the pin labels.
        if placed_kinds.contains(&"vise") && placed_kinds.contains(&"rotary-module") {
            return bad("places the vise and the 4th-axis module: they share the pins, so one at a time".into());
        }
        if pin_kinds.contains(&LocatingPins::Vise) && pin_kinds.contains(&LocatingPins::Rotary) {
            return bad("places the vise and the 4th-axis module on the pins: they are mutually exclusive".into());
        }

        let mut stocks = HashSet::new();
        for m in &self.preferred_mounting {
            if m.stock.trim().is_empty() {
                return bad("has a preferred mounting with no stock class".into());
            }
            if !stocks.insert(m.stock.as_str()) {
                return bad(format!("prefers two mountings for {}", m.stock));
            }
            if let Some(placement) = &m.mount.placement {
                if !placement_ids.contains(placement.as_str()) {
                    return bad(format!(
                        "prefers placement {placement}, which this profile does not have"
                    ));
                }
            }
        }

        if let Some(c) = &self.consumables {
            if let Some(tape) = &c.tape {
                if !finite_positive(tape.width_mm) || !finite_positive(tape.thickness_mm) {
                    return bad("records tape with a width or thickness that is not a positive number".into());
                }
                if tape.provenance.trim().is_empty() {
                    return bad("records tape with no provenance".into());
                }
            }
            for b in &c.boards {
                if b.material.trim().is_empty() {
                    return bad("records a board with no material".into());
                }
                if !b.size.iter().all(|v| finite_positive(*v)) {
                    return bad("records a board whose size is not three positive numbers".into());
                }
            }
        }

        for h in &self.history {
            if h.at.trim().is_empty() || h.what.trim().is_empty() {
                return bad("has a history entry with no date or no description".into());
            }
        }
        Ok(())
    }
}

fn validate_provenance(
    machine: &str,
    what: &str,
    id: &str,
    map: &std::collections::BTreeMap<String, String>,
) -> Result<(), HouseError> {
    for (key, value) in map {
        if key.trim().is_empty() || value.trim().is_empty() {
            return Err(HouseError::BadEntry(format!(
                "machine {machine}'s {what} {id} has a provenance entry with no key or no source"
            )));
        }
    }
    Ok(())
}

/// #1179 — the work offset an origin write left in the controller (the B2 cross-check).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FinishedRunG54 {
    #[serde(default)]
    pub x: Option<f64>,
    #[serde(default)]
    pub y: Option<f64>,
    #[serde(default)]
    pub z: Option<f64>,
}

/// #1179 — the registration a finished program ran under. `surfaceMachineZ` is the ACCEPTED top
/// (measured or derived); `measuredTopMachineZ` is the MEASURED reading only, absent on the derived
/// path — the thickness note reads that one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FinishedRunRegistration {
    #[serde(default)]
    pub surface_machine_z: Option<f64>,
    #[serde(default)]
    pub g54: Option<FinishedRunG54>,
    #[serde(default)]
    pub top_source: Option<String>,
    #[serde(default)]
    pub measured_top_machine_z: Option<f64>,
    #[serde(default)]
    pub implied_thickness_mm: Option<f64>,
    #[serde(default)]
    pub measured_at: Option<String>,
    #[serde(default)]
    pub plan_expected_top_machine_z: Option<f64>,
}

/// #1179 — one RLE stream of a cut map (counts over the grid, row-major).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CutMapStream {
    pub encoding: String,
    pub data: String,
}

/// #1179 — the per-program cut map: a 2 mm raster in the stock frame with, per cell, the deepest
/// quantised Z cut and whether the floor is flat. Two RLE streams (`flat`, `depth`), each capped.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FinishedCutMap {
    pub cell_mm: f64,
    pub cols: u32,
    pub rows: u32,
    pub x0_mm: f64,
    pub y0_mm: f64,
    pub step_mm: f64,
    pub flat: CutMapStream,
    pub depth: CutMapStream,
}

/// #1179 — the cut map of ONE setup/face (the analyst's ruling, issue comment 6775024844): side 1
/// and side 2 never merge, `complete` carries the map, and `unknown` carries the reason a merge
/// could not finish (both enforced by `finished_programs::validate_runs`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FinishedSetupCutMap {
    pub setup_index: u32,
    pub state: String,
    #[serde(default)]
    pub unknown_reason: Option<String>,
    #[serde(default)]
    pub map: Option<FinishedCutMap>,
}

/// #1179 — the stock dims the mask is placed on. `thicknessMm` is the JOB'S STATED thickness.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FinishedRunStock {
    #[serde(default)]
    pub length_mm: Option<f64>,
    #[serde(default)]
    pub width_mm: Option<f64>,
    #[serde(default)]
    pub thickness_mm: Option<f64>,
}

/// #1179 — WHAT a finished program cut, beside the hash list. Additive: every field but `hash` is
/// optional and defaulted, so a partial record is still true and an older document has no key.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FinishedRun {
    pub hash: String,
    #[serde(default)]
    pub job_id: Option<String>,
    #[serde(default)]
    pub job_name: Option<String>,
    #[serde(default)]
    pub package_key: Option<String>,
    #[serde(default)]
    pub key8: Option<String>,
    #[serde(default)]
    pub program_index: Option<u32>,
    #[serde(default)]
    pub program_count: Option<u32>,
    #[serde(default)]
    pub program_name: Option<String>,
    #[serde(default)]
    pub cutter_key: Option<String>,
    #[serde(default)]
    pub setup_index: Option<u32>,
    #[serde(default)]
    pub finished_at: Option<String>,
    #[serde(default)]
    pub stock: Option<FinishedRunStock>,
    #[serde(default)]
    pub registration: Option<FinishedRunRegistration>,
    /// #1179 — one entry per setup/face; the newest record carries the blank's whole state. A list
    /// rather than an option so an older document (no key) and a run with no maps both read as [].
    #[serde(default)]
    pub cut_maps: Vec<FinishedSetupCutMap>,
}

/// One physical machine at the location (§3.1).
///
/// Every optional field is serialized as `null` rather than omitted, the same rule `Tool` follows:
/// the client's schema reads `null` as "not stated", and an absent key is not the same claim. The
/// EXCEPTIONS are the additive sections that must not appear on an older document — the finished
/// programs (#419) and the bed (#510) — which are omitted while absent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MachineRecord {
    /// Ours, minted by the client. Unique within the location; also the URL segment a write names.
    pub id: String,
    /// The `MACHINES` id its identity resolved to (`Z1`), or null for a machine nobody resolved.
    #[serde(default)]
    pub profile_id: Option<String>,
    /// The name it broadcast (`Makera_Z1_010290`), or null for a typed address.
    #[serde(default)]
    pub name: Option<String>,
    /// #596 — the friendly name a person gives the machine ("Zoomba"), set on the machine card
    /// (#602). `name` stays the broadcast name, which observation matching uses, so the two are
    /// never the same claim. Null until the person names it.
    #[serde(default)]
    pub nickname: Option<String>,
    /// Null until something reads it from the machine (`M482.5`). Never typed in or guessed.
    #[serde(default)]
    pub serial: Option<String>,
    /// Null until something reads it from the machine. Never typed in or guessed.
    #[serde(default)]
    pub firmware: Option<String>,
    #[serde(default)]
    pub address: Option<MachineAddress>,
    /// `MachineCalibration` (#279), as the client sent it.
    #[serde(default)]
    pub calibration: Option<serde_json::Value>,
    /// `FixturesSettings` (#203, #213) — the saved vise and sacrificial setup — as the client sent it.
    #[serde(default)]
    pub fixtures: Option<serde_json::Value>,
    /// The machine's bed profiles (#510), named and dated. `None` is "the bed has not been
    /// described yet" — what the first migration and the wizard (#512) act on; `Some(vec![])` is a
    /// description that was deliberately emptied, so the migration does not run again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bed_profiles: Option<Vec<BedProfile>>,
    /// The one active profile. Present exactly when `bed_profiles` has at least one entry.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_bed_profile_id: Option<String>,
    /// `MarginSettings` (#345), as the client sent it.
    #[serde(default)]
    pub margins: Option<serde_json::Value>,
    /// #1123-40 — the registrations this machine holds, one per job setup, as the client sent it:
    /// the record a registration measured, keyed by job and setup, carrying the G54 X/Y its origin
    /// write left in the controller. The client restores one only while the controller's live G54
    /// X/Y still matches, and drops an unreadable entry rather than failing the machine. Omitted
    /// while absent, so a record written before the section round-trips without it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub registrations: Option<serde_json::Value>,
    /// An optional controllable power switch (#416). None is the default and the common case. Written
    /// only through `/api/v1/power/:id`; a machine PUT keeps whatever is stored (`put_machine`).
    #[serde(default)]
    pub power: Option<crate::power::PowerSwitch>,
    /// The machine's own wasteboard as a tracked sacrificial board (#417). Written only through
    /// `/api/v1/wasteboard/:id`, and kept across a machine PUT the same way.
    #[serde(default)]
    pub wasteboard: Option<crate::wasteboard::Wasteboard>,
    /// The FNV program hashes this machine has FINISHED cleanly (#419 §4.5, Q14) — the air-run
    /// "already run" list. Written only through `/api/v1/finished-programs/:id` and kept across a
    /// machine PUT the same way power and the wasteboard are. An EMPTY list is OMITTED, so a record
    /// written before this section existed round-trips without gaining a key (the shared fixture).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub finished_programs: Vec<String>,
    /// #1179 — WHAT each finished program cut (the hash list above is unchanged). Same append
    /// endpoint, same cap; an older document has no key and parses to an empty list.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub finished_runs: Vec<FinishedRun>,
    /// ISO timestamp, the client's clock: when this record was last written.
    pub updated_at: String,
}

impl MachineRecord {
    pub(crate) fn validate(&self) -> Result<(), HouseError> {
        validate_id(&self.id, "machine")?;
        if self.updated_at.trim().is_empty() {
            return Err(HouseError::BadEntry(format!(
                "machine {} does not say when it was recorded",
                self.id
            )));
        }
        if let Some(a) = &self.address {
            if a.host.trim().is_empty() || a.port == 0 {
                return Err(HouseError::BadEntry(format!(
                    "machine {} has an address with no host or no port",
                    self.id
                )));
            }
        }
        if let Some(p) = &self.power {
            p.validate()?;
        }
        if let Some(w) = &self.wasteboard {
            w.validate()?;
        }
        crate::finished_programs::validate_list(&self.id, &self.finished_programs)?;
        crate::finished_programs::validate_runs(&self.id, &self.finished_runs)?;
        if let Some(profiles) = &self.bed_profiles {
            let mut ids = HashSet::new();
            for p in profiles {
                // #597 — the accessories are the house's; the placement check runs at the location level.
                p.validate(&self.id, None)?;
                if !ids.insert(p.id.as_str()) {
                    return Err(HouseError::BadEntry(format!(
                        "machine {} has two bed profiles called {}",
                        self.id, p.id
                    )));
                }
            }
        }
        match (&self.bed_profiles, &self.active_bed_profile_id) {
            (None, Some(id)) => {
                return Err(HouseError::BadEntry(format!(
                    "machine {} names {id} as its active bed profile but has no profiles",
                    self.id
                )));
            }
            (Some(profiles), Some(id)) => {
                if !profiles.iter().any(|p| &p.id == id) {
                    return Err(HouseError::BadEntry(format!(
                        "machine {} names {id} as its active bed profile, which it does not have",
                        self.id
                    )));
                }
            }
            (Some(profiles), None) if !profiles.is_empty() => {
                return Err(HouseError::BadEntry(format!(
                    "machine {} has bed profiles but names no active one",
                    self.id
                )));
            }
            _ => {}
        }
        for (what, section) in [
            ("calibration", &self.calibration),
            ("fixtures", &self.fixtures),
            ("margins", &self.margins),
        ] {
            if let Some(v) = section {
                if !v.is_object() {
                    return Err(HouseError::BadEntry(format!(
                        "machine {}'s {what} is not a record",
                        self.id
                    )));
                }
            }
        }
        Ok(())
    }

    /// #509 — the write-time half of the bed's validation: every scar must lie on its board.
    /// Separate from `validate` ON PURPOSE — that one runs when the document is LOADED too, and a
    /// location saved before this rule existed must keep loading (see
    /// `BedSurface::validate_scar_footprints`). `HouseStore::put_machine` is the caller.
    pub(crate) fn validate_bed_footprints(&self) -> Result<(), HouseError> {
        for profile in self.bed_profiles.as_deref().unwrap_or_default() {
            profile.validate_scar_footprints(&self.id)?;
        }
        Ok(())
    }
}

/// An id that goes into a URL and a document: non-empty, no edge whitespace, no `/` and no control
/// character. Refused rather than sanitised, as every key in `house.rs` is.
fn validate_id(id: &str, what: &str) -> Result<(), HouseError> {
    if id.trim().is_empty() {
        return Err(HouseError::BadEntry(format!("the {what} has no id")));
    }
    if id != id.trim() || id.contains('/') || id.chars().any(|c| c.is_control()) {
        return Err(HouseError::BadEntry(format!(
            "{id:?} cannot be a {what} id: no slash, no control character, no space at either end"
        )));
    }
    Ok(())
}

/// `location.json` (#412). Unknown keys are refused at every depth, as in `house.json` (#339).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocationDoc {
    pub kind: String,
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    /// ISO timestamp: when this location was first written.
    pub created_at: String,
    /// One sentence when this location was made from an older document — `house.json`, on the date
    /// it was moved — so the provenance of the tools in it is not lost with the old file's name.
    #[serde(default)]
    pub migrated_from: Option<String>,
    #[serde(default)]
    pub machines: Vec<MachineRecord>,
    /// #597 — the accessories the house owns (mounts and probes); a bed profile places one by id.
    /// OMITTED while empty, so a location written before the hoist round-trips without gaining a key.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub accessories: Vec<FixtureRecord>,
    #[serde(default)]
    pub tools: Vec<UserTool>,
    #[serde(default)]
    pub inventory: Vec<InventoryItem>,
    /// The stock shelf (#413): the material on hand. Its own endpoint, `ETag` and guarded writes.
    #[serde(default)]
    pub stock: Vec<StockItem>,
    /// The feeds table (#450): the cutting numbers for one (material, cutter edge, diameter band).
    /// Its own endpoint, `ETag` and guarded writes. A fresh location holds the twelve seeded rows
    /// and #450 slice 5 put them in the shared `location-doc.json` too; the table is OMITTED while
    /// empty, so a location written before the table existed round-trips without gaining a key
    /// until a read or an import seeds it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub feeds: Vec<FeedRow>,
    /// The shop's tunable defaults — thresholds, waits, chosen values — with provenance
    /// (`defaults.rs`). Open to new keys; its own endpoint, `ETag` and guarded writes.
    #[serde(default)]
    pub defaults: crate::defaults::ShopDefaults,
}

/// What `GET /api/v1/location` serves: the location without its two tool tiers, which have their
/// own endpoints, their own `ETag`s and their own guarded writes. The `ETag` of THIS body guards a
/// machine write, so a count edit on a cutter never makes a machine save look stale.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocationView<'a> {
    pub kind: &'a str,
    pub schema_version: u32,
    pub id: &'a str,
    pub name: &'a str,
    pub created_at: &'a str,
    pub migrated_from: Option<&'a str>,
    pub machines: &'a [MachineRecord],
    pub accessories: &'a [FixtureRecord],
}

/// A location id nobody else will mint: the time to the nanosecond, in hex. Not a UUID because no
/// UUID crate is a dependency and the id only has to be unique among one user's locations.
fn mint_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("loc-{nanos:x}")
}

impl LocationDoc {
    /// A location with nothing in it yet — the first run.
    pub fn fresh() -> LocationDoc {
        LocationDoc {
            kind: LOCATION_KIND.to_string(),
            schema_version: LOCATION_SCHEMA_VERSION,
            id: mint_id(),
            name: DEFAULT_LOCATION_NAME.to_string(),
            created_at: crate::catalogue::now_iso(),
            migrated_from: None,
            machines: Vec::new(),
            accessories: Vec::new(),
            tools: Vec::new(),
            inventory: Vec::new(),
            stock: Vec::new(),
            feeds: crate::feeds::seeded_rows(),
            defaults: crate::defaults::seeded(),
        }
    }

    /// The migration (#412): a valid house's tools and inventory, moved over whole. Nothing is
    /// filtered, renamed or re-ordered — the caller has already validated `house`, and every row it
    /// held is a row the location holds. The machine list starts empty: the house never knew the
    /// machine, and the client fills it from its own "my machine" data.
    pub fn from_house(house: HouseDoc, source: &str) -> LocationDoc {
        let now = crate::catalogue::now_iso();
        LocationDoc {
            migrated_from: Some(format!("{source}, moved into this location on {now}")),
            tools: house.tools,
            inventory: house.inventory,
            ..LocationDoc::fresh()
        }
    }

    pub fn view(&self) -> LocationView<'_> {
        LocationView {
            kind: &self.kind,
            schema_version: self.schema_version,
            id: &self.id,
            name: &self.name,
            created_at: &self.created_at,
            migrated_from: self.migrated_from.as_deref(),
            machines: &self.machines,
            accessories: &self.accessories,
        }
    }

    /// Everything that must hold of the whole document: its identity, unique machine ids, each
    /// machine on its own, and the tool tiers by exactly the rule `house.json` was held to.
    pub(crate) fn validate(&self) -> Result<(), HouseError> {
        if self.kind != LOCATION_KIND {
            return Err(HouseError::BadEntry(format!(
                "this is a {:?} document, not a location",
                self.kind
            )));
        }
        if self.schema_version != LOCATION_SCHEMA_VERSION {
            return Err(HouseError::BadEntry(format!(
                "the location is version {}; this build reads version {LOCATION_SCHEMA_VERSION}",
                self.schema_version
            )));
        }
        validate_id(&self.id, "location")?;
        if self.name.trim().is_empty() {
            return Err(HouseError::BadEntry("the location has no name".into()));
        }
        if self.created_at.trim().is_empty() {
            return Err(HouseError::BadEntry(
                "the location does not say when it was created".into(),
            ));
        }
        let mut ids = HashSet::new();
        for m in &self.machines {
            m.validate()?;
            if !ids.insert(m.id.as_str()) {
                return Err(HouseError::BadEntry(format!(
                    "machine {} appears twice: one id, one machine",
                    m.id
                )));
            }
        }
        // #597 — the accessories are the house's: unique ids, and every bed placement names one the
        // location owns (the machine-level validate deliberately skips this, so it runs here once).
        let mut accessory_ids = HashSet::new();
        for a in &self.accessories {
            a.validate("the location")?;
            if !accessory_ids.insert(a.id.as_str()) {
                return Err(HouseError::BadEntry(format!(
                    "the location has two accessories called {}",
                    a.id
                )));
            }
        }
        for m in &self.machines {
            if let Some(profiles) = &m.bed_profiles {
                for p in profiles {
                    p.validate(&m.id, Some(self.accessories.as_slice()))?;
                }
            }
        }
        validate_tiers(&self.tools, &self.inventory)?;
        validate_shelf(&self.stock)?;
        validate_table(&self.feeds)?;
        crate::defaults::validate_all(&self.defaults)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a_machine(id: &str) -> MachineRecord {
        MachineRecord {
            id: id.to_string(),
            profile_id: Some("Z1".into()),
            name: Some("Makera_Z1_010290".into()),
            nickname: None,
            serial: None,
            firmware: None,
            address: Some(MachineAddress { host: "192.168.10.43".into(), port: 2222 }),
            calibration: None,
            fixtures: Some(serde_json::json!({})),
            bed_profiles: None,
            active_bed_profile_id: None,
            margins: None,
            power: None,
            wasteboard: None,
            finished_programs: Vec::new(),
            finished_runs: Vec::new(),
            registrations: None,
            updated_at: "2026-10-15T00:00:00.000Z".into(),
        }
    }

    fn a_finished_run(hash: &str, index: u32) -> FinishedRun {
        FinishedRun {
            hash: hash.into(),
            job_id: Some("job-1".into()),
            job_name: Some("M1 tray".into()),
            package_key: Some("package-1".into()),
            key8: Some("package-".into()),
            program_index: Some(index),
            program_count: Some(17),
            program_name: Some("tray-p01.nc".into()),
            cutter_key: Some("inv:flat-25".into()),
            setup_index: Some(1),
            finished_at: Some("2026-11-10T14:02:00.000Z".into()),
            stock: Some(FinishedRunStock {
                length_mm: Some(160.0),
                width_mm: Some(126.0),
                thickness_mm: Some(25.0),
            }),
            registration: Some(FinishedRunRegistration {
                surface_machine_z: Some(-60.487),
                g54: Some(FinishedRunG54 { x: Some(77.344), y: Some(63.0), z: None }),
                top_source: Some("touch".into()),
                measured_top_machine_z: Some(-60.487),
                implied_thickness_mm: Some(25.3),
                measured_at: Some("2026-11-10T13:00:00.000Z".into()),
                plan_expected_top_machine_z: Some(-60.0),
            }),
            cut_maps: vec![FinishedSetupCutMap {
                setup_index: 1,
                state: "complete".into(),
                unknown_reason: None,
                map: Some(FinishedCutMap {
                    cell_mm: 2.0,
                    cols: 80,
                    rows: 63,
                    x0_mm: 0.0,
                    y0_mm: 0.0,
                    step_mm: 0.05,
                    flat: CutMapStream { encoding: "rle".into(), data: "5040:1".into() },
                    depth: CutMapStream { encoding: "rle".into(), data: "5040:0".into() },
                }),
            }],
        }
    }

    fn a_datum(value: f64) -> MeasuredDatum {
        MeasuredDatum {
            value,
            measured_at: "2026-10-15T09:00:00.000Z".into(),
            by: "wired-probe".into(),
            at: Some([-150.0, -150.0]),
            rests_on_stock: None,
        }
    }

    fn a_bed_fixture() -> FixtureRecord {
        FixtureRecord {
            id: "fx-vise-1".into(),
            kind: "vise".into(),
            product: Some("makera-z1-low-profile-vise".into()),
            variant: None,
            constants: serde_json::json!({
                "jawBarWidth": 10.0, "jawLength": 100.0, "ledgeStep": 3.1, "ledgeWidth": 1.9
            })
            .as_object()
            .unwrap()
            .clone(),
            unit: serde_json::json!({
                "jawBarHeight": null, "bodyHeight": null, "maxOpening": null
            })
            .as_object()
            .unwrap()
            .clone(),
            provenance: [("jawBarWidth".to_string(), "measured:2026-10-13".to_string())].into(),
            whereabouts: AccessoryWhereabouts::Box {},
            history: Vec::new(),
        }
    }

    fn a_bed_profile() -> BedProfile {
        BedProfile {
            id: "bp-1".into(),
            name: "Test bed".into(),
            created_at: "2026-10-15T09:00:00.000Z".into(),
            based_on: Some("default:z1-vise".into()),
            surface: BedSurface {
                kind: SurfaceKind::Wasteboard,
                material: Some("MDF".into()),
                length: Some(200.0),
                width: Some(200.0),
                thickness: Some(10.0),
                position: Some(BedPosition { front_left: [-150.0, -150.0], frame: "machine".into() }),
                provenance: [("thickness".to_string(), "measured:2026-10-15".to_string())].into(),
                scars: Vec::new(),
                last_resurfaced_at: None,
            },
            datums: BedDatums {
                surface_top_z: Some(a_datum(-112.345)),
                vise_jaw_top_z: None,
                bracket_seat_z: None,
                rotary_axis: None,
                rotary_face_angle: None,
            },
            placements: vec![BedPlacement {
                id: "pl-vise".into(),
                fixture: "fx-vise-1".into(),
                place: PlacementWhere {
                    kind: PlacementKind::Pins,
                    pins: Some(LocatingPins::Vise),
                    anchor: None,
                },
                count: None,
                frame: Some(PlacementFrame {
                    fixed_jaw_face_x: Some(-0.1),
                    jaw_start_y: Some(-10.0),
                }),
                seed: None,
                provenance: [("fixedJawFaceX".to_string(), "measured:2026-10-17".to_string())].into(),
            }],
            preferred_mounting: vec![PreferredMounting {
                stock: "plate|block".into(),
                mount: MountingChoice { placement: Some("pl-vise".into()), manner: MountingManner::Jaws },
            }],
            consumables: Some(Consumables {
                tape: Some(ConsumableTape {
                    width_mm: 20.0,
                    thickness_mm: 0.1,
                    provenance: "typed".into(),
                }),
                boards: vec![ConsumableBoard {
                    material: "MDF".into(),
                    size: [100.0, 100.0, 2.0],
                    count: 4,
                }],
            }),
            history: vec![ProfileHistoryEntry {
                at: "2026-10-15T09:00:00.000Z".into(),
                what: "created from default:z1-vise".into(),
            }],
        }
    }

    fn a_machine_with_a_bed() -> MachineRecord {
        let mut m = a_machine("m-1");
        m.bed_profiles = Some(vec![a_bed_profile()]);
        m.active_bed_profile_id = Some("bp-1".into());
        m
    }

    #[test]
    fn a_fresh_location_is_valid_and_named_as_a_default() {
        let loc = LocationDoc::fresh();
        loc.validate().unwrap();
        assert_eq!(loc.name, DEFAULT_LOCATION_NAME);
        assert!(loc.id.starts_with("loc-"));
        assert!(loc.migrated_from.is_none());
    }

    #[test]
    fn a_machine_record_refuses_what_it_cannot_store() {
        let mut loc = LocationDoc::fresh();
        loc.machines.push(a_machine("m-1"));
        loc.validate().unwrap();

        let mut twice = loc.clone();
        twice.machines.push(a_machine("m-1"));
        assert!(matches!(twice.validate(), Err(HouseError::BadEntry(_))));

        for broken in [
            MachineRecord { id: "".into(), ..a_machine("x") },
            MachineRecord { id: "a/b".into(), ..a_machine("x") },
            MachineRecord { updated_at: " ".into(), ..a_machine("x") },
            MachineRecord { fixtures: Some(serde_json::json!([1])), ..a_machine("x") },
            MachineRecord {
                address: Some(MachineAddress { host: "".into(), port: 2222 }),
                ..a_machine("x")
            },
            MachineRecord { finished_programs: vec![" ".into()], ..a_machine("x") },
        ] {
            assert!(matches!(broken.validate(), Err(HouseError::BadEntry(_))), "{broken:?}");
        }
    }

    #[test]
    fn a_machine_with_no_finished_programs_says_nothing_about_them() {
        // #419 §4.5. An EMPTY list is the same document as an absent one, so the shared
        // `location-doc.json` (which has no `finishedPrograms`) gains no key through a round trip —
        // the same property `feeds` has, and what `skip_serializing_if` buys.
        let machine = a_machine("m-1");
        machine.validate().unwrap();
        let v = serde_json::to_value(&machine).unwrap();
        assert!(v.get("finishedPrograms").is_none(), "{v}");

        let mut with_hashes = a_machine("m-1");
        with_hashes.finished_programs = vec!["a1b2c3d4".into()];
        with_hashes.validate().unwrap();
        let v = serde_json::to_value(&with_hashes).unwrap();
        assert_eq!(v["finishedPrograms"], serde_json::json!(["a1b2c3d4"]));
    }

    #[test]
    fn the_live_k3_record_written_before_the_run_section_gains_no_key() {
        // #1179. The fixture is the k3 location's own machine record, fetched READ-ONLY on
        // 2026-11-10 — written before `finishedRuns` existed. It must parse with an empty list,
        // and an empty list is omitted, so every stored house and the shared fixture stay stable.
        let raw = include_str!("../../tests/unit/fixtures/location-k3-machine-2026-11-10.json");
        let fixture: serde_json::Value = serde_json::from_str(raw).unwrap();
        let old: MachineRecord = serde_json::from_value(fixture["machine"].clone()).unwrap();
        assert_eq!(old.finished_programs, vec!["5343dd8c", "1e4e7ef9"]);
        assert!(old.finished_runs.is_empty());
        old.validate().unwrap();
        let back = serde_json::to_value(&old).unwrap();
        assert!(back.get("finishedRuns").is_none(), "{back}");
    }

    #[test]
    fn a_finished_run_round_trips_in_camel_case_and_refuses_a_broken_cut_map() {
        // #1179. Every field but the hash is optional — a partial record is still true — and the
        // map is all-or-nothing: an over-cap stream, a non-RLE encoding or a zero grid refuses the
        // whole record, never a half-filled grid. The maps are PER SETUP (the 11-10 ruling):
        // `complete` carries its map, `unknown` carries the reason a merge could not finish.
        let mut machine = a_machine("m-1");
        machine.finished_programs = vec!["a1b2c3d4".into()];
        machine.finished_runs = vec![a_finished_run("a1b2c3d4", 1)];
        machine.validate().unwrap();
        let v = serde_json::to_value(&machine).unwrap();
        assert_eq!(v["finishedRuns"][0]["programName"], serde_json::json!("tray-p01.nc"));
        assert_eq!(
            v["finishedRuns"][0]["registration"]["surfaceMachineZ"],
            serde_json::json!(-60.487)
        );
        assert_eq!(v["finishedRuns"][0]["cutMaps"][0]["map"]["stepMm"], serde_json::json!(0.05));
        assert_eq!(v["finishedRuns"][0]["cutMaps"][0]["state"], serde_json::json!("complete"));
        let back: MachineRecord = serde_json::from_value(v).unwrap();
        assert_eq!(back, machine);

        let partial: FinishedRun =
            serde_json::from_value(serde_json::json!({ "hash": "a1b2c3d4" })).unwrap();
        assert!(partial.cut_maps.is_empty());
        assert_eq!(partial.program_index, None);

        let good = serde_json::json!({
            "cellMm": 2, "cols": 80, "rows": 63, "x0Mm": 0, "y0Mm": 0, "stepMm": 0.05,
            "flat": { "encoding": "rle", "data": "5040:1" },
            "depth": { "encoding": "rle", "data": "5040:0" }
        });
        for field in ["cols", "rows", "stepMm", "flat", "depth"] {
            let mut bad = good.clone();
            match field {
                "cols" | "rows" => bad[field] = serde_json::json!(0),
                "stepMm" => bad[field] = serde_json::json!(0),
                "flat" => bad["flat"] = serde_json::json!({ "encoding": "raw", "data": "1:1" }),
                _ => bad["depth"] = serde_json::json!({ "encoding": "rle", "data": "x".repeat(4097) }),
            }
            let mut machine = a_machine("m-1");
            machine.finished_programs = vec!["a1b2c3d4".into()];
            machine.finished_runs = vec![FinishedRun {
                cut_maps: vec![FinishedSetupCutMap {
                    setup_index: 1,
                    state: "complete".into(),
                    unknown_reason: None,
                    map: Some(serde_json::from_value(bad).unwrap()),
                }],
                ..a_finished_run("a1b2c3d4", 1)
            }];
            assert!(matches!(machine.validate(), Err(HouseError::BadEntry(_))), "{field}: {machine:?}");
        }

        // The state's own rules: complete needs its map, unknown needs its reason, and a state
        // outside the pair refuses the record.
        for entry in [
            serde_json::json!({ "setupIndex": 1, "state": "complete" }),
            serde_json::json!({ "setupIndex": 1, "state": "unknown" }),
            serde_json::json!({ "setupIndex": 1, "state": "unknown", "unknownReason": "  " }),
            serde_json::json!({ "setupIndex": 1, "state": "partial", "map": good }),
        ] {
            let mut machine = a_machine("m-1");
            machine.finished_programs = vec!["a1b2c3d4".into()];
            machine.finished_runs = vec![FinishedRun {
                cut_maps: vec![serde_json::from_value(entry).unwrap()],
                ..a_finished_run("a1b2c3d4", 1)
            }];
            assert!(matches!(machine.validate(), Err(HouseError::BadEntry(_))), "{machine:?}");
        }
        let unknown = FinishedSetupCutMap {
            setup_index: 2,
            state: "unknown".into(),
            unknown_reason: Some("the map does not fit the record even at 8 mm cells".into()),
            map: None,
        };
        let mut machine = a_machine("m-1");
        machine.finished_programs = vec!["a1b2c3d4".into()];
        machine.finished_runs = vec![FinishedRun { cut_maps: vec![unknown], ..a_finished_run("a1b2c3d4", 1) }];
        machine.validate().unwrap();
    }

    #[test]
    fn a_machine_with_a_bed_round_trips_with_its_profile() {
        // #510: the bed model is stored, so a machine carrying it must come back exactly — the
        // profile with its surface/datums/placements, and the active id. (#597 moved the fixture
        // records to the location's `accessories`, so they are not part of this machine round-trip.)
        let machine = a_machine_with_a_bed();
        machine.validate().unwrap();
        let v = serde_json::to_value(&machine).unwrap();
        assert_eq!(v["bedProfiles"][0]["surface"]["kind"], serde_json::json!("wasteboard"));
        assert_eq!(v["bedProfiles"][0]["datums"]["surfaceTopZ"]["by"], serde_json::json!("wired-probe"));
        assert_eq!(v["activeBedProfileId"], serde_json::json!("bp-1"));
        let back: MachineRecord = serde_json::from_value(v).unwrap();
        assert_eq!(back, machine);
    }

    #[test]
    fn a_face_angle_datum_round_trips_in_degrees() {
        // #1059 — the datum the app writes after levelling a square in the 4th axis. `value` is
        // DEGREES of A turn (never a machine Z), `at` the touch column, `residualMm` the last
        // pair's |Z+ − Z−|. The house is `deny_unknown_fields`, so a field the app writes and this
        // struct does not know would refuse the whole write-back — this is the shape it sends.
        let written = serde_json::json!({
            "surfaceTopZ": null,
            "viseJawTopZ": null,
            "bracketSeatZ": null,
            "rotaryAxis": null,
            "rotaryFaceAngle": {
                "value": -2.35,
                "measuredAt": "2026-11-08T00:00:00.000Z",
                "by": "fx-probe-3d",
                "at": [-106.0, -125.06],
                "residualMm": 0.012
            }
        });
        let datums: BedDatums = serde_json::from_value(written.clone()).unwrap();
        datums.validate("m-1", "bp-1").unwrap();
        let angle = datums.rotary_face_angle.as_ref().unwrap();
        assert!((angle.value - -2.35).abs() < 1e-9, "value is degrees of turn");
        assert_eq!(angle.at, Some([-106.0, -125.06]));
        assert_eq!(angle.residual_mm, Some(0.012));
        // …and it comes back exactly as it went in.
        assert_eq!(serde_json::to_value(&datums).unwrap(), written);

        // A datum without a residual omits the key rather than writing null, so an older reading
        // stays byte-identical through a round trip.
        let no_residual: BedDatums = serde_json::from_value(serde_json::json!({
            "rotaryFaceAngle": { "value": 0.0, "measuredAt": "t", "by": "b", "at": null }
        }))
        .unwrap();
        let v = serde_json::to_value(&no_residual).unwrap();
        assert!(v["rotaryFaceAngle"].get("residualMm").is_none(), "{v}");
        // Every other datum may be absent: the profile predates them.
        no_residual.validate("m-1", "bp-1").unwrap();
    }

    #[test]
    fn the_face_angle_datum_refuses_an_unknown_key_and_a_typed_instrument() {
        // The trap the Manager named: an unknown key inside the datum refuses the WHOLE document.
        let extra = serde_json::json!({
            "rotaryFaceAngle": { "value": 1.0, "measuredAt": "t", "by": "b", "at": null, "residualMm": 0.01, "typo": 1 }
        });
        assert!(serde_json::from_value::<BedDatums>(extra).is_err());
        // …as does an unknown DATUM key.
        assert!(serde_json::from_value::<BedDatums>(serde_json::json!({ "rotaryFaceAngles": null })).is_err());
        // A typed reading is refused on write, like every other datum's.
        let mut typed: BedDatums = serde_json::from_value(serde_json::json!({
            "rotaryFaceAngle": { "value": 1.0, "measuredAt": "t", "by": "typed", "at": null }
        }))
        .unwrap();
        assert!(matches!(typed.validate("m-1", "bp-1"), Err(HouseError::BadEntry(_))));
        typed.rotary_face_angle.as_mut().unwrap().by = "wired-probe".into();
        typed.rotary_face_angle.as_mut().unwrap().residual_mm = Some(f64::INFINITY);
        assert!(matches!(typed.validate("m-1", "bp-1"), Err(HouseError::BadEntry(_))));
    }

    #[test]
    fn the_app_serialisers_machine_record_parses_in_the_house() {
        // #1059 — THE SHAPE THE APP ACTUALLY SENDS, not one written by hand. The fixture is the
        // app's own serialiser output (`MachineRecordSchema.parse` then `JSON.stringify`): one
        // profile with the face angle MEASURED and one carrying the app's `null`, because
        // `BedDatums` is `deny_unknown_fields` and a field it did not know would refuse the whole
        // write-back.
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/unit/fixtures/machine-faceangle-ts.json");
        let raw = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("{} should be readable: {e}", path.display()));
        assert!(
            raw.contains("\"rotaryFaceAngle\": null"),
            "the app writes the key as null, not omitted"
        );
        let machine: MachineRecord = serde_json::from_str(&raw).unwrap();
        machine.validate().unwrap();
        let profiles = machine.bed_profiles.as_ref().expect("the fixture carries bed profiles");
        let measured = profiles.iter().find(|p| p.id == "bp-face-angle").expect("the measured profile");
        let datum = measured.datums.rotary_face_angle.as_ref().expect("the measured face angle");
        assert!((datum.value - -2.35).abs() < 1e-9, "the value is degrees of turn");
        assert_eq!(datum.residual_mm, Some(0.012));
        assert_eq!(datum.at, Some([-106.0, -125.06]));
        let unmeasured = profiles.iter().find(|p| p.id == "bp-null").expect("the null profile");
        assert!(unmeasured.datums.rotary_face_angle.is_none(), "null parses as not measured");
    }

    #[test]
    fn a_scar_off_the_board_is_refused_on_write_and_still_loads() {
        // #509 — the footprint check is a WRITE rule. The same machine LOADS (validate) around a
        // stray scar — a location saved before the rule must not lock the shop out of its own
        // house — and the write path refuses it with a sentence. The board states 200 × 200 at
        // machine (−150, −150), so its far corner is (50, 50).
        let scar = |x: f64, y: f64| crate::wasteboard::Scar {
            x,
            y,
            width: 10.0,
            height: 10.0,
            at: "2026-10-20T10:00:00.000Z".into(),
            job_id: None,
        };
        let mut on_it = a_machine_with_a_bed();
        on_it.bed_profiles.as_mut().unwrap()[0].surface.scars.push(scar(-150.0, 40.0));
        on_it.validate().unwrap();
        on_it.validate_bed_footprints().unwrap();

        let mut stray = a_machine_with_a_bed();
        stray.bed_profiles.as_mut().unwrap()[0].surface.scars.push(scar(60.0, -150.0));
        stray.validate().unwrap();
        let refused = stray.validate_bed_footprints();
        assert!(matches!(refused, Err(HouseError::BadEntry(_))), "{refused:?}");
        if let Err(HouseError::BadEntry(why)) = refused {
            assert!(why.contains("outside its 200 × 200 mm footprint"), "{why}");
        }
    }

    #[test]
    fn a_location_round_trips_its_accessories() {
        // #597 — the accessories are the house's: the vise and the wired probe, both checked out to
        // the one machine, round-trip with their whereabouts and history.
        let mut loc = LocationDoc::fresh();
        let mut vise = a_bed_fixture();
        vise.whereabouts = AccessoryWhereabouts::Machine {
            machine_id: "m-1".into(),
            since: "2026-10-23T00:00:00.000Z".into(),
        };
        vise.history = vec![AccessoryHistory {
            at: "2026-10-23T00:00:00.000Z".into(),
            what: "jaw top measured -56.82 by the wired probe".into(),
        }];
        let mut probe = a_bed_fixture();
        probe.id = "fx-probe-1".into();
        probe.kind = "probe".into();
        probe.variant = Some("wired-touch".into());
        probe.unit = serde_json::json!({
            "tipDiameterMm": 2.0, "rimOffsetMm": 0.7, "rimOffsetUncertaintyMm": 0.25
        })
        .as_object()
        .unwrap()
        .clone();
        probe.whereabouts = AccessoryWhereabouts::Machine {
            machine_id: "m-1".into(),
            since: "2026-10-23T00:00:00.000Z".into(),
        };
        loc.accessories = vec![vise.clone(), probe];
        loc.machines.push(a_machine_with_a_bed());
        loc.validate().unwrap();
        let v = serde_json::to_value(&loc).unwrap();
        assert_eq!(v["accessories"][0]["whereabouts"]["machineId"], serde_json::json!("m-1"));
        assert_eq!(v["accessories"][1]["kind"], serde_json::json!("probe"));
        let back: LocationDoc = serde_json::from_value(v).unwrap();
        assert_eq!(back, loc);
    }

    #[test]
    fn a_machine_without_a_bed_says_nothing_about_one() {
        // #510's round-trip rule: a document written before the bed existed must not GAIN the keys.
        // `fixtures` (the #412 settings record) is untouched and still serialized as before.
        let machine = a_machine("m-1");
        machine.validate().unwrap();
        let v = serde_json::to_value(&machine).unwrap();
        for key in ["bedProfiles", "activeBedProfileId"] {
            assert!(v.get(key).is_none(), "{key} was written: {v}");
        }
        assert!(v.get("fixtures").is_some(), "the legacy fixtures section is still there");
    }

    #[test]
    fn a_datum_typed_by_hand_is_refused_and_an_undated_one_does_not_parse() {
        let mut machine = a_machine_with_a_bed();
        machine.bed_profiles.as_mut().unwrap()[0]
            .datums
            .surface_top_z
            .as_mut()
            .unwrap()
            .by = "Typed".into();
        assert!(matches!(machine.validate(), Err(HouseError::BadEntry(_))));

        // The schema itself holds a datum to all four fields: value, date and instrument are not
        // optional, so an unmeasured datum cannot be written as a bare value.
        assert!(serde_json::from_value::<MeasuredDatum>(serde_json::json!({
            "value": -112.3, "by": "wired-probe"
        }))
        .is_err());
        assert!(serde_json::from_value::<MeasuredDatum>(serde_json::json!({
            "value": -112.3, "measuredAt": "2026-10-15T09:00:00.000Z"
        }))
        .is_err());
    }

    #[test]
    fn the_active_bed_profile_must_be_one_the_machine_has() {
        let mut missing = a_machine_with_a_bed();
        missing.active_bed_profile_id = Some("bp-other".into());
        assert!(missing.validate().is_err());

        let mut none_named = a_machine_with_a_bed();
        none_named.active_bed_profile_id = None;
        assert!(none_named.validate().is_err());

        let mut active_without_profiles = a_machine("m-1");
        active_without_profiles.active_bed_profile_id = Some("bp-1".into());
        assert!(active_without_profiles.validate().is_err());

        // An EMPTY list with no active id is a legal, deliberately emptied description — and the
        // marker that the first migration has already run.
        let mut emptied = a_machine("m-1");
        emptied.bed_profiles = Some(Vec::new());
        emptied.validate().unwrap();
    }

    #[test]
    fn the_vise_and_the_rotary_module_may_not_share_the_pins() {
        // #597 — the accessories are the house's, so the placement checks run at the location level.
        let mut rotary = a_bed_fixture();
        rotary.id = "fx-rotary".into();
        rotary.kind = "rotary-module".into();
        let mut loc = LocationDoc::fresh();
        loc.accessories = vec![a_bed_fixture(), rotary];
        let mut machine = a_machine_with_a_bed();
        machine.bed_profiles.as_mut().unwrap()[0].placements.push(BedPlacement {
            id: "pl-rotary".into(),
            fixture: "fx-rotary".into(),
            place: PlacementWhere {
                kind: PlacementKind::Pins,
                pins: Some(LocatingPins::Rotary),
                anchor: None,
            },
            count: None,
            frame: None,
            seed: None,
            provenance: Default::default(),
        });
        loc.machines.push(machine);
        let err = loc.validate().unwrap_err().to_string();
        assert!(err.contains("mutually exclusive") || err.contains("one at a time"), "{err}");

        // A placement naming a fixture the location does not own is refused too, so a profile cannot
        // point at another location's accessory.
        let mut stranger = a_machine_with_a_bed();
        stranger.bed_profiles.as_mut().unwrap()[0].placements[0].fixture = "fx-elsewhere".into();
        let mut loc2 = LocationDoc::fresh();
        loc2.accessories = vec![a_bed_fixture()];
        loc2.machines.push(stranger);
        assert!(loc2.validate().is_err());
    }

    #[test]
    fn a_bare_bed_has_no_size_scars_or_resurfacing() {
        let mut machine = a_machine_with_a_bed();
        {
            let surface = &mut machine.bed_profiles.as_mut().unwrap()[0].surface;
            surface.kind = SurfaceKind::BareBed;
        }
        // It still carries the wasteboard's size and material, which open question E forbids.
        assert!(machine.validate().is_err());

        let surface = &mut machine.bed_profiles.as_mut().unwrap()[0].surface;
        surface.material = None;
        surface.length = None;
        surface.width = None;
        surface.thickness = None;
        surface.position = None;
        surface.provenance.clear();
        machine.validate().unwrap();
    }

    #[test]
    fn a_wasteboard_says_how_thick_it_is() {
        let mut machine = a_machine_with_a_bed();
        machine.bed_profiles.as_mut().unwrap()[0].surface.thickness = None;
        assert!(machine.validate().is_err());
    }

    #[test]
    fn a_key_in_a_profile_this_build_does_not_know_is_refused() {
        let mut v = serde_json::to_value(a_machine_with_a_bed()).unwrap();
        v["bedProfiles"][0]["datums"]["surfaceTopZ"]["typedBy"] = serde_json::json!("hand");
        let err = serde_json::from_value::<MachineRecord>(v).unwrap_err().to_string();
        assert!(err.contains("typedBy"), "{err}");
    }

    /// #1070 (C8) — the seat's statement is a KNOWN key: `restsOnStock` round-trips, and the
    /// strictness that made this necessary still refuses a key this build has never heard of.
    #[test]
    fn a_datum_that_states_it_is_the_stock_surface_round_trips() {
        let mut datum = a_datum(-85.75);
        datum.rests_on_stock = Some(true);
        let v = serde_json::to_value(&datum).unwrap();
        assert_eq!(v["restsOnStock"], serde_json::json!(true), "the statement is written in camelCase");
        let back: MeasuredDatum = serde_json::from_value(v.clone()).unwrap();
        assert_eq!(back, datum);

        // An absent statement stays absent in the file (older datums are untouched).
        let plain = serde_json::to_value(a_datum(-55.119)).unwrap();
        assert!(plain.get("restsOnStock").is_none(), "{plain}");

        // And the strictness itself is unchanged: an unknown key on a datum is still refused.
        let mut unknown = v.clone();
        unknown["typedBy"] = serde_json::json!("hand");
        let err = serde_json::from_value::<MeasuredDatum>(unknown).unwrap_err().to_string();
        assert!(err.contains("typedBy"), "{err}");
    }

    /// #1070 (C8) — a placed bracket's seed is a KNOWN key on a placement: it round-trips with
    /// its `by` word, an unknown key inside it is refused, and a placement without one is
    /// unchanged in the file.
    #[test]
    fn a_placement_seed_round_trips_and_stays_strict() {
        let mut v = serde_json::to_value(a_machine_with_a_bed()).unwrap();
        v["bedProfiles"][0]["placements"] = serde_json::json!([{
            "id": "pl-bracket",
            "fixture": "fx-bracket-thin",
            "where": { "kind": "free", "pins": null, "anchor": null },
            "count": null,
            "frame": null,
            "seed": { "x": -190.89, "y": -193.83, "by": "grid", "measuredAt": "2026-11-08T00:00:00.000Z", "at": null, "probe": null },
            "provenance": {}
        }]);
        let machine: MachineRecord = serde_json::from_value(v.clone()).unwrap();
        let seed = machine.bed_profiles.as_ref().unwrap()[0].placements[0].seed.clone().unwrap();
        assert_eq!(seed.by, BracketSeedBy::Grid);
        assert_eq!(seed.x, -190.89);
        let back = serde_json::to_value(&machine).unwrap();
        assert_eq!(back["bedProfiles"][0]["placements"][0]["seed"]["by"], serde_json::json!("grid"));

        let mut unknown = v.clone();
        unknown["bedProfiles"][0]["placements"][0]["seed"]["typedBy"] = serde_json::json!("hand");
        let err = serde_json::from_value::<MachineRecord>(unknown).unwrap_err().to_string();
        assert!(err.contains("typedBy"), "{err}");

        // A placement with no seed writes none (every other fixture's placement is untouched).
        let mut none = v.clone();
        none["bedProfiles"][0]["placements"][0]
            .as_object_mut()
            .unwrap()
            .remove("seed");
        let plain: MachineRecord = serde_json::from_value(none).unwrap();
        assert!(plain.bed_profiles.as_ref().unwrap()[0].placements[0].seed.is_none());
    }

    #[test]
    fn a_key_this_build_does_not_know_is_refused_on_a_machine_too() {
        let mut v = serde_json::to_value(LocationDoc::fresh()).unwrap();
        v["machines"] = serde_json::json!([serde_json::to_value(a_machine("m-1")).unwrap()]);
        v["machines"][0]["powerSwitch"] = serde_json::json!({ "provider": "ha" });
        let err = serde_json::from_value::<LocationDoc>(v).unwrap_err().to_string();
        assert!(err.contains("powerSwitch"), "{err}");
    }

    #[test]
    fn a_fresh_location_holds_the_seeded_feeds_table() {
        // #450 slice 3: the twelve starting rows, all labelled `seeded` (unmeasured in their
        // provenance). A fresh location is valid with them, and writes the key because it holds rows.
        let loc = LocationDoc::fresh();
        assert_eq!(loc.feeds, crate::feeds::seeded_rows());
        assert!(!loc.feeds.is_empty());
        loc.validate().unwrap();
        let v = serde_json::to_value(&loc).unwrap();
        assert_eq!(v["feeds"].as_array().unwrap().len(), 12, "{v}");
        assert_eq!(v["feeds"][0]["source"], serde_json::json!("seeded"));
    }

    #[test]
    fn an_empty_feeds_table_says_nothing_about_itself() {
        // #450 slice 2/3. An EMPTY table is the same document as an absent one, so a location that
        // has no `feeds` gains no key through a round trip. Writing the key only when it holds a
        // row is what buys that; removing every row must also stay legal.
        let mut loc = LocationDoc::fresh();
        loc.feeds.clear();
        loc.validate().unwrap();
        let v = serde_json::to_value(&loc).unwrap();
        assert!(v.get("feeds").is_none(), "{v}");

        let mut with_a_row = loc.clone();
        with_a_row.feeds.push(crate::feeds::tests::a_row("feed-softwood-flat-0.8-1.6"));
        with_a_row.validate().unwrap();
        let v = serde_json::to_value(&with_a_row).unwrap();
        assert_eq!(v["feeds"][0]["material"], serde_json::json!("softwood"));
    }

    #[test]
    fn the_location_holds_the_feeds_table_to_its_whole_table_rule() {
        // The one cross-row rule lives in `feeds.rs`; this proves the LOCATION calls it, so an import
        // carrying a table the service would refuse cannot land.
        let mut loc = LocationDoc::fresh();
        loc.feeds.clear(); // the seeds are valid; this proves only the overlapping pair is not
        loc.feeds.push(FeedRow {
            min_diameter: 0.8,
            max_diameter: 2.0,
            ..crate::feeds::tests::a_row("feed-a")
        });
        loc.feeds.push(FeedRow {
            min_diameter: 1.6,
            max_diameter: 3.2,
            ..crate::feeds::tests::a_row("feed-b")
        });
        assert!(matches!(loc.validate(), Err(HouseError::BadEntry(_))));

        loc.feeds.pop();
        loc.validate().unwrap();
    }
}
