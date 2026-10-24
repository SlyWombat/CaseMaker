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
}

/// The four datums a profile describes; each is `null` until measured (open question E's bare bed
/// carries only `surfaceTopZ` when someone measures it).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BedDatums {
    pub surface_top_z: Option<MeasuredDatum>,
    pub vise_jaw_top_z: Option<MeasuredDatum>,
    pub bracket_seat_z: Option<MeasuredDatum>,
    pub rotary_axis: Option<MeasuredDatum>,
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
            updated_at: "2026-10-15T00:00:00.000Z".into(),
        }
    }

    fn a_datum(value: f64) -> MeasuredDatum {
        MeasuredDatum {
            value,
            measured_at: "2026-10-15T09:00:00.000Z".into(),
            by: "wired-probe".into(),
            at: Some([-150.0, -150.0]),
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
