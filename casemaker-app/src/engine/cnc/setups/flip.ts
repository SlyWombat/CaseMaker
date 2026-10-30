/**
 * #723 P2-2 — a flip's stated reference: the two locating pins a turned stock sits on.
 *
 * A flipped setup is registered on the pins, not on the mount's edge: the pins fix XY and the
 * rotation, and the question that catches the mistake every forum records — the stock spun 180°
 * about Z — is "which pin is nearer this edge?". Two properties decide whether that question is
 * askable at all, and both are checked here rather than assumed:
 *
 *   - a stock spun 180° about Z maps each pin through the stock's centre. If each pin's reflection
 *     lands on the other pin, the spun stock sits on them too, and the question would have two
 *     right answers — the reference says so (`mirrorCheck`) instead of asking it;
 *   - for a 180° turn over about X (or Y) to land each pin in its own hole, the pins must lie in a
 *     line parallel to that axis in the stock's frame. A line at an angle would miss.
 *
 * The accuracy is NOT stated: nothing has measured how repeatable a pin flip is on this unit, so
 * the words say "unmeasured on this unit" rather than inventing a tolerance (§5.4's bracket rule).
 * Pure: pins and the mounted stock's extents in, words and a question out.
 */

import { orient } from './orient';
import type { RemountStep } from './types';
import type { JobSetup, JobSetupPins } from '@/types/engraveJob';

/** How far a pin may sit from where the rule needs it, mm — a labelled allowance, not a measurement. */
export const PIN_RULE_TOLERANCE_MM = 0.5;

export interface PinPoint {
  x: number;
  y: number;
}

/** The mounted stock's XY extents, mm (origin at its front-left corner as mounted). */
export interface MountedStock {
  x: number;
  y: number;
}

export interface PinReference {
  /** The registration line, in the operator's words. */
  words: string;
  /** The landmark question the app can check, or null when the pins cannot tell a spin apart. */
  confirm: RemountStep['confirm'];
  /** Why no question can be asked, in the operator's words; null when `confirm` is set. */
  mirrorCheck: string | null;
}

const mm = (n: number): string => String(Math.round(n * 100) / 100);

/**
 * The reference for a pin flip. `about` is the flip's axis in the STOCK frame: `x` for a stock
 * turned over about X (the pins' line runs along X), `y` for one turned about Y. Omitted means
 * the caller does not know the axis (a reference-only setup) and no axis rule is applied.
 */
export function pinReference(
  pins: JobSetupPins,
  size: MountedStock,
  opts: { setupIndex?: number; about?: 'x' | 'y' } = {},
): PinReference {
  const [a, b] = pins.at;
  const words =
    `the two pins — ${mm(a.x)} mm and ${mm(b.x)} mm from the left edge, ${mm(a.y)} mm and ${mm(b.y)} mm from ` +
    'the front edge — unmeasured on this unit';

  if (opts.about === 'x' && Math.abs(a.y - b.y) > PIN_RULE_TOLERANCE_MM) {
    return {
      words,
      confirm: null,
      mirrorCheck: `the pins are not on a line along X (their front-edge distances differ by ${mm(Math.abs(a.y - b.y))} mm), so a stock turned over about X would not land on them — put the pins on the flip line`,
    };
  }
  if (opts.about === 'y' && Math.abs(a.x - b.x) > PIN_RULE_TOLERANCE_MM) {
    return {
      words,
      confirm: null,
      mirrorCheck: `the pins are not on a line along Y (their left-edge distances differ by ${mm(Math.abs(a.x - b.x))} mm), so a stock turned over about Y would not land on them — put the pins on the flip line`,
    };
  }

  // A stock spun 180° about Z maps each pin through the stock's centre: the spun stock sits on
  // the pins only when that reflection is the same PAIR (each pin to the other), so the distance
  // between a reflected pin and its partner is what decides whether the question can be asked.
  const reflectionX = Math.abs(size.x - a.x - b.x);
  const reflectionY = Math.abs(size.y - a.y - b.y);
  if (Math.hypot(reflectionX, reflectionY) <= PIN_RULE_TOLERANCE_MM) {
    return {
      words,
      confirm: null,
      mirrorCheck:
        'the pins sit symmetrically about the stock’s centre, so a stock spun 180° would sit on them too — move one pin off the centre line, or add a third mark, before trusting this flip',
    };
  }

  const dx = Math.abs(a.x - b.x);
  const dy = Math.abs(a.y - b.y);
  if (dx <= PIN_RULE_TOLERANCE_MM && dy <= PIN_RULE_TOLERANCE_MM) {
    return {
      words,
      confirm: null,
      mirrorCheck: 'the two pins are at the same point, so they cannot say which way round the stock is',
    };
  }

  // Ask along the axis the pins differ on: the left edge when the line runs mostly along X, the
  // front edge when it runs mostly along Y. The nearer pin is the right answer.
  const alongX = dx >= dy;
  const edge = alongX ? 'left' : 'front';
  const value = (p: PinPoint): number => (alongX ? p.x : p.y);
  const [near, far] = value(a) <= value(b) ? [a, b] : [b, a];
  const right = `the pin ${mm(value(near))} mm from the ${edge} edge`;
  const wrong = `the pin ${mm(value(far))} mm from the ${edge} edge`;
  // The right answer is not always first (the remount landmark's own rule).
  const options = (opts.setupIndex ?? 0) % 2 === 0 ? [right, wrong] : [wrong, right];
  return {
    words,
    confirm: {
      question: `Look at the two pins: which one is nearer the ${edge} edge?`,
      options,
      correct: options.indexOf(right),
    },
    mirrorCheck: null,
  };
}

/** The flip axis a saved setup turns the stock over about, from its orientation and mount. */
export function flipAxisOf(setup: Pick<JobSetup, 'orientation' | 'mount'>): 'x' | 'y' | null {
  if (setup.orientation.top !== 'bottom') return null;
  // `orient` is the one place that decides which axis a bottom-up mount turns about (the vise's
  // jaws make it X; anything else lays it over Y).
  const o = orient('bottom', setup.mount, { x: 1, y: 1, z: 1 });
  return o.ok ? (o.rotate?.about ?? null) : null;
}

/** The reference a saved setup states, or null when it states none. */
export function setupPinReference(
  setup: JobSetup,
  size: MountedStock,
  setupIndex = 0,
): PinReference | null {
  if (setup.pins === undefined) return null;
  return pinReference(setup.pins, size, { setupIndex, about: flipAxisOf(setup) ?? undefined });
}
