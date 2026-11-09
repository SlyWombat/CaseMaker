/**
 * #1123 item 5 — ONE CUTTER LIST, AS ROWS.
 *
 * The bench note: on the Job panel the same cutters printed twice — under "Cutter ·" in the Job
 * block and again as the Cutter group's summary — as one paragraph of "⌀6 mm flat end · 25 mm
 * flute · …". The maintainer: "for a user a paragraph of them is not as useful as a checklist".
 * The promoted interactive checklist (ticks, replacements, the Cut gate) is #1127; this is the
 * visible half item 5 keeps: ONE list, one row per DISTINCT cutter in program order, each naming
 * the program numbers it serves. The Job block's Cutter line collapses to a count.
 *
 * The rows never render a registry key (#930/#690b): the display name only, with the tier word
 * when two cutters share a display name (#1051).
 */
import type { JSX } from 'react';

import { toolDisplayName } from '@/engine/cnc/toolDisplay';
import { benchCutterFor } from '@/engine/cnc/toolRegistry';

/** One row of the list. */
export interface PostedCutter {
  /** The registry key — the row's identity only, never rendered. */
  key: string;
  /** The display name, with the tier word appended when another row shares the name. */
  name: string;
  /** 1-based program numbers (the run's cut order) this cutter serves. */
  programs: number[];
}

/** Which tier a key came from — a word, never the key (#1051). */
function cutterTierWord(toolKey: string): string {
  return toolKey.startsWith('inv:')
    ? 'inventory'
    : toolKey.startsWith('user:')
      ? 'your library'
      : toolKey.startsWith('cat:')
        ? 'catalogue'
        : 'built-in';
}

/**
 * The run's cutters, one per DISTINCT key in program order, each with the programs it serves.
 * A cutter with no registry row is "unknown cutter" — never the id (#887).
 */
export function postedCuttersFor(programs: readonly { toolKey: string }[]): PostedCutter[] {
  const byKey = new Map<string, PostedCutter>();
  const order: PostedCutter[] = [];
  programs.forEach((program, index) => {
    let cutter = byKey.get(program.toolKey);
    if (cutter === undefined) {
      const posted = benchCutterFor(program.toolKey);
      cutter = {
        key: program.toolKey,
        name: posted === null ? 'unknown cutter' : toolDisplayName(posted),
        programs: [],
      };
      byKey.set(program.toolKey, cutter);
      order.push(cutter);
    }
    cutter.programs.push(index + 1);
  });
  const named = new Map<string, number>();
  for (const cutter of order) named.set(cutter.name, (named.get(cutter.name) ?? 0) + 1);
  return order.map((cutter) =>
    (named.get(cutter.name) ?? 0) > 1 ? { ...cutter, name: `${cutter.name} (${cutterTierWord(cutter.key)})` } : cutter,
  );
}

/** `p01, p03` — the program numbers a row serves, in cut order. */
function programListWords(programs: readonly number[]): string {
  return programs.map((n) => `p${String(n).padStart(2, '0')}`).join(', ');
}

/** The visible list. Nothing before a run has posted cutters. */
export function CutterList({ cutters }: { cutters: readonly PostedCutter[] }): JSX.Element | null {
  if (cutters.length === 0) return null;
  return (
    <ul
      data-testid="engrave-cutter-list"
      style={{ listStyle: 'none', margin: '4px 0 0', padding: 0, display: 'grid', gap: 2, fontSize: 12, color: '#d1d5db' }}
    >
      {cutters.map((cutter) => (
        <li
          key={cutter.key}
          data-testid="engrave-cutter-row"
          style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}
        >
          <span style={{ color: '#9aa4b0', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11, minWidth: 56 }}>
            {programListWords(cutter.programs)}
          </span>
          <span>{cutter.name}</span>
        </li>
      ))}
    </ul>
  );
}
