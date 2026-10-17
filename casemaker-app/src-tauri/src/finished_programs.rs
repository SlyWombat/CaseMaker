// A machine's finished programs (#419 §4.5, decisions Q-B and Q14): the FNV program hashes it has
// FINISHED cleanly, so the run plan can stop treating a program it has already cut as new.
//
// THE KEY IS FNV, NOT SHA-256 (decision 3, §4.2). `programHash` in `platform/machineRun.ts` — the
// run confirmation's key — is the same value the plan compares against `RunPlanInput.finishedHashes`.
// Its FNV-1a 32-bit form is what this list stores. `#277`'s record keeps its SHA-256 `ncHash`: the
// two answer different questions and are deliberately different keys.
//
// ONLY A CLEAN FINISH IS RECORDED. A stopped or aborted run proves nothing about the program's text:
// it may have been cut part way, and the next run should still be offered the air run. The writer is
// the run store's finished branch (`store/machineRunStore.ts`); this side only keeps the list honest.
//
// APPEND-ONLY, DEDUPED, CAPPED. Appending is atomic under the store's write lock, so two windows
// recording finishes cannot lose one another's hash as a client-side read-modify-write would. A
// repeated finish is a no-op, and the list keeps the most recent `MAX_FINISHED_PROGRAMS`: an old hash
// falling off only means a program not run in a very long time is offered the air run again, which is
// the harmless direction to be wrong in.

use crate::house::HouseError;

/// How many finished hashes one machine remembers (#419 §4.5). 200 is several years of ordinary use
/// at a few programs a day. The list is a convenience for the air-run default, not a ledger, and the
/// plan only ever asks "is this hash in the list"; the bound exists because the list is read into
/// every location view and copied on every machine write.
pub const MAX_FINISHED_PROGRAMS: usize = 200;

/// One program's hash as the wire carries it: non-empty, trimmed, no control character. The client
/// mints FNV-1a 32-bit lowercase hex, but this side does not require that spelling: a newer build may
/// identify a program differently, and pinning the shape here would let an older service refuse a
/// newer client for no gain.
pub fn validate_hash(hash: &str) -> Result<(), HouseError> {
    if hash.trim().is_empty() || hash != hash.trim() || hash.chars().any(|c| c.is_control()) {
        return Err(HouseError::BadEntry(
            "a finished program needs a non-empty hash with no space at either end".into(),
        ));
    }
    Ok(())
}

/// A machine's whole list, held to its entry rule. Duplicates are not refused here: `append` is the
/// one writer and dedupes, so a duplicate can only come from a hand-edited file, where it costs the
/// plan nothing (`newPrograms` asks a `Set`).
pub fn validate_list(machine_id: &str, list: &[String]) -> Result<(), HouseError> {
    for hash in list {
        validate_hash(hash).map_err(|e| match e {
            HouseError::BadEntry(why) => HouseError::BadEntry(format!("machine {machine_id}: {why}")),
            other => other,
        })?;
    }
    Ok(())
}

/// Append `hash` to `list` in place: a no-op when it is already recorded, otherwise the newest entry,
/// with the oldest dropped once the list is at its cap.
pub fn append(list: &mut Vec<String>, hash: &str) {
    if list.iter().any(|h| h == hash) {
        return;
    }
    list.push(hash.to_string());
    if list.len() > MAX_FINISHED_PROGRAMS {
        let drop = list.len() - MAX_FINISHED_PROGRAMS;
        list.drain(..drop);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hash_must_be_a_trimmed_non_empty_string() {
        for good in ["a1b2c3d4", "0", "program-17"] {
            validate_hash(good).unwrap();
        }
        for bad in ["", " ", "\t", " abc", "abc ", "ab\ncd"] {
            assert!(validate_hash(bad).is_err(), "{bad:?} was accepted");
        }
    }

    #[test]
    fn append_dedupes_and_keeps_the_most_recent_cap() {
        let mut list = Vec::new();
        append(&mut list, "aaaa");
        append(&mut list, "bbbb");
        append(&mut list, "aaaa");
        assert_eq!(list, ["aaaa", "bbbb"]);

        for i in 0..MAX_FINISHED_PROGRAMS {
            append(&mut list, &format!("h{i:04}"));
        }
        assert_eq!(list.len(), MAX_FINISHED_PROGRAMS);
        assert_eq!(list.last().unwrap(), &format!("h{:04}", MAX_FINISHED_PROGRAMS - 1));
        assert!(!list.iter().any(|h| h == "aaaa"), "the oldest entries were not dropped");
    }

    #[test]
    fn a_list_names_the_machine_it_refuses() {
        validate_list("m-1", &[]).unwrap();
        let err = validate_list("m-1", &[" ".into()]).unwrap_err().to_string();
        assert!(err.contains("m-1"), "{err}");
    }
}
