// One physical copy of an inventory cutter, as the operator describes it (#415, decision Q4).
//
// ONLY THE COPIES SOMEBODY SAID SOMETHING ABOUT. An inventory item is one code and a `quantity`
// (#309); `copies` lists at most that many copies, each with the operator's condition and where it
// is. A copy with no entry has NO condition set and is in its box — nothing is guessed, and an
// inventory written before this field needs no migration.
//
// RUNTIME (#381, #414) is COUNTED BY CASE MAKER: minutes of cutting-feed time weighted by the material's
// wear weight, added when a run the app played finishes, to the copy recorded as in that machine. Jobs
// run from Makera Studio are not counted.
// It only warns past a threshold (Q4); it never changes the condition.

use crate::house::HouseError;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// The operator's word for a copy (Q4). Never set by runtime: runtime only warns.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Condition {
    New,
    Used,
    Worn,
    Broken,
}

/// Where a copy is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind", deny_unknown_fields)]
pub enum Whereabouts {
    /// In its box (the default for a copy with no entry). A STRUCT variant, not a unit one: an
    /// internally tagged unit variant ignores extra keys, and `{"kind":"box","x":1}` must be refused
    /// like any other unknown key (#415 review).
    Box {},
    /// Fitted in a machine of the location, by machine id.
    #[serde(rename_all = "camelCase")]
    Machine { machine_id: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolCopy {
    pub id: String,
    pub condition: Condition,
    pub whereabouts: Whereabouts,
    /// This cutter's own runtime-warning threshold, minutes — overrides the shop default
    /// `tools.runtimeWarnMinutes`.
    #[serde(default)]
    pub runtime_warn_minutes: Option<f64>,
    #[serde(default)]
    pub notes: Option<String>,
    /// Wear-minutes counted by Case Maker (#414): cutting minutes × the material's wear weight. Left out
    /// of the JSON while nothing has been counted, so such a file still imports into a build from before
    /// this field; once a copy carries a runtime, that older build refuses it as an unknown key.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_minutes: Option<f64>,
}

/// The most copies an item may describe, a cap well above any drawer. Stated in Zod too.
pub const MAX_COPIES: usize = 500;
/// The largest per-copy runtime-warning override, minutes — the shop default's own bound.
pub const MAX_WARN_MINUTES: f64 = 100_000.0;
/// The most runtime a copy may carry, minutes: a sanity bound (about nineteen years of cutting).
pub const MAX_RUNTIME_MINUTES: f64 = 10_000_000.0;

/// `copies` and `colletFits` on one item, against its `quantity`.
pub(crate) fn validate_copies(
    item_id: &str,
    quantity: u32,
    copies: &[ToolCopy],
    collet_fits: Option<&[String]>,
) -> Result<(), HouseError> {
    let bad = |why: String| Err(HouseError::BadEntry(format!("{item_id}: {why}")));
    if copies.len() > quantity as usize || copies.len() > MAX_COPIES {
        return bad(format!(
            "{} copies are described but only {quantity} are owned",
            copies.len()
        ));
    }
    let mut ids = HashSet::new();
    let mut machines = HashSet::new();
    for c in copies {
        if c.id.trim().is_empty() || c.id != c.id.trim() || c.id.chars().any(char::is_control) {
            return bad("a copy has no usable id".into());
        }
        if !ids.insert(c.id.as_str()) {
            return bad(format!("copy {} is described twice", c.id));
        }
        if let Whereabouts::Machine { machine_id } = &c.whereabouts {
            if machine_id.trim().is_empty() || machine_id.chars().any(char::is_control) {
                return bad(format!("copy {} is in a machine with no id", c.id));
            }
            if !machines.insert(machine_id.as_str()) {
                return bad(format!(
                    "two copies are in machine {machine_id} at once — a spindle holds one cutter"
                ));
            }
        }
        if let Some(m) = c.runtime_minutes {
            if !(m.is_finite() && (0.0..=MAX_RUNTIME_MINUTES).contains(&m)) {
                return bad(format!("copy {}'s runtime must be 0 to {MAX_RUNTIME_MINUTES} minutes", c.id));
            }
        }
        if let Some(m) = c.runtime_warn_minutes {
            if !(m.is_finite() && m > 0.0 && m <= MAX_WARN_MINUTES) {
                return bad(format!(
                    "copy {}'s runtime warning must be above 0 and at most {MAX_WARN_MINUTES} minutes",
                    c.id
                ));
            }
        }
    }
    if let Some(fits) = collet_fits {
        let mut seen = HashSet::new();
        for m in fits {
            if m.trim().is_empty() || m.chars().any(char::is_control) || !seen.insert(m.as_str()) {
                return bad("its collet-fit list names a machine twice, or names none".into());
            }
        }
    }
    Ok(())
}

/// The machine `item` claims a copy in that ANOTHER item already has a copy in (#415 review: a
/// spindle holds one cutter, whichever item it belongs to). `None` in the normal case.
pub(crate) fn machine_clash<'a>(
    inventory: &'a [crate::house::InventoryItem],
    item: &'a crate::house::InventoryItem,
) -> Option<&'a str> {
    item.copies.iter().find_map(|c| match &c.whereabouts {
        Whereabouts::Machine { machine_id } => inventory
            .iter()
            .filter(|other| other.id != item.id)
            .any(|other| {
                other.copies.iter().any(|o| {
                    matches!(&o.whereabouts, Whereabouts::Machine { machine_id: m } if m == machine_id)
                })
            })
            .then_some(machine_id.as_str()),
        Whereabouts::Box {} => None,
    })
}

/// A house import's items carry no copies and no collet fits (`build-house.ts` writes neither), and
/// an import REPLACES the inventory — so, without this, rebuilding the inventory would wipe every
/// condition the operator set (#415 review). For each incoming item that states NEITHER, the
/// current item with the same id lends its `copies` and `colletFits`.
///
/// THE RULE WHEN THE COUNT FELL. If the incoming `quantity` is below the number of copies carried,
/// copies are dropped until they fit: copies IN THEIR BOX first (a boxed copy is the one a smaller
/// count most plausibly lost), the last-listed first; copies in a machine only after every boxed one
/// is gone, again the last-listed first. An incoming item that states either field keeps what it
/// states — the file is then the authority for it.
pub(crate) fn carry_copies(
    current: &[crate::house::InventoryItem],
    incoming: &mut [crate::house::InventoryItem],
) {
    for item in incoming.iter_mut() {
        if !item.copies.is_empty() || item.collet_fits.is_some() {
            continue;
        }
        let Some(old) = current.iter().find(|o| o.id == item.id) else { continue };
        let mut copies = old.copies.clone();
        let limit = item.quantity as usize;
        while copies.len() > limit {
            let drop = copies
                .iter()
                .rposition(|c| matches!(c.whereabouts, Whereabouts::Box {}))
                .unwrap_or(copies.len() - 1);
            copies.remove(drop);
        }
        item.copies = copies;
        item.collet_fits = old.collet_fits.clone();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_is_bounded_and_left_out_when_never_counted() {
        let mut c = copy("a", Condition::Used, Whereabouts::Box {});
        let text = serde_json::to_string(&c).unwrap();
        assert!(!text.contains("runtimeMinutes"), "{text}");
        c.runtime_minutes = Some(12.5);
        let back: ToolCopy = serde_json::from_str(&serde_json::to_string(&c).unwrap()).unwrap();
        assert_eq!(back.runtime_minutes, Some(12.5));
        validate_copies("i", 1, &[c.clone()], None).unwrap();
        c.runtime_minutes = Some(-1.0);
        assert!(validate_copies("i", 1, &[c], None).is_err());
    }

    fn copy(id: &str, c: Condition, w: Whereabouts) -> ToolCopy {
        ToolCopy { id: id.into(), condition: c, whereabouts: w, runtime_warn_minutes: None, notes: None, runtime_minutes: None }
    }
    fn in_machine(m: &str) -> Whereabouts {
        Whereabouts::Machine { machine_id: m.into() }
    }

    #[test]
    fn copies_are_held_to_the_item() {
        let ok = vec![copy("a", Condition::Used, in_machine("m-1")), copy("b", Condition::Worn, Whereabouts::Box {})];
        validate_copies("inv-1", 3, &ok, Some(&["m-1".to_string()])).unwrap();
        // More copies than owned; one id twice; two in one spindle; a bad override; a fit named twice.
        assert!(validate_copies("inv-1", 1, &ok, None).is_err());
        assert!(validate_copies("inv-1", 3, &[copy("a", Condition::New, Whereabouts::Box {}), copy("a", Condition::New, Whereabouts::Box {})], None).is_err());
        assert!(validate_copies("inv-1", 3, &[copy("a", Condition::New, in_machine("m-1")), copy("b", Condition::New, in_machine("m-1"))], None).is_err());
        let mut over = copy("a", Condition::New, Whereabouts::Box {});
        over.runtime_warn_minutes = Some(0.0);
        assert!(validate_copies("inv-1", 3, &[over], None).is_err());
        assert!(validate_copies("inv-1", 3, &[], Some(&["m-1".to_string(), "m-1".to_string()])).is_err());
    }

    #[test]
    fn a_box_with_an_extra_key_is_refused_and_a_box_reads_as_kind_box() {
        assert_eq!(serde_json::to_value(Whereabouts::Box {}).unwrap(), serde_json::json!({ "kind": "box" }));
        assert!(serde_json::from_value::<Whereabouts>(serde_json::json!({ "kind": "box" })).is_ok());
        assert!(serde_json::from_value::<Whereabouts>(serde_json::json!({ "kind": "box", "x": 1 })).is_err());
    }

    #[test]
    fn caps_and_bounds_match_the_client() {
        let mut big = copy("a", Condition::New, Whereabouts::Box {});
        big.runtime_warn_minutes = Some(MAX_WARN_MINUTES + 1.0);
        assert!(validate_copies("i", 1, &[big], None).is_err());
        assert!(validate_copies("i", 1, &[], Some(&[" ".to_string()])).is_err());
        assert!(validate_copies("i", 1, &[copy("a\u{7}", Condition::New, Whereabouts::Box {})], None).is_err());
    }

    #[test]
    fn the_wire_shape_is_tagged_and_strict() {
        let c = copy("a", Condition::Broken, in_machine("m-1"));
        let v = serde_json::to_value(&c).unwrap();
        assert_eq!(v["whereabouts"], serde_json::json!({ "kind": "machine", "machineId": "m-1" }));
        assert_eq!(v["condition"], serde_json::json!("broken"));
        let mut extra = v.clone();
        extra["runtime"] = serde_json::json!(5);
        assert!(serde_json::from_value::<ToolCopy>(extra).is_err());
    }
}
