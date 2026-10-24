//! #566 follow-up — WHERE THE BUILD STRING COMES FROM, in one place.
//!
//! `build.rs` compiles this file (`#[path = "src/build_stamp.rs"] mod build_stamp;`) to fill
//! `CM_BUILD`; the crate compiles it only under `cfg(test)` (`lib.rs`), so the precedence below is
//! proved by the same function the build script runs rather than by a copy of the rule.

/// The build string, from the strongest source that has one.
///
/// 1. `explicit` — the `CASEMAKER_BUILD` environment variable, when set to something other than
///    whitespace. A publish that already knows the sha it is stamping (the k3 rig's
///    `cm_build.sh`, a source tree with no git) sets it; without this source such an image
///    reported `build: "unknown"` while its tag named the commit (#566).
/// 2. `git` — `git describe --tags --always --dirty`, read by `build.rs`.
/// 3. `"unknown"` — no explicit stamp and no git: say so rather than claim a version nobody built.
///
/// Either argument is trimmed and a blank one is treated as absent, so an empty environment
/// variable behaves exactly like an unset one.
pub fn pick_build(explicit: Option<&str>, git: Option<&str>) -> String {
    usable(explicit)
        .or_else(|| usable(git))
        .unwrap_or("unknown")
        .to_string()
}

/// `source`, trimmed, unless it is absent or blank.
fn usable(source: Option<&str>) -> Option<&str> {
    source.map(str::trim).filter(|text| !text.is_empty())
}

#[cfg(test)]
mod tests {
    use super::pick_build;

    #[test]
    fn the_explicit_stamp_wins_over_git() {
        assert_eq!(
            pick_build(Some("c7920af7"), Some("v1.0.0-825-gbea18572")),
            "c7920af7"
        );
    }

    #[test]
    fn git_describe_is_used_when_no_explicit_stamp_is_set() {
        assert_eq!(
            pick_build(None, Some("v1.0.0-825-gbea18572")),
            "v1.0.0-825-gbea18572"
        );
    }

    #[test]
    fn neither_source_says_unknown() {
        assert_eq!(pick_build(None, None), "unknown");
    }

    #[test]
    fn a_blank_explicit_stamp_is_not_a_stamp() {
        assert_eq!(pick_build(Some("   "), Some("v1")), "v1");
        assert_eq!(pick_build(Some(""), None), "unknown");
    }

    #[test]
    fn an_explicit_stamp_is_trimmed() {
        assert_eq!(pick_build(Some("  c7920af7\n"), None), "c7920af7");
    }
}
