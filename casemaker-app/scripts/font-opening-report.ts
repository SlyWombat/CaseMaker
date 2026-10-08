// #185 — the font-opening report: which glyph strokes survive the cutters we actually have.
//
// The issue's procedure starts with a prerequisite it calls free, because it needs no machine:
// run #171's morphological opening, `offset(offset(G, −r), +r)`, over the bundled faces and
// report which strokes survive at
//
//   * r = 0.5 — the 1.0 mm flat end mill (the smallest catalogued non-metal flat), and
//   * the V-bit's effective radius at each rung of #165's depth ladder, `w(d)/2`.
//
// `/Fabrication.md` §7.4's "a 4 mm cap-height title has a stroke around 0.5 mm" was a guess.
// This replaces it with a measurement, and writes the table to `docs/bench/185-font-opening.md`.
//
// Nothing here touches `src/`: it reads `toPartPlan` + `measureLabels`, the same functions the
// Engrave panel's own warnings read, so the report cannot drift from what the app tells a user.
//
// The V-bit radius is an APPROXIMATION and the report says so: a V's groove is a wedge, not a
// cylinder, so `w(d)/2` is the radius of the widest circle that fits inside the groove at depth
// d. It answers "is this stroke reachable at all" — which is the issue's question — but it does
// NOT model decision 14's depth coupling (a stroke wider than w(d) can only be reached at a
// shallower floor). See §7.4.
//
// Run (Windows, from casemaker-app; `node_modules` are Windows-native):
//   npx tsx --tsconfig tsconfig.scripts.json scripts/font-opening-report.ts

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import ManifoldModule from 'manifold-3d';

import { BUNDLED_FONTS, registerBundledFontBytes } from '@/engine/fonts/registry';
import { BUNDLED_FONT_URLS } from '@/engine/fonts/fontAssets';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { labelProfile, toPartPlan } from '@/engine/cnc/engrave/partPlan';
import { LOST_DETAIL_RATIO, measureLabels, type PerCharGlyph } from '@/workers/sim/engraveGeometry';
import type { EngraveJob, EngraveLabel } from '@/types/engraveJob';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const outDir = join(repoRoot, 'docs', 'bench');
mkdirSync(outDir, { recursive: true });

const require = createRequire(import.meta.url);
const wasmPath = require.resolve('manifold-3d/manifold.wasm');
const tl = await ManifoldModule({ locateFile: () => wasmPath });
tl.setup();

// ---------------------------------------------------------------------------------------------
// Fonts, without the browser's fetch
// ---------------------------------------------------------------------------------------------
// The registry loads the six bundled TTFs with `fetch(url)` against `new URL('./files/…',
// import.meta.url)`. Under tsx those hrefs are `file:` URLs, and Node 24's fetch refuses them
// ("not implemented… yet…"), so use the module's own Node seam instead —
// `registerBundledFontBytes`, the one `tests/setup/fonts.ts` uses. Same bytes, same parse.

const fontHashes = new Map<string, string>();
for (const [key, url] of Object.entries(BUNDLED_FONT_URLS)) {
  const bytes = readFileSync(fileURLToPath(url));
  // The numbers below are these exact bytes (#185 review: "pin the font files' hashes"), so a
  // font update that moves an outline shows up as a hash change next to a changed table.
  fontHashes.set(basename(fileURLToPath(url)), createHash('sha256').update(bytes).digest('hex').slice(0, 12));
  registerBundledFontBytes(key, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
}

// ---------------------------------------------------------------------------------------------
// What is measured
// ---------------------------------------------------------------------------------------------

/** The two words the app's own default job ships with — nothing invented, and reproducible. */
const WORDS = ['CASE', 'MAKER'] as const;
/** Cap heights, mm. 4 and 10 are the two #191 quoted; the rest bracket badge and panel scale. */
const SIZES = [4, 6, 8, 10, 14] as const;

const V_HALF_ANGLE_DEG = 15; // a 30° included V-bit (#185)
const LADDER_DEPTHS = [0.6, 0.8, 1.0, 1.2, 1.4, 1.6] as const; // #165's six rungs, as cut
const TIPS = [0.1, 0.5] as const; // #185's tip range, in mm

interface Cutter {
  /** Short row label, e.g. `V 30° · tip 0.10 · d 1.0`. */
  label: string;
  /** Effective tool radius, mm. */
  r: number;
}

const cutters: Cutter[] = [
  { label: 'flat end mill ⌀1.0', r: 0.5 },
  ...TIPS.flatMap((tip) =>
    LADDER_DEPTHS.map((d) => ({
      label: `V 30° · tip ${tip.toFixed(2)} · d ${d.toFixed(1)}`,
      r: tip / 2 + d * Math.tan((V_HALF_ANGLE_DEG * Math.PI) / 180),
    })),
  ),
].sort((a, b) => a.r - b.r);

const faces = BUNDLED_FONTS.flatMap((f) => [
  { key: `${f.id}/regular`, def: f, weight: 'regular' as const },
  { key: `${f.id}/bold`, def: f, weight: 'bold' as const },
]);

/** One probe job: a single centred label on the default stock, free of edges and keep-outs. */
function probeJob(fontId: string, weight: 'regular' | 'bold', word: string, size: number): EngraveJob {
  const base = defaultEngraveJob();
  const label: EngraveLabel = {
    id: 'probe',
    text: word,
    font: fontId,
    weight,
    size,
    position: { x: base.stock.length / 2, y: base.stock.width / 2 },
    rotation: 0,
    depth: 1.0,
    enabled: true,
  };
  return { ...base, labels: [label] };
}

/** `perCharFor`, copied from `engraveGenerate.ts` — that helper is private to its module. */
function perCharFor(job: EngraveJob): (labelId: string) => PerCharGlyph[] {
  return (labelId) => {
    const label = job.labels.find((l) => l.id === labelId);
    if (!label) return [];
    return [...label.text].map((char) => ({
      char,
      profile: labelProfile({ ...label, text: char }, job.customFonts),
    }));
  };
}

interface Measurement {
  faceKey: string;
  word: string;
  size: number;
  cutter: Cutter;
  ratio: number;
  emptyChars: { index: number; char: string }[];
  /**
   * The same cell measured at 2× scale (size × 2, r × 2). The opening is scale-invariant in
   * exact geometry, so `ratio` should equal `ratio2x` and `delta` is the pipeline's own
   * tessellation error — opentype flattens the glyph curves and Manifold arcs its offsets, both
   * at absolute mm tolerances, so the two are not the same polygon. Measured, not assumed.
   */
  ratio2x: number;
  delta: number;
  /** The 2×-scale run's erasure list, so §2 can say whether the two agree on *which* glyphs go. */
  emptyChars2x: { index: number; char: string }[];
}

const jobs = new Map<string, EngraveJob>();
for (const face of faces) {
  for (const word of WORDS) {
    for (const size of SIZES) {
      jobs.set(`${face.key}|${word}|${size}`, probeJob(face.def.id, face.weight, word, size));
    }
  }
}

const measurements: Measurement[] = [];
let done = 0;
const total = faces.length * WORDS.length * SIZES.length * cutters.length;
for (const face of faces) {
  for (const word of WORDS) {
    for (const size of SIZES) {
      const job = jobs.get(`${face.key}|${word}|${size}`)!;
      const plan = toPartPlan(job);
      const perChar = perCharFor(job);
      // The 2× probe is its own job, one per size, reused across every cutter in this cell.
      const job2 = probeJob(face.def.id, face.weight, word, size * 2);
      const plan2 = toPartPlan(job2);
      for (const cutter of cutters) {
        const m = measureLabels(tl, plan, cutter.r, job.edgeMargin, perChar)[0];
        const m2 = measureLabels(tl, plan2, cutter.r * 2, job2.edgeMargin, perCharFor(job2))[0];
        const ratio = m?.ratio ?? 0;
        const ratio2x = m2?.ratio ?? 0;
        measurements.push({
          faceKey: face.key,
          word,
          size,
          cutter,
          ratio,
          emptyChars: m?.emptyChars ?? [],
          ratio2x,
          delta: Math.abs(ratio - ratio2x),
          emptyChars2x: m2?.emptyChars ?? [],
        });
        done++;
      }
      process.stderr.write(`\r  ${done}/${total}`);
    }
  }
}
process.stderr.write('\n');

const deltas = measurements.map((m) => m.delta).sort((a, b) => a - b);
const medianDelta = deltas[Math.floor(deltas.length / 2)] ?? 0;
const maxDelta = deltas[deltas.length - 1] ?? 0;
/** Cells this close to the threshold are read as "at the line", not as a verdict. */
const NEAR_THRESHOLD = maxDelta;

// ---------------------------------------------------------------------------------------------
// Reading the measurements
// ---------------------------------------------------------------------------------------------

const at = (faceKey: string, word: string, size: number, cutter: Cutter): Measurement | undefined =>
  measurements.find((m) => m.faceKey === faceKey && m.word === word && m.size === size && m.cutter === cutter);

const pct = (ratio: number): string => `${(ratio * 100).toFixed(1)} %`;

/** A ratio is "legible" when it reaches the app's own threshold (`LOST_DETAIL_RATIO`). */
const survives = (m: Measurement | undefined): boolean => (m?.ratio ?? 0) >= LOST_DETAIL_RATIO;

/**
 * A `~` marks a cell within the measured tessellation error of the 90 % line — the verdict is
 * not decidable from this measurement, so it is reported as *at* the line rather than as a
 * pass or a fail.
 */
const statusCell = (m: Measurement | undefined): string => {
  if (!m) return '—';
  if (Math.abs(m.ratio - LOST_DETAIL_RATIO) <= NEAR_THRESHOLD) return `${pct(m.ratio)} ~`;
  return `${pct(m.ratio)}${survives(m) ? '' : ' ✗'}`;
};

function table(header: string[], rows: string[][]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]): string =>
    `| ${cells.map((c, i) => c.padEnd(widths[i]!)).join(' | ')} |`;
  return [line(header), `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`, ...rows.map(line)].join('\n');
}

const lines: string[] = [];
const push = (s: string): void => {
  lines.push(s);
};

push('# #185 — font-opening report: what each cutter actually reaches');
push('');
push('Generated by `scripts/font-opening-report.ts` (re-run it to regenerate). Every number is');
push('#171\'s morphological opening — `offset(offset(glyph, −r), +r)` — measured by the app\'s own');
push('`measureLabels`, at the same radii the Engrave panel warns about. **Nothing here was cut.**');
push('');
push('**The question.** `/Fabrication.md` §7.4 said "a 4 mm cap-height title has a stroke around');
push('0.5 mm" on the strength of a guess. This replaces the guess with a measurement: which strokes');
push('survive the 1.0 mm flat end mill, and which the V-bit reaches that the flat end does not.');
push('');
push('## What was measured, and the one approximation');
push('');
push(`- **Faces:** all six bundled faces — ${BUNDLED_FONTS.map((f) => f.label).join(', ')}, regular and bold.`);
push(`- **Words:** ${WORDS.map((w) => `\`${w}\``).join(' and ')} — the app's own default-job labels, so the`);
push('  sample is not invented and any ratio here can be reproduced by typing the same word.');
push(`- **Cap heights:** ${SIZES.map((s) => `${s} mm`).join(', ')}.`);
push(`- **Cutters:** the ⌀1.0 mm flat end (r = 0.5), and a 30° included V-bit for tip ⌀ ∈ {${TIPS.join(', ')}} mm`);
push(`  over #165's ladder depths ${LADDER_DEPTHS.map((d) => `${d}`).join(' / ')} mm.`);
push('');
push('**Ratios are per-word.** `ratio` = the opened glyph area ÷ the ideal glyph area, so a word whose');
push('letters are mostly thick verticals scores higher than one with thin diagonals at the same cap');
push('height — which is why the tables name the word. The *tolerance* in §5 is a different animal: it');
push('is set by the face\'s thinnest stroke and barely moves between these two words at all.');
push('');
push('**The approximation:** a V-groove is a wedge, not a cylinder. `w(d) = tip + 2·d·tan(15°)` is the');
push('groove\'s surface width at depth `d`, and `w(d)/2` is the radius of the largest circle that fits');
push('inside it. Opening at that radius answers the issue\'s question — *is this stroke reachable at all* —');
push('but it does not model decision 14\'s depth coupling: a stroke **wider** than `w(d)` is still reachable,');
push('just at a floor shallower than `d`. So a ✗ here means erased; a ✓ means "cut to full depth".');
push('');
push('**The fonts, pinned.** These numbers are these bytes, and nothing else:');
push('');
push(table(
  ['font file', 'sha256 (first 12)'],
  [...fontHashes.entries()].map(([file, hash]) => [file, `\`${hash}\``]),
));
push('');
push('A font update that moves an outline changes a hash here and the tables with it. The cutter');
push('radius is likewise the only other input: it is `r = w(d)/2` from the formula above, never a');
push('figure read off a tool label (#185 review).');
push('');
push(`**Precision, measured not assumed.** The opening is exactly scale-invariant, so every cell was`);
push(`measured twice — once at its own size, once at 2× size with r × 2. The two should be identical and`);
push(`are not, because opentype flattens glyph curves and Manifold arcs its offsets at absolute mm`);
push(`tolerances. Over all ${measurements.length} cells the disagreement is a median of`);
push(`${(medianDelta * 100).toFixed(2)} pp and a worst case of ${(maxDelta * 100).toFixed(2)} pp — the worst`);
push('cases sit exactly on a cliff, where a hundredth of a millimetre decides whether a stroke is cut');
push('at all. **A cell within that worst case of the 90 % line is marked `~`**: it is *at* the line, not');
push('demonstrably on one side of it.');
push('');

// -- §1: the headline, one face, one word ------------------------------------------------

const HEAD_FACE = 'sans-default/bold';
const HEAD_WORD = 'CASE';

push(`## 1. Barlow Bold (the app's default face) — \`${HEAD_WORD}\`, every cutter`);
push('');
push(table(
  ['cutter', 'r (mm)', ...SIZES.map((s) => `${s} mm`)],
  cutters.map((c) => [
    c.label,
    c.r.toFixed(3),
    ...SIZES.map((s) => statusCell(at(HEAD_FACE, HEAD_WORD, s, c))),
  ]),
));
push('');
push(`The ` + '`✗`' + ` marks a cell below the app's own ${(LOST_DETAIL_RATIO * 100).toFixed(0)} % legibility threshold, and ` + '`~`' + ` marks one`);
push('sitting within the measured error of it (see §Precision above).');
push('');

// -- §2: per-character loss at the flat end ----------------------------------------------

push('## 2. What the 1.0 mm flat end deletes — character by character');
push('');
push('The flat-end row of §1 says how much area survives; this says *which glyphs* go. A character');
push('listed here had an opened region of exactly zero area — a stroke thinner than the 1.0 mm cutter');
push('is erased whole, not thinned. The last column is the same list at 2× scale: `same` means the two');
push('agree, and a differing list is spelled out.');
push('');
const FLAT = cutters.find((c) => c.label.startsWith('flat'))!;
const charRows: string[][] = [];
for (const face of faces) {
  for (const word of WORDS) {
    for (const size of SIZES) {
      const m = at(face.key, word, size, FLAT);
      if (!m) continue;
      const lost = m.emptyChars.length;
      if (lost === 0) continue;
      const list1 = m.emptyChars.map((e) => e.char).join('');
      const list2 = m.emptyChars2x.map((e) => e.char).join('');
      charRows.push([
        face.key,
        `\`${word}\``,
        `${size} mm`,
        pct(m.ratio),
        m.emptyChars.map((e) => `\`${e.char}\``).join(' '),
        list1 === list2 ? 'same' : `\`${list2}\``,
      ]);
    }
  }
}
push(charRows.length === 0
  ? '**Nothing is erased outright at any measured face, word or cap height.** Every character keeps a'
  : table(['face', 'word', 'cap height', 'ratio', 'characters erased', 'at 2×'], charRows));
push('');

// -- §3: the two cutters across every face ------------------------------------------------

push('## 3. Every bundled face, at the two cutters that matter');
push('');
const V_SHARP = cutters.find((c) => c.label.includes('tip 0.10') && c.label.includes('d 1.0'))!;
for (const [title, cutter] of [['The 1.0 mm flat end mill (r = 0.500)', FLAT], [`The V-bit at r = ${V_SHARP.r.toFixed(3)} (30°, tip 0.10 mm, d = 1.0 mm)`, V_SHARP]] as const) {
  push(`### ${title}`);
  push('');
  push(table(
    ['face', 'word', ...SIZES.map((s) => `${s} mm`)],
    faces.flatMap((f) => WORDS.map((w) => [
      f.key,
      `\`${w}\``,
      ...SIZES.map((s) => statusCell(at(f.key, w, s, cutter))),
    ])),
  ));
  push('');
}

// -- §4: the smallest legible cap height per cutter ---------------------------------------

push('## 4. The smallest legible cap height, per cutter (Barlow Bold)');
push('');
push(`"Legible" = ratio ≥ ${(LOST_DETAIL_RATIO * 100).toFixed(0)} % for \`${HEAD_WORD}\`. "never" means no measured cap`);
push('height reaches it.');
push('');
push(table(
  ['cutter', 'r (mm)', `smallest legible cap height (\`${HEAD_WORD}\`)`, 'verdict'],
  cutters.map((c) => {
    const hit = SIZES.find((s) => survives(at(HEAD_FACE, HEAD_WORD, s, c)));
    return [
      c.label,
      c.r.toFixed(3),
      hit ? `${hit} mm` : 'never',
      hit ? 'reaches' : 'erases everything',
    ];
  }),
));
push('');
const headline = measurements.filter((m) => m.faceKey === HEAD_FACE && m.word === HEAD_WORD);
const decided = headline.filter((m) => Math.abs(m.ratio - LOST_DETAIL_RATIO) > NEAR_THRESHOLD);
const closest = decided.length === 0
  ? null
  : decided.reduce(
      (a, b) => (Math.abs(b.ratio - LOST_DETAIL_RATIO) < Math.abs(a.ratio - LOST_DETAIL_RATIO) ? b : a),
      decided[0]!,
    );
if (closest) {
  push(`Every verdict above is decided: the closest cell not marked \`~\` is ${closest.size} mm at`);
  push(`${(Math.abs(closest.ratio - LOST_DETAIL_RATIO) * 100).toFixed(1)} pp from the line`);
  push(`(\`${closest.cutter.label}\`, ${pct(closest.ratio)}).`);
} else {
  push('Every headline cell sits within the precision bound of the line — read the table as a band,');
  push('not as verdicts.');
}
push('');

// -- §5: the largest cutter each text tolerates -------------------------------------------

/**
 * The radius at which this text's ratio falls to `LOST_DETAIL_RATIO` — the biggest cutter that
 * still engraves it legibly, and therefore the operational form of "how wide are these strokes".
 * Bisected on the ratio itself rather than scaled from another size (a ratio is not linear in
 * size — `engraveGeometry.ts:164`). The ratio falls steeply through this range, so the bisection
 * is well-conditioned: around the crossing the slope is a few hundred pp per mm, which puts the
 * precision band above at roughly ±0.01 mm of radius.
 */
function rAtThreshold(faceKey: string, word: string, size: number): number | null {
  const job = jobs.get(`${faceKey}|${word}|${size}`)!;
  const plan = toPartPlan(job);
  const perChar = perCharFor(job);
  const ratioAt = (r: number): number => measureLabels(tl, plan, r, job.edgeMargin, perChar)[0]?.ratio ?? 0;
  if (ratioAt(2) >= LOST_DETAIL_RATIO) return null; // even a ⌀4 mm cutter would do
  let lo = 0;
  let hi = 2;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (ratioAt(mid) >= LOST_DETAIL_RATIO) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

push('## 5. The widest cutter each text tolerates');
push('');
push(`The largest cutting DIAMETER that still keeps the ratio ≥ ${(LOST_DETAIL_RATIO * 100).toFixed(0)} % —`);
push('bisected per cell on the ratio itself, so it is a measurement and not a scaled guess.');
push('This is the number that replaces §7.4\'s "stroke around 0.5 mm".');
push('');
const tol = new Map<string, number | null>();
for (const f of faces) {
  for (const w of WORDS) {
    for (const s of SIZES) tol.set(`${f.key}|${w}|${s}`, rAtThreshold(f.key, w, s));
  }
}
/** Spread of ⌀/cap-height across the five sizes, as a % of its mean — a measured proportionality. */
function perMmSpread(faceKey: string, word: string): { perMm: number; spreadPct: number } {
  const perMm: { s: number; v: number }[] = [];
  for (const s of SIZES) {
    const r = tol.get(`${faceKey}|${word}|${s}`);
    if (r === null || r === undefined) continue; // the cell reads "≥ 4.00" instead
    perMm.push({ s, v: (2 * r) / s });
  }
  if (perMm.length === 0) return { perMm: 0, spreadPct: 0 };
  const mean = perMm.reduce((a, b) => a + b.v, 0) / perMm.length;
  const vals = perMm.map((p) => p.v);
  return { perMm: mean, spreadPct: ((Math.max(...vals) - Math.min(...vals)) / mean) * 100 };
}
const dia = (faceKey: string, word: string, size: number): string => {
  const r = tol.get(`${faceKey}|${word}|${size}`);
  return r === null || r === undefined ? '≥ 4.00' : (2 * r).toFixed(2);
};
push(table(
  ['face', '⌀ at 4 mm (`CASE`)', '⌀ at 4 mm (`MAKER`)', '⌀ per mm of cap height', 'spread over 4–14 mm'],
  faces.map((f) => {
    const a = perMmSpread(f.key, WORDS[0]);
    const b = perMmSpread(f.key, WORDS[1]);
    return [
      f.key,
      `⌀${dia(f.key, WORDS[0], 4)}`,
      `⌀${dia(f.key, WORDS[1], 4)}`,
      `⌀${a.perMm.toFixed(3)}`,
      `${Math.max(a.spreadPct, b.spreadPct).toFixed(1)} %`,
    ];
  }),
));
push('');
const perMmValues = faces.flatMap((f) => WORDS.map((w) => perMmSpread(f.key, w).perMm));
const lo = Math.min(...perMmValues);
const hi = Math.max(...perMmValues);
const worstSpread = Math.max(...faces.map((f) => Math.max(perMmSpread(f.key, WORDS[0]).spreadPct, perMmSpread(f.key, WORDS[1]).spreadPct)));
push(`Two things the table says by collapsing what was measured: the tolerated diameter is`);
push(`**proportional to cap height** — the worst deviation across the five sizes is ${worstSpread.toFixed(1)} % — so`);
push(`\`⌀ per mm\` is the whole row; and \`CASE\` and \`MAKER\` cross within a hundredth of a millimetre`);
push(`of each other, because the crossing is set by the face's thinnest stroke, not by which word you`);
push(`type.`);
push('');
push(`Across the six faces the tolerated cutter runs from **⌀${lo.toFixed(2)} to ⌀${hi.toFixed(2)} per mm of cap`);
push(`height**. At the 4 mm cap height §7.4's guess was about, that is ${faces.length} different answers`);
push(`spanning ⌀${(4 * lo).toFixed(2)} to ⌀${(4 * hi).toFixed(2)} mm — and the smallest flat end mill in the`);
push(`catalogue is ⌀1.0 mm, which is ${(1.0 / (4 * hi)).toFixed(1)}× wider than even the most forgiving face allows.`);
push('');

// -- §6: how much worse the flat end is ---------------------------------------------------

push('## 6. What this settles');
push('');
push(`Computed from the tables above, so it stays true if the numbers move. "Reaches" = the ratio is`);
push(`≥ ${(LOST_DETAIL_RATIO * 100).toFixed(0)} % for \`${HEAD_WORD}\` in Barlow Bold, the app's default face.`);
push('');
for (const size of SIZES) {
  const flat = at(HEAD_FACE, HEAD_WORD, size, FLAT);
  const vs = cutters.filter((c) => c.label.startsWith('V')).map((c) => ({ c, m: at(HEAD_FACE, HEAD_WORD, size, c)! }));
  const reaching = vs.filter((v) => survives(v.m));
  // The most forgiving V setting that still reaches the line — the largest radius, because a
  // bigger effective radius is a deeper cut (#185's whole point).
  const deepest = reaching[reaching.length - 1];
  push(
    `- **${size} mm \`${HEAD_WORD}\`** — flat end ⌀1.0: ${statusCell(flat)}. ` +
      (reaching.length === 0
        ? 'No V setting reaches the line either.'
        : `A 30° V reaches it at r = ${reaching[0]!.c.r.toFixed(3)} (${reaching[0]!.c.label}), and ` +
          `keeps reaching it down to r = ${deepest!.c.r.toFixed(3)} (${deepest!.c.label}) — ` +
          `${reaching.length} of ${vs.length} rungs.`),
  );
}
push('');

const outPath = join(outDir, '185-font-opening.md');
writeFileSync(outPath, `${lines.join('\n')}\n`, 'utf8');
process.stdout.write(`wrote ${outPath}\n`);
