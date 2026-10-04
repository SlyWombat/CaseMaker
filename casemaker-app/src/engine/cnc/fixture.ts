import type { Mm, Vec3 } from '@/types/units';
import type { ViseParams } from '@/types/engraveJob';
import type { FixtureEnvelope, ObstacleBox } from './setup';
import type { JobFinding } from './engrave/jobSetup';

/**
 * The fixture as an obstacle envelope (#203, decision 28, `/Simulation.md` §1.1).
 *
 * The part is HELD by the vise; what the tool must not HIT is the vise. Those are two
 * different things (decision 28): `Workholding` says *how* the part is held, this envelope
 * says *what is in the way* and belongs in `Setup.fixture`, not inside the `Workholding` union.
 *
 * The envelope is an INPUT with provenance — a shipped **default**, a **saved** measurement,
 * or a fresh **measurement** — never a catalogue lookup presented as truth. Every box is
 * grown by `uncertainty` before any collision check (#204), so a default can never be mistaken
 * for a measurement.
 *
 * V1 models the Z1 low-profile vise as exactly TWO boxes: the fixed jaw and the moving jaw.
 * The slot, the lip over the top edge, the screws and the body are deliberately NOT modelled
 * — #208 photographs and calipers the real vise, and refines the boxes only where a box is
 * shown to be wrong.
 *
 * The work frame is the job frame (`/Simulation.md` §2, `toSetup`): origin at the stock's
 * top-front-left corner, +X to the right along the jaws' clamping direction, +Y away from the
 * operator, Z = 0 on the stock's top face with cuts at negative Z.
 */

/**
 * How far the box extends below the stock's underside, mm. It only has to be "far enough that
 * nothing can pass under it" (/Simulation.md §1.1: the holder-into-part check), so this is a
 * generous depth, not a measured body height.
 *
 * PROVISIONAL (#208): the real vise body is unmeasured.
 */
export const VISE_BODY_DEPTH = 20;

/**
 * The minimum stock gripped below the jaw tops, mm, below which the part can lift.
 *
 * PROVISIONAL (#208): a placeholder threshold; #208's measurements and test cuts replace it.
 */
export const GRIP_MIN = 3;

/**
 * Where a dimension came from is the whole point (decision 28), so the default uncertainty is
 * a function of the source, never a bare constant at the call site.
 *
 * PROVISIONAL (#208): both bands are guesses until the real vise is measured.
 */
export function uncertaintyFor(source: ViseParams['source']): Mm {
  return source === 'default' ? DEFAULT_UNCERTAINTY : SAVED_UNCERTAINTY;
}

/** A default is not a measurement: the jaws may be anywhere in this band. PROVISIONAL (#208). */
const DEFAULT_UNCERTAINTY: Mm = 2;
/** A measurement still carries caliper/mounting error. PROVISIONAL (#208). */
const SAVED_UNCERTAINTY: Mm = 0.5;

/**
 * The shipped default `ViseParams` for the Z1 low-profile vise, for a job that has no saved
 * measurement. Published NOWHERE (/Fabrication.md §7.3): jaw capacity, jaw length, jaw height,
 * the slot and lip, and the fixed jaw's offset from the anchor pins are all unmeasured, so
 * every number here is a PROVISIONAL (#208) placeholder.
 *
 * NOTE (#203): this is the ONE place the five placeholder numbers live. `engrave/defaults.ts`
 * imports `DEFAULT_VISE` for a new job's vise, and `engraveJobStore` passes a saved
 * `ViseParams` back in through `defaultEngraveJob(vise)` when settings holds one.
 */
export const DEFAULT_VISE: ViseParams = {
  stockProud: 4, // PROVISIONAL (#208): how far the top face stands above the jaw tops.
  fixedJawThickness: 15, // PROVISIONAL (#208): fixed jaw (LEFT, /Fabrication.md §7.3) width in X.
  movingJawThickness: 15, // PROVISIONAL (#208): moving jaw width in X.
  jawLength: 80, // PROVISIONAL (#208): jaw length in Y.
  jawStartY: -10, // PROVISIONAL (#208): jaw start relative to the stock's front edge (Y).
  source: 'default',
  uncertainty: DEFAULT_UNCERTAINTY,
};

/**
 * The vise a NEW `EngraveJob` starts from: the saved `ViseParams` from settings when one
 * exists, otherwise the shipped default. This is the seam the panel (#205) resolves a new job
 * through, so a saved measurement is picked up without retyping it.
 *
 * The returned object is a copy — the caller may patch it without mutating settings.
 */
export function viseForNewJob(saved?: ViseParams): ViseParams {
  return saved ? { ...saved } : { ...DEFAULT_VISE };
}

/**
 * The Z1 low-profile vise as two obstacle boxes, in the WORK frame, mm. Returned UN-INFLATED:
 * consumers grow each box by `envelope.uncertainty` before checking (decision 28).
 *
 * The fixed jaw is the LEFT jaw (/Fabrication.md §7.3), so it sits at work X <= 0 with its
 * face on x = 0; the moving jaw sits at work X >= length with its face on x = length. Both
 * jaws' TOPS are at `Z = -stockProud` — below the stock's top face by however much the stock
 * stands proud. In Y the jaws span `[jawStartY, jawStartY + jawLength]`.
 */
export function viseEnvelope(
  stock: { length: Mm; width: Mm; thickness: Mm },
  vise: ViseParams,
): FixtureEnvelope {
  const { length, thickness } = stock;
  const jawMinY = vise.jawStartY;
  const jawMaxY = vise.jawStartY + vise.jawLength;
  const boxMinZ = -(thickness + VISE_BODY_DEPTH);
  const jawTopZ = -vise.stockProud;
  const boxes: ObstacleBox[] = [
    {
      id: 'vise-fixed-jaw',
      label: 'Vise fixed jaw (left)',
      min: [-vise.fixedJawThickness, jawMinY, boxMinZ],
      max: [0, jawMaxY, jawTopZ],
    },
    {
      id: 'vise-moving-jaw',
      label: 'Vise moving jaw (right)',
      min: [length, jawMinY, boxMinZ],
      max: [length + vise.movingJawThickness, jawMaxY, jawTopZ],
    },
  ];
  // `measuredAt` is copied through with the provenance: the envelope must be able to say WHEN it
  // was measured, not only that it was (#203).
  return { boxes, source: vise.source, uncertainty: vise.uncertainty, measuredAt: vise.measuredAt };
}

/**
 * The ISO date (`YYYY-MM-DD`) for `ViseParams.measuredAt` / `FixtureEnvelope.measuredAt`. Takes
 * `now` so it stays pure and testable; the stores pass the clock when a measurement is recorded
 * ("Save as my vise" / "I just measured these", #203).
 */
export function todayISODate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Grow every bound of a box by `by` mm on every side. Negative `by` shrinks it. */
export function inflate(box: ObstacleBox, by: Mm): ObstacleBox {
  return {
    ...box,
    min: [box.min[0] - by, box.min[1] - by, box.min[2] - by] as Vec3,
    max: [box.max[0] + by, box.max[1] + by, box.max[2] + by] as Vec3,
  };
}

/**
 * True when the two boxes' INTERIORS overlap on all three axes. Boxes that merely touch — one
 * bound equal on a single axis — do NOT overlap, so a jaw seated flush against the stock is
 * not a collision.
 */
export function boxesOverlap(a: ObstacleBox, b: ObstacleBox): boolean {
  return (
    a.min[0] < b.max[0] &&
    b.min[0] < a.max[0] &&
    a.min[1] < b.max[1] &&
    b.min[1] < a.max[1] &&
    a.min[2] < b.max[2] &&
    b.min[2] < a.max[2]
  );
}

/**
 * Pure checks on the vise as data, before any geometry (#203). Codes the findings with the
 * same `JobFinding` the job validators use, so a panel can render them together.
 */
export function validateVise(
  stock: { length: Mm; width: Mm; thickness: Mm },
  vise: ViseParams,
): JobFinding[] {
  const findings: JobFinding[] = [];
  const { width, thickness } = stock;

  if (vise.stockProud <= 0) {
    findings.push({
      severity: 'error',
      code: 'vise-stock-not-proud',
      message:
        `The stock stands ${vise.stockProud} mm above the jaw tops — at or below the surface ` +
        `being cut, so the tool would run into the jaws.`,
    });
  }

  if (vise.stockProud >= thickness) {
    findings.push({
      severity: 'error',
      code: 'vise-stock-proud-exceeds-thickness',
      message:
        `The stock stands ${vise.stockProud} mm above the jaw tops on a ${thickness} mm stock ` +
        `— nothing is left in the jaws.`,
    });
  }

  const grip = thickness - vise.stockProud;
  if (grip < GRIP_MIN) {
    findings.push({
      severity: 'warning',
      code: 'vise-grip-shallow',
      message:
        `Only ${grip} mm of the stock is gripped below the jaw tops; under ${GRIP_MIN} mm ` +
        `the part can lift (PROVISIONAL threshold, #208).`,
    });
  }

  // The jaw's Y span, intersected with the stock's own Y range [0, width].
  const covered = Math.max(
    0,
    Math.min(vise.jawStartY + vise.jawLength, width) - Math.max(vise.jawStartY, 0),
  );
  if (covered < width / 2) {
    findings.push({
      severity: 'warning',
      code: 'vise-jaw-short',
      message:
        `The jaws span Y ${vise.jawStartY} to ${vise.jawStartY + vise.jawLength}, covering ` +
        `${covered} mm of the stock's ${width} mm width — less than half.`,
    });
  }

  if (vise.source === 'default') {
    findings.push({
      severity: 'warning',
      code: 'vise-default',
      message: 'Vise dimensions are unmeasured defaults (#208); collisions cannot be trusted yet.',
    });
  }

  return findings;
}
