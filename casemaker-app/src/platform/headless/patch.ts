/**
 * The ONE headless way to change a project's case parameters (#482).
 *
 * The interactive app mutates `project.case` through `projectStore.patchCase`, which validates the
 * patch and then runs `applyCasePatch`. That second step is not optional: setting
 * `joint = 'snap-fit'` by direct assignment leaves `snapCatches` empty, and the compiled case has
 * no catches at all (#29/#35/#62). A headless driver that edits the JSON and compiles hits exactly
 * that trap, so the CLI and the MCP server must go through this function rather than assign.
 *
 * `patchProject` is that path with no React, no store and no undo history: validate against
 * `caseParamsSchema.partial()` (the same top-level-partial contract), apply the auto-population
 * rules, pin `modifiedAt`, return a NEW project. The input is never mutated — a rejected patch
 * leaves it byte-identical, which is what a caller retrying or reporting needs.
 *
 * Nested objects (`ventilation`, `bosses`, …) must be complete values: `.partial()` loosens only
 * top-level fields. That is the store's contract too; see `projectStore.patchCase`.
 */

import { produce } from 'immer';

import { applyCasePatch } from '@/engine/compiler/applyCasePatch';
import { getBuiltinHat } from '@/library/hats';
import { caseParamsSchema } from '@/store/projectSchema';
import type { CaseParameters, Project } from '@/types';

/** A rejected field, flattened for a receipt or a CLI message: `path` is dotted, `''` at the root. */
export interface PatchIssue {
  path: string;
  message: string;
}

export type PatchResult =
  | { ok: true; project: Project }
  | { ok: false; reason: string; issues: PatchIssue[] };

/**
 * The `modifiedAt` every patch writes. The interactive store pins the epoch so a patch is a pure
 * function of its inputs (undo comparisons, template builds); the headless path keeps that default
 * and takes a clock so a CLI that WANTS a real timestamp can pass one.
 */
export function pinnedModifiedAt(): string {
  return new Date(0).toISOString();
}

/**
 * Validate and apply a case patch. `patch` is `unknown` on purpose: headless callers hand it
 * JSON, and the failure they need named is a schema rejection, not a type cast.
 */
export function patchProject(
  project: Project,
  patch: unknown,
  now: () => string = pinnedModifiedAt,
): PatchResult {
  const parsed = caseParamsSchema.partial().safeParse(patch);
  if (!parsed.success) {
    const issues: PatchIssue[] = parsed.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    const detail = issues
      .map((issue) => (issue.path === '' ? issue.message : `${issue.path}: ${issue.message}`))
      .join('; ');
    return { ok: false, reason: `invalid case patch: ${detail}`, issues };
  }

  const validPatch = parsed.data as Partial<CaseParameters>;
  const next = produce(project, (draft) => {
    // Same resolver as the store: a user's custom HAT shadows the builtin of the same id, and the
    // resolver is what places snap catches on the rim the HAT stack actually pushes up (#46).
    const hatResolver = (id: string) =>
      (draft.customHats ?? []).find((h) => h.id === id) ?? getBuiltinHat(id);
    applyCasePatch(draft, validPatch, hatResolver);
    draft.modifiedAt = now();
  });
  return { ok: true, project: next };
}
