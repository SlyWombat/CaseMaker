/**
 * The ONE label a blank route seeds (#363, #364).
 *
 * Taking a blank replaces the job's stock, void and depths (#271 route 1, #352, #362) — but nothing
 * moved the labels, so the shipped demo job's three lines, laid out for a 100 × 60 mm softwood
 * plank, were left standing on whatever blank was taken. On a badge (76.2 × 38.1 mm) `CASE` ran
 * 12 mm off the back edge and every line was centred 10 mm right of the centre, so `generate`
 * refused the job the wizard had just built with three `item-outside-stock` errors; on any other
 * blank the same three lines ran off the edges in the same way (#364).
 *
 * Option (a) of the issue, and the house rule behind it (a default, not a knob): those three lines
 * were demo text for a plank, not badge text. A badge is a name badge, so the badge route seeds
 * one line of it, laid out FROM the blank — and `takeBadgeBlank` runs the same
 * `redepthLabelsForBlank` walk over it that #362 added, so the depth is the one #362 already
 * recommends for the new blank: 1.0 mm on the default badge, its colour split's own reveal (see
 * below).
 *
 * The seeded line sits in the free band BESIDE the pocket, and since #365 the walk's void bound
 * knows it: `voidLimitForItem` asks about the voids the LINE's own ink box reaches, so the pocket
 * a line is clear of no longer sets its depth. Measured: the line at (38.1, 6.775) has no void
 * under it. Before #365 the bound was blank-wide (`shallowestVoidLimit`) and this line was advised
 * the pocket's 0.51 mm.
 *
 * The JAW bound knows where the line is too, since #369: a line's own ink box decides whether the
 * jaws can reach it, and this one comes no nearer than 6.9 mm to a jaw face even at the estimate's
 * width — past the 1 mm reach the jaws are judged by (`uncertainty + radius`, #394: 0.5 mm of vise
 * band and a 1 mm cutter) — so the jaws set no limit here and the split's reveal is what the walk
 * writes. While every line was charged the blank-wide jaw floor, this line took 1.905 − 1 =
 * 0.905 mm instead (the vise default of the day; a new job now SEATS the blank at `thickness − 3.1`,
 * #391), which lands inside the split's ±0.2 mm band and came back up as a 0.6 mm `surface` floor:
 * a two-colour blank handed over with a floor that stops just short of its colour boundary.
 *
 * The BARE blank (#364) takes the same rule with `BLANK_SEED_TEXT` and no pocket, so `freeBands`
 * answers its whole usable face as one band: a `Text` line sized to the blank, rather than three
 * demo words laid out for a blank they were not written for. The demo PLANK (100 × 60) is the one
 * blank that keeps the three lines — they are the content that blank shipped with — and the store's
 * footprint test is what tells the two apart.
 *
 * #364 also made the FALLBACK measurement an upper bound (`inkBox.ts`'s `ESTIMATED_ADVANCE_EM`,
 * which since #365 is also what the depth bound measures a line with). The hand-off runs
 * before any face is parsed, so the estimate is what sizes the seeded line in the app — and the old
 * rule of thumb erred small, which seeded a line the real face then ran off the blank. That is the
 * same `item-outside-stock` failure this seed exists to remove, produced by the seed itself.
 *
 * This module is PURE and returns plain data: no store, no font registry, no wasm. The store decides
 * WHEN to seed — a set the route may replace (`mayRelayoutLabels` for the badge, whose seed may also
 * take over an earlier take's line; `isShippedDemoLabelSet` alone for a bare blank, whose seed is
 * only a placeholder) — and writes the result. The measurement is injected, because a bundled face
 * that has not been parsed yet throws rather than answering (#180) and the wizard's hand-off must
 * not depend on the fonts being up.
 */

import type { TextWeight } from '@/types/textLabel';
import type { EngraveJob, EngraveLabel, EngraveKeepOutRect, FieldSource } from '@/types/engraveJob';
import type { Mm } from '@/types/units';
import { inkBoxOf, type InkMeasure } from './inkBox';
import { defaultEngraveJob, newEngraveLabelId } from './defaults';

/**
 * The placeholder the badge route writes. Deliberately NOT the project's name
 * (`"<Board> Case"`), which reads wrong on a name badge; a neutral placeholder carries no wrong
 * information, and the text is the user's to type over.
 */
export const BADGE_SEED_TEXT = 'Name';

/**
 * The placeholder the bare-blank route writes (#364).
 *
 * `Text` and not a name or a word with meaning: a blank is "just cut something", so the shipped
 * line has to be something the person will type over, and `Text` is the string the label editor's
 * own empty state uses. A word like `CASE` would read as content that fits a differently-shaped
 * blank.
 */
export const BLANK_SEED_TEXT = 'Text';

/**
 * How much of the room a free band offers the seeded line takes, as a fraction — the LABELLED
 * FALLBACK for the shop's `engrave.blankBandFill` (#451), and the same number it is seeded with.
 *
 * There is more to keep clear of than the pocket: the cutter's own clearance to the blank's edge
 * is `edgeMargin` (already taken off below), and a printed blank — a badge above all — is engraved
 * after printing, so the dome and the print's own overshoot want something too. This fallback,
 * 0.7 of an 11.55 mm band, is 8 mm of cap height with 1.8 mm either side of it — the number the
 * issue's decision quotes. A caller sends the shop's own number; this constant is what is left for
 * the no-service build (the hosted web app), exactly as the sim's pitches and clearances do.
 */
export const BLANK_BAND_FILL_FALLBACK = 0.7;

/**
 * The floor the seeded label starts at, mm, before `redepthLabelsForBlank` replaces it — the same
 * starting number `engraveJobStore`'s `newLabel` writes, and for the same reason (the schema
 * refuses 0, and a document must never carry a depth nobody computed). The walk below runs on the
 * blank as it now stands and writes both the value and its `computed` stamp (#362), so this is
 * never the number anything cuts at: a blank so thin that no floor survives (pocket ceiling, jaws
 * and underside all inside their clearances) is a setup the jaw and void findings already refuse.
 */
const STARTING_DEPTH = 0.5;

/** The blank the seed lays a label out on, in the job's frame: front-left corner at the origin. */
export interface SeedBlank {
  length: Mm;
  width: Mm;
  /**
   * The void the blank declares, or null, in the RECT shape (`badgeBlankFor` builds the badge's
   * magnet pocket as one, and a y-band is only a band for a rect) — `position` its CENTRE. Read as
   * a band across the whole blank (see `freeBands`): the badge centres its pocket and this seed
   * centres the line, so a y-band clear of the pocket is clear of it whatever the line's width.
   *
   * A bare blank has none (`blankStockFor` carries dimensions only), so its free band is the whole
   * usable face.
   */
  pocket: EngraveKeepOutRect | null;
}

/** Everything `blankLabelSeed` reads. Plain data: the store extracts it from the job. */
export interface LabelSeedInputs {
  blank: SeedBlank;
  /** The blank's edge inset, mm — `job.edgeMargin`, the number the outside-stock finding uses. */
  edgeMargin: Mm;
  /** The face to set the line in, borrowed from the job's own labels. */
  font: string;
  weight: TextWeight;
  /** The placeholder: `BADGE_SEED_TEXT` for a badge, `BLANK_SEED_TEXT` for a bare blank. */
  text?: string;
  /**
   * The shop's `engrave.blankBandFill` (#451): how much of a free band the line takes, as a
   * fraction in (0, 1]. Read from the location by the caller, because this module is pure. Absent
   * — or outside that range, which a hand-built caller may pass — `BLANK_BAND_FILL_FALLBACK`
   * stands in.
   */
  bandFill?: number;
  measure?: InkMeasure;
}

/**
 * The fields a demo label is compared on — everything that decides what it CUTS **except the DEPTH
 * and the intent**, plus nothing else that the app's own walk can write.
 *
 * Deliberately by VALUE and not by id (`defaultEngraveJob` mints a fresh id every call, so the
 * shipped labels have no stable identity to check against).
 *
 * `depth` is NOT one of them (#363 review): since #362 a depth a person typed carries
 * `depth: 'user'` in `sources`, so a depth that differs WITHOUT a stated claim is one the app wrote
 * — or one typed before #362, which `redepthLabelsForBlank` already documents as indistinguishable
 * from an app-written one, and re-depths. Comparing the number here is what made a job the OLD
 * badge route had already re-depth-ed to 0.51 look like a job somebody had touched, so it was never
 * re-seeded.
 *
 * `depthIntent` is out for the same reason, one step further (#363 review, folding the follow-up):
 * the walk WRITES `'reveal'` on a printed badge's floor and stamps it `computed`, so a pre-#363 job
 * that went through a split badge carries a `depthIntent` value the shipped set never had and would
 * never re-seed. A person's intent is caught by provenance like every other claim (they can only
 * reach it through `updateLabel`, which stamps `user`), not by its value.
 *
 * `construction` stays, compared by what it MEANS rather than by presence: `construction ?? false`
 * (a label with no flag and one flagged `false` both cut, so they are the same label).
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
    l.enabled,
    l.construction ?? false,
  ]);
}

/** The two `FieldSource`s that say a PERSON stated the value — the ones that make a label theirs. */
const STATED_SOURCES: readonly FieldSource[] = ['user', 'measured'];

function isStated(source: FieldSource | undefined): boolean {
  return source !== undefined && STATED_SOURCES.includes(source);
}

/**
 * Has anyone stated anything about these labels that the app did not work out? (#363 review)
 *
 * Only `user` and `measured` count. `computed` is the app's own past answer — the walk in
 * `redepthLabelsForBlank` writes one and the seed below stamps one — so it says nothing about
 * whether the person wants the line where it is. Reading every claim as a touch is what kept a
 * pre-#363 job, whose three lines the old badge route had re-depth-ed and stamped `computed`, out
 * of the seed for good.
 */
function hasStatedClaim(job: Pick<EngraveJob, 'sources'>): boolean {
  return Object.values(job.sources?.labels ?? {}).some(
    (claim) => isStated(claim.depth) || isStated(claim.depthIntent) || isStated(claim.layout),
  );
}

/** Are these still the shipped demo labels, by value? (`demoShape` says what is compared.) */
export function isShippedDemoLabelSet(job: Pick<EngraveJob, 'labels'>): boolean {
  const demo = defaultEngraveJob().labels;
  if (job.labels.length !== demo.length) return false;
  return job.labels.every((l, i) => demoShape(l) === demoShape(demo[i]!));
}

/**
 * Did a ROUTE lay every one of these labels out? (#363 review)
 *
 * The badge route can run more than once — take one badge blank, then a different one — and the
 * second take has to re-lay the line the first one seeded, which is neither the demo set nor
 * anything a person has touched. What identifies it is provenance and not values: the seed stamps
 * `layout: 'computed'` on the line it writes, and a person's own edit stamps `layout: 'user'`
 * (which `hasStatedClaim` has already caught by the time this is asked).
 *
 * EVERY label has to carry the stamp, so one line the person added — which has no claim at all —
 * takes the whole set out of consideration.
 */
function isRouteLaidOut(job: Pick<EngraveJob, 'labels' | 'sources'>): boolean {
  return (
    job.labels.length > 0 &&
    job.labels.every((l) => job.sources?.labels?.[l.id]?.layout === 'computed')
  );
}

/**
 * May the BADGE route replace this job's labels? The gate `takeBadgeBlank` asks (#363).
 *
 * True for the shipped demo set, and for a set the badge route seeded on an earlier take. False the
 * moment a person has stated anything about any line, and false for a job left with no lines — a set
 * someone emptied is a decision, and re-seeding it would hand back a line they deleted.
 *
 * The BARE-blank route (#364) asks only `isShippedDemoLabelSet`, not this: a badge seeds content of
 * its own (a badge is a name badge) and so may also take over a line an earlier take left, but a
 * blank's seed is only a placeholder, so it replaces the demo words it was never written for and
 * leaves any other set alone — including a line the badge route seeded.
 */
export function mayRelayoutLabels(job: Pick<EngraveJob, 'labels' | 'sources'>): boolean {
  if (job.labels.length === 0) return false;
  if (hasStatedClaim(job)) return false;
  return isShippedDemoLabelSet(job) || isRouteLaidOut(job);
}

/**
 * The y-bands of the blank a line can sit in without touching the pocket, front (the operator's
 * edge, y = 0) first.
 *
 * The free space either side of the pocket, INSIDE the edge inset. Empty when the pocket leaves no
 * strip tall enough to be worth naming — a blank whose pocket spans the usable height — which the
 * caller reads as "no free band": the seed then centres the line on the blank and accepts the
 * `item-over-void` warning, which is the honest thing for a blank whose pocket is its whole face.
 *
 * Two voids are not bands at all, and both fall back to the whole usable area (the same reading as
 * "no pocket", so the line still goes on the blank): one that is **disabled** — it does not cut, and
 * the recommendation ignores it too — and one **rotated** off the axes, whose y-extent is not a
 * height a horizontal band can be cut out of. A rect at 0° or 180° has the same footprint either
 * way and is answered normally.
 */
function freeBands(blank: SeedBlank, edgeMargin: Mm): { y0: Mm; y1: Mm }[] {
  const y0 = edgeMargin;
  const y1 = blank.width - edgeMargin;
  if (y1 <= y0) return [];
  const { pocket } = blank;
  if (!pocket || !pocket.enabled || pocket.rotation % 180 !== 0) return [{ y0, y1 }];
  const roof = pocket.position.y - pocket.height / 2;
  const floor = pocket.position.y + pocket.height / 2;
  const bands = [
    { y0, y1: Math.min(y1, roof) },
    { y0: Math.max(y0, floor), y1 },
  ];
  return bands.filter((b) => b.y1 > b.y0);
}

/**
 * The one label a blank route seeds, or null when this blank cannot hold one at all.
 *
 * The shape of the answer, and why each number is what it is:
 *
 *   - **The band** — the free strip with the most ROOM, ties going to the front (nearest the
 *     operator, and the edge a line is read from). With no pocket the whole usable area is one band.
 *   - **The cap height** — the shop's band fill (`engrave.blankBandFill`; fallback
 *     `BLANK_BAND_FILL_FALLBACK`) of the band, rounded DOWN to a whole millimetre, then measured
 *     down a millimetre at a time until the line's real ink box fits both the band's height and
 *     the blank's usable width. Whole millimetres and not a measured size: this is a starting
 *     point a person reads and edits, and `8` is a number someone can see is too big.
 *   - **The position** — centred in its band, and centred on the blank's X. `position` is the ink
 *     box's CENTRE, which is what `labelProfile` centres a label on too, so the clearance either
 *     side of the band is the same number.
 *   - **The depth** — `STARTING_DEPTH`, and the caller's `redepthLabelsForBlank` walk replaces it
 *     before anything reads it, so one place owns the number and its provenance (#362).
 *
 * Null when no size at or above 1 mm fits — a blank too small to hold a single line at all. Nothing
 * is seeded then; the person gets the demo labels' own findings, which is the honest report.
 */
export function blankLabelSeed(inputs: LabelSeedInputs): EngraveLabel | null {
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

  // The band fill is the shop's (#451): the caller reads `engrave.blankBandFill` from the location
  // because this module is pure, and a no-service build falls back to the labelled constant. A
  // fraction outside (0, 1] — which the location's own rule refuses, but a hand-built caller may
  // pass — falls back rather than sizing a line to no band at all (0 would floor below 1 mm and
  // seed nothing) or taking more than the band.
  const askedFill = inputs.bandFill;
  const bandFill =
    typeof askedFill === 'number' && Number.isFinite(askedFill) && askedFill > 0 && askedFill <= 1
      ? askedFill
      : BLANK_BAND_FILL_FALLBACK;
  const start = Math.floor(bandFill * bandHeight);
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
