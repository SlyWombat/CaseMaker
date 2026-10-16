/**
 * The shop's own defaults (the maintainer's rule, 2026-10-15: "That type of setting should be
 * something we keep in our own database and not compiled in"). Tunable values — a threshold, a wait,
 * a chosen margin — live in `location.json`'s `defaults` section, each with where it came from. The
 * service's half is `src-tauri/src/defaults.rs`.
 *
 * OPEN TO NEW KEYS, VALIDATED. The section maps a dotted lowerCamel key (`power.onWaitSeconds`) to
 * `{ value, source, setAt?, unit? }`. Any well-formed key is kept and served; a key listed in
 * {@link KNOWN_DEFAULTS} is ALSO held to its own rule here. A new consumer (#436's rest-machining
 * defaults, next) adds its key to that registry — its rule and its labelled fallback — and nothing
 * else about the section changes.
 *
 * THE FALLBACK IS FOR NO SERVICE, AND SAYS SO. {@link readDefault} answers the stored value with its
 * source when the location has one, and the registry's fallback marked `fallback` when it does not
 * (the hosted web build, or a service that could not be read). A fallback is never written back.
 */

import { z } from 'zod';
import { GRIP_MIN } from '@/engine/cnc/fixture';
import {
  houseRequest,
  type HouseFailure,
  type HouseReadFailure,
  type HouseRequestOptions,
  type HouseWrite,
} from './houseClient';

export const DEFAULT_SOURCES = ['seeded', 'chosen', 'measured'] as const;
export type DefaultSource = (typeof DEFAULT_SOURCES)[number];

/** `segment(.segment)+`, each lowerCamel ASCII — `defaults.rs`'s `valid_key`. */
export const DEFAULT_KEY = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;

const filled = z.string().refine((v) => v.trim().length > 0, 'is empty');

export const ShopDefaultSchema = z
  .object({
    value: z.union([
      z.number().finite(),
      z.boolean(),
      // eslint-disable-next-line no-control-regex
      z.string().max(200).refine((v) => !/[\u0000-\u001f\u007f-\u009f]/.test(v), 'has a control character'),
    ]),
    source: z.enum(DEFAULT_SOURCES),
    setAt: filled.nullable().default(null),
    unit: z.string().max(16).nullable().default(null),
    /** Where a measured value came from, in a sentence (#430 review). */
    note: z
      .string()
      .max(400)
      // eslint-disable-next-line no-control-regex
      .refine((v) => !/[\u0000-\u001f\u007f-\u009f]/.test(v), 'has a control character')
      .nullable()
      .default(null),
  })
  .strict()
  .superRefine((d, ctx) => {
    if (d.source !== 'seeded' && d.setAt === null) {
      ctx.addIssue({ code: 'custom', path: ['setAt'], message: 'a chosen or measured value says when it was set' });
    }
  });

export type ShopDefault = z.infer<typeof ShopDefaultSchema>;

/** What the surface tolerance must leave below the park height, mm — `defaults.rs`'s `PARK_CLEARANCE_MM`. */
export const PARK_CLEARANCE_MM = 0.5;

/** A key this build knows: its rule, and the value used when there is no location to read. */
export interface KnownDefault {
  label: string;
  unit: string;
  /** The bound, stated once — the same as `defaults.rs`'s `known_rule`. */
  rule: z.ZodType<number>;
  /** Used only with no service. Labelled `fallback` wherever it is shown. */
  fallback: number;
}

export const KNOWN_DEFAULTS: Readonly<Record<string, KnownDefault>> = {
  // #416 — how long switching on waits for the controller to answer.
  'power.onWaitSeconds': {
    label: 'power-on wait',
    unit: 's',
    rule: z.number().min(10).max(1800),
    fallback: 180,
  },
  // #430 — the stepped edge scan and the surface touch, as the 2026-10-15 bench ran them.
  'registration.capBelowSurfaceMm': { label: 'touch cap below the surface', unit: 'mm', rule: z.number().min(0.1).max(1), fallback: 0.5 },
  'registration.coarseStepMm': { label: 'scan coarse step', unit: 'mm', rule: z.number().min(0.1).max(10), fallback: 1.0 },
  'registration.fineStepMm': { label: 'scan fine step', unit: 'mm', rule: z.number().min(0.05).max(5), fallback: 0.5 },
  'registration.parkAboveSurfaceMm': { label: 'park height above the surface', unit: 'mm', rule: z.number().min(2).max(30), fallback: 3.0 },
  'registration.scanInsideMm': { label: 'scan start inside the edge', unit: 'mm', rule: z.number().min(0.5).max(30), fallback: 3.0 },
  'registration.scanReachMm': { label: 'scan reach past the edge', unit: 'mm', rule: z.number().min(0.5).max(50), fallback: 5.0 },
  'registration.cornerClearanceMm': { label: 'clearance from a rounded corner', unit: 'mm', rule: z.number().min(0).max(30), fallback: 2.0 },
  'registration.surfaceBandMm': { label: 'surface band', unit: 'mm', rule: z.number().min(0.01).max(1), fallback: 0.25 },
  // MEASURED 2026-10-15 — the effective rim offset; the note in location.json says how. The fallback is that measurement.
  'registration.tipRadiusMm': { label: 'probe rim offset (measured)', unit: 'mm', rule: z.number().min(0).max(3), fallback: 0.7 },
  'registration.surfaceToleranceMm': { label: 'surface tolerance', unit: 'mm', rule: z.number().min(0.05).max(10), fallback: 0.4 },
  'registration.edgeMarginMm': { label: 'registration margin', unit: 'mm', rule: z.number().min(0.01).max(20), fallback: 0.5 },
  'registration.surfaceSeekMm': { label: 'surface seek travel, at most', unit: 'mm', rule: z.number().min(1).max(100), fallback: 60.0 },
  'registration.touchFeed': { label: 'scan touch feed', unit: 'mm/min', rule: z.number().min(10).max(1000), fallback: 150.0 },
  'registration.surfaceFastFeed': { label: 'surface touch, fast', unit: 'mm/min', rule: z.number().min(10).max(1000), fallback: 300.0 },
  'registration.surfaceSlowFeed': { label: 'surface touch, slow', unit: 'mm/min', rule: z.number().min(5).max(500), fallback: 100.0 },
  // #428 — the setups planner.
  // The fallback is fixture.ts's GRIP_MIN — the one compiled figure, shared with validateVise.
  'setups.minGripMm': { label: 'least stock to grip', unit: 'mm', rule: z.number().min(0.5).max(50), fallback: GRIP_MIN },
  'setups.remountMinutes': { label: 'remount estimate', unit: 'min', rule: z.number().min(0.5).max(120), fallback: 3 },
  'setups.reregisterMinutes': { label: 're-registration estimate', unit: 'min', rule: z.number().min(0.5).max(120), fallback: 2 },
  // #423 — the run screen's watch. 2000 ms is the poll's floor (0.6 s faulted the controller, #386).
  'run.pollMs': { label: 'run status poll', unit: 'ms', rule: z.number().min(2000).max(60000), fallback: 2000 },
  'run.noProgressMs': { label: 'no-progress timeout', unit: 'ms', rule: z.number().min(15000).max(600000), fallback: 30000 },
  'run.missLimit': { label: 'missed polls before unreachable', unit: 'polls', rule: z.number().int().min(1).max(10), fallback: 3 },
  // #415 — past how many minutes of runtime a cutter gets "check this bit". It only warns.
  'tools.runtimeWarnMinutes': {
    label: 'runtime before "check this bit"',
    unit: 'min',
    rule: z.number().gt(0).max(100_000),
    fallback: 600,
  },
  // #417 — how deep a cut may go into the wasteboard before it is warned about.
  'wasteboard.depthLimitMm': {
    label: 'wasteboard depth limit',
    unit: 'mm',
    rule: z.number().min(0).max(50),
    fallback: 0.5,
  },
};

/** The whole section: well-formed keys, each value valid, and each known key within its rule. */
export const ShopDefaultsSchema = z.record(z.string(), ShopDefaultSchema).superRefine((map, ctx) => {
  if (Object.keys(map).length > 200) {
    ctx.addIssue({ code: 'custom', message: 'the shop defaults hold more than 200 keys' });
  }
  // #430 review: the surface band inside the touch cap, as `defaults.rs` checks it.
  const band = map['registration.surfaceBandMm']?.value;
  const cap = map['registration.capBelowSurfaceMm']?.value;
  if (typeof band === 'number' && typeof cap === 'number' && band >= cap) {
    ctx.addIssue({ code: 'custom', message: `registration.surfaceBandMm (${band}) must be less than registration.capBelowSurfaceMm (${cap})` });
  }
  // The surface tolerance inside the park height less a clearance — `defaults.rs`'s PARK_CLEARANCE_MM.
  const tol = map['registration.surfaceToleranceMm']?.value;
  const park = map['registration.parkAboveSurfaceMm']?.value;
  if (typeof tol === 'number' && typeof park === 'number' && tol >= park - PARK_CLEARANCE_MM) {
    ctx.addIssue({ code: 'custom', message: `registration.surfaceToleranceMm (${tol}) must be less than registration.parkAboveSurfaceMm (${park}) less ${PARK_CLEARANCE_MM}` });
  }
  for (const [key, d] of Object.entries(map)) {
    if (!DEFAULT_KEY.test(key)) {
      ctx.addIssue({ code: 'custom', path: [key], message: 'a key is dotted lowerCamel words, like power.onWaitSeconds' });
      continue;
    }
    const known = KNOWN_DEFAULTS[key];
    if (known && !known.rule.safeParse(d.value).success) {
      ctx.addIssue({ code: 'custom', path: [key], message: `${key} is outside its bounds` });
    }
  }
});

export type ShopDefaults = z.infer<typeof ShopDefaultsSchema>;

/** A default as a consumer reads it: the value, and where it came from — `fallback` with no location. */
export interface ReadDefault {
  value: number;
  source: DefaultSource | 'fallback';
}

/**
 * The number a consumer uses for `key`: the location's, or — only when there is no location, or its
 * entry does not hold a number within the key's rule — the registry's labelled fallback.
 */
export function readDefault(map: ShopDefaults | null, key: string): ReadDefault {
  const known = KNOWN_DEFAULTS[key];
  const stored = map?.[key];
  if (stored && typeof stored.value === 'number' && (!known || known.rule.safeParse(stored.value).success)) {
    return { value: stored.value, source: stored.source };
  }
  if (!known) throw new Error(`${key} has no fallback in KNOWN_DEFAULTS`);
  return { value: known.fallback, source: 'fallback' };
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'unrecognised shape';
  const at = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  return `${at}${issue.message}`;
}

export type DefaultsRead = { kind: 'ok'; etag: string | null; defaults: ShopDefaults } | HouseReadFailure;

/** Read the section. A 404 is a service from before it: no defaults there. */
export async function houseDefaults(opts?: HouseRequestOptions): Promise<DefaultsRead> {
  const res = await houseRequest('GET', '/defaults', undefined, opts);
  if (res.kind === 'refused') {
    return res.status === 404 ? { kind: 'absent', reason: res.message } : { kind: 'error', detail: res.message };
  }
  if (res.kind !== 'ok') return res;
  let json: unknown;
  try {
    json = JSON.parse(res.text);
  } catch {
    return { kind: 'error', detail: 'the shop defaults are not readable JSON' };
  }
  const parsed = ShopDefaultsSchema.safeParse(json);
  if (!parsed.success) return { kind: 'error', detail: `the shop defaults do not match this build: ${firstIssue(parsed.error)}` };
  return { kind: 'ok', etag: res.etag ?? null, defaults: parsed.data };
}

/** Set one default (checked here first). GUARDED on the section's `ETag`. */
export async function housePutDefault(
  key: string,
  value: ShopDefault,
  ifMatch: string | null,
  opts?: HouseRequestOptions,
): Promise<HouseWrite> {
  const check = ShopDefaultsSchema.safeParse({ [key]: value });
  if (!check.success) return { kind: 'refused', status: 400, message: firstIssue(check.error) };
  // `seeded` is the app's word for its own starting value; a value set here is chosen or measured.
  if (value.source === 'seeded') {
    return { kind: 'refused', status: 400, message: 'a value you set is `chosen` (or `measured`), with the date — not `seeded`' };
  }
  const res = await houseRequest('PUT', `/defaults/${encodeURIComponent(key)}`, value, { ...opts, ifMatch });
  return res.kind === 'ok' ? { kind: 'ok' } : (res as HouseFailure);
}

/** Reset one default to its seed (a key with no seed is removed). Guarded. */
export async function houseResetDefault(
  key: string,
  ifMatch: string | null,
  opts?: HouseRequestOptions,
): Promise<HouseWrite> {
  const res = await houseRequest('DELETE', `/defaults/${encodeURIComponent(key)}`, undefined, { ...opts, ifMatch });
  return res.kind === 'ok' ? { kind: 'ok' } : (res as HouseFailure);
}
