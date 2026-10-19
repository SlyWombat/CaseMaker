/**
 * The largest project we will read, bytes. A `.3mf` is a zip of the whole plate, and the maintainer's
 * own badge project — three text volumes and a magnet pocket — is well under a megabyte; this is a
 * guard against picking something that is not a project at all (a 200 MB STL renamed, a backup
 * archive) and spending the read on it. Generous on purpose: a legitimately dense plate is a few MB.
 *
 * Lives in its own module (not `designImport.ts`) so `meshStock.ts` — a pure module the headless
 * graph reaches — can use the limit without importing `designImport`, which statically pulls the
 * browser-only features/sim-client/worker graph (#544, same class as #534).
 */
export const MAX_DESIGN_FILE_BYTES = 64 * 1024 * 1024;
