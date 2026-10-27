// The stock shelf (#413, `docs/design/cnc-job-workflow.md` §3.1, §5.1; decisions Q2, Q6, Q20): the
// material on hand at the location, kept in `location.json` beside the machines and the tools.
//
// WHAT IS CHECKED HERE AND WHAT IS NOT. This side holds the SHAPE of an entry to the rules a shelf
// needs to stay usable: the dimensions a form needs and no others, layers that fit inside the
// stock, a domed flatness that says how domed, reservations that never exceed what is on the
// shelf. The MATERIAL word is the client's vocabulary (`engine/cnc/materials.ts`) and is only
// checked to be a plain non-empty word here — a second copy of that list would be a second place to
// drift, and the client reads entries one at a time so an unknown word costs one entry, not the
// shelf (the same split `location.rs` uses for a machine's sections).
//
// A SPHERE IS REFUSED, BY NAME (Q20): nothing at the location holds one and nothing cuts one. It is
// a refusal with a reason rather than an unknown variant, so the sentence a user sees says why.

use crate::house::HouseError;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// The forms a shelf entry can take (#413). `sphere` is NOT here: see `StockItem::validate`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StockForm {
    Sheet,
    Plate,
    Block,
    Rod,
    Tube,
    Disc,
    PrintedBlank,
}

/// The surface the stock arrives with — the input to the facing default (Q6): rough or unknown →
/// face it; finished sheet or a printed blank → do not.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StockFinish {
    Rough,
    Finished,
    Printed,
    Unknown,
}

/// Flat, domed by a stated height, or not known — the input to the auto-level default (Q13).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StockFlatness {
    Flat,
    Domed,
    Unknown,
}

/// Where the entry came from (§3.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StockSource {
    Purchased,
    Printed,
    Offcut,
    Other,
}

/// Where a laminate's cap came from (#492). `assumed` is a number nobody has measured; `measured`
/// is a bench or datasheet reading. A printed blank's colour facts are the JOB's, not the shelf's.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StockCapSource {
    Assumed,
    Measured,
}

/// The dimensions, in mm. Which are required depends on the form, and the rest must be absent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StockSize {
    #[serde(default)]
    pub length: Option<f64>,
    #[serde(default)]
    pub width: Option<f64>,
    #[serde(default)]
    pub thickness: Option<f64>,
    #[serde(default)]
    pub diameter: Option<f64>,
    /// A tube's wall thickness (#713). `wall`, not an inner diameter: it is the fact the job writes
    /// and the number a cut depth is capped by.
    #[serde(default)]
    pub wall: Option<f64>,
    /// LEGACY, READ-ONLY (#713 review): a tube stored before the rename carries its inner diameter
    /// here. Read on the way in, converted to `wall` (see `effective_wall`) and never written
    /// again — `skip_serializing` keeps every save on `wall` alone. A record with both keys
    /// prefers `wall`.
    #[serde(default, skip_serializing)]
    pub inner_diameter: Option<f64>,
}

impl StockSize {
    /// A tube's wall: stated, or derived from a legacy inner diameter as `(outer − inner) / 2`.
    /// The derivation is the read path's, so an old shelf row validates exactly like a new one —
    /// including an inside-out legacy tube, whose derived wall fails the same positivity/bore
    /// checks with the same words.
    fn effective_wall(&self) -> Option<f64> {
        self.wall.or_else(|| match (self.diameter, self.inner_diameter) {
            (Some(outer), Some(inner)) => Some((outer - inner) / 2.0),
            _ => None,
        })
    }
}

/// One layer of a colour stack, from the top down (the two-colour blank, laminated acrylic).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StockLayer {
    pub name: String,
    pub thickness: f64,
}

/// A count held for, or taken by, one job.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StockClaim {
    pub job_id: String,
    pub quantity: u32,
    /// ISO timestamp, the client's clock.
    pub at: String,
}

/// One entry on the shelf.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StockItem {
    /// Ours, minted by the client. Unique on the shelf; also the URL segment a write names.
    pub id: String,
    pub material: String,
    pub form: String,
    pub size: StockSize,
    #[serde(default)]
    pub layers: Vec<StockLayer>,
    /// The top colour's thickness from the top face, mm (#492) — a purchased laminate's cap. Absent
    /// on every other entry. It is not a layer: a cap and printed layers may not both be stated.
    #[serde(default)]
    pub cap_mm: Option<f64>,
    /// Where that cap came from (#492). Present exactly when `cap_mm` is.
    #[serde(default)]
    pub cap_source: Option<StockCapSource>,
    pub finish: StockFinish,
    pub flatness: StockFlatness,
    /// The dome's height in mm. Required when `flatness` is `domed`, absent otherwise.
    #[serde(default)]
    pub dome_height: Option<f64>,
    pub conductive: bool,
    /// How many are on the shelf. 0 is legal: a consumed entry stays listed until it is removed.
    pub quantity: u32,
    #[serde(default)]
    pub reservations: Vec<StockClaim>,
    #[serde(default)]
    pub consumed: Vec<StockClaim>,
    pub source: StockSource,
    #[serde(default)]
    pub notes: Option<String>,
    /// ISO timestamp, the client's clock: when it was put on the shelf.
    pub added_at: String,
}

fn bad(id: &str, why: impl std::fmt::Display) -> HouseError {
    HouseError::BadEntry(format!("stock {id}: {why}"))
}

fn positive(id: &str, what: &str, v: Option<f64>) -> Result<f64, HouseError> {
    match v {
        Some(x) if x.is_finite() && x > 0.0 => Ok(x),
        Some(x) => Err(bad(id, format!("{what} must be a positive number of mm, not {x}"))),
        None => Err(bad(id, format!("a {what} is needed for this form"))),
    }
}

impl StockForm {
    fn parse(id: &str, form: &str) -> Result<StockForm, HouseError> {
        if form == "sphere" {
            // Q20. A refusal with a reason, not an unknown word.
            return Err(bad(
                id,
                "sphere stock is not offered — nothing at the location holds one and nothing here \
                 cuts one",
            ));
        }
        serde_json::from_value(serde_json::Value::String(form.to_string())).map_err(|_| {
            bad(
                id,
                format!(
                    "{form:?} is not a stock form — sheet, plate, block, rod, tube, disc or \
                     printed-blank"
                ),
            )
        })
    }

    /// Whether the form has a flat top a colour stack can sit in.
    fn is_flat(self) -> bool {
        !matches!(self, StockForm::Rod | StockForm::Tube)
    }
}

impl StockItem {
    pub(crate) fn validate(&self) -> Result<(), HouseError> {
        let id = self.id.as_str();
        if id.trim().is_empty() || id != id.trim() || id.contains('/') || id.chars().any(char::is_control) {
            return Err(HouseError::BadEntry(format!(
                "{id:?} cannot be a stock id: not empty, no slash, no control character, no space at \
                 either end"
            )));
        }
        if self.material.trim().is_empty() || self.material.chars().any(char::is_control) {
            return Err(bad(id, "it names no material"));
        }
        if self.added_at.trim().is_empty() {
            return Err(bad(id, "it does not say when it was put on the shelf"));
        }
        let form = StockForm::parse(id, &self.form)?;

        // The dimensions this form needs, and nothing else.
        let s = &self.size;
        let (needed, thickness): (&[&str], Option<f64>) = match form {
            StockForm::Sheet | StockForm::Plate | StockForm::Block | StockForm::PrintedBlank => {
                positive(id, "length", s.length)?;
                positive(id, "width", s.width)?;
                let t = positive(id, "thickness", s.thickness)?;
                (&["length", "width", "thickness"], Some(t))
            }
            StockForm::Rod => {
                positive(id, "diameter", s.diameter)?;
                positive(id, "length", s.length)?;
                (&["diameter", "length"], None)
            }
            StockForm::Tube => {
                let outer = positive(id, "diameter", s.diameter)?;
                let wall = positive(id, "wall", s.effective_wall())?;
                positive(id, "length", s.length)?;
                if 2.0 * wall >= outer {
                    return Err(bad(id, "a tube's wall must leave a bore — two walls are less than its outer diameter"));
                }
                (&["diameter", "wall", "length"], None)
            }
            StockForm::Disc => {
                positive(id, "diameter", s.diameter)?;
                let t = positive(id, "thickness", s.thickness)?;
                (&["diameter", "thickness"], Some(t))
            }
        };
        for (name, value) in [
            ("length", s.length),
            ("width", s.width),
            ("thickness", s.thickness),
            ("diameter", s.diameter),
            ("wall", s.wall),
        ] {
            if value.is_some() && !needed.contains(&name) {
                return Err(bad(id, format!("a {} has no {name}", self.form)));
            }
        }

        // Layers: only on a flat top, each a named positive thickness, together inside the stock.
        if !self.layers.is_empty() {
            let Some(total) = thickness.filter(|_| form.is_flat()) else {
                return Err(bad(id, format!("a {} has no flat top to carry layers", self.form)));
            };
            let mut sum = 0.0;
            for l in &self.layers {
                if l.name.trim().is_empty() {
                    return Err(bad(id, "a layer has no name"));
                }
                if !(l.thickness.is_finite() && l.thickness > 0.0) {
                    return Err(bad(id, format!("layer {:?} has no positive thickness", l.name)));
                }
                sum += l.thickness;
            }
            if sum > total + 1e-9 {
                return Err(bad(
                    id,
                    format!("its layers come to {sum} mm, more than the {total} mm stock"),
                ));
            }
        }

        // A purchased laminate's colour cap (#492): a flat top, a thickness to measure from, a
        // positive cap inside the stock, and no printed layers. The two descriptions of a colour
        // plane are mutually exclusive here, so the job never has to choose between them silently.
        match (self.cap_mm, self.cap_source) {
            (Some(cap), Some(_)) => {
                let Some(total) = thickness.filter(|_| form.is_flat()) else {
                    return Err(bad(id, format!("a {} has no flat top to carry a colour cap", self.form)));
                };
                if !(cap.is_finite() && cap > 0.0) {
                    return Err(bad(id, format!("the colour cap must be above 0 mm, not {cap}")));
                }
                if cap > total + 1e-9 {
                    return Err(bad(
                        id,
                        format!("a {cap} mm colour cap is thicker than the {total} mm stock"),
                    ));
                }
                if !self.layers.is_empty() {
                    return Err(bad(id, "a laminate has no printed layers"));
                }
                if form == StockForm::PrintedBlank {
                    return Err(bad(
                        id,
                        "a printed blank states its colour in the job, not as a shelf cap",
                    ));
                }
            }
            (Some(_), None) => {
                return Err(bad(id, "a colour cap states where it came from, assumed or measured"));
            }
            (None, Some(_)) => {
                return Err(bad(id, "only an entry with a colour cap states a cap source"));
            }
            (None, None) => {}
        }

        match (self.flatness, self.dome_height) {
            (StockFlatness::Domed, Some(h)) if h.is_finite() && h > 0.0 => {}
            (StockFlatness::Domed, _) => {
                return Err(bad(id, "domed stock needs the dome's height, in mm"));
            }
            (_, Some(_)) => return Err(bad(id, "only domed stock has a dome height")),
            _ => {}
        }

        // Claims: each names a job and a count; one reservation per job; never more held than there is.
        let mut jobs = HashSet::new();
        let mut held: u64 = 0;
        for r in &self.reservations {
            Self::claim_ok(id, r)?;
            if !jobs.insert(r.job_id.as_str()) {
                return Err(bad(id, format!("job {} holds two reservations", r.job_id)));
            }
            held += u64::from(r.quantity);
        }
        if held > u64::from(self.quantity) {
            return Err(bad(
                id,
                format!("{held} reserved, but only {} on the shelf", self.quantity),
            ));
        }
        for c in &self.consumed {
            Self::claim_ok(id, c)?;
        }
        Ok(())
    }

    fn claim_ok(id: &str, c: &StockClaim) -> Result<(), HouseError> {
        if c.job_id.trim().is_empty() || c.quantity == 0 || c.at.trim().is_empty() {
            return Err(bad(id, "a reservation or a use names no job, no count or no time"));
        }
        Ok(())
    }
}

/// The whole shelf: every entry on its own, and one id per entry.
pub(crate) fn validate_shelf(stock: &[StockItem]) -> Result<(), HouseError> {
    let mut ids = HashSet::new();
    for item in stock {
        item.validate()?;
        if !ids.insert(item.id.as_str()) {
            return Err(HouseError::BadEntry(format!(
                "stock {} appears twice: one id, one entry",
                item.id
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn a_plate(id: &str) -> StockItem {
        StockItem {
            id: id.to_string(),
            material: "aluminium-6061".into(),
            form: "plate".into(),
            size: StockSize {
                length: Some(100.0),
                width: Some(100.0),
                thickness: Some(5.0),
                ..StockSize::default()
            },
            layers: vec![],
            cap_mm: None,
            cap_source: None,
            finish: StockFinish::Rough,
            flatness: StockFlatness::Flat,
            dome_height: None,
            conductive: true,
            quantity: 2,
            reservations: vec![],
            consumed: vec![],
            source: StockSource::Purchased,
            notes: None,
            added_at: "2026-10-15T00:00:00.000Z".into(),
        }
    }

    fn claim(job: &str, n: u32) -> StockClaim {
        StockClaim { job_id: job.into(), quantity: n, at: "2026-10-15T01:00:00.000Z".into() }
    }

    #[test]
    fn a_plate_rod_tube_and_two_colour_blank_are_accepted() {
        a_plate("s-1").validate().unwrap();
        StockItem {
            form: "rod".into(),
            size: StockSize { diameter: Some(10.0), length: Some(100.0), ..StockSize::default() },
            ..a_plate("s-2")
        }
        .validate()
        .unwrap();
        StockItem {
            form: "tube".into(),
            size: StockSize {
                diameter: Some(20.0),
                wall: Some(2.0),
                length: Some(100.0),
                ..StockSize::default()
            },
            ..a_plate("s-3")
        }
        .validate()
        .unwrap();
        StockItem {
            material: "pla".into(),
            form: "printed-blank".into(),
            size: StockSize {
                length: Some(60.0),
                width: Some(30.0),
                thickness: Some(3.0),
                ..StockSize::default()
            },
            layers: vec![
                StockLayer { name: "white".into(), thickness: 0.6 },
                StockLayer { name: "black".into(), thickness: 2.4 },
            ],
            finish: StockFinish::Printed,
            flatness: StockFlatness::Domed,
            dome_height: Some(0.2),
            conductive: false,
            source: StockSource::Printed,
            ..a_plate("s-4")
        }
        .validate()
        .unwrap();
        // #492 — a purchased two-colour laminate: a stated cap, no layers.
        StockItem {
            material: "plastic".into(),
            form: "sheet".into(),
            size: StockSize {
                length: Some(76.0),
                width: Some(25.35),
                thickness: Some(1.5),
                ..StockSize::default()
            },
            cap_mm: Some(0.075),
            cap_source: Some(StockCapSource::Assumed),
            finish: StockFinish::Finished,
            conductive: false,
            source: StockSource::Purchased,
            ..a_plate("s-5")
        }
        .validate()
        .unwrap();
    }

    #[test]
    fn a_colour_cap_outside_its_rules_is_refused() {
        let laminate = StockItem {
            form: "sheet".into(),
            cap_mm: Some(0.075),
            cap_source: Some(StockCapSource::Assumed),
            ..a_plate("s-1")
        };
        laminate.clone().validate().unwrap();
        let cases: Vec<(&str, StockItem)> = vec![
            ("a cap without a source", StockItem { cap_source: None, ..laminate.clone() }),
            ("a source without a cap", StockItem { cap_mm: None, ..laminate.clone() }),
            ("a cap thicker than the stock", StockItem { cap_mm: Some(50.0), ..laminate.clone() }),
            ("a zero cap", StockItem { cap_mm: Some(0.0), ..laminate.clone() }),
            (
                "a cap beside printed layers",
                StockItem {
                    layers: vec![StockLayer { name: "top".into(), thickness: 0.5 }],
                    ..laminate.clone()
                },
            ),
            ("a cap on a rod", StockItem {
                form: "rod".into(),
                size: StockSize { diameter: Some(10.0), length: Some(100.0), ..StockSize::default() },
                ..laminate.clone()
            }),
            ("a cap on a printed blank", StockItem { form: "printed-blank".into(), ..laminate }),
        ];
        for (why, item) in cases {
            assert!(matches!(item.validate(), Err(HouseError::BadEntry(_))), "{why} was accepted");
        }
    }

    #[test]
    fn a_legacy_tube_reads_its_inner_diameter_as_a_wall() {
        // #713 review — a row stored before the rename carries `innerDiameter` and no `wall`.
        let json = r#"{
            "id": "old-tube",
            "material": "pla",
            "form": "tube",
            "size": { "diameter": 20.0, "innerDiameter": 16.0, "length": 100.0 },
            "finish": "rough",
            "flatness": "flat",
            "conductive": false,
            "quantity": 1,
            "source": "other",
            "addedAt": "2026-10-01T00:00:00.000Z"
        }"#;
        let item: StockItem = serde_json::from_str(json).expect("a legacy tube deserialises");
        item.validate().expect("a legacy tube with a real wall loads");
        assert_eq!(item.size.effective_wall(), Some(2.0));
        // It is READ-ONLY: the saved record carries `wall` and never the legacy key again.
        let saved = serde_json::to_value(StockSize {
            wall: Some(2.0),
            inner_diameter: Some(16.0),
            ..StockSize::default()
        })
        .unwrap();
        assert!(saved.get("wall").is_some());
        assert!(saved.get("innerDiameter").is_none(), "{saved}");
    }

    #[test]
    fn a_tube_with_both_keys_prefers_the_wall() {
        let json = r#"{
            "id": "both-tube",
            "material": "pla",
            "form": "tube",
            "size": { "diameter": 20.0, "wall": 2.5, "innerDiameter": 16.0, "length": 100.0 },
            "finish": "rough",
            "flatness": "flat",
            "conductive": false,
            "quantity": 1,
            "source": "other",
            "addedAt": "2026-10-01T00:00:00.000Z"
        }"#;
        let item: StockItem = serde_json::from_str(json).expect("both keys deserialise");
        item.validate().expect("the stated wall is the one that counts");
        assert_eq!(item.size.effective_wall(), Some(2.5));
    }

    #[test]
    fn an_inside_out_legacy_tube_is_refused_in_words() {
        // The derived wall is ≤ 0, so the same positivity rule refuses it, with the same sentence.
        let json = r#"{
            "id": "bad-tube",
            "material": "pla",
            "form": "tube",
            "size": { "diameter": 16.0, "innerDiameter": 20.0, "length": 100.0 },
            "finish": "rough",
            "flatness": "flat",
            "conductive": false,
            "quantity": 1,
            "source": "other",
            "addedAt": "2026-10-01T00:00:00.000Z"
        }"#;
        let item: StockItem = serde_json::from_str(json).expect("the record still deserialises");
        let err = item.validate().unwrap_err();
        assert!(err.to_string().contains("wall"), "{err}");
    }

    #[test]
    fn a_sphere_is_refused_with_its_reason() {
        let err = StockItem { form: "sphere".into(), ..a_plate("s-1") }.validate().unwrap_err();
        assert!(err.to_string().contains("sphere stock is not offered"), "{err}");
        let err = StockItem { form: "cone".into(), ..a_plate("s-1") }.validate().unwrap_err();
        assert!(err.to_string().contains("not a stock form"), "{err}");
    }

    #[test]
    fn an_entry_the_shelf_cannot_use_is_refused() {
        let cases: Vec<(&str, StockItem)> = vec![
            ("no width", StockItem { size: StockSize { width: None, ..a_plate("x").size }, ..a_plate("x") }),
            ("a plate with a diameter", StockItem {
                size: StockSize { diameter: Some(3.0), ..a_plate("x").size },
                ..a_plate("x")
            }),
            ("a negative length", StockItem {
                size: StockSize { length: Some(-1.0), ..a_plate("x").size },
                ..a_plate("x")
            }),
            ("a tube with no bore", StockItem {
                form: "tube".into(),
                size: StockSize {
                    diameter: Some(10.0),
                    wall: Some(6.0),
                    length: Some(5.0),
                    ..StockSize::default()
                },
                ..a_plate("x")
            }),
            ("layers thicker than the stock", StockItem {
                layers: vec![StockLayer { name: "top".into(), thickness: 6.0 }],
                ..a_plate("x")
            }),
            ("layers on a rod", StockItem {
                form: "rod".into(),
                size: StockSize { diameter: Some(10.0), length: Some(100.0), ..StockSize::default() },
                layers: vec![StockLayer { name: "top".into(), thickness: 1.0 }],
                ..a_plate("x")
            }),
            ("domed without a height", StockItem { flatness: StockFlatness::Domed, ..a_plate("x") }),
            ("a height on flat stock", StockItem { dome_height: Some(0.3), ..a_plate("x") }),
            ("more reserved than there is", StockItem {
                reservations: vec![claim("job-1", 2), claim("job-2", 1)],
                ..a_plate("x")
            }),
            ("one job, two reservations", StockItem {
                reservations: vec![claim("job-1", 1), claim("job-1", 1)],
                ..a_plate("x")
            }),
            ("a reservation of none", StockItem { reservations: vec![claim("job-1", 0)], ..a_plate("x") }),
            ("no material", StockItem { material: " ".into(), ..a_plate("x") }),
            ("an id with a slash", StockItem { id: "a/b".into(), ..a_plate("x") }),
        ];
        for (why, item) in cases {
            assert!(matches!(item.validate(), Err(HouseError::BadEntry(_))), "{why} was accepted");
        }
        let twice = vec![a_plate("s-1"), a_plate("s-1")];
        assert!(validate_shelf(&twice).is_err());
    }

    #[test]
    fn a_consumed_entry_at_zero_is_still_a_shelf_entry() {
        StockItem { quantity: 0, consumed: vec![claim("job-12", 2)], ..a_plate("s-1") }
            .validate()
            .unwrap();
    }

    #[test]
    fn an_unknown_key_on_an_entry_is_refused() {
        let mut v = serde_json::to_value(a_plate("s-1")).unwrap();
        v["voids"] = serde_json::json!([]);
        let err = serde_json::from_value::<StockItem>(v).unwrap_err().to_string();
        assert!(err.contains("voids"), "{err}");
    }
}
