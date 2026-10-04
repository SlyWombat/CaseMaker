/**
 * The tools the simulator can be told about (`/Simulation.md` §6, §9 q1).
 *
 * Makera's own catalogue is a local SQLite file the web build cannot read (#181), so V1 has
 * its own short list, seeded from tools that are actually owned. It carries the same fields
 * as the `;@MKR|TOOL` record (`Tool`), plus where each row came from. Plain data, with a Zod
 * schema so a list imported later is validated rather than trusted.
 *
 * V1 sweeps FLAT end mills only. Nothing here enforces that: the refusal lives in
 * `cuttingRadiusForSweep` and applies to whatever tool is SELECTED, so a ball or a V-bit can
 * be listed (and one day swept) without anyone being able to simulate it as a flat end by
 * accident. A field a source does not state is `null`, never a guess — a null shoulder and
 * flute length is what makes the holder gate say "cannot be proven".
 */

import { z } from 'zod';
import { flatEndMill, type Tool } from './tool';

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
});

export const ToolLibraryEntrySchema = z.object({
  /** Stable key a form stores. */
  key: z.string().min(1),
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
      stickout: 0,
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

export function libraryTool(key: string): Tool | null {
  const e = TOOL_LIBRARY.find((t) => t.key === key);
  return e ? { ...e.tool } : null;
}
