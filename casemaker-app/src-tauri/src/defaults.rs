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
pub const MEASURED_SEEDS: &[(&str, f64, &str, &str, &str)] = &[(
    "registration.tipRadiusMm",
    0.7,
    "mm",
    "2026-10-15T19:03:20.874Z",
    "effective rim offset of the wired probe, from the 2026-10-15 bench scan (trace 18:59-19:03): \
     the 38.1 mm blank read 39.5 mm wide, (39.5 - 38.1) / 2 = 0.70 mm, +/- 0.25 at a 0.5 mm step; \
     the tip's outside diameter is 2.0 mm",
)];

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
                    note: None,
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
    let need = |ok: bool, what: &str| if ok { Ok(()) } else { Err(format!("{key} must be {what}")) };
    match key {
        "power.onWaitSeconds" => Some(need(n.is_some_and(|v| (10.0..=1800.0).contains(&v)), "10 to 1800 seconds")),
        "wasteboard.depthLimitMm" => Some(need(n.is_some_and(|v| (0.0..=50.0).contains(&v)), "0 to 50 mm")),
        "registration.capBelowSurfaceMm" => Some(need(n.is_some_and(|v| (0.1..=1.0).contains(&v)), "0.1 to 1 mm")),
        "registration.coarseStepMm" => Some(need(n.is_some_and(|v| (0.1..=10.0).contains(&v)), "0.1 to 10 mm")),
        "registration.fineStepMm" => Some(need(n.is_some_and(|v| (0.05..=5.0).contains(&v)), "0.05 to 5 mm")),
        "registration.parkAboveSurfaceMm" => Some(need(n.is_some_and(|v| (2.0..=30.0).contains(&v)), "2 to 30 mm")),
        "registration.scanInsideMm" => Some(need(n.is_some_and(|v| (0.5..=30.0).contains(&v)), "0.5 to 30 mm")),
        "registration.scanReachMm" => Some(need(n.is_some_and(|v| (0.5..=50.0).contains(&v)), "0.5 to 50 mm")),
        "registration.cornerClearanceMm" => Some(need(n.is_some_and(|v| (0.0..=30.0).contains(&v)), "0 to 30 mm")),
        "registration.surfaceBandMm" => Some(need(n.is_some_and(|v| (0.01..=1.0).contains(&v)), "0.01 to 1 mm")),
        "registration.tipRadiusMm" => Some(need(n.is_some_and(|v| (0.0..=3.0).contains(&v)), "0 to 3 mm")),
        "registration.surfaceToleranceMm" => Some(need(n.is_some_and(|v| (0.05..=10.0).contains(&v)), "0.05 to 10 mm")),
        "registration.edgeMarginMm" => Some(need(n.is_some_and(|v| (0.01..=20.0).contains(&v)), "0.01 to 20 mm")),
        "registration.surfaceSeekMm" => Some(need(n.is_some_and(|v| (1.0..=100.0).contains(&v)), "1 to 100 mm")),
        "registration.touchFeed" => Some(need(n.is_some_and(|v| (10.0..=1000.0).contains(&v)), "10 to 1000 mm/min")),
        "registration.surfaceFastFeed" => Some(need(n.is_some_and(|v| (10.0..=1000.0).contains(&v)), "10 to 1000 mm/min")),
        "run.pollMs" => Some(need(n.is_some_and(|v| (2000.0..=60000.0).contains(&v)), "2000 to 60000 ms — never faster than 2 s (#386)")),
        "run.noProgressMs" => Some(need(n.is_some_and(|v| (15000.0..=600000.0).contains(&v)), "15000 to 600000 ms")),
        "run.missLimit" => Some(need(n.is_some_and(|v| (1.0..=10.0).contains(&v) && v.fract() == 0.0), "a whole number of polls, 1 to 10")),
        "registration.surfaceSlowFeed" => Some(need(n.is_some_and(|v| (5.0..=500.0).contains(&v)), "5 to 500 mm/min")),
        "tools.runtimeWarnMinutes" => Some(need(n.is_some_and(|v| v > 0.0 && v <= 100_000.0), "above 0, up to 100000 minutes")),
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
    if d.note.as_deref().is_some_and(|n| n.len() > 400 || n.chars().any(char::is_control)) {
        return bad("a note is a sentence of at most 400 characters".into());
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
    map.iter().try_for_each(|(k, d)| validate_one(k, d))?;
    // #430 review: the surface band must be inside the touch cap, or a hit at the cap's depth could
    // read as "on the stock".
    let num = |k: &str| map.get(k).and_then(|d| d.value.as_f64());
    if let (Some(band), Some(cap)) = (num("registration.surfaceBandMm"), num("registration.capBelowSurfaceMm")) {
        if band >= cap {
            return Err(HouseError::BadEntry(format!(
                "registration.surfaceBandMm ({band}) must be less than registration.capBelowSurfaceMm ({cap})"
            )));
        }
    }
    // The surface tolerance inside the park height, less a clearance: a surface found at the top of
    // the band must still leave the park above it (#430 re-review).
    if let (Some(tol), Some(park)) = (num("registration.surfaceToleranceMm"), num("registration.parkAboveSurfaceMm")) {
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
        ShopDefault { value: v, source: DefaultSource::Chosen, set_at: Some("2026-10-15T00:00:00.000Z".into()), unit: None, note: None }
    }

    #[test]
    fn the_seeds_are_valid_and_labelled() {
        let s = seeded();
        validate_all(&s).unwrap();
        // Every chosen seed is `seeded`; the measured one says it was measured, when, and how.
        for (k, d) in &s {
            if MEASURED_SEEDS.iter().any(|(m, ..)| m == k) {
                assert_eq!(d.source, DefaultSource::Measured, "{k}");
                assert!(d.set_at.is_some() && d.note.as_deref().is_some_and(|n| n.contains("2026-10-15")), "{k}");
            } else {
                assert_eq!(d.source, DefaultSource::Seeded, "{k}");
            }
        }
        let mut band_over_cap = s.clone();
        band_over_cap.insert("registration.surfaceBandMm".into(), ShopDefault { value: serde_json::json!(0.5), ..s["registration.surfaceBandMm"].clone() });
        assert!(validate_all(&band_over_cap).is_err(), "a band as deep as the cap");
        let mut tol_over_park = s.clone();
        tol_over_park.insert("registration.surfaceToleranceMm".into(), ShopDefault { value: serde_json::json!(2.6), ..s["registration.surfaceToleranceMm"].clone() });
        assert!(validate_all(&tol_over_park).is_err(), "a tolerance that reaches the park height");
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
        let seeded = |v: serde_json::Value| ShopDefault { value: v, source: DefaultSource::Seeded, set_at: None, unit: None, note: None };
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
