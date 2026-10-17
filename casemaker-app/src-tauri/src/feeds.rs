// The feeds table (#450): the cutting numbers for one (material, cutter edge, diameter band), kept in
// `location.json` beside the machines, the tools and the stock shelf.
//
// WHAT THIS REPLACES, AND WHY IT IS A TABLE. `engine/cnc/feeds.ts` holds `UNMEASURED_FEEDS_TABLE`, a
// short literal of conservative starting values (soft/hard/mdf × two diameter bands, PLA × three, and
// a PLA V-bit row). Every row carries rpm, feed, plungeFeed, stepDown, stepOverFraction, peckFraction
// and the air flag, so the table is roughly seventy numbers in a 200-key `defaults` section that is
// already 96 keys in. Cardinality is the honest argument rather than the cap: the matrix is keyed by
// material × diameter × edge and is unbounded — a new material or band is a new row, and one row is
// ONE unit of provenance, where seven dotted scalar keys would carry provenance per number and each
// would have to be registered in three places (`KNOWN_DEFAULTS`, `defaults.rs`, `location-doc.json`).
//
// WHAT IS CHECKED HERE AND WHAT IS NOT. This side holds the SHAPE of a row to the rules a table needs
// to stay usable: an id the endpoint can name, a non-empty material, an ordered positive diameter
// band, every `params` value finite and positive, the source enum, and a note and a provenance that
// are sentences rather than blobs. The MATERIAL word itself is the client's vocabulary
// (`engine/cnc/materials.ts`), only checked to be a plain non-empty word here — a second copy of that
// list would be a second place to drift, and the client reads rows one at a time so an unknown word
// costs one row, not the table (the same split `stock.rs` and `location.rs` use).
//
// THE ONE CROSS-ROW RULE. `entryFor` (`feeds.ts:757`) takes the FIRST row whose material, edge and
// diameter range match, and the inclusive both-ends convention at a shared boundary is load-bearing
// (`feeds.ts:174-177`: a 1.6 mm cutter must take the smaller band, the conservative side). So two rows
// that share a material and an edge may TOUCH — 0.8-1.6 and 1.6-3.2 — but they may not overlap or
// repeat a range, because then the answer depends on row ORDER rather than on the cutter. That is a
// property of the list, not of any one row, so it lives in `validate_table` and not in `validate`.
//
// `note` and `provenance` are held to `defaults.rs`'s sentence rule (`validate_one`, ~:825-840): at
// most 400 characters and no control character. `setAt` carries the same "a value you set says when"
// rule a `ShopDefault` does — a `seeded` row is the app's own starting value and needs no date; a
// `chosen` or `measured` row is somebody's act and does.

use crate::house::HouseError;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// The longest a `note` or a `provenance` may be, matching `defaults.rs`'s note rule.
const MAX_SENTENCE: usize = 400;

/// The twelve starting rows (#450 slice 3, #221, #492): exactly the values the compiled
/// `UNMEASURED_FEEDS_TABLE` held, every one `seeded` and labelled unmeasured. **No vendor numbers**:
/// the three wood step-downs are conservative guesses for a 150 W spindle, the PLA rows are the
/// bench's running values, and the V rows are the one hand-written bench file's own numbers (the
/// PETG and plastic ones add the observed two-colour blank run) — each row's `provenance` says which.
///
/// ONE SPECIMEN, TWO READERS. `tests/unit/fixtures/feed-table.json`'s `good` list is the same rows,
/// the shared `tests/unit/fixtures/location-doc.json` carries them in its `feeds` section (#450
/// slice 5), and `the_shared_specimen_is_the_shape_the_client_parses` holds this file to the
/// specimen, so a value edited on one side cannot silently drift from the other.
///
/// THE MATERIAL WORD IS THE CLIENT'S VOCABULARY. The V rows are `pla` and `petg` because that is
/// what the stock materials name today; J19 moves the PLA row to `plastic`, and when it lands this
/// file, the feed specimen and the location fixture each change one `material` line — together, in
/// that order.
const SEED_ROWS_JSON: &str = include_str!("feed-seeds.json");

/// What a fresh location starts with — and what an EMPTY table is filled from on load.
pub(crate) fn seeded_rows() -> Vec<FeedRow> {
    serde_json::from_str(SEED_ROWS_JSON)
        .expect("feed-seeds.json is the feeds table's own seed and must parse")
}

/// A location written before the table existed has an EMPTY table. Fill it with the seeds IN MEMORY,
/// the way `defaults::add_missing_seeds` fills a missing scalar; the next write stores them. A
/// NON-empty table is the shop's own and is never added to — taking a row out must stick.
pub(crate) fn add_missing_seeds(rows: &mut Vec<FeedRow>) {
    if rows.is_empty() {
        *rows = seeded_rows();
    }
}

/// The cutter EDGE a row is written for (#405). Absent means `flat`, every row before #405 and every
/// coupon (which cuts with a flat end mill). It is part of SELECTION, not a comment: a V-bit engages a
/// fraction of the material a same-diameter flat end mill does and wants different numbers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FeedEdge {
    Flat,
    V,
}

/// Where a row's numbers came from — the same `seeded | chosen | measured` vocabulary `defaults` uses,
/// so "nothing measured" means the same thing wherever the location is read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FeedSource {
    /// The starting value this app writes into a new location. No date, no act.
    Seeded,
    /// A number a person set. Carries `setAt`.
    Chosen,
    /// A number this shop's own equipment settled. Carries `setAt`.
    Measured,
}

/// The cutting parameters, the seven numbers a row is FOR. All the numeric fields are positive;
/// `stepOverFraction` and `peckFraction` are fractions of the cutter DIAMETER, resolved in `feedsFor`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeedParams {
    pub rpm: f64,
    /// mm/min, XY cutting.
    pub feed: f64,
    /// mm/min, Z-.
    pub plunge_feed: f64,
    /// mm per depth pass.
    pub step_down: f64,
    pub step_over_fraction: f64,
    pub peck_fraction: f64,
    /// The job's accessory output. On a Z1 the post realises it as the vacuum.
    pub air: bool,
}

/// One row of the table.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeedRow {
    /// Ours, minted by the client. Unique in the table; also the URL segment a write names.
    pub id: String,
    /// The client's material vocabulary. Only checked to be a non-empty word here.
    pub material: String,
    /// The cutter edge the row is for. Absent is `flat`.
    #[serde(default)]
    pub edge: Option<FeedEdge>,
    /// Applies to cutters with cutting diameter in [minDiameter, maxDiameter], mm — INCLUSIVE at both
    /// ends, so a boundary value takes the first matching row (`feeds.ts:174-177`).
    pub min_diameter: f64,
    pub max_diameter: f64,
    pub params: FeedParams,
    pub source: FeedSource,
    /// ISO timestamp, the client's clock. Required when `source` is not `seeded`.
    #[serde(default)]
    pub set_at: Option<String>,
    /// A sentence about the row, for a person reading it. Absent is the common case.
    #[serde(default)]
    pub note: Option<String>,
    /// The sentence the panel shows: where these numbers came from.
    pub provenance: String,
}

fn bad(id: &str, why: impl std::fmt::Display) -> HouseError {
    HouseError::BadEntry(format!("feed {id}: {why}"))
}

fn positive(id: &str, what: &str, v: f64) -> Result<f64, HouseError> {
    if v.is_finite() && v > 0.0 {
        Ok(v)
    } else {
        Err(bad(id, format!("{what} must be a positive number, not {v}")))
    }
}

/// `defaults.rs`'s note rule, applied to whichever sentence field is named.
fn sentence_ok(id: &str, what: &str, text: Option<&str>) -> Result<(), HouseError> {
    if text.is_some_and(|t| t.len() > MAX_SENTENCE || t.chars().any(char::is_control)) {
        return Err(bad(
            id,
            format!("a {what} is a sentence of at most {MAX_SENTENCE} characters"),
        ));
    }
    Ok(())
}

impl FeedRow {
    /// `flat` unless the row names the cone — the effective edge the cross-row rule groups by.
    fn edge_or_flat(&self) -> FeedEdge {
        self.edge.unwrap_or(FeedEdge::Flat)
    }

    pub(crate) fn validate(&self) -> Result<(), HouseError> {
        let id = self.id.as_str();
        if id.trim().is_empty() || id != id.trim() || id.contains('/') || id.chars().any(char::is_control) {
            return Err(HouseError::BadEntry(format!(
                "{id:?} cannot be a feed row id: not empty, no slash, no control character, no space \
                 at either end"
            )));
        }
        if self.material.trim().is_empty() || self.material.chars().any(char::is_control) {
            return Err(bad(id, "it names no material"));
        }

        // The diameter band: both ends positive, and the band the right way round.
        positive(id, "minDiameter", self.min_diameter)?;
        positive(id, "maxDiameter", self.max_diameter)?;
        if self.min_diameter > self.max_diameter {
            return Err(bad(
                id,
                format!(
                    "its diameters run backwards: {} mm to {} mm",
                    self.min_diameter, self.max_diameter
                ),
            ));
        }

        // The seven numbers a row is for.
        let p = &self.params;
        positive(id, "rpm", p.rpm)?;
        positive(id, "feed", p.feed)?;
        positive(id, "plungeFeed", p.plunge_feed)?;
        positive(id, "stepDown", p.step_down)?;
        positive(id, "stepOverFraction", p.step_over_fraction)?;
        positive(id, "peckFraction", p.peck_fraction)?;

        if self.source != FeedSource::Seeded
            && self.set_at.as_deref().is_none_or(|s| s.trim().is_empty())
        {
            return Err(bad(id, "a chosen or measured row says when it was set"));
        }
        sentence_ok(id, "note", self.note.as_deref())?;
        if self.provenance.trim().is_empty() {
            return Err(bad(
                id,
                "it carries no provenance: every row says where its numbers came from",
            ));
        }
        sentence_ok(id, "provenance", Some(&self.provenance))?;
        Ok(())
    }
}

/// The whole table: every row on its own, one id per row, and the cross-row rule — no two rows that
/// share a material and an edge may overlap or repeat a diameter range.
pub(crate) fn validate_table(rows: &[FeedRow]) -> Result<(), HouseError> {
    let mut ids = HashSet::new();
    for row in rows {
        row.validate()?;
        if !ids.insert(row.id.as_str()) {
            return Err(HouseError::BadEntry(format!(
                "feed {} appears twice: one id, one row",
                row.id
            )));
        }
    }

    // `entryFor` takes the FIRST match, so an overlap makes the answer depend on row order. Touching
    // ranges (a shared boundary) are allowed on purpose; only interiors meeting is a conflict.
    for (i, a) in rows.iter().enumerate() {
        for b in &rows[i + 1..] {
            if a.material != b.material || a.edge_or_flat() != b.edge_or_flat() {
                continue;
            }
            let overlap = a.min_diameter < b.max_diameter && b.min_diameter < a.max_diameter;
            let duplicate = a.min_diameter == b.min_diameter && a.max_diameter == b.max_diameter;
            if overlap || duplicate {
                return Err(HouseError::BadEntry(format!(
                    "feeds {} and {} both cover {}–{} mm and {}–{} mm for {}: entryFor takes the \
                     FIRST matching row, so an overlap makes the answer depend on row order — split \
                     the band or point one row at a range no other row claims",
                    a.id,
                    b.id,
                    a.min_diameter,
                    a.max_diameter,
                    b.min_diameter,
                    b.max_diameter,
                    a.material,
                )));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;

    fn params() -> FeedParams {
        FeedParams {
            rpm: 12000.0,
            feed: 500.0,
            plunge_feed: 200.0,
            step_down: 0.5,
            step_over_fraction: 0.45,
            peck_fraction: 1.0,
            air: true,
        }
    }

    pub(crate) fn a_row(id: &str) -> FeedRow {
        FeedRow {
            id: id.to_string(),
            material: "softwood".into(),
            edge: None,
            min_diameter: 0.8,
            max_diameter: 1.6,
            params: params(),
            source: FeedSource::Seeded,
            set_at: None,
            note: None,
            provenance: "Starting value, nothing measured.".into(),
        }
    }

    #[test]
    fn a_few_rows_are_accepted() {
        a_row("feed-softwood-flat-0.8-1.6").validate().unwrap();
        // The V-bit row: a different effective edge in the same material.
        FeedRow {
            edge: Some(FeedEdge::V),
            min_diameter: 0.3,
            max_diameter: 0.5,
            ..a_row("feed-pla-v-0.3-0.5")
        }
        .validate()
        .unwrap();
        // A measured row carries its date; a chosen one does too.
        FeedRow {
            source: FeedSource::Measured,
            set_at: Some("2026-10-15T00:00:00.000Z".into()),
            ..a_row("feed-measured")
        }
        .validate()
        .unwrap();
        FeedRow {
            source: FeedSource::Chosen,
            set_at: Some("2026-10-15T00:00:00.000Z".into()),
            note: Some("stepped down for the 0.6 mm corn cutter".into()),
            ..a_row("feed-chosen")
        }
        .validate()
        .unwrap();
    }

    #[test]
    fn a_row_the_table_cannot_use_is_refused() {
        let cases: Vec<(&str, FeedRow)> = vec![
            ("no material", FeedRow { material: " ".into(), ..a_row("x") }),
            ("a diameter at zero", FeedRow { min_diameter: 0.0, ..a_row("x") }),
            ("a diameter below zero", FeedRow { max_diameter: -1.0, ..a_row("x") }),
            ("diameters inside out", FeedRow { min_diameter: 3.2, max_diameter: 1.6, ..a_row("x") }),
            ("a zero rpm", FeedRow { params: FeedParams { rpm: 0.0, ..params() }, ..a_row("x") }),
            ("a negative feed", FeedRow { params: FeedParams { feed: -1.0, ..params() }, ..a_row("x") }),
            ("a zero step-over fraction", FeedRow {
                params: FeedParams { step_over_fraction: 0.0, ..params() },
                ..a_row("x")
            }),
            ("a chosen row with no date", FeedRow { source: FeedSource::Chosen, ..a_row("x") }),
            ("a measured row with a blank date", FeedRow {
                source: FeedSource::Measured,
                set_at: Some("  ".into()),
                ..a_row("x")
            }),
            ("no provenance", FeedRow { provenance: "  ".into(), ..a_row("x") }),
            ("a provenance past the sentence limit", FeedRow { provenance: "x".repeat(401), ..a_row("x") }),
            ("a note past the sentence limit", FeedRow { note: Some("x".repeat(401)), ..a_row("x") }),
            ("a note with a control character", FeedRow {
                note: Some("line\nbreak".into()),
                ..a_row("x")
            }),
            ("an id with a slash", FeedRow { id: "a/b".into(), ..a_row("x") }),
            ("an id with a trailing space", FeedRow { id: "feed ".into(), ..a_row("x") }),
        ];
        for (why, row) in cases {
            assert!(matches!(row.validate(), Err(HouseError::BadEntry(_))), "{why} was accepted");
        }
    }

    #[test]
    fn two_rows_that_claim_the_same_diameters_are_refused() {
        let flat = |id: &str, lo: f64, hi: f64| FeedRow {
            id: id.to_string(),
            min_diameter: lo,
            max_diameter: hi,
            ..a_row(id)
        };

        // An overlap: [0.8, 2.0] and [1.6, 3.2] share 1.6-2.0, so the answer depends on row order.
        assert!(validate_table(&[flat("feed-a", 0.8, 2.0), flat("feed-b", 1.6, 3.2)]).is_err());
        // The same range said twice.
        assert!(validate_table(&[flat("feed-a", 0.8, 1.6), flat("feed-b", 0.8, 1.6)]).is_err());
        // The same POINT range twice: no interior to overlap, still one row's worth said twice.
        assert!(validate_table(&[flat("feed-a", 1.0, 1.0), flat("feed-b", 1.0, 1.0)]).is_err());
        // One id, one row.
        assert!(validate_table(&[flat("feed-a", 0.8, 1.6), flat("feed-a", 1.6, 3.2)]).is_err());

        // TOUCHING at 1.6 is the table's shape, not a conflict: the first matching row wins, on purpose.
        validate_table(&[flat("feed-a", 0.8, 1.6), flat("feed-b", 1.6, 3.2)]).unwrap();
        // A different edge is a different row: a cone and a flat end mill want different numbers.
        validate_table(&[
            flat("feed-a", 0.8, 1.6),
            FeedRow { edge: Some(FeedEdge::V), ..flat("feed-v", 0.8, 1.6) },
        ])
        .unwrap();
        // And a different material is a different row.
        validate_table(&[
            flat("feed-a", 0.8, 1.6),
            FeedRow { material: "pla".into(), ..flat("feed-b", 0.8, 1.6) },
        ])
        .unwrap();
    }

    #[test]
    fn an_unknown_key_on_a_row_is_refused() {
        let mut v = serde_json::to_value(a_row("feed-1")).unwrap();
        v["pressure"] = serde_json::json!(0.5);
        let err = serde_json::from_value::<FeedRow>(v).unwrap_err().to_string();
        assert!(err.contains("pressure"), "{err}");

        let mut v = serde_json::to_value(a_row("feed-1")).unwrap();
        v["params"]["dwell"] = serde_json::json!(1);
        assert!(serde_json::from_value::<FeedRow>(v).is_err());
    }

    /// The seeded table is a valid table: twelve rows, all `seeded` (so no date), each labelled
    /// unmeasured in its own provenance. This is the property a fresh location depends on.
    #[test]
    fn the_seed_rows_are_a_valid_unmeasured_table() {
        let rows = seeded_rows();
        validate_table(&rows).unwrap();
        assert_eq!(rows.len(), 12);
        assert!(rows.iter().all(|r| r.source == FeedSource::Seeded && r.set_at.is_none()));
        assert!(rows.iter().all(|r| !r.provenance.trim().is_empty()));
    }

    /// An empty table is a location from before #450, and gets the seeds; a table with a row is the
    /// shop's own and is left exactly as it is (removing a row must stick).
    #[test]
    fn an_empty_table_is_seeded_and_a_non_empty_one_is_not_added_to() {
        let mut empty = Vec::new();
        add_missing_seeds(&mut empty);
        assert_eq!(empty, seeded_rows());

        let mut one = vec![a_row("feed-mine")];
        add_missing_seeds(&mut one);
        assert_eq!(one, vec![a_row("feed-mine")]);
    }

    /// `tests/unit/fixtures/feed-table.json`: the ONE specimen BOTH sides read — the good rows this
    /// service accepts and the tables it refuses. `feedTable.spec.ts` reads the same file through the
    /// Zod schema, so a key this side spells differently from the client fails one reader rather than
    /// passing both. A case marked `"zodOnly": true` is a rule only the client holds (the material
    /// vocabulary), as `stock-refusals.json` marks its own.
    ///
    /// #450 slice 3: the specimen's `good` list IS the seed — the rows a fresh location holds and the
    /// compiled table's values — so this also holds the Rust seed to the client's fixture, row for row
    /// and key for key.
    #[test]
    fn the_shared_specimen_is_the_shape_the_client_parses() {
        let path =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/unit/fixtures/feed-table.json");
        let doc: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();

        // Every good row is a table this side accepts, and it round-trips to the SAME JSON: the keys
        // the client parses are exactly the keys serde writes, null-valued options included.
        let good: Vec<FeedRow> = serde_json::from_value(doc["good"].clone()).unwrap();
        validate_table(&good).unwrap();
        for (row, raw) in good.iter().zip(doc["good"].as_array().unwrap()) {
            assert_eq!(serde_json::to_value(row).unwrap(), *raw, "a row does not round-trip");
        }
        assert!(good.len() >= 12, "the specimen should carry the twelve starting rows");
        assert_eq!(
            serde_json::to_value(seeded_rows()).unwrap(),
            doc["good"],
            "the seeded table is the shared specimen's good rows, byte for byte"
        );

        // Every refused table is refused here: either the parse (a shape serde cannot hold) or the
        // rules. The `zodOnly` cases are the client's alone and are skipped.
        let mut checked = 0;
        for case in doc["refused"].as_array().unwrap() {
            if case["zodOnly"].as_bool() == Some(true) {
                continue;
            }
            let why = case["why"].as_str().unwrap();
            let refused = match serde_json::from_value::<Vec<FeedRow>>(case["rows"].clone()) {
                Err(_) => true,
                Ok(rows) => validate_table(&rows).is_err(),
            };
            assert!(refused, "{why} was accepted");
            checked += 1;
        }
        assert!(checked >= 6, "the specimen should carry the shared refusals ({checked})");
    }
}
