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
}

pub type ShopDefaults = BTreeMap<String, ShopDefault>;

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
];

pub fn seeded() -> ShopDefaults {
    let mut map = ShopDefaults::new();
    add_missing_seeds(&mut map);
    map
}

/// Fill in any seed the map does not have. Returns whether anything was added.
pub fn add_missing_seeds(map: &mut ShopDefaults) -> bool {
    let mut added = false;
    for (key, value, unit) in SEEDS {
        if !map.contains_key(*key) {
            map.insert(
                (*key).to_string(),
                ShopDefault {
                    value: serde_json::json!(value),
                    source: DefaultSource::Seeded,
                    set_at: None,
                    unit: Some((*unit).to_string()),
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
    let need = |ok: bool, what: &str| if ok { Ok(()) } else { Err(format!("{key} must be {what}")) };
    match key {
        "power.onWaitSeconds" => Some(need(n.is_some_and(|v| (10.0..=1800.0).contains(&v)), "10 to 1800 seconds")),
        "wasteboard.depthLimitMm" => Some(need(n.is_some_and(|v| (0.0..=50.0).contains(&v)), "0 to 50 mm")),
        "tools.runtimeWarnMinutes" => Some(need(n.is_some_and(|v| v > 0.0 && v <= 100_000.0), "above 0, up to 100000 minutes")),
        _ => None,
    }
}

/// The most keys the section holds, and the longest unit. Caps, so a client cannot grow the
/// document without bound (#416/#417 review).
pub const MAX_KEYS: usize = 200;
pub const MAX_UNIT: usize = 16;

/// The seed for `key`, if it has one.
pub fn seed_of(key: &str) -> Option<f64> {
    SEEDS.iter().find(|(k, _, _)| *k == key).map(|(_, v, _)| *v)
}

/// A WRITE's extra rule (#416/#417 review): `seeded` is the app's own word for its starting value, so
/// a client may only say it about a key that HAS a seed, with exactly the seed's value. Anything else
/// it sets is `chosen` or `measured`, dated.
pub fn validate_write(key: &str, d: &ShopDefault) -> Result<(), HouseError> {
    validate_one(key, d)?;
    if d.source == DefaultSource::Seeded && seed_of(key).is_none_or(|seed| d.value.as_f64() != Some(seed)) {
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
    if d.unit.as_deref().is_some_and(|u| u.len() > MAX_UNIT || u.chars().any(char::is_control)) {
        return bad(format!("a unit is a short word ({MAX_UNIT} characters at most)"));
    }
    if d.source != DefaultSource::Seeded && d.set_at.as_deref().is_none_or(|s| s.trim().is_empty()) {
        return bad("a chosen or measured value says when it was set".into());
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
    map.iter().try_for_each(|(k, d)| validate_one(k, d))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chosen(v: serde_json::Value) -> ShopDefault {
        ShopDefault { value: v, source: DefaultSource::Chosen, set_at: Some("2026-10-15T00:00:00.000Z".into()), unit: None }
    }

    #[test]
    fn the_seeds_are_valid_and_labelled() {
        let s = seeded();
        validate_all(&s).unwrap();
        assert!(s.values().all(|d| d.source == DefaultSource::Seeded));
        assert_eq!(s["power.onWaitSeconds"].value, serde_json::json!(180.0));
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
        let undated = ShopDefault { set_at: None, ..chosen(serde_json::json!(1)) };
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
        let seeded = |v: serde_json::Value| ShopDefault { value: v, source: DefaultSource::Seeded, set_at: None, unit: None };
        validate_write("power.onWaitSeconds", &seeded(serde_json::json!(180.0))).unwrap();
        assert!(validate_write("power.onWaitSeconds", &seeded(serde_json::json!(600))).is_err(), "a faked seed");
        assert!(validate_write("rest.overlapMm", &seeded(serde_json::json!(0.5))).is_err(), "no seed to claim");
        let long_unit = ShopDefault { unit: Some("millimetres-per-minute".into()), ..chosen(serde_json::json!(1)) };
        assert!(validate_one("rest.overlapMm", &long_unit).is_err());
        let mut many = seeded_map();
        for i in 0..MAX_KEYS {
            many.insert(format!("x.k{i}"), chosen(serde_json::json!(1)));
        }
        assert!(validate_all(&many).is_err());
    }

    fn seeded_map() -> ShopDefaults {
        seeded()
    }
}
