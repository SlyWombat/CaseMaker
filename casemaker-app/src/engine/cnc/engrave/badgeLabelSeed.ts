/**
 * The ONE label the badge route seeds (#363).
 *
 * Taking a badge blank replaces the job's stock, void and depths (#271 route 1, #352, #362) — but
 * nothing moved the labels, so the shipped demo job's three lines, laid out for a 100 × 60 mm
 * softwood plank, were left standing on a 76.2 × 38.1 mm badge. `CASE` at (50, 43) ran 12 mm off
 * the back edge of the smaller blank and every line was centred 10 mm right of the badge's centre,
 * so `generate` refused the job the wizard had just built with three `item-outside-stock` errors.
 *
 * Option (a) of the issue, and the house rule behind it (a default, not a knob): those three lines
 * were demo text for a plank, not badge text. A badge is a name badge, so the badge route seeds
 * one line of it, laid out FROM the blank — and `takeBadgeBlank` runs the same
 * `redepthLabelsForBlank` walk over it that #362 added, so the depth is the one #362 already
 * recommends for the new blank: on the default badge the magnet pocket's ceiling binds, and the
 * line comes out at 0.51 mm wherever in the band it sits (the void limit is a property of the
 * blank, not of what happens to be over it).
 *
 * This module is PURE and returns plain data: no store, no font registry, no wasm. The store
 * decides WHEN to seed (only a job still carrying the shipped demo labels, untouched) and writes
 * the result; the measurement is injected, because a bundled face that has not been parsed yet
 * throws rather than answering (#180) and the wizard's hand-off must not depend on the fonts
 * being up.
 */

import type { TextWeight } from '@/types/textLabel';
import type { EngraveJob, EngraveLabel, EngraveKeepOutRect } from '@/types/engraveJob';
import type { Mm } from '@/types/units';
import { defaultEngraveJob, newEngraveLabelId } from './defaults';

/**
 * The placeholder the badge route writes. Deliberately NOT the project's name
 * (`"<Board> Case"`), which reads wrong on a name badge; a neutral placeholder carries no wrong
 * information, and the text is the user's to type over.
 */
export const BADGE_SEED_TEXT = 'Name';

/**
 * How much of the room a free band offers the seeded line takes, as a fraction.
 *
 * There is more to keep clear of than the pocket: the cutter's own clearance to the blank's edge
 * is `edgeMargin` (already taken off below), and a badge is engraved after being printed, so the
 * dome and the print's own overshoot want something too. 0.7 of an 11.55 mm band is 8 mm of cap
 * height with 1.8 mm either side of it — the number the issue's decision quotes.
 */
const BAND_FILL = 0.7;

/**
 * The floor the seeded label starts at, mm, before `redepthLabelsForBlank` replaces it — the same
 * starting number `engraveJobStore`'s `newLabel` writes, and for the same reason (the schema
 * refuses 0, and a document must never carry a depth nobody computed). The walk below runs on the
 * blank as it now stands and writes both the value and its `computed` stamp (#362), so this is
 * never the number anything cuts at: a blank so thin that no floor survives (pocket ceiling, jaws
 * and underside all inside their clearances) is a setup the jaw and void findings already refuse.
 */
const STARTING_DEPTH = 0.5;

/**
 * Average glyph advance, in em, for the FALLBACK ink box: the same ≈0.6 em/char estimate the
 * board preview's silkscreen label uses. It is only ever read when the real face is not parsed —
 * a wide line is then a shade likelier to be measured down a millimetre further, which is the
 * harmless direction to be wrong in.
 */
const ESTIMATED_ADVANCE_EM = 0.6;

/** The ink box of `text` at cap height `size`, mm — what the seed lays out and fits. */
export interface SeedGlyphBox {
  width: Mm;
  height: Mm;
}

/**
 * Measure one candidate line, or answer `null` when the face is not available — in which case the
 * caller falls back to `ESTIMATED_ADVANCE_EM`. Injected so this module stays free of the font
 * registry (and of its throw).
 */
export type SeedMeasure = (
  text: string,
  font: string,
  weight: TextWeight,
  size: Mm,
) => SeedGlyphBox | null;

/** The blank the seed lays a label out on, in the job's frame: front-left corner at the origin. */
export interface BadgeSeedBlank {
  length: Mm;
  width: Mm;
  /**
   * The void the badge declares, or null, in the RECT shape (`badgeBlankFor` builds the magnet
   * pocket as one, and a y-band is only a band for a rect) — `position` its CENTRE. Read as a band
   * across the whole blank (see `freeBands`): the badge centres its pocket and this seed centres the
   * line, so a y-band clear of the pocket is clear of it whatever the line's width.
   */
  pocket: EngraveKeepOutRect | null;
}

/** Everything `badgeLabelSeed` reads. Plain data: the store extracts it from the job. */
export interface BadgeLabelSeedInputs {
  blank: BadgeSeedBlank;
  /** The blank's edge inset, mm — `job.edgeMargin`, the number the outside-stock finding uses. */
  edgeMargin: Mm;
  /** The face to set the line in, borrowed from the job's own demo labels. */
  font: string;
  weight: TextWeight;
  /** The placeholder. Defaults to `BADGE_SEED_TEXT`. */
  text?: string;
  measure?: SeedMeasure;
}

/**
 * The fields a demo label is compared on — everything that decides what it CUTS, plus the intent
 * that decides which colour its floor means, and nothing else.
 *
 * Deliberately by VALUE and not by id (`defaultEngraveJob` mints a fresh id every call, so the
 * shipped labels have no stable identity to check against).
 *
 * The two optionals are compared by what they MEAN rather than by presence: `construction ?? false`
 * (a label with no flag and one flagged `false` both cut, so they are the same label), and
 * `depthIntent ?? null` (a stated intent is a claim about which colour the floor is, which the
 * shipped set never makes).
 */
function demoShape(l: EngraveLabel): string {
  return JSON.stringify([
    l.text,
    l.font,
    l.weight,
    l.size,
    l.position.x,
    l.position.y,
    l.rotation,
    l.depth,
    l.enabled,
    l.construction ?? false,
    l.depthIntent ?? null,
  ]);
}

/**
 * Is this job still carrying the shipped demo labels, untouched?
 *
 * The gate on the whole seed (#363): a label set the person has made is theirs, so the badge route
 * replaces ONLY the three lines it shipped with — one typed character, a moved line, a stated
 * intent or a claimed depth takes the job out of this function's answer, and then the labels are
 * left exactly where they are (and, as #362 already does, only the unclaimed ones are re-depth-ed).
 *
 * The claim check is belt-and-braces beside the values: `sources.labels` is how a number says who
 * decided it (#362), and a claim on ANY label means this job has been touched by someone who
 * stated something. It also keeps the replacement from leaving an orphan claim behind for an id it
 * is about to drop.
 */
export function isShippedDemoLabelSet(job: Pick<EngraveJob, 'labels' | 'sources'>): boolean {
  if (Object.keys(job.sources?.labels ?? {}).length > 0) return false;
  const demo = defaultEngraveJob().labels;
  if (job.labels.length !== demo.length) return false;
  return job.labels.every((l, i) => demoShape(l) === demoShape(demo[i]!));
}

/**
 * The y-bands of the blank a line can sit in without touching the pocket, front (the operator's
 * edge, y = 0) first.
 *
 * The free space either side of the pocket, INSIDE the edge inset. Empty when the pocket leaves no
 * strip tall enough to be worth naming — a blank whose pocket spans the usable height — which the
 * caller reads as "no free band": the seed then centres the line on the blank and accepts the
 * `item-over-void` warning, which is the honest thing for a badge whose pocket is its whole face.
 */
function freeBands(blank: BadgeSeedBlank, edgeMargin: Mm): { y0: Mm; y1: Mm }[] {
  const y0 = edgeMargin;
  const y1 = blank.width - edgeMargin;
  if (y1 <= y0) return [];
  const { pocket } = blank;
  if (!pocket) return [{ y0, y1 }];
  const roof = pocket.position.y - pocket.height / 2;
  const floor = pocket.position.y + pocket.height / 2;
  const bands = [
    { y0, y1: Math.min(y1, roof) },
    { y0: Math.max(y0, floor), y1 },
  ];
  return bands.filter((b) => b.y1 > b.y0);
}

/** The ink box of one candidate size: the injected measurement, or the documented estimate. */
function inkBoxOf(text: string, font: string, weight: TextWeight, size: Mm, measure?: SeedMeasure): SeedGlyphBox {
  const measured = measure?.(text, font, weight, size);
  if (measured) return measured;
  return { width: ESTIMATED_ADVANCE_EM * size * text.length, height: size };
}

/**
 * The one label the badge route seeds, or null when this blank cannot hold one at all.
 *
 * The shape of the answer, and why each number is what it is:
 *
 *   - **The band** — the free strip with the most ROOM, ties going to the front (nearest the
 *     operator, and the edge a badge is read from). With no pocket the whole usable area is one
 *     band.
 *   - **The cap height** — `BAND_FILL` of the band, rounded DOWN to a whole millimetre, then
 *     measured down a millimetre at a time until the line's real ink box fits both the band's
 *     height and the blank's usable width. Whole millimetres and not a measured size: this is a
 *     starting point a person reads and edits, and `8` is a number someone can see is too big.
 *   - **The position** — centred in its band, and centred on the blank's X. `position` is the ink
 *     box's CENTRE, which is what `labelProfile` centres a label on too, so the clearance either
 *     side of the band is the same number.
 *   - **The depth** — `STARTING_DEPTH`, and the caller's `redepthLabelsForBlank` walk replaces it
 *     before anything reads it, so one place owns the number and its provenance (#362).
 *
 * Null when no size at or above 1 mm fits — a blank too small to hold a single line at all. Nothing
 * is seeded then; the person gets the demo labels' own findings, which is the honest report.
 */
export function badgeLabelSeed(inputs: BadgeLabelSeedInputs): EngraveLabel | null {
  const { blank, edgeMargin, font, weight } = inputs;
  const text = inputs.text ?? BADGE_SEED_TEXT;
  const usableWidth = blank.length - 2 * edgeMargin;
  if (usableWidth <= 0 || text.trim().length === 0) return null;

  // The band with the most room, front first on a tie (`reduce` keeps the first). With no free
  // band at all the line is centred on the blank instead and takes the pocket's warning with it.
  const bands = freeBands(blank, edgeMargin);
  const band = bands.reduce<{ y0: Mm; y1: Mm } | null>(
    (a, b) => (a === null || b.y1 - b.y0 > a.y1 - a.y0 ? b : a),
    null,
  );
  const room = band
    ? { y0: band.y0, y1: band.y1 }
    : { y0: edgeMargin, y1: blank.width - edgeMargin };
  const bandHeight = room.y1 - room.y0;
  if (bandHeight <= 0) return null;

  const start = Math.floor(BAND_FILL * bandHeight);
  for (let size = Math.min(start, Math.floor(usableWidth)); size >= 1; size--) {
    const ink = inkBoxOf(text, font, weight, size, inputs.measure);
    if (ink.width <= usableWidth && ink.height <= bandHeight) {
      return {
        id: newEngraveLabelId(),
        text,
        font,
        weight,
        size,
        position: { x: blank.length / 2, y: (room.y0 + room.y1) / 2 },
        rotation: 0,
        depth: STARTING_DEPTH,
        enabled: true,
      };
    }
  }
  return null;
}
