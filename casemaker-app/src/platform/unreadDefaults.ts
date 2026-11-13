/**
 * #1207 landing rule (the analyst's 2026-11-13 ruling) — REGISTERED, NOT YET READ.
 *
 * These keys are in the registry (`KNOWN_DEFAULTS`, `defaults.rs`, the location fixture) because
 * they were shipped before the rule existed. No product code reads them yet, so a control on
 * Manage › Advanced › All values would change nothing; the page is generated from the registry
 * MINUS this list, and the guard (`defaultsReaders1207.spec.ts`) allows them here and nowhere
 * else. Each is owned by follow-up #1256, which wires its reader and removes its line. The list may
 * ONLY SHRINK: the guard fails on a key with no reader that is not named here, and fails again if
 * a named key gains a reader but stays listed.
 */
export const UNREAD_DEFAULT_KEYS: readonly string[] = [
  // The raster-trace dialog still starts from `rasterOutline.ts`'s compiled fallbacks (#451's
  // consumer rewire was deferred).
  'import.traceThreshold',
  'import.traceDespecklePx',
  'import.traceSimplifyPx',
  // The tape strip width the run sheet would state; no path reads it.
  'tape.stripWidthMm',
  // The band above a machine ceiling where a feed/rpm is refused; the clamp takes it as an
  // argument nobody supplies from the shop yet.
  'clamp.refuseFraction',
];
