/**
 * The tools the simulator can be told about (`/Simulation.md` §6, §9 q1).
 *
 * Makera's own catalogue is a local SQLite file the web build cannot read (#181), so V1 has
 * its own short list, seeded from tools that are actually owned. It carries the same fields
 * as the `;@MKR|TOOL` record (`Tool`), plus where each row came from. Plain data, with a Zod
 * schema so a list imported later is validated rather than trusted.
 *
 * `TOOL_LIBRARY` is the `builtin` tier of the tool registry (#305) and stays one PERMANENTLY —
 * the shipped default job names `flat-1.0` (`engrave/defaults.ts:120`), so a job has to resolve
 * with no service at all, and a later tier must not be able to take that away. Resolving a key is
 * `toolRegistry.resolveTool`, which is the only place a key becomes a `Tool`.
 *
 * V1 sweeps FLAT end mills only. Nothing here enforces that: the refusal lives in
 * `cuttingRadiusForSweep` and applies to whatever tool is SELECTED, so a ball or a V-bit can
 * be listed (and one day swept) without anyone being able to simulate it as a flat end by
 * accident. A field a source does not state is `null`, never a guess — a null shoulder and
 * flute length is what makes the holder gate say "cannot be proven".
 */

import { z } from 'zod';
import { flatEndMill } from './tool';

const finiteOrNull = z.number().finite().nullable();

export const ToolSchema = z.object({
  number: z.number().int().nullable(),
  id: z.string().nullable(),
  name: z.string().min(1),
  typeText: z.string(),
  shape: z.enum(['flat', 'ball', 'tapered-ball', 'engraving', 'chamfer', 'drill', 'thread', 'bull', 'unknown']),
  handleDiameter: finiteOrNull,
  tipDiameter: finiteOrNull,
  diameter: finiteOrNull,
  cornerRadius: finiteOrNull,
  angle: finiteOrNull,
  halfAngle: finiteOrNull,
  fluteLength: finiteOrNull,
  shoulderLength: finiteOrNull,
  stickout: finiteOrNull,
  /**
   * Not a `;@MKR|TOOL` field (#220): a list saved before it existed parses with `null` —
   * UNKNOWN, the same as an absent header field, never `false`.
   */
  centreCutting: z.boolean().nullable().default(null),
});

/**
 * The namespaces a key in this app can be in (#319). `cat:` is the catalogue tier a sync owns,
 * `user:` the house's own tools, `inv:` the physical cutters; a key with none of them and no colon
 * is a built-in (`TOOL_LIBRARY`). `toolTiers.ts` reads the same four, in this order.
 */
export const KEY_NAMESPACES = ['inv:', 'user:', 'cat:'] as const;

/**
 * The key rule, as the CLIENT states it (#319, `house.rs::validate_key`).
 *
 * The service stores exactly `user:<something>` and refuses everything else — but the client does
 * not only WRITE keys, it READS all four namespaces, so "the same rule" here is the service's rule
 * applied to the vocabulary the app actually carries: a known namespace with at least one character
 * after it, or a bare built-in with no colon at all. A colon in any other position is a namespace
 * nobody claims — precisely what the service refuses to store — so the client refuses to read it
 * rather than filing it under the built-ins and hoping.
 *
 * The same two characters are refused as at the service's door, for the same reason: `|` ends the
 * `.nc` header's tool field and a control character (CR, LF, TAB) ends the comment line it sits in,
 * so a key carrying one could inject a line into a job's program (#305 design point 3). Whitespace
 * at either end is refused, never trimmed: `user:abc ` and `user:abc` are one cutter to a human and
 * two keys to a `Map`, and a silent rename is what this contract exists to prevent.
 */
export function isToolKey(key: string): boolean {
  if (key.length === 0 || key !== key.trim()) return false;
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  if (key.includes('|') || /[\u0000-\u001f\u007f-\u009f]/.test(key)) return false;
  const namespace = KEY_NAMESPACES.find((prefix) => key.startsWith(prefix));
  return namespace ? key.length > namespace.length : !key.includes(':');
}

export const ToolLibraryEntrySchema = z.object({
  /**
   * Stable key a form stores. Held to {@link isToolKey}: the service validates the same rule before
   * it stores one and refuses the rest, so a body carrying a key this refuses is a service (or a
   * file) that is not the one this build talks to.
   */
  key: z.string().refine(isToolKey, {
    message: 'a tool key must be `inv:…`, `user:…`, `cat:…` or a bare built-in, with no control character',
  }),
  tool: ToolSchema,
  /** Where the numbers came from, for the panel. */
  provenance: z.string().min(1),
});

export const ToolLibrarySchema = z.array(ToolLibraryEntrySchema).superRefine((list, ctx) => {
  const seen = new Set<string>();
  list.forEach((e, i) => {
    if (seen.has(e.key)) ctx.addIssue({ code: 'custom', path: [i, 'key'], message: `duplicate tool key "${e.key}"` });
    seen.add(e.key);
  });
});

export type ToolLibraryEntry = z.infer<typeof ToolLibraryEntrySchema>;

export const TOOL_LIBRARY: readonly ToolLibraryEntry[] = [
  {
    key: 'flat-3.175x12-metal',
    // Verbatim from the `;@MKR|TOOL` line of reference-gcode/Z1/TopClamp.nc.
    tool: {
      number: 1,
      id: '112111313812',
      name: '3.175*12mm Flat End(Metal)',
      typeText: 'Flat End',
      shape: 'flat',
      handleDiameter: 3.175,
      tipDiameter: 3.175,
      diameter: 3.175,
      cornerRadius: 0,
      angle: 0,
      halfAngle: 0,
      fluteLength: 12,
      shoulderLength: 12,
      // A COLLARED bit: the stick-out is whatever the Bit Collar Installer set on it, and nobody
      // has measured this one. The header's `sticklength=0` means "unset", the same statement the
      // catalogue makes with an empty `cutterStickoutLength` (#305 design point 1) — so this is
      // null, not the 0 that would put the collet nut at the tool tip once A2 measures the nut.
      stickout: null,
      // The header has no such field, and Makera's catalogue does not state it (#220). Unknown,
      // so a job that drills with this cutter gets `plunge-unproven` rather than a silent plunge.
      centreCutting: null,
    },
    provenance: 'the TOOL line of Makera sample Z1/TopClamp.nc',
  },
  {
    key: 'flat-1.0',
    // The simulation plan's working assumption (`/Simulation.md` §4). Only the diameter is
    // stated there, so the lengths are NOT invented: the holder gate will say "cannot be proven".
    tool: flatEndMill(1, { number: 1, name: '1 mm flat end (assumed)', handleDiameter: 3.175 }),
    provenance: "the 1 mm flat end mill /Simulation.md assumes; diameter only, lengths unknown",
  },
];

// Resolving a key is `toolRegistry.resolveTool` (#305) — this module owns the builtin tier and
// its schema, and nothing else, so the one resolver has one home.
