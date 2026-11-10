// #1151 Phase 2 — THE RANK POOL'S WORKER BOOTSTRAP.
//
// A worker thread inherits tsx's LOADER (through execArgv) but not tsx's `--tsconfig`, so the app
// modules this worker loads cannot resolve the `@/…` alias. Register the alias hooks and only then
// import the pool's real entry — which is TypeScript, compiled by the inherited tsx loader.
import { register } from 'node:module';

register(new URL('./rankWorkerAlias.mjs', import.meta.url).href);
await import('./rankPoolWorker.ts');
