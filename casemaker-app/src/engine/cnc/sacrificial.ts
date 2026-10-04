import { pTranslate, pUnion, rectProfile, type Profile } from '@/engine/compiler/profile';
import type { JobFinding } from '@/engine/cnc/engrave/jobSetup';
import type { EngraveJob, Sacrificial, SacrificialSide, SacrificialUnder } from '@/types/engraveJob';
import type { Mm, Vec3 } from '@/types/units';

/**
 * User-selected sacrificial material (#213, `/Fabrication.md` §7.3 / decision 28 in practice).
 *
 * A board UNDER the part and/or strips BESIDE it, and nothing else. The work frame is the job
 * frame and is UNCHANGED (`/Simulation.md` §2): the origin stays at the part's top-front-left
 * corner and Z = 0 stays on the part's top face. Sacrificial material lives at negative X,
 * negative Y, beyond the part's far edges, and below Z = `−thickness`. Because Z is probed on
 * the part's top face, the thickness of the board, of tape or of glue under the part cannot
 * reach a cut depth — the same argument as decision 24.
 *
 * Pure: profiles and boxes are plain data, no wasm. The stage integrations that consume these
 * — the vise envelope (#203/#204), the verifier (#174) and the two-body sweep (#193/#204) —
 * are named where they are deferred.
 */

/**
 * How far a through-cut may pass below the part's underside, mm (#213/#218). PROVISIONAL: 0.3
 * is enough to part cleanly, and is replaced by a measurement on the first through-cut. It may
 * never exceed `under.thickness − 1` (`validateSacrificial` enforces the invariant).
 */
export const DEFAULT_BREAKTHROUGH: Mm = 0.3;

/**
 * The two setups people actually build (#213 §5), offered as one-click presets when the panel
 * (#205) lands. Their `source` is `'saved'` because they are a user's asserted setup, not a
 * shipped unmeasured default (decision 28) — the panel records the day when it applies one.
 */
export function presetPartOnBoard(): Sacrificial {
  return {
    under: {
      thickness: 12,
      overhang: { left: 10, right: 10, front: 10, back: 10 },
      attach: 'tape',
    },
    sides: { left: null, right: null, front: null, back: null },
    source: 'saved',
  };
}

export function presetJawStrips(): Sacrificial {
  const strip: SacrificialSide = { thickness: 6, height: 'flush' };
  return {
    under: null,
    sides: { left: { ...strip }, right: { ...strip }, front: null, back: null },
    source: 'saved',
  };
}

/** No sacrificial material: the shipped default, and the shape an old job migrates to. */
export function noneSacrificial(): Sacrificial {
  return {
    under: null,
    sides: { left: null, right: null, front: null, back: null },
    source: 'default',
  };
}

/**
 * The under-board the panel's "Board under the part" toggle creates (#213 §5). A neutral
 * starting point for a user who then types their own numbers: a 12 mm board flush with the
 * part (overhang 0), taped down. PROVISIONAL: 12 mm is common hobby board stock, and the
 * toggle's numbers are the user's assertion (`source` becomes `'saved'` in the panel).
 */
export function defaultSacrificialUnder(): SacrificialUnder {
  return {
    thickness: 12,
    overhang: { left: 0, right: 0, front: 0, back: 0 },
    attach: 'tape',
  };
}

/** The strip the panel's per-side toggle creates (#213 §5): 6 mm, flush — the preset's strip. */
export function defaultSacrificialSide(): SacrificialSide {
  return { thickness: 6, height: 'flush' };
}

/**
 * The sacrificial model a NEW job starts from: the saved setup from settings when one exists,
 * otherwise none (#213 §5). The same seam as `viseForNewJob` (#203) — the store resolves it, so
 * `defaultEngraveJob` stays a pure function of its arguments. A deep copy is returned so
 * patching the job cannot mutate the settings object.
 */
export function sacrificialForNewJob(saved?: Sacrificial): Sacrificial {
  if (!saved) return noneSacrificial();
  return {
    under: saved.under
      ? { thickness: saved.under.thickness, overhang: { ...saved.under.overhang }, attach: saved.under.attach }
      : null,
    sides: {
      left: saved.sides.left ? { ...saved.sides.left } : null,
      right: saved.sides.right ? { ...saved.sides.right } : null,
      front: saved.sides.front ? { ...saved.sides.front } : null,
      back: saved.sides.back ? { ...saved.sides.back } : null,
    },
    source: saved.source,
  };
}

/** True when any piece of sacrificial material is present. */
export function hasSacrificial(s: Sacrificial): boolean {
  return s.under !== null || Object.values(s.sides).some((side) => side !== null);
}

/** The strip's resolved height from the part's bottom face, mm — `flush` = the part's thickness. */
export function stripHeight(side: SacrificialSide, partThickness: Mm): Mm {
  return side.height === 'flush' ? partThickness : side.height;
}

/** Stock dimensions the model is expressed against. */
type StockSize = { length: Mm; width: Mm; thickness: Mm };

/** One sacrificial solid as an axis-aligned box in the WORK frame, mm. */
export interface SacrificialBox {
  id: 'under' | 'left' | 'right' | 'front' | 'back';
  min: Vec3;
  max: Vec3;
}

/**
 * The sacrificial material as axis-aligned boxes in the WORK frame, mm (#213 §1):
 *
 * - `under`: X `[−ov.left, L + ov.right]`, Y `[−ov.front, W + ov.back]`, Z `[−T − t, −T]`.
 * - `left`: X `[−thickness, 0]`, Y `[0, W]`, Z `[−T, −T + height]` (`flush` → up to 0).
 *
 * Right mirrors left; front/back mirror the same construction in Y. None overlaps the part's
 * own volume, which occupies X `[0, L]`, Y `[0, W]`, Z `[−T, 0]`.
 */
export function sacrificialBoxes(stock: StockSize, s: Sacrificial): SacrificialBox[] {
  const { length: L, width: W, thickness: T } = stock;
  const boxes: SacrificialBox[] = [];

  if (s.under) {
    const { thickness: t, overhang: ov } = s.under;
    boxes.push({
      id: 'under',
      min: [-ov.left, -ov.front, -T - t],
      max: [L + ov.right, W + ov.back, -T],
    });
  }

  const { left, right, front, back } = s.sides;
  if (left) {
    const h = stripHeight(left, T);
    boxes.push({ id: 'left', min: [-left.thickness, 0, -T], max: [0, W, -T + h] });
  }
  if (right) {
    const h = stripHeight(right, T);
    boxes.push({ id: 'right', min: [L, 0, -T], max: [L + right.thickness, W, -T + h] });
  }
  if (front) {
    const h = stripHeight(front, T);
    boxes.push({ id: 'front', min: [0, -front.thickness, -T], max: [L, 0, -T + h] });
  }
  if (back) {
    const h = stripHeight(back, T);
    boxes.push({ id: 'back', min: [0, W, -T], max: [L, W + back.thickness, -T + h] });
  }

  return boxes;
}

/**
 * The region a cutter may travel over without leaving material: the part outline ∪ every
 * sacrificial footprint, in XY (#213 §3). The verifier's `cut-outside-stock` becomes "outside
 * `supportedFootprint`". With no sacrificial material this is exactly the part outline.
 */
export function supportedFootprint(stock: StockSize, s: Sacrificial): Profile {
  const part = rectProfile(stock.length, stock.width);
  if (!hasSacrificial(s)) return part;
  const footprints = sacrificialBoxes(stock, s).map((b) =>
    pTranslate([b.min[0], b.min[1]], rectProfile(b.max[0] - b.min[0], b.max[1] - b.min[1])),
  );
  return pUnion([part, ...footprints]);
}

/**
 * How far each jaw's face moves outward from the part for a sacrificial setup, mm (#213 §2):
 * the fixed (LEFT) jaw's face moves from x = 0 to `−max(left strip thickness, under.overhang.left)`,
 * the moving (right) jaw's from x = L to `L + max(right strip thickness, under.overhang.right)`.
 *
 * Pure so the vise envelope (#204 owns `fixture.ts`) and the preview can both consume it without
 * `viseEnvelope` needing to know about sacrificial material itself.
 */
export function viseJawShift(s: Sacrificial): { left: Mm; right: Mm } {
  const leftMax = Math.max(s.sides.left?.thickness ?? 0, s.under?.overhang.left ?? 0);
  const rightMax = Math.max(s.sides.right?.thickness ?? 0, s.under?.overhang.right ?? 0);
  return { left: leftMax, right: rightMax };
}

/**
 * Pure checks on the sacrificial setup as data (#213 §1). Codes are members of `JobFindingCode`
 * (`jobSetup.ts`) so a panel renders them beside the vise findings.
 *
 * - `side-strip-unsupported` — a front or back strip with no under-board is an error: those
 *   strips are not clamped by the jaws and rest on nothing.
 * - `strip-taller-than-part` — a strip whose top rises above the part's top face (Z > 0) is hit
 *   by the first pass.
 * - `under-too-thin` — the board is thinner than `breakthrough + 1`, so it cannot absorb the
 *   breakthrough the spec allows (`breakthrough ≤ under.thickness − 1`). #218 gates this on a
 *   through-cut actually being requested; the invariant is enforced here regardless.
 * - `under-loose` — the part is only resting on the board and may move.
 * - `sacrificial-default` — dimensions nobody measured. Fires only when material is PRESENT: a
 *   job with no sacrificial material behaves exactly as before and is not warned about it.
 */
export function validateSacrificial(job: EngraveJob): JobFinding[] {
  const s = job.sacrificial;
  const { thickness: T } = job.stock;
  const findings: JobFinding[] = [];

  if (!s.under) {
    for (const pos of ['front', 'back'] as const) {
      if (s.sides[pos]) {
        const side = s.sides[pos];
        findings.push({
          severity: 'error',
          code: 'side-strip-unsupported',
          message:
            `A ${pos} sacrificial strip (${side.thickness} mm) has no board under the part; ` +
            `${pos} strips are not clamped by the jaws and would rest on nothing.`,
        });
      }
    }
  }

  for (const pos of ['left', 'right', 'front', 'back'] as const) {
    const side = s.sides[pos];
    if (!side) continue;
    const h = stripHeight(side, T);
    if (h > T) {
      findings.push({
        severity: 'error',
        code: 'strip-taller-than-part',
        message:
          `The ${pos} strip is ${h} mm tall on a ${T} mm part — its top rises above the part's ` +
          `top face, where the first pass would hit it.`,
      });
    }
  }

  if (s.under && job.breakthrough > s.under.thickness - 1) {
    findings.push({
      severity: 'error',
      code: 'under-too-thin',
      message:
        `The under-board is ${s.under.thickness} mm, but a breakthrough of ${job.breakthrough} mm ` +
        `needs at least ${job.breakthrough + 1} mm (breakthrough may not exceed ` +
        `under.thickness − 1).`,
    });
  }

  if (s.under && s.under.attach === 'loose') {
    findings.push({
      severity: 'warning',
      code: 'under-loose',
      message:
        'The part is only resting on the under-board; the run sheet should say how it is fixed.',
    });
  }

  if (hasSacrificial(s) && s.source === 'default') {
    findings.push({
      severity: 'warning',
      code: 'sacrificial-default',
      message:
        'Sacrificial dimensions are unmeasured defaults (#213); cut depths onto them cannot be trusted yet.',
    });
  }

  return findings;
}
