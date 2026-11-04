# Golden pins — the rebuilt engine's programs

Empty until the CAM rebuild (#956, slices #957–#966) posts its first accepted programs. Each case
will live in its own directory and carry the same artefacts as the 10-24 badge pins plus the plan:

- `program.nc.sha256` — `sha256 <hash> (<bytes> bytes)` of the posted program;
- `verifier.json` — the pipeline's own `VerifyReport` on that text;
- `plan.json` — B's `ModelPlanOutput` (`{ perSetup: SetupPlan[] }`, #956 §3.0) as the engine
  produced it. The spec validates the amended interface's names and optionality, so a rename
  (`clSurface` → `clGrid`) or a reshaped op fails here, not in a consumer:
  - `SetupPlan`: `setupIndex`, `features`, `clGrid`, `ops`, `sequence`, `linking`, `programs`,
    `totalCostSeconds` — all required;
  - `clGrid[]`: `cutterKey`, `toleranceMm`, `minSpacingMm`, `maxSpacingMm` — all required;
  - `ops[]`: `kind` (pocket | contour | rough | rest | finish | pencil | chamfer) + `region` +
    `outcome`, all required; `region` is `{ id, kind (pocket | island-top | curved | contour |
    rim), bounds, topZ, bottomZ, obstacles }`; `outcome` is `{ ir, cutter, cleared? }` — `cleared`
    is the one optional field the note leaves optional;
  - `sequence[]`: `cutterKey`, `cost` (#927's `CycleTerms`: `movesSeconds`, `entrySeconds`,
    `spinUpSeconds`, `totalSeconds`), `pinned`, `house` — all required;
  - `linking`: `rapidsCount`, `hopsCount`, `airFractionPct` — all required;
  - `programs` is `ToolpathIR[]`, one per cutter in sequence order; `totalCostSeconds` is a number.
- `estimate.json` — #927's cycle terms and the program facts the seven-line scorer reads
  (rapids per 1,000 feed lines, cutters, air fraction);
- `card.json` — the reference card and the seven lines, as `tests/tools/seven-lines.ts` prints them.

The case's entry in `manifest.json` names the job, the goal mesh's sha256 (the mesh stays a local
input, injected the way `samples/3d` already is) and `setupIndex` — which entry of
`perSetup` the case pins (default 0).

Regeneration is a deliberate act: `CASEMAKER_UPDATE_GOLDEN=1 npx vitest run
tests/unit/modelGolden.spec.ts`, with a landing note on the issue naming which artefact moved and
why. Bytes that move without that note are the defect the spec exists to catch.
