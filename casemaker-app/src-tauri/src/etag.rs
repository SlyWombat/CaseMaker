// One content-validator idiom for the crate (#313).
//
// Everything this app serves over HTTP asks the same question — the house's JSON documents
// (`house_api.rs`), their guarded writes (`house.rs`), the catalogue's `contentHash` (`catalogue.rs`)
// and the SPA shell (`server.rs`) — and the question is "are these the same bytes the client already
// holds?". One answer to it keeps "the same bytes" meaning the same thing wherever it is asked, which
// is the only property an `ETag` is worth having for.
//
// It lives here rather than in `house.rs` since the shell's caching needed it (#313): a validator the
// SPA's own assets depend on should not be reached through the house's module.

use axum::http::HeaderValue;

/// FNV-1a, 64-bit: a content validator, not a security hash. Written here rather than pulled in as a
/// dependency because the only requirement is "the same bytes give the same string", and a validator
/// that changed without the bytes changing would only cost a 200 where a 304 was possible.
pub(crate) fn fnv1a_hex(bytes: &[u8]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}")
}

/// The HTTP `ETag` for a body: quoted, and derived from the exact bytes that were hashed, so the
/// validator and the representation cannot disagree.
pub(crate) fn etag_for(bytes: &[u8]) -> String {
    format!("\"fnv1a-{}\"", fnv1a_hex(bytes))
}

/// Does an `If-None-Match` value cover this validator? `*` covers any current representation, and a
/// comma-separated list covers the validator it names — the two forms RFC 9110 gives a client for "I
/// already have this", and a revalidating browser sends the list form.
pub(crate) fn if_none_match_covers(requested: &HeaderValue, etag: &str) -> bool {
    requested.as_bytes() == etag.as_bytes()
        || requested
            .to_str()
            .map(|list| {
                list.split(',').any(|part| {
                    let part = part.trim();
                    part == etag || part == "*"
                })
            })
            .unwrap_or(false)
}
