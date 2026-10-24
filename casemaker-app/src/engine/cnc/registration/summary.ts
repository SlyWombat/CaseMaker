/**
 * The registration in sentences (#430 phase 1) — the one UI-facing piece before the job flow draws
 * it: what the plan will do, and what the run found. Pure.
 */

import type { RegistrationPlan } from './plan';
import type { RegistrationOutcome } from './outcome';

const n = (v: number) => String(Math.round(v * 100) / 100);

export function summarizePlan(plan: RegistrationPlan): string {
  const s = plan.settings;
  if (plan.references) {
    // #429 review: the walls by their labels, and the surface touch where it really is.
    return (
      `Home, fit the wired probe and measure it (M491); touch the surface at (${n(plan.surfacePoint.x)}, ${n(plan.surfacePoint.y)}), ` +
      `on solid stock clear of every opening; then scan ${plan.scans.map((sc) => sc.label ?? `the ${sc.edge} edge`).join(', ')} — bracketing each wall ` +
      `and bisecting to ${n(s.fineStepMm)} mm, stopping at the first touch that falls into the opening, every touch capped at the surface − ${n(s.capBelowSurfaceMm)} mm; home when finished.`
    );
  }
  const edges =
    plan.scans.length === 0
      ? 'no edge scan (the bracket fixes X and Y)'
      : plan.mount === 'bracket'
        ? `the right edge at Y ${n(plan.scans[0]!.along)} and the back edge at X ${n(plan.scans[1]!.along)} only to confirm the stock is in the bracket's corner (the bracket fixes X and Y)`
      : plan.scans.map((sc) => `the ${sc.edge} edge at ${sc.edge === 'left' || sc.edge === 'right' ? 'Y' : 'X'} ${n(sc.along)}`).join(', ');
  const clamps = plan.mountObstacles.filter((o) => o.kind === 'clamp').map((o) => o.label);
  const assumes =
    plan.mount === 'bracket'
      ? ` It assumes ${clamps.length === 0 ? 'no clamps on the stock' : clamps.join('; ')} — you confirm that before the probe moves.`
      : '';
  // #619 — the datum path's first act is the mount tap, checked against the stored datum.
  const tap =
    plan.mountTap !== null && plan.mountDatum != null
      ? ` the fixed-jaw top is tapped first and checked against the stored datum (${n(plan.mountDatum.jawTopZ)});`
      : '';
  return (
    `Home, fit the wired probe and measure it (M491);${tap}` +
    ` touch the surface at the cut area's centre ` +
    `(${n(plan.surfacePoint.x)}, ${n(plan.surfacePoint.y)}); then scan ${edges} — bracketing each edge ` +
    `and bisecting to ${n(s.fineStepMm)} mm, stopping at the first touch off the stock, every touch capped at the surface − ${n(s.capBelowSurfaceMm)} mm; home when finished.${assumes}`
  );
}

export function summarizeOutcome(o: RegistrationOutcome): string {
  if (!o.usable) {
    return `The measurement is not usable, and no origin will be written from it: ${o.problems.join('; ')}.`;
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
  return `${found}; ${verdict}.`;
}
