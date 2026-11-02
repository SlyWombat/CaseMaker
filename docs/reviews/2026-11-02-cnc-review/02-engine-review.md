# CNC engine — architecture and health review (read-only)

Repo `/mnt/c/Projects/Case Maker`, `main` at `5bcc5a88` (2026-11-02). App in `casemaker-app/`. Nothing was
edited, installed, committed, or sent to k3 / the Z1. All paths below are relative to `casemaker-app/`
unless they start with `docs/` or a root design doc.

Method: `wc`/`grep`/`awk`/`git log` over the tree; `gh issue view --comments` for #584/#608/#623/#625/#628/#631
and the follow-ups; `node node_modules/typescript/bin/tsc -b` in this checkout (clean, 55 s); the engrave
pipeline specs run in the Linux-side clone `~/projects/CaseMaker` (its `node_modules` has the linux
rolldown binding; this checkout's is `win32-arm64` and vitest refuses to start — see §7).

---

## 1. Map of the CNC engine

"Specs" = number of files under `tests/unit` that import the module (`@/…` alias or relative). e2e specs
import almost nothing directly (5 import `types/engraveJob`, 1 each `engine/cnc/machine` and `post/z1`).

| Area | Files | LOC | Purpose (one line) | Specs |
|---|---|---|---|---|
| `src/engine/cnc/` (root) | 45 | 18,038 | Machine profiles/calibration (`machine.ts` 1,871), feeds table (`feeds.ts` 1,740), cutter geometry (`cutterProfile.ts` 1,638, `tool.ts`), `.nc` verifier (`verify.ts` 1,150), stock start (`stockStart.ts` 1,020), fixture/vise/probe plan, run end/restart, gates (`uploadGate.ts`, `simGate.ts`) | 36 via index; `machine` 95, `feeds` 59, `verify` 30, `stockStart` 10, `cutterProfile` 1 |
| `engine/cnc/engrave/` | 74 | 32,839 | The engrave-job domain: setup/validation (`jobSetup.ts` 4,105), part plan (`partPlan.ts` 2,509), run sheet (`runSheet.ts` 5,086), oracle (`oracle.ts` 1,082), depth bounds, cutter plan/recommend/smart pick, surface plane/spread, goal-* (flip, underside, coverage, reach), package freeze, rest pass, inlay, texture | 276 (`jobSetup` 109, `partPlan` 46, `runSheet` 38, `oracle` 17, `depthBounds` 19, `package` 9, `surfacePlane` 6, `surfaceSpread` 7) |
| `engine/cnc/cam/` | 22 | 11,291 | Toolpath generation: 2.5D rings + V-carve (`engraveJob.ts` 1,203), 3D surfacing (`surface3d.ts` 3,056), adaptive (`adaptive.ts` 1,012 + grid 637), thread mill 543, rotary relief 519, drill/profile/pocket/facing/chamfer/indexed/tour, IR (`ir.ts` 672) | 85 (`surface3d` 20, `engraveJob` 20, `adaptive` 6, `threadMill` 3, `rotaryRelief` 5, `rough3d` 3) |
| `engine/cnc/registration/` | 13 | 4,611 | Plan the probe touches (`plan.ts` 702) → drive them (`execute.ts` 1,682) → judge (`outcome.ts` 507); centre find, 3D probe, rotary tap, mount context | 29 (`plan` 9, **`execute` 3**) |
| `engine/cnc/post/` | 5 | 1,604 | `postZ1` (686) incl. rotary emitter, `postGrbl` (172), thumbnail (656), `postFor(machine)` dispatch | 28 (`z1` 28, `grbl` 1) |
| `engine/cnc/gcode/` | 8 | 2,158 | Lexer, interpreter/runner (932), event store, `;@MKR` header | 18 |
| `engine/cnc/emulator/` | 2 | 1,282 | Timeline builder + checkpoint store the sim sweeps | 11 |
| `engine/cnc/rotary/` | 5 | 1,759 | Wrap/unwrap maps, neck, face ops, findings, tailstock | 8 |
| `engine/cnc/setups/` | 12 | 2,188 | Multi-setup authoring, flip, carry, remount, orient | 17 |
| `engine/cnc/camera/` | 6 | 1,393 | Camera calibration, target sheet, fiducials | 3 |
| `engine/cnc/preflight/` | 4 | 907 | Preflight hub/collect | 5 |
| `engine/cnc/mounts/` | 5 | 836 | Bracket/vise/rotary mounts, in-path check | 11 |
| `engine/cnc/plan/`, `bed/` | 6 | 1,127 | Time/phase plan; bed binding | 4 / 2 |
| `src/workers/sim/` | 12 | 15,010 | **`engraveGenerate.ts` 8,380** (orchestrator: regions → CAM → post → verify → predicted areas), `session.ts` 1,330 (sim routing + oracle), `engraveGeometry.ts` 1,834, `engravePreview.ts` 1,109, `planEvaluate.ts` 761 | 142 (`engraveGenerate` 69, `session` 62, `engravePreview` 18) |
| `src/workers/geometry/` | 7 | 4,936 | `columnEngine.ts` 2,310 (dexel, flat + rotary parameterisations), `sweep.ts` 1,786 (exact Manifold CSG + `unliftTimeline`), playback, evaluateOp | 83 (`columnEngine` 24, `sweep` 18) |
| `src/platform/` (root) | 26 | ~10,848 | Machine clients (`machineRun` 579, `machineUpload` 339, `machineProbe` 525, console/vacuum/laser/light/stop/pause/heartbeat), `houseClient` 1,021, `locationClient` 738, `defaultsClient` 774 (158 shop-default keys), bed profiles/wizard, flight recorder | 176 (`houseClient` 41, `locationClient` 40, `machineProbe` 15, `machineRun` 7, `machineUpload` 7) |
| `platform/desktop/` | 6 | 2,807 | Z1 wire protocol (`protocol.ts` 1,887: framing, CRC16, discovery, status, upload), `machineBridge.ts` 559, quicklz | 18 (`protocol` 15, **`machineBridge` 3**) |
| `platform/headless/` | 4 ts + 5 json | 1,598 + 23,689 | CLI/MCP bootstrap, receipt, patch; **generated** JSON schemas (`engrave-job.json` 8,013, `coupon-spec.json` 8,115) | 13 |
| `src-tauri/src/` (Rust) | 25 | 21,006 | House service data + HTTP (`house.rs` 4,882, `house_api.rs` 2,152), server/guard, location/defaults/catalogue/stock/feeds/power, machine TCP+serial transport (`machine.rs` 802, `machine_api.rs` 638), camera, crash log, build stamp | 124 `#[test]` (house.rs 6, catalogue 24, location 17, machine 2, machine_api 0 — its tests are `#[tokio::test]`) |
| Stores | — | — | `engraveJobStore.ts` 3,434 (86 actions), `engraveJobSchema.ts` 2,905, `engraveRunStore.ts` 1,184, `engraveRunGate.ts` 648, `machineRunStore.ts` 685, `locationStore.ts` 1,047, `engraveJobFileStore.ts` 403, `engravePackageStore.ts` 150 | 66 / 80 / 20 / 12 / 9 / 29 |
| Types | — | — | `types/engraveJob.ts` 2,343 — 95 exported types; `EngraveJob` has **44 top-level keys**; 155 `src` files import it | 223 |

Totals: engine/cnc 80,033 LOC; sim+geometry workers 19,946; platform 38,942 (incl. 23.7k generated JSON);
Rust 21,006. The CNC side is roughly 160k of the 243k-line `src/`.

---

## 2. The simple case, end to end (text on a flat blank, vise, flat or V cutter)

Stage → function (file:line) → what the simple case passes through.

1. **Document.** `EngraveJob` (`src/types/engraveJob.ts`; 44 keys, a text job needs ~13: `schemaVersion id name machineId stock labels toolKey workholding minFloor edgeMargin sacrificial breakthrough jawClearance customFonts shapes`). Parsed by `parseEngraveJob` (`src/store/engraveJobSchema.ts:2832`) — version branch by literal, machine-frame and travel refusal (`:2870–2877`), `migrateParsedJob` (`:2773`). Edited through `engraveJobStore` (86 actions, 143 `if (`).
2. **Regions.** `engraveRegions` (`src/workers/sim/engraveGenerate.ts:1753–2854`, **1,100 lines, 10 params**) → `partPlan.ts`, `depthBounds.ts`, `vCarveGeometry.ts`, `stackDepthLimit.ts`, `feedsFor` (`feeds.ts`), `recommendTool.ts`. Predicted floor for the oracle is built here (`(design ⊖ planeRadius) ⊕ tipRadius`, the #584 fix at ~`:1792`).
3. **Validation.** `validateJob` (`src/engine/cnc/engrave/jobSetup.ts:1682–3501`, **1,820 lines**, `JobFindingCode` union of **158** codes at `:~100–260`).
4. **Orchestration.** `engraveGenerate` (`engraveGenerate.ts:6595–7175`). Before the simple case is reached it passes four dispatches: facing-material refusal `:6635`, faces-only job `:6679`, pure-goal 3D job `:6690`, multi-setup goal `:6695`; then "a job is a list of programs" `:6740`, one per (setup, tool) `:6906`, each via `generateOneProgram` (`:7335–8380`, **1,046 lines, 16 params**).
5. **CAM.** `generateEngrave` (`src/engine/cnc/cam/engraveJob.ts:623`, **11 params** incl. `rotary` and `adaptive`) → `ToolpathIR` (`cam/ir.ts`).
6. **Post.** `postFor(mill)` (`src/engine/cnc/post/index.ts:46`) → `postZ1` (`post/z1.ts:413`) with `PostContext` (10 fields: `zDatum 'probed-top-face'|'rotary-axis'`, `surface`, `startingTool` …) and `PostOptions` (vacuum span, thumbnail). Call site `engraveGenerate.ts:8206`.
7. **Verifier.** `verifyProgram` (`src/engine/cnc/verify.ts:390`) runs **inside the worker** on the posted text; `VerifyContext` 9 fields (`dialect?`, `rotary?`, `mountObstacles?` …); 12 rule groups (`:375–389`). An error-severity finding fails generation (`engraveGenerate.ts:~6560`).
8. **Sim + oracle.** `engraveRunStore.run` (`src/store/engraveRunStore.ts:406–1008`, 600 lines) → `simClient` → `sim.worker.ts` → `session.load` (`src/workers/sim/session.ts:786`): parse with the post's dialect (`:850`), `buildTimeline`, `unliftTimeline` when a surface frame is set (`:856`), then **routing at `:888`**: `wrapped rotary || sweepsOnColumn(tool) || denseFlatRoutesToColumn(...)` → `columnSweep` (dexel), else `sweepTimeline` (exact CSG). **A V-bit text job takes the column engine; a flat-end-mill text job takes the exact sweeper** (`sweepsOnColumn` `:441`). Oracle: `session.oracle` → `computeOracle` (`src/engine/cnc/engrave/oracle.ts:621`), column slices via `gridSliceAt` (`:361`); `combineOracles` (`engraveRunStore.ts:228`). `SimLoadOpts` has 16 fields (`session.ts:226`).
9. **Run gate.** `src/store/engraveRunGate.ts`: `saveBlocker :445` → `runElsewhereBlocker :481` → `uploadBlocker :509` (one program only; verifier report or surface3d check must exist `:528`) / `releaseBlocker :542` (multi-program) → `surfaceRepostBlocker :575` (#608/#635) → `facingRegistrationBlocker :627`. Program-level: `programUploadProblem` (`src/engine/cnc/uploadGate.ts:78`), `simulationProblem` (`simGate.ts:39`). Package: `freezePackage` / `packageStaleness` (`engrave/package.ts:148/209`).
10. **Registration.** `surfaceSpreadPlan` (`engrave/surfaceSpread.ts:381`) + `planRegistration` (`registration/plan.ts:385`) → `runMountTap :715` / `runRegistration :1166–1452` (`registration/execute.ts`) → `computeOutcome` (`outcome.ts:230`) → `assessSurfaceSpread :653` → `surfaceFitForPost :635` → re-post via `run(surface)` (`engraveRunStore.ts:406`). Called from 5 UI/store files (`EngraveRegistrationStep.tsx` 1,104 LOC, `useMountTap.ts`, `EngraveCentreFind.tsx`, `engraveRegistrationStore.ts`, `engraveReleaseStore.ts`).
11. **Upload.** `uploadProgram` (`src/platform/machineUpload.ts:245`): `programUploadProblem` gate → idle status check → `uploadVerifiedProgram` (`platform/desktop/machineBridge.ts:430`, branded `VerifiedProgram` via `asVerifiedProgram :144`) → `protocol.ts` framing (`encodeFrame :137`, `PTYPE_FILE_*`, md5) → Tauri `machine.rs` (TCP/serial) or `machine_api.rs` HTTP (`/api/v1/machine/*`).
12. **Run.** `runProgram` (`src/platform/machineRun.ts:215`): `playLine`, alarm/Idle/`P<100` checks, M331 vacuum, M331.4 antistatic, `play`, progress poll with stop/alarm/unreachable outcomes.

**Knob count the simple case carries** (whether or not it uses them): document 44 keys; `EngraveShopOpts` 15; `engraveGenerate` 8 params; `generateOneProgram` 16; `generateEngrave` 11; `PostContext` 10 + `PostOptions` 3; `VerifyContext` 9; `SimLoadOpts` 16; 158 shop-default keys (`defaultsClient.ts`); 158 finding codes; 87 `if (` in `engraveGenerate()` alone and 346 in the file.

### Where breadth is threaded through the same code paths (coupling evidence)

| Breadth feature | Where it sits on the simple path |
|---|---|
| Rotary | `engraveGenerate.ts:7433` `rotaryMap = rotaryMapOf(job)` evaluated for every program; `:7991` `toRotaryIR`; **`:8002` `const surfaceFrame = rotaryMap === null ? (shop.surface ?? null) : null`** — the flat job's surface frame is decided by a rotary null-check; `:8146` `zDatum`; `:8230` rotary verify ctx. `cam/engraveJob.ts:632` `rotary` param scales every ring (`aroundScale`). `post/z1.ts:77/443` A-word refusal in the flat emitter. `verify.ts:399/412` dialect and rule set chosen by `ctx.rotary`. `session.ts:888` routing. `oracle.ts:69` `topZ` for indexed rotary in `computeOracle`. |
| Thread mill | `engraveGenerate.ts:7648` `threadMillIR` inside the per-program loop; `columnEngine.ts:118/355–371` thread cutter kinds; `SimLoadOpts.threads`; `oracle.ts:621` `threadGrid?` param; `validateJob` has 116 "thread" mentions. |
| Adaptive (metal) | `engraveGenerate.ts:7745–7772` settings resolved and passed into `generateEngrave(..., adaptive)`; `:7882–7904` findings; `cam/engraveJob.ts:633` param. |
| 3D goal mesh / surface3d | `engraveGenerate.ts:6690/6695/7376` dispatches; `engraveRunGate.ts:528` `surface3d == null` clause in `uploadBlocker`; `releaseBlocker :556` `surfaceCheck` alternative to a verifier report; `EngraveShopOpts.surfaceGrid`. |
| Multi-setup / carry | `engraveGenerate.ts:6740–7130` programs list, `#865` per-program findings; `engraveRunStore.ts` carried fields `:393–440` (`priorRemoval`, `priorFields`, `carried`); `session.ts:815–830` seed normalisation and `prior-removal-column` refusal before routing. |
| GRBL machines | `post/index.ts:46` `postFor`; `verify.ts:399` dialect; `session.ts:850` parse dialect; **`engraveJobSchema.ts:2870–2877`** — document *load* refuses by machine `frameState`/`boxProblem` (#773/#845). |
| Tape / bracket / bed | `engraveGenerate.ts:7688` tape hold findings; `:8124` travel height for tape/bracket; `validateJob` `bed`/`defaults` options (`jobSetup.ts:1690–1700`); `VerifyContext.mountObstacles`. |
| Facing | `engraveGenerate.ts:6635` refusal before anything; `:8060` separate program; `runSheet.ts` 94 "facing" mentions; `facingRegistrationBlocker`. |

Everything a text badge needs and everything else share `generateOneProgram`, `validateJob`,
`buildRunSheet`, `session.load`, `postZ1`, `verifyProgram` and one document schema.

---

## 3. Markers of unfinished or unmeasured work (`.ts` under engine/cnc, workers, platform, + job types/schema/store)

| Term | Lines | Files |
|---|---|---|
| `TODO` / `FIXME` | 0 / 0 | — (the codebase uses issue numbers and words instead) |
| `PROVISIONAL` | 132 | 26 |
| `unmeasured` | 116 | 33 |
| `placeholder` | 79 | 19 |
| `assumed` | 72 | 37 |
| `stub` | 24 | 9 |
| `not yet` | 14 | 10 |
| `bench` | 296 | 92 (mostly comments citing or deferring to bench evidence) |

Grouped by theme:

- **Fixture/bed geometry is drawn, not measured** — `bedScene.ts:102–127,173,300` (bed top, plate thickness, pin pair, clamp footprint), `drawnVise.ts:58–115,346–372` (18 PROVISIONAL constants), `drawnRotary.ts:78–83`, `rotary/tailstock.ts:11–25` ("THE FIGURES ARE PROVISIONAL. None of them has been calipered"), `fixture.ts:104–142,279,410` (`GRIP_MIN`, `VISE_BODY_DEPTH`, #208), `bedPlate.ts:29`, `probePlan.ts:90–109` (chuck runout, bracket repeatability, jaw squareness residuals), `defaultsClient.ts:193,256`, `types/engraveJob.ts:2190–2194` (through depth 0.3, jaw clearance 1.0).
- **Feeds/cut numbers are placeholders** — `feeds.ts` (21 "unmeasured"; `:268–284` PLACEHOLDER row for 0.8–1.6 mm, `:338/359` PETG and laminate rows "chosen placeholder"), `defaultsClient.ts:284–325` `drill.*`, `thread.*`, `adaptive.*` all labelled "(placeholder)", `cam/surface3d.ts:31` "FEEDS ARE A PLACEHOLDER", `cam/adaptive.ts:90–94`, `cam/threadMill.ts:75–79`, `cam/drillBit.ts:43–45`, `cam/tabSettings.ts:13,43` ("ALL THREE ARE PROVISIONAL AND CHOSEN"), `cam/drill.ts:35`, `sacrificial.ts:22,66`, `feeds.ts:1646` (profile = full-width slot).
- **Stock provenance 'assumed'** — `stockStart.ts:336–338,387,525–532,603–609,664–667` (laminate cap 0.075, PCB 1.6 mm, copper); surfaced by `runSheet.ts:1010–1037` "(assumed)" and `FieldSource` (`types/engraveJob.ts:113`).
- **Flatness / surface not yet measured** — `depthBounds.ts:547,593` ("flatness not yet measured: no bow claim"), `materialScan.ts:158`, `engraveJobSchema.ts:1447,1478`.
- **Protocol facts not confirmed on this Z1** — `defaultsClient.ts:641` (`.bin` compression of upload "not yet confirmed"), `machinePause.ts:7` ("[DECOMPILED], not yet tried on our Z1"), `post/z1.ts:37–48,286` (rotary preamble "until the bench reads a Studio-generated rotary file").
- **Stub placement** — `setup.ts:34–37,190–268` (`RegistrationSource 'stub'`, origin-at-centre), `columnEngine.ts:749` ("The stub placement (#237) is approximate"), `jobSetup.ts:86`.
- **Preview/UI gaps** — `workers/sim/engraveRegistration.ts:236` (preview does not re-orient stock per setup), `preflight/types.ts:101,149` (deliberately unresolved placeholder).

---

## 4. The oracle / surface-frame saga (#584 → #608 → #623 → #625 → #628 → #631/#634/#635)

**Status on main: resolved in code, pinned by tests, and bench-confirmed once (2026-10-25 run 9).**

The chain, each with its landing commit (all ancestors of `5bcc5a88`, verified with `git merge-base`):

| # | What was wrong | Fix | Proof |
|---|---|---|---|
| #584 | Prediction over-promised: floor = `design − floorInset` kept a Ø0.61 dot the V-bit's first erosion drops → 0.0815 mm² under-cut | floor = `(design ⊖ planeRadius) ⊕ tipRadius` (`engraveGenerate.ts:~1792`), `03e60786` | `tests/unit/vCarveFloorReach.spec.ts:129,144` |
| #608 | Registration read a 0.45 mm tilt as "bowed"; nothing could follow it | Least-squares plane fit + `{plane, z0}` on the record; Cut re-posts against it (`applySurfaceLift`, `surfacePlane.ts:157`), `0df9b329` + `9d15b836` | `surfaceLiftPost.spec.ts`, `registrationSurfaceSpread.spec.ts` |
| #623 | Oracle judged a lifted file in the work frame → 301 mm² | Judge in the surface frame (`OracleReport.frame`), `c7920af7` | `engraveOracleSurface.spec.ts:216,297,325` |
| #625 | The lift's many Z buckets pushed a flat job over the exact-sweep density cap onto the column engine | Density judged on the un-lifted image, `8e603e1f` | `surfaceLiftDensity.spec.ts:71–163` |
| #628 | **The actual badge failure (1.66 / 75.5 mm²)**: column engine sweeps a feed at `min(z0,z1)`; a lifted move ramps, so long glyph segments were swept at their deep end | Un-lift the timeline for the column path too (`session.ts:856` `unliftTimeline`, `sweep.ts:118`); seat + per-cell lift removed; `830054ae` | `engraveOracleSurface.spec.ts:233` (un-lifted stock, top Z 0), `:256` (non-zero z0/offset plane), **`:309` the real bench badge job (`tests/unit/fixtures/badge-2026-10-24-vbit.job.json`, 0.817° plane) reads 0/0** — added `69f85601` on 2026-11-02, on main |
| #634 | `airMoves` stayed lifted → phantom rapid-through-stock | `unliftTimeline` un-lifts air moves (`sweep.ts:212–213`) | `unliftTimeline.spec.ts:95`, `surfaceLiftDensity.spec.ts:111` |
| #635 | `surfaceRepostBlocker` one-directional | both directions (`engraveRunGate.ts:575–606`) | closed 10-25 |
| #631 | Dome verdict: G32 vs plane disagreement | G32 route with the stated assumption; (c) accept route with miss N; `3360d793`, `a8a41fa0`, `b69670f3` | closed; calipers moved to #767 |

How I know it is resolved: the specs above ran green here (`engraveOracleSurface`, `vCarveFloorReach`,
`surfaceLiftDensity`, `unliftTimeline`, `columnEngine`, `engraveOracle` all in the 18-file run, §7); #628's
own thread records the real job through the app's path at 0/0 with the flat post's own numbers
(337.21/71.07 predicted vs 336.99/71.14 simulated); and `docs/bench/2026-10-24-datum-path-bench.md:146–150`
records run 9 on k3 build with #623+#625+#628+#584: oracle 0/0 in the surface frame, upload md5-verified,
**the cut ran `P:` 0→100 in ~4:15 (13,442 moves)** — the first complete badge cut from the app.

What is NOT closed: #569 (the cut's floor depth vs the colour plane, calipers) and #767 (bench checklist)
are OPEN. The column engine's `min(z0, z1)` rule is still the sweep rule (`columnEngine.ts:1657,1684,1727,1729`);
it is exact only because every surface post is un-lifted before routing (`session.ts:856` precedes `:888`).
#629 (ramping feeds swept at their deep end on the column path — adaptive helix entries, thread chords)
was closed 2026-10-25 as a flagged limitation, not removed. Any future change that routes a program to
the column engine *before* un-lifting, or posts a genuinely ramping flat program, re-opens the same class
of failure.

---

## 5. Fragility — the files most likely to break again

| # | File | LOC | Churn (commits since 10-19) | Concrete smell |
|---|---|---|---|---|
| 1 | `src/workers/sim/engraveGenerate.ts` | 8,380 | 134 | 96 imports; `generateOneProgram` is 1,046 lines with 16 params (`:7335`); `engraveRegions` 1,100 lines; `generateGoalProgram` 1,150 lines (`:4662–5814`); four job-shape dispatches before the simple case; `:8002` flat surface frame gated on `rotaryMap === null`; 346 `if (`. One worker module is the orchestrator, the region builder, the goal sampler, the prediction builder and the post/verify caller. |
| 2 | `src/engine/cnc/engrave/jobSetup.ts` | 4,105 | 104 | `validateJob` 1,820 lines (`:1682–3501`), 139 `if (`; 158-member `JobFindingCode` union; 53 `src` importers; `withSideGoal`/`jobSetups`/`jobMount` live beside it, so UI, worker and run sheet all depend on the same file. New diagnostic codes also need a `cnc-guide.md` chapter-8 row (`cncGuide.spec`), and the guide has 135 commits — strings are part of the contract. |
| 3 | `src/engine/cnc/engrave/runSheet.ts` | 5,086 | 59 | `buildRunSheet` 1,137 lines (`:3732–4868`), 57 imports, 127 `if (`; prints facing (94 mentions), thread (50), rotary (25), setups (26), grbl (3). Tests pin sentences (`runSheet*.spec` ×6), so any wording change in a breadth feature ripples. |
| 4 | `src/components/panels/EngravePanel.tsx` | 5,585 | **144** (most-changed file) | 133 imports; the panel binds every store and every wizard; the registration step (`EngraveRegistrationStep.tsx` 1,104) and cut surface (`EngraveCutSurface.tsx` 1,207) are its satellites. Review #636/#638/#639 all landed here (state not cleared between runs, writes whose results were not read). |
| 5 | The document trio: `src/types/engraveJob.ts` (2,343) + `src/store/engraveJobSchema.ts` (2,905) + `src/platform/headless/schemas/engrave-job.json` (8,013 generated) | — | 57 / 63 / 60 | Three artefacts changed in lock-step ~60 times in two weeks; +155 type field lines, +142 zod field lines, 19 removed/re-homed. 155 `src` files import the type. 27 `.strict()` sub-blocks refuse unknown keys by path (`:125…1034`), 18 plain `z.object` strip them, the root is `.passthrough()` (`:2684`). A new field must be added in three places (plus the Zod stripping rule noted in project memory) or it vanishes on load. |
| 6 | `src/workers/sim/session.ts` (1,330) + `src/workers/geometry/columnEngine.ts` (2,310) + `sweep.ts` (1,786) | 5,426 | 31 / 22 / — | Routing at `session.ts:888` is tool-shape × density × rotary class × seed kind; `SimLoadOpts` 16 fields; two engines with different error models (`ramp-over-removed` warned on one, silent on the other until #629); `columnEngine.ts:1657` `min(z0,z1)` is correct only given `:856` runs first. The V text badge and the flat text badge are simulated by *different engines*. |
| 7 | `src/store/engraveRunStore.ts` (1,184) + `src/store/engraveRunGate.ts` (648) | 1,832 | 40 / 31 | `run()` is 600 lines (`:406–1008`), sets `phase: 'blocked'` at 8 sites, carries removal fields across programs (`:384–440`); gates read `generated.verify` of program 1 only (`engraveRunGate.ts:~520` comment); #642 found staleness watches 2 of 8 stamped inputs. |
| 8 | `src/engine/cnc/registration/execute.ts` | 1,682 | 31 | Machine-safety code (G38 streams, 38 mentions; 100 `if (`) with **3** unit specs importing it directly (plan.ts 9); the 10-25 blocker #632 (`G0` into stock) lived at `~:696`; five UI/store callers; the write-back semantics (#636/#650 re-PUT after 412) live in callers, not here. |
| — | Also | | | `src/platform/desktop/machineBridge.ts` 559 LOC / 3 specs (upload path); `src-tauri/src/house.rs` 4,882 LOC / 6 `#[test]`; `src/engine/cnc/cutterProfile.ts` 1,638 / 1 spec. |

---

## 6. Schema / document stability

- **Version:** `CURRENT_JOB_SCHEMA_VERSION = 3` (`engraveJobSchema.ts:2761`), introduced `e6cfe6b8` on **2026-10-17** (#425) — the window opened with a fresh version and the literal has not moved since. v2 dates from 2026-10-04 (#213/#214).
- **Field churn without a bump:** 63 commits to the schema since 10-19; `+142 / −19` zod field lines; `+155 / −10` type field lines; `engrave-job.json` regenerated 60 times. The convention is explicit: "an additive optional field does not bump the schema version" (`:1221`), every addition is `.optional()` and "not defaulted" so stored documents round-trip byte-for-byte (`:2600–2683`). The 19 removed lines are re-homings (thread fields into a sub-schema, `rotary-chuck` into `jobWorkholdingSchema`, `fromKey/toKey` substitution), not deletions of document keys.
- **Migration code:** `migrateParsedJob` v1→v3 and v2→v3 (`:2773–2800`), `migrateStockPrint` for pre-#492 `stock.print` (`:1416`, applied via `z.preprocess` `:1659`), `legacyFlatnessSchema` dropped on load (`:1480–1496`), `withDiscStock` (`:2802`), `caseNoteMigration.ts` (134 LOC). A newer version is refused by name (`:2764`, `:2845–2853`).
- **Strictness:** 46 `z.object`, 27 `.strict()`, 1 `.passthrough()` (root, `:2684`). Unknown keys inside the three Save/Open-owned blocks (`sourceFiles`, `package`, `runLog`) are refused by path; elsewhere they are silently stripped — the known trap (memory: new JSON fields must be added to the Zod schema or they are dropped).
- **Does a job saved two weeks ago still load?** Yes, with evidence: `docs/bench/*.job.json` holds 8 `schemaVersion: 2` documents (incl. `single-barrel.job.json`, the bench badge) and 5 v3; they are loaded by `tests/unit/benchTypicalJobs.spec.ts`, `docsRoundTrip.spec.ts`, `casemakerCutPrograms.spec.ts`, `cncVerify.spec.ts` and others (10 specs reference `docs/bench`); 53 `schemaVersion: 1|2` literals in `tests/unit`; the #628 fixture `badge-2026-10-24-vbit.job.json` is a 10-24 document that loads today. Load-time caveat added since 10-19: `parseEngraveJob` now refuses a document whose `machineId` names a model with an unread frame or whose stock exceeds that machine's travel (`:2870–2877`, #773/#845) — a job file is no longer loadable independently of the machine registry.

---

## 7. Test health

- **Typecheck:** `node node_modules/typescript/bin/tsc -b` in this checkout (main `5bcc5a88`): **clean**, 55 s.
- **Vitest in this checkout:** refused to start — `Cannot find native binding … @rolldown/binding-wasm32-wasi` — `node_modules/@rolldown/` holds only `binding-win32-arm64-msvc` (this checkout was `npm ci`'d from Windows; CLAUDE.md "pick one side per checkout"). No install was attempted.
- **Vitest in the Linux clone** `~/projects/CaseMaker` at `07c499ed` (contains `5bcc5a88`; `src`/`tests` differ from main by one follow-up: `engraveGenerate.ts` +51, `jobSetup.ts` +5, a new `goalChamfer3d.spec.ts`; working tree clean under `src`/`tests`): the 18 engrave-pipeline spec files — `engraveGenerate`, `engraveJob`, `engraveJobGate`, `engraveOracle`, `engraveOracleSurface`, `engraveOracleDeterminism`, `engraveRunStore`, `engraveRunVerify`, `postZ1`, `registrationPlanner`, `runSheet`, `runSheetVCarve`, `runSheetZ0`, `simGate`, `vCarveFloorReach`, `surfaceLiftDensity`, `unliftTimeline`, `columnEngine` — **18 files passed, 591 tests passed, 0 failed, 33.5 s** (`--maxWorkers=4`).
- Suite size: 694 unit spec files, 102 e2e specs (23 CNC-named: `engrave*.spec`, `cutStep1`, `cutConfirm`, `runStates`, `sim-worker`, `simulation`, `simRotaryOpen`, `simIndexedTurn`, `firstJob.acceptance`, `machineRail`, `cncMode`).
- Coverage shape: thick on the document, the generator and the run sheet (223 / 69 / 38 importers); thin exactly where the machine is touched — `registration/execute.ts` 3, `machineBridge.ts` 3, `machineRun.ts` 7, `machineUpload.ts` 7, `cutterProfile.ts` 1, `post/grbl.ts` 1. CI has never run (memory); every green number above is a local run.

---

## 8. Assessment

### Required for one clean badge/text cut

Document (`EngraveJob` ~13 keys) → `engraveRegions` (text → polygons, V-carve plane geometry, depth
bounds, feeds row) → `validateJob` → `generateEngrave` rings/V trace → `postZ1` flat emitter → `verifyProgram`
(Z1 dialect, flat rules) → `session.load` (V → column engine; flat → exact) → `computeOracle` → `saveBlocker`/
`uploadBlocker`/`surfaceRepostBlocker` → `planRegistration`/`runRegistration`/`assessSurfaceSpread` →
`applySurfaceLift` re-post → `uploadProgram` → `runProgram`. Plus the house data it reads: the cutter
record + catalogue row, the location's machine/vise/probe, three shop defaults (`registration.*`,
`vacuum`, `sim.columnFlatPitchYMm`). Roughly: `engrave/{jobSetup,partPlan,depthBounds,vCarveGeometry,
oracle,surfacePlane,surfaceSpread,package,runSheet}`, `cam/{engraveJob,ir,pocket,trace}`, `post/z1`,
`verify`, `gcode/*`, `emulator/*`, `registration/{plan,execute,outcome}`, `workers/sim/{engraveGenerate,
session}`, `workers/geometry/{columnEngine,sweep}`, `platform/{machineUpload,machineRun,machineProbe,
desktop/*}`, `stores/{engraveJob*,engraveRun*}`, the Rust house + machine transport. That path exists,
is green, and cut a badge on 2026-10-25; what it still owes is #569's caliper reading and #767's checks.

### Breadth (not required for that cut)

Rotary (wrap/indexed/neck/faceOps/tailstock, `rotaryRelief`, `computeRotaryOracle`, rotary post), mesh-to-part
(`surface3d`, `rough3d`, goal-* ×10 files, `goalFlipSetups`, `primitiveSurface`, carried fields),
adaptive metal (`adaptive.ts`, `adaptiveGrid.ts`, `adaptivePool.worker.ts`), thread mill (`threadMill`,
`threadTable`, `threadFit`, thread column cutter), GRBL/stated machines (`post/grbl`, `MILL_MODELS`
frame states, load-time refusal), multi-setup (`setups/*`, `targetObjects`), PCB isolation/copper oracle,
inlay/texture/slot/chamfer/drill/bore, facing, tape/bracket/bed profiles, camera, laser. By LOC this is
most of `engine/cnc` and most of the per-program function the badge runs through.

### Where to freeze/branch so the simple path stops moving under the bench

1. **Pin the badge path with a golden, not a branch.** The strongest existing anchor is
   `engraveOracleSurface.spec.ts:309` (real 10-24 badge job → 0/0). Extend it into a *frozen-artefact*
   test: the committed bench job → generated `.nc` text hash + verifier report + oracle numbers +
   run-sheet text, byte-compared (the repo already does this for `docsRoundTrip`'s receipt). Any
   breadth commit that changes the badge's bytes then fails locally before gate. This freezes the
   output without freezing the files.
2. **Split `generateOneProgram` by job shape before adding more to it.** A `generateFlatItemProgram`
   (vise, flat/V, no rotary map, no thread, no adaptive, no neck, no facing) that the badge takes, with
   the rotary/thread/adaptive/neck branches moved out behind the existing `rotaryMap !== null` /
   `regions.some(adaptive)` / `job.threads` predicates (`engraveGenerate.ts:7433,7648,7745,7843`). Same
   for `validateJob`'s thread/drill/chamfer/inlay/texture/primitive blocks (one function, 1,820 lines),
   and `buildRunSheet`'s facing/thread/rotary sections. This is a mechanical extraction; the predicates
   already exist.
3. **Freeze the document for the bench.** Declare schema v3 closed for the duration: new breadth
   fields go into a v4 branch (`engraveJobV4Schema = v3.extend(...)`) that `parseEngraveJob` only
   accepts behind the existing version switch; the bench jobs stay v3 and are not re-parsed through a
   schema that changed 63 times in two weeks. The strict-block/strip rule then cannot eat a bench
   field by accident.
4. **Make the sim routing decision a named, tested function with a frozen table.** `session.ts:888`
   decides which engine judges the cut. A table test (tool shape × rotary class × density × seed →
   engine) pinned on main stops a GRBL/thread/rest-pass change from moving a V badge off the column
   engine (or a flat badge onto it) silently.
5. **Give the machine-touching layer the specs it lacks before adding to it:** `registration/execute.ts`
   (3 specs), `machineBridge.ts` (3), `machineRun.ts` (7). The two machine-safety findings of the last
   review (#632, #643) were in files with the least direct coverage.
6. **Branch policy:** the repo works on `main` with ~40 worktrees (`git worktree list`). A literal
   branch is not the house style; the equivalent is a published k3 build pinned for the bench
   (`cm_build.sh <sha>`, memory: "publish per batch") and a rule that the pinned sha only moves when
   the golden in (1) and the 18-file pipeline run are green on the candidate.

### One-line verdict

The simple engrave path is complete, typed, green (591/591 on the pipeline specs; tsc clean), and has
produced one real cut; its risk is not missing function but that every one of its stages is a shared
function with 10–16 parameters through which rotary, thread, adaptive, 3D-goal, GRBL and multi-setup
work also flow, in files that changed 60–144 times in two weeks. Freeze the badge's bytes and extract
the flat-item program before the next bench session, not after.
