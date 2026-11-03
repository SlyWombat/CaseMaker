# Review C — #926 efficiency measures, #927 honest cycle estimate

Reviewed `origin/main` = 829708cc, read-only. Commits: d69c4b37, d19912ab, 72430bd0, 6a76fc8b, e88c656b, c9c18718, 83a725c9 (#926); 8dc0419f, c7cd93aa, b3d1ed8b, c64e1236, 491a6880, c5142cd8, 95d88f3e, b37c876b, d851034f, 63c942cd, c3ef1c2c, 452b9c62 (#927). Line numbers are on origin/main unless a sha is given.

## Findings, severity-ranked

### HIGH

**H1 — No record the app writes carries the machine's elapsed; the runbook line on #927 is false against the code.**
- b3d1ed8b adds `actualSeconds` as a 4th parameter to `buildRunRecord` (`casemaker-app/src/engine/cnc/engrave/runRecord.ts:162-170`). Its only caller is `casemaker-app/src/components/panels/EngravePanel.tsx:3045` — `buildRunRecord(job, generated)` — two arguments.
- c7cd93aa's `withActualSeconds` (`runRecord.ts`) has zero callers in `src/` or `scripts/`.
- `casemaker-app/src/store/machineRunStore.ts:297` has `outcome.last.elapsedS` in hand and writes it to no record.
- #927's design note item 4 named this exact seam ("a one-line seam in A's `machineRunStore.ts` that the manager must sequence"); it did not land. The manager's hand-in comment then states a runbook line — "save the run record AFTER the run, so it carries the machine's clock" — which the code does not do.
- Failure scenario: S1 bench cut, operator saves the record after the run → `actualSeconds: null`, `cutOn: null`. The Done card reads "No timed run recorded for this job yet.", §9 prints no last-run line, `readback run --list` prints "no actual". The milestone's first predicted/actual pair is never recorded by the app unless a person types `minutes`.

### MEDIUM

**M1 — The 12 s spindle ramp is sourced, but to the wrong event in its own trace (8dc0419f).**
- `casemaker-app/src/engine/cnc/machine.ts:689-691`: `Z1_SPIN_UP_SECONDS = 12`, source = S:36.8 at 17:18:08.262 → S:12011.7 at 17:18:20.296 in `docs/bench/traces/2026-10-15-185-cut.log`. The trace does say that.
- But the clock-relevant quantity is how long the controller DWELLS before motion resumes, and the same trace shows motion resuming before full speed: line 22 S:36.8, Z −3.0, `P:0,58,10`; line 34 (17:18:16.28) S:11748, Z already −8.77 at F600, `P:0,70,17` — dwell ≈ 7–8 s. The air run `2026-10-15-185-air.log` agrees: S:629 at 17:16:57 (elapsed 1), Z moving at 17:17:05 (elapsed 9), 12000 rpm only at 17:17:07.
- Effect: every program over-charged ~4 s. The model's known bias is LOW (1.17–1.55×), so this hides part of the real error rather than correcting it. The code labels it "a speed-field read, not the D3 timed run" and D3 replaces it — honest, but the number as shipped measures spindle speed, not the clock. Recommend ~8 s with the dwell basis, or label 12 s an upper bound, before S1's comparison.

**M2 — The new terms are priced but unlabelled where the estimate is printed; the receipt strips them.**
- Sheet header `casemaker-app/src/engine/cnc/engrave/runSheet.ts:790` and the `.nc` comment `casemaker-app/src/engine/cnc/post/z1.ts:180-182` still read "cutting + rapids through the trapezoid … a planning estimate". The efficiency step (`runSheet.ts:3220`) says "the cycle estimate's own trapezoids" while its cycle now includes a non-trapezoid 12 s constant.
- `RunSheetCamSummary.cycle?: CycleTerms` (`runSheet.ts:217`, c7cd93aa) is declared and never read — `grep spinUp` outside `ir.ts`/`machine.ts` returns nothing in `src/` or `scripts/`.
- `engraveCamSchema` in `casemaker-app/src/platform/headless/receipt.ts` (6a76fc8b) has no `entrySeconds`/`spinUpSeconds`/`cycle` keys; receipts go through `receiptSchema.safeParse` (`receipt.ts:598`) and zod strips them, so the receipt cannot say which term moved either.
- Doctrine "a number must have a source": the source exists in code; a reader of the sheet, the file or the receipt cannot see that 12 s of the number is a ramp.

**M3 — `readback run --list` lists nothing today and ignores a person's minutes; untested (c3ef1c2c).**
- `casemaker-app/src/engine/cnc/engrave/runHistory.ts:21`: `MEASURED_RUNS: readonly RunRecord[] = []`. The 10-17 runs (94/136, 373/437, 162/255) were never records, so the listing prints "0 run(s)". The commit's example line came from a synthetic run (its own message says so).
- `casemaker-app/scripts/lib/casemaker/readbackRun.ts:133` maps `actualSeconds: r.actualSeconds` — not `runSeconds(r)` — so a record applied with the operator's `minutes` (the only clock the app can currently write, see H1) prints "no actual"; `receipt.ts:851ff` then prints no error %.
- No test references `--list` or `stage: 'listed'` (grep over `tests/`).
- Failure: after S1 the operator fills `minutes`, applies the record → listing shows "no actual".

**M4 — `tourExcess` moved by #927 with no change to any path.**
- `efficiencyOf` adds the inter-operation entry to `total.rapidMm` (`casemaker-app/src/engine/cnc/cam/ir.ts:1053`) while the program bound stays the sum of per-operation MSTs (`ir.ts:1079-1081`), which excludes inter-operation travel; the comment at `ir.ts:1079` argues the opposite. Golden badge: "165 % past it" → "179 % past it" (c64e1236), laminate 145→179, single-thin 158→196, with identical toolpaths. A reader sees the ordering "got worse" when only the measure changed.

### LOW

- **L1** The 10-17 programs were NOT re-estimated; recorded honestly on #927 (manager: not on any disk here; read from the SD card at S1 with D3). Open item, not a defect — but M1 should be settled before that comparison is made.
- **L2** `runRecord.ts:321`: `*/function hasReadings(` — the newline was lost in d19912ab (cosmetic). `hasReadings` excludes `actualSeconds`, so an undated `actualSeconds` passes validation where undated `minutes` is refused; `isTimedRun` still requires the date, so such a record is invisible everywhere. Consistent with b3d1ed8b's stated intent, but asymmetric.
- **L3** `EngravePanel.tsx:5445-5450` — the older "Last measured run" line still reads `lastMeasured.minutes` only; §9 and the Done card use `runSeconds`. A machine-timed record would show in two places and not the third.
- **L4** `casemaker-app/tests/unit/camEfficiency.spec.ts:2` and `:221` still say "the written fraction" after e88c656b removed it (stale describe title).
- **L5** Tool change / M491 are not in the cycle — by design (#927 design note item 3, like-for-like program comparison). The same note promised the sheet would state the pre-program terms beside the cycle and the record would carry them; neither is in this stack (`fitCutterSeconds|toolLengthSeconds|homeSeconds` absent from `runSheet.ts`).
- **L6** 452b9c62 `run --capture` records status polls (interval ≈ 2 s) with the `P:` state/percent/line/elapsed, the wall clock, outcome and `junction_deviation`. It is per-line at poll resolution, NOT a separate timing of rapids vs feeds, and nothing in the repo reads a capture back (`machineElapsedS` appears only in `z1.mjs`). Honest about what it is; "readable back into the model" = by hand.
- **L7** The air threshold is a real shop default — three seeds present: `defaultsClient.ts` `KNOWN_DEFAULTS['efficiency.maxAirFraction']` (0.35), `src-tauri/src/defaults.rs` `UNMEASURED_SEEDS` + `known_rule` (0..=1), `tests/unit/fixtures/location-doc.json` — with a provenance note ("chosen, not measured; corpus worst good program 26.3 %"). There is NO per-job recommendation: the sheet compares every program to the one shop value. The 26.3 % basis was measured before #927 changed both numerator (entries) and denominator (ramp); `docs/bench/single-barrel.receipt.json` moved 27.0→26.6 % and the note was not re-stated.
- **L8** `engraveGolden.spec.ts` single-thin case depends on untracked `samples/badge-blank/thin-film/single-thin.3mf` (fails ENOENT on a clean checkout). Pre-existing, not this stack's.
- **L9** Commits without tests: c3ef1c2c (`--list`), 452b9c62 (`z1.mjs`; no `tools/z1` run-path tests exist), c5142cd8 (covered indirectly by goldens/pins). c7cd93aa, b3d1ed8b, b37c876b, d851034f, d19912ab, 8dc0419f, d69c4b37 all carry tests.

## Answers to the seven questions

**1. Measures.** `efficiencyOf(ir, rapid)` (`ir.ts`, d69c4b37 + 8dc0419f) computes per operation and per program, from the IR's own moves with the SAME trapezoid/rapid model as the estimate: `cycleSeconds` (= moves + inter-op entries + ramp), `rapidSeconds` (incl. entries), `feedSeconds`, `entrySeconds`, `spinUpSeconds`, `airFraction`, `hopCount`/`hopSeconds` (XY-only rapids at `hopZ`), `commandedFeedSeconds` → `feedUtilisation`, `rapidMm`/`cutMm`/`rapidCutRatio`, `sweptAreaMm2` (Σ XY length × cutter width at depth, V via `vCone`), `deepestCutMm`, `tourBoundMm` (Prim MST over loop entries, capped 4096 points) and `tourExcess`. `camEfficiency.spec` asserts rapid+feed = `estimateCycleSeconds` per op and total = `estimateCycleTerms`. Dropped: the redundant-removal judgement (`writtenFraction`, `efficiency-air-cut`, `efficiency.minWrittenFraction`) in e88c656b, with the reason (36/39 corpus programs under 0.5 because the strip sums every depth pass while the volume divides by the deepest cut once; the IR cannot tell step-over overlap from a re-cut) — recorded on #926 as a comment with the full corpus table and the manager's acceptance. Only ONE threshold ships; it is a real shop default (L7), not a constant; absent a setting the sheet prints measures and warns on nothing (`runSheet.ts` `options.efficiencyThresholds`). No per-job recommendation exists.

**2. Golden/pinned bytes.** 72430bd0: only the three `run-sheet.md` moved (2 steps inserted, renumbered); `.nc` hashes untouched. c64e1236: three `program.nc.sha256` moved with identical byte counts (129956/110997/207926); the commit names the single changed line (`;@MKR|TIME` 283→296, 355→370, 400→415) and says so. 95d88f3e: 5 spec files, 11 pins. In-repo full-text proof for two (`tests/unit/fixtures/default-job.nc` diff = TIME 1410→1424 only; `postZ1.spec.ts` inline snapshot = TIME 4→17 only). I reproduced two more by generating on base 66566420 and on origin/main and diffing full text (scratch `out-base/` vs `out-head/`): thread841 M3 → one line, `TIME` 23→35; j18 pipeline → one line, `TIME` 45→58 — the commit's exact numbers. The remaining seven (M2.5/M5/M6, thread848 ×3, goalRoughSplit869) rest on the commit's stated method, with magnitudes consistent (+12 single-op = ramp, +13/14 two-op = ramp + entry). The TIME header IS in the posted bytes (`post/z1.ts:554`), so the hash moving is by design and every commit says so.

**3. Sources.** Inter-op rapid: priced from operation i−1's last move to operation i's first on the existing `rapidRate`/trapezoid (`ir.ts` `entryMoveSeconds`, `estimateCycleTerms`); operation 1's entry is explicitly not priced (`ir.ts:649`) — the cut trace shows that leg was ~9 s from park. Ramp: `Z1_SPIN_UP_SECONDS = 12` on the profile with a source string (M1 — right trace, wrong observable). Labelled in the basis? No (M2). Tool change/M491: not in the cycle, by design (L5). 10-17 re-estimate: not done, deferred to S1 on the issue (L1).

**4. Run record / readback / capture.** Plumbing exists (`actualSeconds`, `withActualSeconds`, `runSeconds`, `isTimedRun` accepts it, round-trip tested) but no app path writes it (H1). `readback run --list` prints predicted vs actual with % from the measured region of `runHistory.ts`, which is empty, reads `actualSeconds` only, and has no test (M3). D3 capture: poll-resolution `P:` trail plus wall clock; not rapids/feeds separately; no reader (L6).

**5. Done card.** `actualTimeSentence(lastTimedRun(job.name, allRuns(imported)))` (`EngraveCutSurface.tsx`); d851034f dates it from the record's own `cutOn` so it does not claim to be the run just finished. It derives from the store on each render, no local state; `runOver` is scoped to `machineRun.context.jobId === job.id`, so job B's done card does not show job A's run. Correct as far as it goes — but with H1 it will say "No timed run recorded" after every app-saved run.

**6. Ownership/tiers.** 6a76fc8b (B: `engraveGenerate.ts` summarize signature + 10 call sites, `receipt.ts` schema + 1 render line; D: `EngravePanel.tsx` one option; E: CLI 2 lines) and c5142cd8 (B: summarize uses `estimateCycleTerms`; D: `lastRun` option) are additive and declared in the messages. 63c942cd touched E's `readbackFeeds.ts`/`readbackRun.ts` for the `history: null` field it introduced — minimal. docs:sync: `src/docs/cnc-guide.md` and `docs/cnc-guide.md` are the same blob (eef39677) on origin/main; the `efficiency-air` row is present and `efficiency-air-cut` removed in both. Missing tests: L9.

**7. Spec runs** (scratch tree = `git archive origin/main`, node_modules symlinked, time-boxed): `camEfficiency, runRecord, camEstimate, timeEstimate735, headlessReceipt, postZ1, thread841, thread848, goalRoughSplit869, ncSnapshot, runHistory, cutSurface` — 12 files, 194 tests passed. `runSheet.spec.ts` — 111 passed, 2 skipped. `engraveGolden.spec.ts` — 2/3 on a clean archive (single-thin ENOENT on the untracked sample, L8); 3/3 after copying the sample in. Nothing modified in the repo or `~/projects/CaseMaker`.

## Scratch artefacts
- `.../review-C/wt/specs-a.log`, `.../review-C/runsheet.log`, `golden.log`, `golden2.log`
- `.../review-C/out-base/{m3,j18}.nc` vs `.../review-C/out-head/{m3,j18}.nc` (full-text re-pin proof)
- `.../review-C/wt-base/` = 66566420 (pre-#927 base); probe spec `tests/unit/zzProbe927.spec.ts` in both scratch trees only
