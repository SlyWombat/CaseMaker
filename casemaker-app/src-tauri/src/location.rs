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
// `feeds`, its rows' rules in `feeds.rs`. A FRESH location starts with the eleven placeholder rows
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

/// One physical machine at the location (§3.1).
///
/// Every optional field is serialized as `null` rather than omitted, the same rule `Tool` follows:
/// the client's schema reads `null` as "not stated", and an absent key is not the same claim.
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
    #[serde(default)]
    pub tools: Vec<UserTool>,
    #[serde(default)]
    pub inventory: Vec<InventoryItem>,
    /// The stock shelf (#413): the material on hand. Its own endpoint, `ETag` and guarded writes.
    #[serde(default)]
    pub stock: Vec<StockItem>,
    /// The feeds table (#450): the cutting numbers for one (material, cutter edge, diameter band).
    /// Its own endpoint, `ETag` and guarded writes. A fresh location holds the eleven seeded rows
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
            margins: None,
            power: None,
            wasteboard: None,
            finished_programs: Vec::new(),
            updated_at: "2026-10-15T00:00:00.000Z".into(),
        }
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
    fn a_key_this_build_does_not_know_is_refused_on_a_machine_too() {
        let mut v = serde_json::to_value(LocationDoc::fresh()).unwrap();
        v["machines"] = serde_json::json!([serde_json::to_value(a_machine("m-1")).unwrap()]);
        v["machines"][0]["powerSwitch"] = serde_json::json!({ "provider": "ha" });
        let err = serde_json::from_value::<LocationDoc>(v).unwrap_err().to_string();
        assert!(err.contains("powerSwitch"), "{err}");
    }

    #[test]
    fn a_fresh_location_holds_the_seeded_feeds_table() {
        // #450 slice 3: the eleven starting rows, all labelled `seeded` (unmeasured in their
        // provenance). A fresh location is valid with them, and writes the key because it holds rows.
        let loc = LocationDoc::fresh();
        assert_eq!(loc.feeds, crate::feeds::seeded_rows());
        assert!(!loc.feeds.is_empty());
        loc.validate().unwrap();
        let v = serde_json::to_value(&loc).unwrap();
        assert_eq!(v["feeds"].as_array().unwrap().len(), 11, "{v}");
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
