# Golden pins — the rebuilt engine's programs

Empty until the CAM rebuild (#956, slices #957–#966) posts its first accepted programs. Each case
will live in its own directory and carry the same artefacts as the 10-24 badge pins:

- `program.nc.sha256` — `sha256 <hash> (<bytes> bytes)` of the posted program;
- `verifier.json` — the pipeline's own `VerifyReport` on that text;
- `estimate.json` — #927's cycle terms and the program facts the seven-line scorer reads
  (rapids per 1,000 feed lines, cutters, air fraction);
- `card.json` — the reference card and the seven lines, as `tests/tools/seven-lines.ts` prints them.

The case's entry in `manifest.json` names the job and the goal mesh's sha256 (the mesh stays a
local input, injected the way `samples/3d` already is). Regeneration is a deliberate act:
`CASEMAKER_UPDATE_GOLDEN=1 npx vitest run tests/unit/modelGolden.spec.ts`, with a landing note on
the issue naming which artefact moved and why. Bytes that move without that note are the defect
the spec exists to catch.
