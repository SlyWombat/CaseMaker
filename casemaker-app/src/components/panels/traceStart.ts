/**
 * #1256 — WHERE A RASTER TRACE STARTS: the shop's three numbers (`import.traceThreshold`,
 * `import.traceDespecklePx`, `import.traceSimplifyPx`), `invert` staying a per-picture toggle.
 * With no location the recommendations answer, which are the tracer's own compiled defaults.
 */
import { TRACE_DEFAULTS, type TraceOptions } from '@/engine/import/outlineImport';
import { readDefault, type ShopDefaults } from '@/platform/defaultsClient';

export function traceStartFrom(defaults: ShopDefaults | null | undefined): Required<TraceOptions> {
  return {
    ...TRACE_DEFAULTS,
    threshold: readDefault(defaults ?? null, 'import.traceThreshold').value,
    despeckle: readDefault(defaults ?? null, 'import.traceDespecklePx').value,
    simplify: readDefault(defaults ?? null, 'import.traceSimplifyPx').value,
  };
}
