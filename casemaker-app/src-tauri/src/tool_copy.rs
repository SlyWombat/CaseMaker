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

/// The case a boxed copy lives in (#491). The colour is the operator's word — "yellow" — and the
/// label is the full descriptor on the case ("yellow base, clear tube") when one was recorded.
/// No palette is enforced: a case the shop labelled in a colour this build has never seen must
/// still round-trip, and must still print. It simply gets no swatch in the UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CopyCase {
    pub colour: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// Where a copy is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind", deny_unknown_fields)]
pub enum Whereabouts {
    /// In its box (the default for a copy with no entry). A STRUCT variant, not a unit one: an
    /// internally tagged unit variant ignores extra keys, and `{"kind":"box","x":1}` must be refused
    /// like any other unknown key (#415 review). THE CASE (#491) is only a box's: a copy fitted in
    /// a machine is not in a case, so the machine variant has no such field.
    Box {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        case: Option<CopyCase>,
    },
    /// Fitted in a machine of the location, by machine id.
    #[serde(rename_all = "camelCase")]
    Machine { machine_id: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolCopy {
    pub id: String,
    /// The operator's condition. Optional since #491 because the case migration REQUIRES it: the
    /// label corpus states which box each bit is in and nothing about wear, so the migration and
    /// the label import create one copy per box with a case and no condition. The alternatives
    /// were to drop the case or to claim "new" for a bit nobody examined — the guess #415 refused.
    #[serde(default)]
    pub condition: Option<Condition>,
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
/// The longest case colour word and case label — `caseColour.ts`'s bounds.
pub const MAX_CASE_COLOUR: usize = 40;
pub const MAX_CASE_LABEL: usize = 120;

/// A trimmed, non-blank, control-free string within `max` characters — the Zod rule for case text.
fn valid_case_text(text: &str, max: usize) -> bool {
    !text.trim().is_empty()
        && text == text.trim()
        && !text.chars().any(char::is_control)
        && text.chars().count() <= max
}

fn validate_case(item_id: &str, copy_id: &str, case: &CopyCase) -> Result<(), HouseError> {
    let bad = |why: String| Err(HouseError::BadEntry(format!("{item_id}: {why}")));
    if !valid_case_text(&case.colour, MAX_CASE_COLOUR) {
        return bad(format!(
            "copy {copy_id}'s case colour must be 1 to {MAX_CASE_COLOUR} characters, trimmed, with no control character"
        ));
    }
    if let Some(label) = &case.label {
        if !valid_case_text(label, MAX_CASE_LABEL) {
            return bad(format!(
                "copy {copy_id}'s case label must be 1 to {MAX_CASE_LABEL} characters, trimmed, with no control character"
            ));
        }
    }
    Ok(())
}

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
        if let Whereabouts::Box { case: Some(case) } = &c.whereabouts {
            validate_case(item_id, &c.id, case)?;
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
        Whereabouts::Box { .. } => None,
    })
}

/// A house import REPLACES the inventory, so without this a rebuild would wipe every condition and
/// runtime the operator set (#415 review).
///
/// TWO SHAPES OF INCOMING ITEM. An item that states NEITHER `copies` nor `colletFits` (the
/// pre-#491 `build-house.ts`, and any import that does not describe copies) is lent the current
/// item's `copies` and `colletFits` whole.
///
/// SINCE #491 THE LABEL IMPORT STATES COPIES — one per box, carrying its case and no condition —
/// so the "states neither" branch no longer covers it. For an incoming item that states copies of
/// the SAME LENGTH as the current one, each incoming copy lends the operator's fields it does not
/// state: condition, runtime warning, runtime and notes. The incoming CASE wins when it states one
/// (the label import is the authority on which box a bit is in); the operator's case survives when
/// the incoming copy has none. Equal length is required because the two lists are matched by
/// position, and a rebuild that changed the count has no defensible correspondence — it keeps the
/// file's copies as written rather than pairing a condition with the wrong box.
///
/// THE RULE WHEN THE COUNT FELL (stated-neither branch). If the incoming `quantity` is below the
/// number of copies carried, copies are dropped until they fit: copies IN THEIR BOX first (a boxed
/// copy is the one a smaller count most plausibly lost), the last-listed first; copies in a machine
/// only after every boxed one is gone, again the last-listed first. An incoming item that states
/// either field keeps what it states — the file is then the authority for it.
pub(crate) fn carry_copies(
    current: &[crate::house::InventoryItem],
    incoming: &mut [crate::house::InventoryItem],
) {
    for item in incoming.iter_mut() {
        let Some(old) = current.iter().find(|o| o.id == item.id) else { continue };
        if !item.copies.is_empty() {
            // A stated copy list is the file's. The label import's list is distinguishable from an
            // operator's: every copy is BARE — it states where the bit is (its case) and nothing
            // the operator sets. Only such a list borrows the old conditions/runtimes by position,
            // and only when the lengths line up. A file that states a condition is the authority.
            let bare = item.copies.iter().all(|c| {
                c.condition.is_none()
                    && c.runtime_warn_minutes.is_none()
                    && c.runtime_minutes.is_none()
                    && c.notes.is_none()
            });
            if bare && item.copies.len() == old.copies.len() {
                for (fresh, prev) in item.copies.iter_mut().zip(old.copies.iter()) {
                    fresh.condition = prev.condition;
                    fresh.runtime_warn_minutes = prev.runtime_warn_minutes;
                    fresh.runtime_minutes = prev.runtime_minutes;
                    fresh.notes = prev.notes.clone();
                    if let (
                        Whereabouts::Box { case: fresh_case },
                        Whereabouts::Box { case: prev_case },
                    ) = (&mut fresh.whereabouts, &prev.whereabouts)
                    {
                        if fresh_case.is_none() {
                            *fresh_case = prev_case.clone();
                        }
                    }
                }
                if item.collet_fits.is_none() {
                    item.collet_fits = old.collet_fits.clone();
                }
            }
            continue;
        }
        if item.collet_fits.is_some() {
            continue;
        }
        let mut copies = old.copies.clone();
        let limit = item.quantity as usize;
        while copies.len() > limit {
            let drop = copies
                .iter()
                .rposition(|c| matches!(c.whereabouts, Whereabouts::Box { .. }))
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
        let mut c = copy("a", Condition::Used, Whereabouts::Box { case: None });
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
        ToolCopy { id: id.into(), condition: Some(c), whereabouts: w, runtime_warn_minutes: None, notes: None, runtime_minutes: None }
    }
    fn in_machine(m: &str) -> Whereabouts {
        Whereabouts::Machine { machine_id: m.into() }
    }

    #[test]
    fn copies_are_held_to_the_item() {
        let ok = vec![copy("a", Condition::Used, in_machine("m-1")), copy("b", Condition::Worn, Whereabouts::Box { case: None })];
        validate_copies("inv-1", 3, &ok, Some(&["m-1".to_string()])).unwrap();
        // More copies than owned; one id twice; two in one spindle; a bad override; a fit named twice.
        assert!(validate_copies("inv-1", 1, &ok, None).is_err());
        assert!(validate_copies("inv-1", 3, &[copy("a", Condition::New, Whereabouts::Box { case: None }), copy("a", Condition::New, Whereabouts::Box { case: None })], None).is_err());
        assert!(validate_copies("inv-1", 3, &[copy("a", Condition::New, in_machine("m-1")), copy("b", Condition::New, in_machine("m-1"))], None).is_err());
        let mut over = copy("a", Condition::New, Whereabouts::Box { case: None });
        over.runtime_warn_minutes = Some(0.0);
        assert!(validate_copies("inv-1", 3, &[over], None).is_err());
        assert!(validate_copies("inv-1", 3, &[], Some(&["m-1".to_string(), "m-1".to_string()])).is_err());
    }

    #[test]
    fn a_box_with_an_extra_key_is_refused_and_a_box_reads_as_kind_box() {
        assert_eq!(serde_json::to_value(Whereabouts::Box { case: None }).unwrap(), serde_json::json!({ "kind": "box" }));
        assert!(serde_json::from_value::<Whereabouts>(serde_json::json!({ "kind": "box" })).is_ok());
        assert!(serde_json::from_value::<Whereabouts>(serde_json::json!({ "kind": "box", "x": 1 })).is_err());
    }

    #[test]
    fn caps_and_bounds_match_the_client() {
        let mut big = copy("a", Condition::New, Whereabouts::Box { case: None });
        big.runtime_warn_minutes = Some(MAX_WARN_MINUTES + 1.0);
        assert!(validate_copies("i", 1, &[big], None).is_err());
        assert!(validate_copies("i", 1, &[], Some(&[" ".to_string()])).is_err());
        assert!(validate_copies("i", 1, &[copy("a\u{7}", Condition::New, Whereabouts::Box { case: None })], None).is_err());
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

    #[test]
    fn a_boxed_copy_round_trips_its_case_and_may_state_no_condition() {
        // #491: `{ colour, label? }` on a box, absent on a machine, and a copy may carry a case
        // with no condition at all. Both directions of the wire are checked.
        let json = serde_json::json!({
            "id": "c1",
            "whereabouts": { "kind": "box", "case": { "colour": "yellow", "label": "yellow base, clear tube" } }
        });
        let c: ToolCopy = serde_json::from_value(json).unwrap();
        assert_eq!(c.condition, None);
        assert_eq!(
            c.whereabouts,
            Whereabouts::Box {
                case: Some(CopyCase { colour: "yellow".into(), label: Some("yellow base, clear tube".into()) })
            }
        );
        let back = serde_json::to_value(&c).unwrap();
        assert_eq!(
            back["whereabouts"],
            serde_json::json!({ "kind": "box", "case": { "colour": "yellow", "label": "yellow base, clear tube" } })
        );
        assert!(back.get("condition").is_none(), "{back}");

        // A bare colour is enough; an unknown key inside the case, or on a machine, is refused.
        let bare: ToolCopy = serde_json::from_value(serde_json::json!({
            "id": "c2", "condition": "used", "whereabouts": { "kind": "box", "case": { "colour": "green" } }
        }))
        .unwrap();
        validate_copies("i", 1, &[bare], None).unwrap();
        assert!(serde_json::from_value::<ToolCopy>(serde_json::json!({
            "id": "c3", "whereabouts": { "kind": "box", "case": { "colour": "green", "x": 1 } }
        }))
        .is_err());
        assert!(serde_json::from_value::<ToolCopy>(serde_json::json!({
            "id": "c4", "whereabouts": { "kind": "machine", "machineId": "m", "case": { "colour": "green" } }
        }))
        .is_err());
        // Blank or oversized case text is a validation failure, not a parse one.
        let blank: ToolCopy = serde_json::from_value(serde_json::json!({
            "id": "c5", "whereabouts": { "kind": "box", "case": { "colour": "  " } }
        }))
        .unwrap();
        assert!(validate_copies("i", 1, &[blank], None).is_err());
        let long = "x".repeat(MAX_CASE_COLOUR + 1);
        let oversized: ToolCopy = serde_json::from_value(serde_json::json!({
            "id": "c6", "whereabouts": { "kind": "box", "case": { "colour": long } }
        }))
        .unwrap();
        assert!(validate_copies("i", 1, &[oversized], None).is_err());
    }
}
