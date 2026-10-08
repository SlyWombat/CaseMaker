// Types for `transport.node.mjs`, which `scripts/machine-upload-check.ts` imports directly.
//
// Same reason as `scripts/sync-docs.d.mts`, and named the same way — the `.d.mts` is what `tsc`
// looks for when it resolves the `.mjs` — because the harness is plain ESM JavaScript and a
// TypeScript importer would otherwise see an implicit `any` (`TS7016`). Written from the module's
// own export, not guessed.
//
// The return type is the protocol's `MachineTransport` — the five-call seam — and it is declared
// here rather than in the `.mjs` so the harness stays runnable by plain `node` from Windows with no
// build step. `tools/z1/z1.mjs` imports it the same way and has no declaration need of its own.

import type { MachineTransport } from '../../src/platform/desktop/protocol';

/**
 * The five-call transport over node's own sockets. This is the bench half of the seam the Tauri
 * transport implements in Rust; the upload code under it is identical either way.
 */
export function createNodeTransport(): MachineTransport;
