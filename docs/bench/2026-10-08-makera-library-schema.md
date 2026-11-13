# The Makera Studio library database — schema (2026-10-08, #307)

Moved to the house share by #1260: the schema, the join and the sample rows were read from the
installed library database, which Makera does not publish. The file is kept at
`/mnt/house/casemaker/vendor-notes-from-repo/bench/2026-10-08-makera-library-schema.md`.

What the code needs from it is in `casemaker-app/src-tauri/src/catalogue.rs` (the reader) and in the
catalogue chapter of the CNC guide. The catalogue is read at run time from the user's own Studio
installation; nothing from it is committed.
