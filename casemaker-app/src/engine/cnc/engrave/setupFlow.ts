/**
 * The guided job setup's pure half (#254): the questions, the answers' provenance, the one
 * document write they become, and the step-by-step findings.
 *
 * This is the JOB setup, not the machine wizard refused as R1 in `/Makera-Parity.md` §14.4. It
 * asks only what the app cannot know — workholding, material, blank, cutter — and everything
 * derivable (feeds, step-down, the recommended cutter) stays derived in the panel. It needs no
 * machine and no bridge, so it ships on the web build.
 *
 * Two rules the module enforces in code rather than prose:
 *
 * - **Every answer it writes carries a source** (#246/#254). `applyAnswers` is the single write
 *   path, and `sources` is part of the answer, so there is no way to apply a value untagged.
 *   A value already tagged `measured` is never demoted to `user` by a re-entry.
 * - **A typo is caught at the step that causes it.** `stepFindings` runs the panel's own
 *   validators on the would-be job, so a blank that is thinner than the vise's `stockProud`
 *   (the #231 case: the shipped 4 mm default refuses a 3.81 mm blank) is reported on the blank
 *   step, with `stockProudFix` offering the value that resolves it.
 */

import { defaultStockProud, jobVise, validateVise } from '@/engine/cnc/fixture';
import { FEEDS_TABLE } from '@/engine/cnc/feeds';
import { MATERIAL_LABELS } from '@/engine/cnc/materials';
import { rodDimsOf } from '@/engine/cnc/stockStart';
import type { MillProfile } from '@/engine/cnc/machine';
import {
  hasSacrificial,
  noneSacrificial,
  presetJawStrips,
  presetPartOnBoard,
} from '@/engine/cnc/sacrificial';
import { dedupeFindings, validateJob, type JobFinding } from '@/engine/cnc/engrave/jobSetup';
import type {
  EngraveJob,
  FieldSource,
  JobWorkholding,
  RotaryChuck,
  RotaryJawMode,
  Sacrificial,
  StockMaterial,
  ViseParams,
} from '@/types/engraveJob';

/** One material the flow offers: the value it writes into the job and the word it shows. */
export interface MaterialOption {
  value: StockMaterial;
  label: string;
}

/**
 * The materials a job may be cut in: the ones the STARTING TABLE has a row for, and the ones the
 * machine's own profile declares (#347).
 *
 * The UNION is the point, and its two halves are two different claims:
 *
 *   - A material the starting table covers (softwood, hardwood, MDF, PLA) is cut on this app's own
 *     numbers, whatever a profile says about it.
 *   - A material only a PROFILE names — the Z1's metals, ABS and Acrylic, and the printed-blank
 *     classes (#456) — is one the machine is set up for, and the numbers for it are Makera's own,
 *     for that exact cutter and material (`feedsFor`, Route A). The printed-blank classes have no
 *     vendor row at all, so `CATALOGUE_MATERIAL_ALIASES` answers them from the nearest plastic rows
 *     as a labelled mapping. Offering any of them is not a promise: a job in one is REFUSED until
 *     a row (direct or mapped) exists, and the refusal says which row is missing. The important
 *     half is that the material can be ASKED for at all — before #347 the list offered four
 *     materials and the machine's own table could not be answered from.
 *
 * It deliberately does NOT consult the catalogue, and that is a rule rather than a simplification:
 * the catalogue is a runtime snapshot, empty on the web build (#324) and empty on the desktop until
 * the service answers, so an option list built from it would offer a different set of materials on
 * two machines running the same build.
 *
 * A word this build cannot label is dropped rather than shown blank. That is belt-and-braces rather
 * than the load path — a profile's own schema refuses a material this build does not know — but the
 * options are built from whatever machine object a caller hands in, and a blank `<option>` is a
 * worse answer than a material that is simply not offered.
 */
export function materialOptionsFor(machine?: MillProfile): MaterialOption[] {
  const options: MaterialOption[] = [];
  const seen = new Set<string>();
  const add = (material: StockMaterial): void => {
    if (seen.has(material) || !Object.prototype.hasOwnProperty.call(MATERIAL_LABELS, material)) return;
    seen.add(material);
    options.push({ value: material, label: MATERIAL_LABELS[material] });
  };
  // The table's own order, because that list is the one this app can cut with no help.
  for (const entry of FEEDS_TABLE) add(entry.material);
  for (const material of machine?.materials ?? []) add(material);
  return options;
}

/**
 * What the part is held in (#240): the vise, or the rotary module's three-jaw chuck. The rotary
 * choice is the machine's active mount plus round stock; selecting it is one store write
 * (`setRotaryHolding`) that states both the workholding and the axis-frame stock box.
 */
export type WorkholdingChoice = 'vise' | 'rotary';

/**
 * The chuck facts a rotary job starts from, with the wiki's own gaps kept gaps (#240/#714,
 * `/Rotary.md` §3.4): the page names reverse jaws fitted by default and a tailstock; the jaw
 * capacity is not stated, so `gripDiameter` is null rather than an invented millimetre.
 *
 * #714 — the jaws follow Makera's rule by the rod's DIAMETER, and the stick-out is the rod's
 * length less the GRIP. The grip's default is the shop's `rotary.gripMm`; Makera publishes no jaw
 * depth, so it is Case Maker's figure until a bench measurement replaces it (`ROTARY_GRIP_FALLBACK_MM`
 * is the same number the setting seeds, and only a caller with no location reads it).
 */
export const ROTARY_CHUCK_SOURCE = 'Makera Z1 wiki, 4-axis accessory (wiki.makera.com/en/Z1/Accessories/4Axis)';

/** The shop's `rotary.gripMm` fallback, mm — what a caller with no location reads. */
export const ROTARY_GRIP_FALLBACK_MM = 15;

/**
 * Makera's jaw rule by the rod's diameter (`docs/design/rotary-flow.md` §3.4, from the decompiled
 * Studio): standard under ⌀20 mm; reverse with the inner teeth from ⌀20 to ⌀35; reverse with the
 * outer teeth over ⌀35. The wiki's "reverse jaws fitted by default for larger work" agrees.
 */
export function rotaryJawModeFor(diameterMm: number): RotaryJawMode {
  if (diameterMm < 20) return 'standard';
  if (diameterMm <= 35) return 'reverse-inner';
  return 'reverse-outer';
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** The rod's own length along the axis and its diameter, from the job's box either way it faces. */
export function rodAxisOf(
  stock: Pick<EngraveJob['stock'], 'length' | 'width' | 'thickness' | 'shape' | 'diameter'>,
): { length: number; diameter: number } {
  // A standing rod is D × D × L, an axis-frame rod is L × D × D (the same two boxes
  // `rotaryBoxForRod`/`standingBoxForRod` own); the diameter is the box's own number.
  return stock.shape === 'cylinder'
    ? { length: stock.length, diameter: stock.diameter ?? stock.width }
    : { length: stock.thickness, diameter: stock.width };
}

export function defaultRotaryChuck(
  job: Pick<EngraveJob, 'stock'>,
  gripMm: number = ROTARY_GRIP_FALLBACK_MM,
): RotaryChuck {
  const { length, diameter } = rodAxisOf(job.stock);
  const grip = Math.min(Math.max(0, gripMm), Math.max(0, length - 0.1));
  return {
    stickout: round3(Math.max(0.1, length - grip)),
    gripDiameter: null,
    jawMode: rotaryJawModeFor(diameter),
    tailstock: true,
    source: ROTARY_CHUCK_SOURCE,
  };
}

/** The three sacrificial answers people actually build — plus "keep a custom setup". */
export type SacrificialChoice = 'none' | 'board' | 'strips' | 'custom';

/** The steps, in the order they are asked. #516: the cutter is not one — the tool is the software's
 *  recommendation once the work exists, not a question to ask before any of it is defined. */
export type SetupStepId = 'holding' | 'material' | 'blank';

export const SETUP_STEPS: readonly { id: SetupStepId; title: string }[] = [
  { id: 'holding', title: 'What is holding the part?' },
  { id: 'material', title: 'What is it made of?' },
  { id: 'blank', title: 'How big is the blank?' },
];

/**
 * Everything the guided setup collects. One object, so a single store action can apply it and a
 * single test can assert that every field it carries is tagged.
 */
export interface SetupAnswers {
  workholding: WorkholdingChoice;
  sacrificial: Sacrificial;
  stock: { length: number; width: number; thickness: number; material: StockMaterial };
  vise: ViseParams;
  /** The chuck facts the rotary choice writes (#240); carried through a re-entry. */
  rotary: RotaryChuck;
  /**
   * The provenance of each answer. The vise's own `source` and the sacrificial's own `source`
   * travel inside those objects; stock has no other home, so it lives here.
   */
  sources: {
    stock: Record<'length' | 'width' | 'thickness' | 'material', FieldSource>;
  };
}

/** A `measured` value is never demoted; anything else is the user asserting it now. */
function carried(existing?: FieldSource): FieldSource {
  return existing === 'measured' ? 'measured' : 'user';
}

/**
 * The answers a re-entry starts from: the job as it stands, so "same as last job" is a no-op and
 * an experienced user passes through in two clicks. Existing `measured` tags are carried, never
 * relabelled — the point of #246's third state.
 */
export function defaultSetupAnswers(job: EngraveJob): SetupAnswers {
  const rotary = job.workholding.kind === 'rotary-chuck';
  return {
    workholding: rotary ? 'rotary' : 'vise',
    sacrificial: job.sacrificial,
    stock: { ...job.stock },
    vise: { ...jobVise(job) },
    rotary: rotary && job.workholding.kind === 'rotary-chuck' ? { ...job.workholding.rotary } : defaultRotaryChuck(job),
    sources: {
      stock: {
        length: carried(job.sources?.stock?.length),
        width: carried(job.sources?.stock?.width),
        thickness: carried(job.sources?.stock?.thickness),
        material: carried(job.sources?.stock?.material),
      },
    },
  };
}

function sameSacrificial(a: Sacrificial, b: Sacrificial): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Which preset (if any) the answers' sacrificial setup matches, for the select's value. */
export function sacrificialChoice(s: Sacrificial): SacrificialChoice {
  if (!hasSacrificial(s)) return 'none';
  if (sameSacrificial(s, presetPartOnBoard())) return 'board';
  if (sameSacrificial(s, presetJawStrips())) return 'strips';
  return 'custom';
}

/** Resolve the choice's sacrificial object. `custom` keeps the object the answers already hold. */
export function sacrificialForChoice(choice: SacrificialChoice, current: Sacrificial): Sacrificial {
  switch (choice) {
    case 'none':
      return noneSacrificial();
    case 'board':
      return presetPartOnBoard();
    case 'strips':
      return presetJawStrips();
    case 'custom':
      return current;
  }
}

/**
 * #707 BM-1 — A BED JOB STAYS ON THE BED. The answers describe the vise (and, since #240, the
 * rotary); writing them onto a taped or bracket job would silently change the fixture under the
 * operator — the rotary guard's sibling, one arm further out. Selecting another holding is the
 * store's explicit write, which the bed options get in BM-2; these functions never perform that
 * conversion.
 */
function bedHolding(job: EngraveJob): JobWorkholding | null {
  return job.workholding.kind === 'tape' || job.workholding.kind === 'bracket' ? job.workholding : null;
}

/**
 * The one write path (#254). Applies every answer to the job and stamps the stock provenance. The
 * vise and sacrificial carry their own `source`, so nothing this function writes is untagged — the
 * acceptance the guided setup promises. #516: the cutter is NOT an answer — the flow collects the
 * work, and the tool is the software's recommendation once the work is defined, not a question asked
 * before any of it exists.
 */
export function applyAnswers(job: EngraveJob, a: SetupAnswers): EngraveJob {
  const workholding: JobWorkholding =
    bedHolding(job) ??
    (a.workholding === 'rotary'
      ? { kind: 'rotary-chuck', rotary: { ...a.rotary } }
      : { kind: 'vise', vise: { ...a.vise } });
  return {
    ...job,
    stock: { ...a.stock },
    workholding,
    sacrificial: a.sacrificial,
    sources: {
      ...(job.sources ?? {}),
      stock: { ...a.sources.stock },
    },
  };
}

/**
 * The step-3 write: the holding answers ARE the workholding and the sacrificial, and nothing else.
 *
 * #684 review — the arrival write (the mount the stock calls for) goes through here. A whole-setup
 * write would replace `sources.stock` with the answers' four fields, and the answers do not carry
 * every stock-source key: a laminate's assumed cap (`sources.stock.colour`) has no answer field, so
 * replacing the record dropped it and the job could no longer say the cap was an assumption. The
 * stock is step 2's document; step 3 writes only what it asked about.
 *
 * #240 — A ROTARY JOB STAYS ROTARY. The vise answers describe the vise; writing them onto a job
 * held in the rotary chuck would silently change the machine setup under the operator. Selecting
 * the vise again is the store's explicit `setRotaryHolding(null, …)`, which also restores the
 * standing stock box; this function never performs that conversion.
 */
export function applyHoldAnswers(job: EngraveJob, a: SetupAnswers): EngraveJob {
  const workholding: JobWorkholding =
    bedHolding(job) ??
    (job.workholding.kind === 'rotary-chuck' ? job.workholding : { kind: 'vise', vise: { ...a.vise } });
  return {
    ...job,
    workholding,
    sacrificial: a.sacrificial,
  };
}

/** Findings a step should show: the panel's own validators, filtered to that step's concern. */
const STEP_CODES: Record<SetupStepId, ReadonlySet<JobFinding['code']>> = {
  holding: new Set([
    'side-strip-unsupported',
    'strip-taller-than-part',
    'under-too-thin',
    'under-loose',
    'sacrificial-default',
  ]),
  material: new Set(),
  blank: new Set([
    'vise-jaw-collision',
    'vise-stock-not-proud',
    'vise-stock-proud-exceeds-thickness',
    'vise-grip-shallow',
    'vise-jaw-short',
    'vise-default',
    'depth-exceeds-stock',
  ]),
};

/**
 * The findings the current step's answers cause. Built from `applyAnswers`, so the flow checks
 * the exact document it would write. `validateJob` alone does not raise the vise's own checks
 * (`validateVise` is a separate pass the worker merges in), so both run here — the #231
 * `vise-stock-proud-exceeds-thickness` comes from `validateVise`.
 *
 * The merge goes through `dedupeFindings` (#353): two passes over the same document can answer the
 * same code, and the step rendered that twice — `vise-default`, one copy per validator — until
 * this was added. It is a safety net, not the fix: `validateVise` is the code's one owner.
 */
export function stepFindings(step: SetupStepId, job: EngraveJob, a: SetupAnswers): JobFinding[] {
  const codes = STEP_CODES[step];
  if (codes.size === 0) return [];
  const probe = applyAnswers(job, a);
  // #240 — the vise's own checks are the VISE's. A job in the rotary chuck has no jaw faces or
  // seat to judge, and its holding findings belong to slice 3's rotary run sheet.
  const viseFindings =
    probe.workholding.kind === 'vise'
      ? validateVise(probe.stock, probe.workholding.vise, probe.sacrificial)
      : [];
  const all = dedupeFindings([...validateJob(probe), ...viseFindings]);
  return all.filter((f) => codes.has(f.code));
}

/**
 * The vise findings a blank step should show. `validateVise` is the same check `stepFindings`
 * reaches through `validateJob`; exposed directly so a caller can act on the #231 case without
 * re-deriving the step's code set.
 */
export function blankViseFindings(a: SetupAnswers): JobFinding[] {
  return validateVise(a.stock, a.vise, a.sacrificial);
}

/**
 * The #231 fix: when the vise's `stockProud` is at or past the blank's thickness, the value that
 * resolves it is the seated default (`defaultStockProud`: the blank's underside on its seat, #508),
 * applied as the user's asserted setup (`source: 'saved'`). Returns null when nothing needs fixing.
 *
 * On a blank no taller than the ledge step the derived value is `≤ 0` — the blank's top at or below
 * the jaw tops. Since #488 that is no longer a refusal, so the fix is offered there too: the job is
 * cuttable whenever its cuts keep `jawClearance` clear of the jaw faces, and the panel's own
 * findings say so. Before #488 this returned null, because the value only traded this refusal for
 * `vise-stock-not-proud`.
 */
export function stockProudFix(a: SetupAnswers): ViseParams | null {
  if (a.vise.stockProud < a.stock.thickness) return null;
  return {
    ...a.vise,
    stockProud: defaultStockProud(a.stock.thickness, a.vise.seat),
    source: 'saved',
  };
}

// ---- answer updaters ---------------------------------------------------------------------------
//
// Editing an answer re-tags it `'user'` — the user just asserted it — but a `'measured'` value is
// never demoted (the #246 rule: a bench number keeps its provenance through a re-entry).

/** Set one stock dimension, tagging it (unless it was measured). */
export function withStockAnswer(
  a: SetupAnswers,
  key: keyof SetupAnswers['stock'],
  value: number | StockMaterial,
): SetupAnswers {
  return {
    ...a,
    stock: { ...a.stock, [key]: value },
    sources: { ...a.sources, stock: { ...a.sources.stock, [key]: carried(a.sources.stock[key]) } },
  };
}

/** Set the workholding answer. The rotary choice's own write is `setRotaryHolding` (#240). */
export function withWorkholding(a: SetupAnswers, choice: WorkholdingChoice): SetupAnswers {
  return { ...a, workholding: choice };
}

/** Set the sacrificial answer, resolving the choice to the object the job will carry. */
export function withSacrificialChoice(a: SetupAnswers, choice: SacrificialChoice): SetupAnswers {
  return { ...a, sacrificial: sacrificialForChoice(choice, a.sacrificial) };
}

/** Merge a vise edit; the patch owns `source` (the #231 fix passes `'saved'`). */
export function withVise(a: SetupAnswers, patch: Partial<ViseParams>): SetupAnswers {
  return { ...a, vise: { ...a.vise, ...patch } };
}
