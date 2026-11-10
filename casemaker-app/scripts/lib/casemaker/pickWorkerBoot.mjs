// #1137 — THE PICK POOL'S WORKER BOOTSTRAP.
//
// A worker thread inherits tsx's LOADER (through execArgv) but not tsx's `--tsconfig`, so the app
// modules the worker loads cannot resolve the `@/…` alias. This module registers the alias hooks
// (`pickWorkerAlias.mjs`) and only then imports the pool's real entry — which is TypeScript, and
// is compiled by the inherited tsx loader. Plain JavaScript on purpose: the bootstrap must run
// before any TypeScript in the worker needs resolving.
import { register } from 'node:module';

register(new URL('./pickWorkerAlias.mjs', import.meta.url).href);
await import('./pickPoolWorker.ts');
