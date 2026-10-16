// Types for `benchDefaults.mjs` (#449), which `tests/unit/benchDefaults.spec.ts` imports directly —
// the same reason as `transport.node.d.mts`: the module is plain ESM so `node` runs it from Windows
// with no build step, and a TypeScript importer would otherwise see an implicit `any` (TS7016).

export interface BenchDefaultRule {
  min: number;
  max: number;
  int?: boolean;
  fallback: number;
  unit: string;
}

export const BENCH_DEFAULTS: Readonly<Record<string, BenchDefaultRule>>;

export function accepts(key: string, value: unknown): boolean;

export function defaultLocationPath(env?: Record<string, string | undefined>, platform?: string): string | null;

export interface BenchDefaultValue {
  value: number;
  source: 'seeded' | 'chosen' | 'measured' | 'fallback';
  unit: string;
  note?: string;
}

export interface BenchDefaultsRead {
  path: string | null;
  note: string | null;
  values: Record<string, BenchDefaultValue>;
}

export function readBenchDefaults(opts?: {
  location?: string;
  env?: Record<string, string | undefined>;
  platform?: string;
  keys?: string[];
}): BenchDefaultsRead;

export function describeBenchDefaults(result: BenchDefaultsRead): string[];
