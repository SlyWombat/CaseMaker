// The machine's own wasteboard as a tracked sacrificial board (#417, decision Q7): the Z1's MDF
// bed counts as the sacrificial layer for a through-cut, and its state lives on the machine record.
//
// WHAT IS STORED, AND IN WHICH FRAME. The thickness (with where it came from — no thickness is
// shipped as a constant), when it was last resurfaced, the chosen depth limit, and the scars:
// rectangles a finished through-cut left, in MACHINE XY. Not work coordinates: the work origin moves
// with every job, and a scar recorded in one job's frame would be in the wrong place for the next.
// The depth limit a warning uses is a shop default (`defaults.rs`, `wasteboard.depthLimitMm`).
// The warning logic is the client's (`engine/cnc/wasteboard.ts`), a pure function the run plan
// calls; this side only keeps the record honest.

use crate::house::HouseError;
use serde::{Deserialize, Serialize};

/// Where a number came from (decision 28's vocabulary): measured on this board, or chosen by the user.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BoardSource {
    Measured,
    Chosen,
}

/// One scarred area, in machine XY (mm), with the run that left it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Scar {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    /// ISO timestamp of the run.
    pub at: String,
    #[serde(default)]
    pub job_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Wasteboard {
    /// mm.
    pub thickness: f64,
    pub thickness_source: BoardSource,
    /// When a measured thickness was measured.
    #[serde(default)]
    pub measured_at: Option<String>,
    #[serde(default)]
    pub last_resurfaced_at: Option<String>,
    // How deep a cut may go into the board before it is warned about is NOT here: it is a shop
    // default (`wasteboard.depthLimitMm` in the location's `defaults`), a setting with provenance.
    #[serde(default)]
    pub scars: Vec<Scar>,
}

/// The most scars a board records (#417 review cap). A board this scarred wants resurfacing.
pub const MAX_SCARS: usize = 500;

fn finite_positive(v: f64) -> bool {
    v.is_finite() && v > 0.0
}

impl Wasteboard {
    pub(crate) fn validate(&self) -> Result<(), HouseError> {
        let bad = |why: String| Err(HouseError::BadEntry(format!("the wasteboard: {why}")));
        if !finite_positive(self.thickness) {
            return bad(format!("its thickness must be a positive number of mm, not {}", self.thickness));
        }
        if self.thickness_source == BoardSource::Measured
            && self.measured_at.as_deref().is_none_or(|s| s.trim().is_empty())
        {
            return bad("a measured thickness says when it was measured".into());
        }
        if self.scars.len() > MAX_SCARS {
            return bad(format!(
                "{} scars recorded; {MAX_SCARS} is the most — resurface the board, which clears them",
                self.scars.len()
            ));
        }
        for s in &self.scars {
            if ![s.x, s.y].iter().all(|v| v.is_finite())
                || !finite_positive(s.width)
                || !finite_positive(s.height)
                || s.at.trim().is_empty()
            {
                return bad("a scar needs a position, a positive size and a time".into());
            }
        }
        Ok(())
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn a_board() -> Wasteboard {
        Wasteboard {
            thickness: 10.0,
            thickness_source: BoardSource::Measured,
            measured_at: Some("2026-10-15T00:00:00.000Z".into()),
            last_resurfaced_at: None,
            scars: vec![Scar {
                x: -150.0,
                y: -150.0,
                width: 40.0,
                height: 20.0,
                at: "2026-10-15T01:00:00.000Z".into(),
                job_id: Some("job-1".into()),
            }],
        }
    }

    #[test]
    fn a_board_is_held_to_its_rules() {
        a_board().validate().unwrap();
        for (why, b) in [
            ("no thickness", Wasteboard { thickness: 0.0, ..a_board() }),
            ("measured with no date", Wasteboard { measured_at: None, ..a_board() }),
            ("a negative thickness", Wasteboard { thickness: -1.0, ..a_board() }),
            (
                "a scar of no size",
                Wasteboard {
                    scars: vec![Scar { width: 0.0, ..a_board().scars[0].clone() }],
                    ..a_board()
                },
            ),
        ] {
            assert!(b.validate().is_err(), "{why} was accepted");
        }
        // A chosen thickness needs no date.
        Wasteboard { thickness_source: BoardSource::Chosen, measured_at: None, ..a_board() }
            .validate()
            .unwrap();
    }
}
