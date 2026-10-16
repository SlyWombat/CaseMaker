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

import { defaultStockProud, validateVise } from '@/engine/cnc/fixture';
import { FEEDS_TABLE } from '@/engine/cnc/feeds';
import { MATERIAL_LABELS } from '@/engine/cnc/materials';
import type { MillProfile } from '@/engine/cnc/machine';
import {
  hasSacrificial,
  noneSacrificial,
  presetJawStrips,
  presetPartOnBoard,
} from '@/engine/cnc/sacrificial';
import { dedupeFindings, validateJob, type JobFinding } from '@/engine/cnc/engrave/jobSetup';
import { resolveTool } from '@/engine/cnc/toolRegistry';
import type {
  EngraveJob,
  FieldSource,
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
 *   - A material only a PROFILE names — the Z1's metals, ABS and Acrylic — is one the machine is
 *     set up for, and the only numbers for it are Makera's own, for that exact cutter and material
 *     (`feedsFor`, Route A). Offering it is not a promise: a job in one is REFUSED until the user's
 *     own synced catalogue carries such a row, and the refusal says which row is missing. The
 *     important half is that the metal can be ASKED for at all — before #347 the list offered four
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
 * What the part is held in. Only a vise exists today; a rotary chuck is CNC-5's work and is
 * offered as a disabled choice so the shape of the question is right before the geometry is.
 */
export type WorkholdingChoice = 'vise' | 'rotary';

/** The three sacrificial answers people actually build — plus "keep a custom setup". */
export type SacrificialChoice = 'none' | 'board' | 'strips' | 'custom';

/** The steps, in the order they are asked. */
export type SetupStepId = 'holding' | 'material' | 'blank' | 'cutter';

export const SETUP_STEPS: readonly { id: SetupStepId; title: string }[] = [
  { id: 'holding', title: 'What is holding the part?' },
  { id: 'material', title: 'What is it made of?' },
  { id: 'blank', title: 'How big is the blank?' },
  { id: 'cutter', title: 'Which cutter is fitted?' },
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
  toolKey: string;
  /**
   * The provenance of each answer. The vise's own `source` and the sacrificial's own `source`
   * travel inside those objects; stock and the cutter have no other home, so they live here.
   */
  sources: {
    stock: Record<'length' | 'width' | 'thickness' | 'material', FieldSource>;
    tool: FieldSource;
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
  return {
    workholding: 'vise',
    sacrificial: job.sacrificial,
    stock: { ...job.stock },
    vise: { ...job.workholding.vise },
    toolKey: job.toolKey,
    sources: {
      stock: {
        length: carried(job.sources?.stock?.length),
        width: carried(job.sources?.stock?.width),
        thickness: carried(job.sources?.stock?.thickness),
        material: carried(job.sources?.stock?.material),
      },
      tool: carried(job.sources?.tool),
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
 * The one write path (#254). Applies every answer to the job and stamps the stock and cutter
 * provenance. The vise and sacrificial carry their own `source`, so nothing this function writes
 * is untagged — the acceptance the guided setup promises.
 *
 * **The snapshot moves WITH the key (#318).** A job names its cutter twice — `toolKey` and the
 * materialised `tool` — and `toolForJob` prefers the snapshot, so this function writing `toolKey`
 * alone left the job cutting with the OLD cutter while the panel showed the new one: picking
 * `flat-1.0`, then answering the flow's cutter question with `flat-3.175x12-metal`, kept the 1 mm
 * flat under every consumer (preview, feeds, CAM, post, verifier, and `stepFindings`). Re-resolved
 * here rather than only in the store, because `stepFindings` builds its probe through this same
 * function and has to judge the cutter the flow is about to write.
 *
 * Re-pinned **only when the key changes**: an unchanged key keeps the job's own snapshot, so
 * opening this flow and finishing without touching the cutter cannot silently re-prove the job at
 * a cutter that has since been re-collared or re-measured (`toolRegistry`'s design point 1).
 */
export function applyAnswers(job: EngraveJob, a: SetupAnswers): EngraveJob {
  return {
    ...job,
    stock: { ...a.stock },
    toolKey: a.toolKey,
    tool: a.toolKey === job.toolKey ? job.tool : resolveTool(a.toolKey),
    workholding: { kind: 'vise', vise: { ...a.vise } },
    sacrificial: a.sacrificial,
    sources: {
      ...(job.sources ?? {}),
      stock: { ...a.sources.stock },
      tool: a.sources.tool,
    },
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
    'stock-proud-too-small',
    'vise-stock-not-proud',
    'vise-stock-proud-exceeds-thickness',
    'vise-grip-shallow',
    'vise-jaw-short',
    'vise-default',
    'depth-exceeds-stock',
  ]),
  cutter: new Set(['tool-missing']),
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
  const all = dedupeFindings([
    ...validateJob(probe),
    ...validateVise(probe.stock, probe.workholding.vise, probe.sacrificial),
  ]);
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
 * resolves it is the stock-derived default (`defaultStockProud`: the seated value, capped by half
 * the blank and the shipped 4 mm), applied as the user's asserted setup (`source: 'saved'`).
 * Returns null when nothing needs fixing — and when nothing the app can offer WOULD fix it (#406):
 * on a blank no taller than the ledge step the derived value is `≤ 0`, which only trades this
 * refusal for `vise-stock-not-proud`. That blank needs a packer and a stated proud, not a button.
 */
export function stockProudFix(a: SetupAnswers): ViseParams | null {
  if (a.vise.stockProud < a.stock.thickness) return null;
  const stockProud = defaultStockProud(a.stock.thickness);
  if (stockProud <= 0) return null;
  return { ...a.vise, stockProud, source: 'saved' };
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

/** Set the cutter, tagging it (unless it was measured). */
export function withToolAnswer(a: SetupAnswers, key: string): SetupAnswers {
  return { ...a, toolKey: key, sources: { ...a.sources, tool: carried(a.sources.tool) } };
}

/** Set the workholding answer. Only `'vise'` is selectable today (rotary is CNC-5). */
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
