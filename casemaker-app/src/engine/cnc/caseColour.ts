/**
 * The colour of the case a cutter lives in (#491), and the words every surface uses for it.
 *
 * THE COLOUR IS THE COPY'S, NOT THE DEFINITION'S. One inventory row can hold two physical bits in
 * different cases — the chamfer code is 2× yellow and 2× orange today — so the colour lives on the
 * copy's box whereabouts (`ToolCopy.whereabouts.case`) and never on the item. A copy in a machine
 * has no case field at all: the case is where the bit lives when it is not in a spindle.
 *
 * NOTHING IS GUESSED. A copy nobody gave a case keeps `case: null`; the drawing has no band, the
 * instruction has no colour word, and the tools table shows no swatch. A word in an unfamiliar
 * colour (a box the shop painted itself, say) still PRINTS — it is the operator's word — but it
 * gets no swatch, because a colour this module invents would be a claim about a case nobody
 * described.
 *
 * THE WORD IS THE FIRST WORD. The boxes are described in the label corpus as "yellow base, clear
 * tube"; the operator's word for that case is `yellow`, and that is what {@link caseColourWord}
 * prints ("Yellow case"). The full descriptor belongs in `case.label`, where it can be shown
 * verbatim without ever being mistaken for the colour word.
 */

import { z } from 'zod';

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** The longest colour word and the longest case label this schema carries — sanity bounds, not a palette. */
export const MAX_CASE_COLOUR = 40;
export const MAX_CASE_LABEL = 120;

/** A non-blank, trimmed, control-free piece of case text — the rule both fields share. */
const caseText = (max: number, what: string) =>
  z
    .string()
    .min(1, `${what} is blank`)
    .max(max, `${what} is too long`)
    // Untrimmed text is refused rather than silently normalised, exactly as `tool_copy.rs`'s
    // `valid_case_text` refuses it: the stored word is the operator's, and both doors agree.
    .refine((v) => v === v.trim() && !CONTROL.test(v), `${what} is untrimmed or has a control character`);

/**
 * The case a boxed copy lives in (#491): the operator's colour word and, optionally, the full
 * descriptor printed on the case ("yellow base, clear tube"). The label is for display; the colour
 * is the word every instruction uses.
 */
export const CopyCaseSchema = z
  .object({
    colour: caseText(MAX_CASE_COLOUR, 'the case colour'),
    label: caseText(MAX_CASE_LABEL, 'the case label').nullable().default(null),
  })
  .strict();

export type CopyCase = z.infer<typeof CopyCaseSchema>;

/**
 * Swatches for the colours the shop's cases are actually described in. A colour absent here still
 * prints; it simply has no swatch (`caseSwatch` answers null) — never a guessed paint chip.
 */
export const CASE_SWATCH: Readonly<Record<string, string>> = {
  yellow: '#d8b52a',
  orange: '#d97a24',
  green: '#3f8f4e',
  blue: '#3d72b8',
  red: '#b8453f',
  clear: '#cfd8df',
  white: '#f0f0f0',
  black: '#222222',
};

/** The swatch hex for a colour word, or null when the palette does not know it. Case-insensitive. */
export function caseSwatch(colour: string | null | undefined): string | null {
  if (colour == null) return null;
  return CASE_SWATCH[colour.trim().toLowerCase()] ?? null;
}

/** `yellow` → `Yellow`; anything else is left alone, so an operator's capitalisation survives. */
export function capitaliseColour(colour: string): string {
  const t = colour.trim();
  return t.length === 0 ? t : t.charAt(0).toUpperCase() + t.slice(1);
}

/** The bench's word for a case: `Yellow case`. */
export function caseColourWord(colour: string): string {
  return `${capitaliseColour(colour)} case`;
}

/** The case stored on a copy, if the copy is in a box and carries one. */
export function copyCase(copy: {
  whereabouts: { kind: string; case?: CopyCase | null };
}): CopyCase | null {
  return copy.whereabouts.kind === 'box' ? (copy.whereabouts.case ?? null) : null;
}

/** The colour word for a copy, or null when it lives in a machine or nobody described its case. */
export function copyColour(copy: {
  whereabouts: { kind: string; case?: CopyCase | null };
}): string | null {
  return copyCase(copy)?.colour ?? null;
}

/** The first word of a case descriptor — "yellow base, clear tube" → "yellow". */
export function caseColourOnly(descriptor: string): string {
  return descriptor.trim().split(/\s+/)[0] ?? '';
}

export interface DistinctCase {
  /** The colour as first recorded (trimmed), unique case-insensitively. */
  colour: string;
  /** How many copies carry this case. */
  count: number;
  /** The first full case descriptor recorded for it, when one was. */
  label: string | null;
}

/**
 * The distinct cases among a set of copies, in the order they first appear. Only copies that
 * actually state a case contribute: a copy nobody described adds no colour, and no count.
 */
export function distinctCases(
  copies: readonly { whereabouts: { kind: string; case?: CopyCase | null } }[],
): DistinctCase[] {
  const out: DistinctCase[] = [];
  const byKey = new Map<string, DistinctCase>();
  for (const copy of copies) {
    const c = copyCase(copy);
    if (c === null) continue;
    const key = c.colour.toLowerCase();
    const found = byKey.get(key);
    if (found !== undefined) {
      found.count += 1;
      if (found.label === null && c.label !== null) found.label = c.label;
      continue;
    }
    const entry: DistinctCase = { colour: c.colour, count: 1, label: c.label };
    byKey.set(key, entry);
    out.push(entry);
  }
  return out;
}

/**
 * The tools table's one-line answer, e.g. `2 copies: yellow, orange` — or null when no copy states
 * a case. The count is the copies that DO state one, not the item's quantity: claiming a colour
 * for a copy nobody described is exactly the guess this feature refuses.
 */
export function copyCaseSummary(
  copies: readonly { whereabouts: { kind: string; case?: CopyCase | null } }[],
): string | null {
  const cases = distinctCases(copies);
  if (cases.length === 0) return null;
  const n = cases.reduce((sum, c) => sum + c.count, 0);
  return `${n} ${n === 1 ? 'copy' : 'copies'}: ${cases.map((c) => c.colour.toLowerCase()).join(', ')}`;
}

/**
 * Read the case note the label import has always written: `Case: yellow.` or
 * `Case: yellow + orange.` Returns the colour words in note order, or null when the note has none.
 * `counts[i]` is how many copies the note's variant sentence assigns to `colours[i]`, or null when
 * the note does not say (a single-colour note need not: all copies are that colour).
 */
export interface CaseNote {
  colours: string[];
  counts: (number | null)[];
}

export function parseCaseNote(notes: string | null | undefined): CaseNote | null {
  if (notes == null) return null;
  const match = /Case:\s*([^.\n]+)\./.exec(notes);
  if (match === null) return null;
  const colours: string[] = [];
  for (const part of match[1]!.split('+')) {
    const colour = caseColourOnly(part);
    if (colour.length === 0) continue;
    if (!colours.some((c) => c.toLowerCase() === colour.toLowerCase())) colours.push(colour);
  }
  if (colours.length === 0) return null;
  if (colours.length === 1) return { colours, counts: [null] };

  // A multi-case note's variant sentence says how many of each: `2× yellow with collar; 2× orange`.
  // Only those colour words count, so an unrelated `N×` clause cannot be read as a case count.
  const counts: (number | null)[] = colours.map(() => null);
  const variant = /(\d+)\s*[×x]\s*([A-Za-z]+)/g;
  for (const m of notes.matchAll(variant)) {
    const n = Number(m[1]);
    const colour = m[2]!.toLowerCase();
    const i = colours.findIndex((c) => c.toLowerCase() === colour);
    if (i >= 0 && Number.isInteger(n) && n > 0) counts[i] = n;
  }
  return { colours, counts };
}
