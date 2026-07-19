# Contributing to Case Maker

Thanks for considering a contribution. The fastest paths to a merged PR:

1. **Add a board profile** — these go to the [community library](https://github.com/SlyWombat/casemaker-library), not this repo; its [AGENT.md](https://github.com/SlyWombat/casemaker-library/blob/main/AGENT.md) lets Claude Code drive the whole flow for you.
2. **Fix a bug** flagged in the [issue tracker](https://github.com/SlyWombat/CaseMaker/issues) — look for `good first issue`.
3. **Improve docs** — the in-app docs live in `casemaker-app/src/docs/`.

## Bug workflow

The project follows an issue-first bug workflow:

1. **File an issue** before writing the fix. Title, repro, expected vs. actual.
2. **Write the fix.**
3. **Add a regression test** under `casemaker-app/tests/{unit,e2e}/` that fails without the fix and passes with it. Reference the issue number in a comment (`// regression: #N — port persisted as string`).
4. **Reference the issue in the commit message** (`Fixes #N`) so it auto-closes on merge.

## Adding a board profile

**Community boards** (the usual case): contribute to
[casemaker-library](https://github.com/SlyWombat/casemaker-library) — users
enable it under **Sources** in the app. Provenance (`source` URL +
`measurementMethod`) is mandatory there, and measure-don't-guess is the
cardinal rule.

**Built-in boards** (bundled with the app, maintainer-curated):

1. Drop `casemaker-app/src/library/boards/<id>.json` (model after `rpi-4b.json`).
   Discovery is automatic (`import.meta.glob`) — there is **no import list to edit**.
2. A manufacturer `source` URL is **mandatory** (the strict zod schema rejects builtins without one); record `measurementMethod` honestly — vendor CAD beats datasheet drawings.
3. Ship a quickstart template: drop `casemaker-app/src/library/templates/specs/<id>.json`
   with `boardId` and an `order` value, then add the template id to the
   sequence assertion in `tests/unit/templates.spec.ts` and the mirror list in
   `tests/e2e/templates-smoke.spec.ts`.
4. New board-JSON *fields* must be added in three places: `library/schema.ts`,
   `types/board.ts`, and (if projects persist them) `store/projectSchema.ts` —
   the zod schemas silently strip unknown keys.

## Development setup

See [Getting Started](docs/getting-started.md) for the full setup. TL;DR:

```bash
cd casemaker-app
npm ci
npm run dev          # start the Vite dev server on localhost:8000
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm test             # vitest unit
npm run test:e2e     # playwright E2E (requires installed Chromium)
npm run build        # production bundle
```

> **Note:** On WSL, develop inside your Linux home (`~/casemaker-app`), not the Windows-mounted `/mnt/c/...` path. The `sharp` postinstall fails on the Windows mount.

## Code style

- TypeScript **strict** mode + `noUncheckedIndexedAccess`. No `any`. Use `unknown` and narrow.
- Prefer the `BuildOp` op-tree primitives in `src/engine/compiler/buildPlan.ts` for any new geometry. Don't reach into Three.js or Manifold directly from compiler code.
- Component naming: file = component name, default export only when the file is a route module.
- React Hooks: function names that aren't React Hooks must NOT start with `use` (the `react-hooks` lint rule will yell).
- No comments unless the *why* is non-obvious. Don't restate what well-named code already says.

## Test-suite contract

- **Unit tests** (`tests/unit/*.spec.ts`) run under Vitest in node env. They should be hermetic — no I/O, no sleep, no flaky timing.
- **E2E tests** (`tests/e2e/*.spec.ts`) run under Playwright with a real Chromium + the Vite dev server. Drive behavior through `window.__caseMaker` (the test API) wherever possible — the API surface in `src/testing/windowApi.ts` is the contract. Don't simulate clicks for state changes that the API can mutate directly.
- **Mesh-stat assertions over pixel snapshots.** The viewport renders WebGL — pixel diffs are noisy. Compare `getMeshStats('shell').triangleCount` and `bbox` instead.
- **For mesh-pipeline bugs** the canonical fingerprint is `getLastDiag().meshOpsSeen === 0` while `project.externalAssets.length > 0` (or analogous). Use `getJobError()` to read the worker's last error.

## Commit messages

Multi-paragraph. First line ≤ 72 chars summarizing the user-visible change. Body explains the *why* and any non-obvious decisions. Phase-completing commits list the tests they ran. Reference closed issues with `Fixes #N`.

Co-author trailer for AI-assisted commits:

```
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

## Pull requests

- Run `npm run lint && npm run typecheck && npm test && npm run test:e2e && npm run build` locally before pushing.
- Keep PRs scoped to one logical change.
- Include screenshots or a short clip if you touch the UI.
- Update the [CHANGELOG](CHANGELOG.md) under `[Unreleased]`.

## Reporting bugs

Please include:

- The board profile loaded (or "custom").
- The relevant case parameters (snap of the sidebar is enough).
- Output of `window.__caseMaker.getLastDiag()` and `window.__caseMaker.getJobError()` from the browser console.
- The exported STL/3MF if it crashes a slicer.
