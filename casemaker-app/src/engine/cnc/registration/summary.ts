/**
 * The registration in sentences (#430 phase 1) — the one UI-facing piece before the job flow draws
 * it: what the plan will do, and what the run found. Pure.
 */

import { probeInstrumentOf, topTouchTipRadiusMm, topTouchTipWords, type RegistrationPlan } from './plan';
import { topTouchEdgeMarginsMm } from './cutBlank';
import { probeColletWords } from '@/engine/cnc/probeFitWords';
import type { RegistrationOutcome } from './outcome';

const n = (v: number) => String(Math.round(v * 100) / 100);

/**
 * #1200 — THE CARD'S TIP FACT AND ITS PROVENANCE. The value stands alone ("Top touches are kept
 * 3 mm inside the edges"); the source is its own sentence, never a caveat on the value.
 */
function tipSentence(plan: RegistrationPlan): string {
  const tip = plan.topTouchTip;
  const hold = plan.holdUncertainty;
  const floor = plan.settings.probeFootprintShrinkMm;
  if (tip === undefined || hold === undefined || floor === undefined) return '';
  const margins = topTouchEdgeMarginsMm(
    { tipRadiusMm: topTouchTipRadiusMm(tip), tipLateralUncertaintyMm: plan.probe?.tipLateralUncertaintyMm ?? 0 },
    { floorMm: floor, hold },
  );
  return ` Top touches are kept ${n(Math.min(margins.xMm, margins.yMm))} mm inside the edges. ${topTouchTipWords(tip, floor)}.`;
}

export function summarizePlan(plan: RegistrationPlan): string {
  const s = plan.settings;
  // #640 — the probe the plan will actually use: the 3D probe touches edges sideways, so the
  // narration must not send the operator to fit the wired one.
  const probeWords = probeInstrumentOf(plan.probe) === 'xyz' ? 'the 3D probe' : 'the wired probe';
  // #1201 — A GUARDED TOP SEEK has no expected surface: the card names BOTH points before the
  // press and the floor under them, so the operator can clear the spots and see where the probe
  // will stop if the blank is not there.
  if (plan.guarded !== undefined) {
    const points = (plan.surfaceChecks ?? [])
      .map((check) => `(${n(check.x)}, ${n(check.y)})`)
      .join(' and ');
    const floor = plan.guarded.floorMachineZ + plan.guarded.marginMm;
    const clamps = plan.mountObstacles.filter((o) => o.kind === 'clamp').map((o) => o.label);
    const assumes =
      plan.mount === 'bracket'
        ? ` It assumes ${clamps.length === 0 ? 'no clamps on the stock' : clamps.join('; ')} — you confirm that before the probe moves.`
        : '';
    return (
      `Home, fit ${probeWords} and measure it (M491); touch the TOP OF THE BLANK at ${points} — ` +
      `two touches that must agree, each seek stopping above the bed at machine Z ${n(floor)}; home when finished.${assumes}` +
      tipSentence(plan)
    );
  }
  if (plan.references) {
    // #429 review: the walls by their labels, and the surface touch where it really is.
    return (
      `Home, fit ${probeWords} (${probeColletWords(plan.probe?.shankMm)}) and measure it (M491); touch the surface at (${n(plan.surfacePoint.x)}, ${n(plan.surfacePoint.y)}), ` +
      `on solid stock clear of every opening; then scan ${plan.scans.map((sc) => sc.label ?? `the ${sc.edge} edge`).join(', ')} — bracketing each wall ` +
      `and bisecting to ${n(s.fineStepMm)} mm, stopping at the first touch that falls into the opening, every touch capped at the surface − ${n(s.capBelowSurfaceMm)} mm; home when finished.` +
      tipSentence(plan)
    );
  }
  // #1123 item 29 — a plan with NO scans (a bracket whose offset was measured: the bracket fixes
  // X and Y, only the surface is touched) narrates NO scan. Before this, the empty case fed the
  // sentence its own words — "then scan no edge scan (the bracket fixes X and Y) — bracketing each
  // edge and bisecting …", which reads as a garbled instruction to do something impossible.
  // #1123 item 46 — NO BRACKET ARM HERE. A bracket's plan carries no scans (#1133: the bracket
  // fixes X and Y, so nothing is measured along an edge), so the "right edge at Y … and the back
  // edge at X …" arm could never be reached; it also indexed scans[1] blind. The empty case above
  // speaks for every bracketed plan.
  const edges =
    plan.scans.length === 0
      ? ''
      : plan.disc !== undefined
        ? `the disc’s rim at its centre-lines — left, right, front and back — so each touch finds the extreme point of the circle (the centre is the midpoint of each opposite pair, the diameter the span)`
        : plan.scans.map((sc) => `the ${sc.edge} edge at ${sc.edge === 'left' || sc.edge === 'right' ? 'Y' : 'X'} ${n(sc.along)}`).join(', ');
  const clamps = plan.mountObstacles.filter((o) => o.kind === 'clamp').map((o) => o.label);
  const assumes =
    plan.mount === 'bracket'
      ? ` It assumes ${clamps.length === 0 ? 'no clamps on the stock' : clamps.join('; ')} — you confirm that before the probe moves.`
      : '';
  // #619/#607/#640 — the plan's FIRST act is its mount tap whenever there is one, checked against
  // the stored reference: the vise's fixed-jaw top, or the bracket's seat. The #607 bracket tap has
  // no `mountDatum` (its seat is the datum), so keying this on the datum alone narrated no tap and
  // sent the operator by surprise to the arm.
  // (`?? null`: a hand-built plan in a spec may omit the field, and the narration has no business
  // crashing over a tap that is not there.)
  const tapPoint = plan.mountTap ?? null;
  const tap =
    tapPoint === null
      ? ''
      : tapPoint.reference === 'bracket-seat'
        ? ` the bracket's seat beside the arm is tapped first and checked against the stored seat;`
        : ` the fixed-jaw top is tapped first and checked against the stored datum${
            plan.mountDatum == null ? '' : ` (${n(plan.mountDatum.jawTopZ)})`
          };`;
  const scanClause =
    plan.scans.length === 0
      ? ''
      : `; then scan ${edges} — ` +
        // #1133 — the edge find stays in its band: a sideways seek travels in from outside, and a
        // Z-only scan never probes deeper in than the band either.
        `each kept within ±${n(s.edgeBandMm)} mm of where its edge is expected, stopping at the first touch off the stock, ` +
        `every touch capped at the surface − ${n(s.capBelowSurfaceMm)} mm`;
  return (
    `Home, fit ${probeWords} (${probeColletWords(plan.probe?.shankMm)}) and measure it (M491);${tap}` +
    ` touch the surface at the cut area's centre ` +
    `(${n(plan.surfacePoint.x)}, ${n(plan.surfacePoint.y)})${scanClause}; home when finished.${assumes}` +
    tipSentence(plan)
  );
}

export function summarizeOutcome(o: RegistrationOutcome): string {
  if (!o.usable) {
    return `The measurement is not usable, and no origin will be written from it: ${o.problems.join('; ')}.`;
  }
  // #1088 — SIDE 2 READS ITS OWN SENTENCE: the bores' centres and diameters, their line against the
  // pins', and the corner touches against the carried top. The side-1 wording below ("the stock is
  // off by … the margin") would judge a frame this run is replacing.
  if (o.flip !== undefined) {
    const f = o.flip;
    const bores = f.holes.map((h) => `(${n(h.centre.x)}, ${n(h.centre.y)}) ⌀${n(h.diameterMm)} mm`).join(' and ');
    const cross =
      f.crossCheck === null
        ? ''
        : `; their line reads ${n(f.crossCheck.measuredAngleDeg)}° against the pins' ${n(f.crossCheck.expectedAngleDeg)}° (inside ${n(f.crossCheck.toleranceDeg)}°)`;
    const carried =
      f.carried === null || f.carried.band === null
        ? ''
        : `; the corner touches read ${f.frontPair.map((p) => `${n(p.surfaceZ)} mm`).join(' and ')} against the carried side-2 top ${n(f.carried.topMachineZ)} mm`;
    return `Side 2 registered on the bores side 1 left: ${bores}${cross}${carried}. The origin is the bores' midpoint X and the front pair's mean Y — confirmed.`;
  }
  if (o.currentG54 === null && !o.bracketCheck) {
    return 'The surface was found. X and Y were NOT checked: they are the bracket’s, taken on trust (no confirming touch).';
  }
  if (o.bracketCheck) {
    const c = o.bracketCheck;
    return `X and Y from the bracket; the confirming touch found the right edge ${n(c.x ?? 0)} mm and the back edge ${n(c.y ?? 0)} mm from where the bracket’s corner puts them — within the ${n(o.margin)} mm margin.`;
  }
  const parts: string[] = [];
  if (o.measured.x) parts.push(`X off by ${n(o.offset.x)} mm`);
  if (o.measured.y) parts.push(`Y off by ${n(o.offset.y)} mm`);
  if (o.rotationDeg !== null) parts.push(`turned ${n(o.rotationDeg)}° (${n(o.rotationShiftMm ?? 0)} mm over its length)`);
  const found = parts.length === 0 ? 'the surface was found' : `the stock is ${parts.join(', ')}`;
  const verdict = o.withinMargin
    ? `within the ${n(o.margin)} mm margin — confirmed`
    : `outside the ${n(o.margin)} mm margin — set the origin from the measurement (after you confirm), or stop and re-seat`;
  // #743 — a disc's rim has its own number: the span the touches found, against the stated ⌀.
  // Both spans are always stated (an out-of-round blank is a fact, not a refusal), and a size more
  // than 1 % off says the operator is asked — never that the origin is withheld.
  const discWord =
    o.disc === undefined
      ? ''
      : ` It measures ⌀${n(o.disc.measuredMm)} mm` +
        (o.disc.spanXMm !== null && o.disc.spanYMm !== null
          ? ` (⌀${n(o.disc.spanXMm)} across X, ⌀${n(o.disc.spanYMm)} across Y)`
          : '') +
        ` against the job’s ⌀${n(o.disc.statedMm)} mm — ${Math.round(o.disc.fraction * 1000) / 10} % ${
          o.disc.mismatchMm >= 0 ? 'larger' : 'smaller'
        }` +
        (o.disc.askResize ? ', so the operator is asked: resize the job, or cut as is.' : ', within 1 %.');
  return `${found}; ${verdict}.${discWord}`;
}
