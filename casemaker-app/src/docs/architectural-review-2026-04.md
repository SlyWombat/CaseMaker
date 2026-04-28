# Architectural Review — Case Maker, April 2026

**Scope:** `casemaker-app/` working tree at HEAD + uncommitted changes for issues #36/#37/#38/#39. Closed issues #6, #7, #10, #12–24, #27–30, #32, #34–40 read against current source.

**Posture:** Read-only audit. Findings cite exact `file:line` and a one-sentence severity (`blocker` / `structural-debt` / `nit`).

---

## 0. Process risk (read this first)

`git status` shows the engine files for the four most recent issues (#36 extra-cavity-Z, #37 placement validator, #38 clone-board, #39 fixtures) sit **uncommitted in the working tree**. `placementValidator.ts`, `PlacementBanner.tsx`, `boardPlaceholder.ts`, and the entire `engine/scene/fixtures/` directory are untracked. Any review-driven follow-ups must be sequenced against landing those changes first or against checkpointing them; otherwise a stash-and-rebase cycle will lose the history of what we audited.

---

## 1. Bucket A — Engine compiler

The compiler is twelve modules totaling ~1,800 lines orchestrated by `ProjectCompiler.compileProject` (`/casemaker-app/src/engine/compiler/ProjectCompiler.ts`). Every per-feature compiler is invoked once, ops are bucketed `additive` vs `cutoutOps`, then `union` + `difference` produce a single shell node and a single lid node. `placementValidator.validatePlacements(project)` runs at the end and is attached to the BuildPlan but does not gate anything (see §1.6 below).

### 1.1 Coordinate-frame conventions are unwritten and silently inconsistent

The codebase has **no central coordinate-system module**. `src/engine/coords.ts:1–17` is a 17-line stub that only flips three.js's `DEFAULT_UP` to Z; it is not the helper its name suggests. `src/engine/portConstraints.ts` only carries 2D drag/clamp utilities. Every compiler reinvents the conversion from PCB-frame (board-local mm, origin at PCB lower-left, Z=0 at PCB bottom) to world-frame (case origin, Z=0 at the bottom of the floor).

The result is that two compilers compute "world Z of a point on the host PCB top" two different ways:

- **Board ports** (`ports.ts:50`): `wz = floor + standoff + zMin` — PCB-relative `zMin` is added on top of the elevated PCB. Standoff is included.
- **HAT ports** (`hats.ts:118`): `wz = zMin` where `zMin` already comes from `z0 + port.position.z - profile.pcb.size.z` (line 93) — i.e. world Z is baked into the offset. Standoff arrives via `z0` from `computeHatBaseZ`.
- **Smart-layout pre-pass** (`smartCutoutLayout.ts:44`): `cutoutTopWorldZ = floor + position.z + size.z + cutoutMargin` — **standoff omitted**. This is the same formula `ports.ts` used before issue #28 corrected it.
- **Screw-down validation** (`validation.ts:33` vs `validation.ts:42`): `boardTopZ` includes standoff; `componentTopZ` does not.

> **Severity: blocker.** Two of these (`smartCutoutLayout.ts:44` and `validation.ts:42`) are concrete bugs introduced when issue #28 added the standoff offset to `ports.ts:50` but did not propagate the symmetric fix.

| File | Line | Symptom | Severity |
|---|---|---|---|
| `src/engine/compiler/smartCutoutLayout.ts` | 44 | `cutoutTopWorldZ` omits `+board.defaultStandoffHeight`; `topClearance` is overstated by `standoff` (~5 mm), so the `< MIN_BRIDGE_THICKNESS=1.5` branch fires far too rarely. The exact case `giga-parts.jpg` was filed against (#17) is no longer caught after #28 landed. | blocker |
| `src/engine/compiler/validation.ts` | 42 | `componentTopZ` omits `+ standoff`; the comparison `componentTopZ < boardTopZ + clearance` (line 43) is biased by exactly one standoff. Most real `+z` component / lid-post collisions silently pass `validateScrewDownAlignment`. | blocker |
| `src/engine/coords.ts` | 1–17 | The file named `coords` is a 17-line three.js up-vector setter; there is no central PCB→world helper despite three compilers needing one. | structural-debt |
| `src/engine/portConstraints.ts` | 1–119 | Has the right name to host face-frame and projection helpers but currently only carries 2D drag clamping. | structural-debt |

### 1.2 `computeShellDims` is called HAT-blind by ten downstream consumers

`computeShellDims(board, params, hats?, resolveHat?)` is the single source of truth for the shell envelope. The signature accepts HATs but defaults `hats=[]` and `resolveHat=()=>undefined`. The actual shell built by `buildOuterShell` always passes them in, so the case grows for HATs as designed. Every other caller passes `(board, params)` and silently believes the case is shorter than it is:

| File | Line | What's anchored to the wrong `outerZ` |
|---|---|---|
| `src/engine/compiler/lid.ts` | 31, 43, 72, 115, 141 | Lid post length, recess pocket dims, every joint variant. |
| `src/engine/compiler/displays.ts` | 46 | Display window Z base / pocket base. |
| `src/engine/compiler/snapCatches.ts` | 16, 74 | Default catch placement, pocket Z. |
| `src/engine/compiler/antennas.ts` | 88 | Z-center clamp `min(8, cavityZ/2)` (effect is bounded so visible damage is small). |
| `src/engine/compiler/ventilation.ts` | 14, 39 | Slot height / hex grid extent — the back-wall vent area is computed against the HAT-blind shell. |

> **Severity: structural-debt → blocker** depending on the path. Snap-catch pockets at 1mm below `outerZ` (the HAT-blind value) are now ~one HAT-stack height *below* the actual rim; recessed-lid pockets cut at the wrong Z; vent-slot heights compute against a shrunken cavity.

### 1.3 Three independent `faceFrame` implementations have already diverged

The same concept — "given a face like `+y`, return the world-frame origin and U/V axes" — is reimplemented three times with three different return shapes:

- `src/engine/compiler/mountingFeatures.ts:23–75` — `{origin, uAxis, vAxis, outwardAxis: [number,number,number]}`.
- `src/engine/compiler/fans.ts:18–33` — `{origin, uAxis, vAxis}` only; **no outward axis at all**, and the `default:` branch silently routes `-x` to a `+x`-shaped frame.
- `src/engine/compiler/textLabels.ts:28–79` — `{origin, uAxis, vAxis, outwardSign, outwardAxis: 'x'|'y'|'z'}`.

All three duplicate the same trigonometric reasoning; `placementValidator.ts:71–96` reimplements the same projection inline with yet another convention (port faces only).

| File | Line | Symptom | Severity |
|---|---|---|---|
| `src/engine/compiler/mountingFeatures.ts` | 196–207 | `generateVesaMount` always uses a Z-axis cylinder for the through-hole; on `+y`/`+x`/`-x` faces this is **not a through-hole** — it's a 20mm Z-axis slug that may or may not intersect the wall. No test catches it. | blocker |
| `src/engine/compiler/fans.ts` | 31 | `default:` returns the `-x` frame for any unmatched face; invites quiet bugs. | nit |
| `src/engine/compiler/fans.ts` | 125–129 | Side-mounted fan emits "just an open hole" with no grille; documented as v1 limitation but never tracked. | structural-debt |

### 1.4 `BuildOp` lacks oriented primitives, forcing every compiler to re-emit `rotate(cylinder)` boilerplate

`buildPlan.ts:3–19` defines `cube`, `cylinder` (Z-axis only), `mesh`, plus transforms. There is no "axis-aligned cylinder along facing F" or "wall-piercing cutout on face F" primitive. As a result:

- `roundCutout.ts:27–48` builds the rotation case-by-case for `+x/-x/+y/-y` (three cases share a body, one diverges).
- `antennas.ts:124–166` re-rotates `cylinder + rotate([-90,0,0])` four times by hand for the four side facings.
- `fans.ts:118–135` only supports `+z/-z` because the rotation case for side-mounted fans is too verbose to write.
- `mountingFeatures.ts:201–206` skips the rotation and ships a Z-axis cylinder for what should be a through-hole on any face (per §1.3 it's a blocker).

Adding `axisCylinder(facing, length, radius, segments)` to `buildPlan.ts` would eliminate four copies of the same switch and remove the temptation that produced the VESA bug.

### 1.5 Hidden statefulness in `compileProject`

`ProjectCompiler.ts:33–37` declares a module-level `let lastSmartCutoutDecisions: SmartCutoutDecision[] = []` and exposes a `getLastSmartCutoutDecisions()` getter. Every `compileProject` call writes this. The compiler is otherwise pure; this one mutable global is the path the (still-not-shipped) "Why did my cutout extend?" diagnostic uses to surface decisions in the UI. In a multi-project / undo / temporal-zundo world, this mutable global desyncs from the active project.

### 1.6 Issue #37 acceptance criterion not met

Issue #37 explicitly required: "UI shows a red banner when errors exist **and blocks export with a clear message**; warnings show in yellow but allow export." The shipped implementation:

- `placementValidator.ts:23` comment: "The geometry pipeline does not gate on it; the user can still export."
- `ProjectCompiler.ts:121–122` attaches the report to `BuildPlan` but no consumer in the export path reads `errorCount`.
- `PlacementBanner.tsx:21–22` shows the banner but does not disable any control.

Either the criterion should be revised in #37's closure note or the gate should ship.

### 1.7 Cross-issue narrative — the four "fought against" pairs

The git log makes the bug pattern legible:

1. **#17 → #28.** Commit `0c16c94` introduced `smartCutoutLayout.ts` with `cutoutTopWorldZ = floor + z + size + margin`. Commit `e2304f4` ("port Z alignment") later changed `ports.ts:50` to `floor + standoff + z` to fix #28 — but did not touch `smartCutoutLayout.ts`. The smart-layout pre-pass now thinks every cutout is `standoff` mm lower than it actually is, so the bridge-thickness check that #17 was filed to add no longer fires for the very board-class (`GIGA R1`, `giga-parts.jpg`) it was filed against. **This is the canonical example issue #41 worried about.**
2. **#18 → #32.** #18 added a host-tallest-+z lift; #32 found that side-facing connectors also occupy Z and filtered out `facing==='+z'`. Both compilers (`caseShell.ts:21` and `hats.ts:28`) were updated symmetrically — this pair landed cleanly. The cost is the duplication: two `tallestPlusZ` reductions live in two files, both labeled "Issue #32" so the next reader knows they have to update both.
3. **#32 → #35.** #32 added the Giga+DMX template with `ports: []`. #35 fixed the template's empty `ports` and the fictional Giga components, but only patched the two surfaced templates. `templates/index.ts:30–37` (`piPoeStack`) still has `ports: []` and reproduces the same empty-ports bug — see §3.5.
4. **#30 sliding-removal.** Half-completed: schema and engine drop `'sliding'`, but `CasePanel.tsx:8`, `tests/e2e/joints.spec.ts:24`, and `tests/unit/lidPostsAcrossJoints.spec.ts:15` still mention it. The schema preprocesses `'sliding' → 'flat-lid'`, but `patchCase` writes raw values and bypasses the schema (see §2.4 and §3.1).

---

## 2. Bucket B — Data model / schema

`Project` (`src/types/project.ts:27–48`) is canonical; `projectSchema.ts:128–290` defines five Zod versions and a unified migration.

### 2.1 Migrations are reachable but the structure is copy-paste

`projectV1Schema` … `projectV5Schema` (`projectSchema.ts:128–242`) each redeclare every shared field instead of `.extend(previous)`. Adding `projectV6Schema` for the next feature will mean re-typing the field list a sixth time.

### 2.2 `BoardComponent` ↔ `PortPlacement` overlap

`BoardComponent` (`src/types/board.ts:31–42`) and `PortPlacement` (`src/types/port.ts:4–15`) carry duplicate fields: `kind`, `position`, `size`, `facing`, `cutoutMargin`, `cutoutShape`. `autoPortsForBoard` and `autoPortsForHat` explicitly project the former into the latter. `projectStore.patchComponent` (`projectStore.ts:338–370`) then has to mirror writes from the component into the port. There is no inverse: editing a port (e.g. `cutoutMargin`) does not update the component.

### 2.3 Three parallel "custom profile" arrays + no shared editor

| Path | Has builtin library | Has custom array | Has clone action | Has editor UI |
|---|---|---|---|---|
| `BoardProfile` | yes | (lives in `project.board`) | `cloneBoardForEditing` | `BoardEditorPanel.tsx` |
| `HatProfile` | yes | `customHats[]` | none | none |
| `DisplayProfile` | yes | `customDisplays[]` | none | none |

### 2.4 `caseParameters` field-bloat and orphans

`CaseParameters` now carries 13 fields. The CasePanel surfaces only ~6:

| Field | Source issue | Surfaced in CasePanel? |
|---|---|---|
| `wallThickness`, `floorThickness`, `lidThickness`, `internalClearance`, `zClearance`, `cornerRadius` | core | yes |
| `joint` | #2/#27 | yes (but includes the dead `'sliding'` value, see §3.5) |
| `bosses.insertType` | #21/#27 | yes |
| `bosses.outerDiameter`, `bosses.holeDiameter`, `bosses.enabled` | core | **no** |
| `ventilation.*` | #33 | yes |
| `extraCavityZ` | #36 | yes |
| `lidRecess` | #30 | **no** |
| `snapCatches[]` | #29 | **no** |

So `lidRecess`, `snapCatches`, and the boss diameters are reachable only via templates or hand-edited JSON — same pattern as the missing top-level panels for `antennas`, `fanMounts`, `textLabels`, `mountingFeatures` (see §3.4).

---

## 3. Bucket C — UI / store

### 3.1 `useProjectStore` is 30+ actions in 630 lines and cannot be sliced

`src/store/projectStore.ts` mixes board, case, ports, components, hats, mounting features, displays, fans, and text labels into one Zustand store. There is no shared patcher helper; 30+ `addX`/`removeX`/`patchX` actions are repeated almost identically.

The store has actions for `addFanMount`, `addTextLabel`, `addMountingFeature`, `setDisplay` — but **no `addAntenna`, `removeAntenna`, `patchAntenna`** despite the `antennas: AntennaPlacement[]` array existing.

### 3.2 `boardVisualization` photo / 3D modes are stubbed

`viewportStore.ts:5` declares the cycle `'schematic' | 'photo' | '3d'`; `Toolbar.tsx:91–97` shows the cycle button. But:

- `BoardPlaceholderMesh.tsx:21` explicitly `void`s the value.
- `AppShell.tsx:33–67` is the only consumer; uses the value purely to render a "fallback" banner.
- `BoardProfile.visualAssets.glb` is declared but no built-in board has a GLB and no consumer would render one.

### 3.3 Three diagnostics surfaces with overlapping responsibilities

| Surface | Source | Carries |
|---|---|---|
| `PlacementBanner.tsx` (#37) | recomputes `validatePlacements` in a `useMemo` instead of reading `BuildPlan.placementReport` | overlaps, off-PCB, rim margin, HAT collisions |
| Fallback banner inline in `AppShell.tsx:51–68` (#34) | reads `viewportStore.boardVisualization` | "no photo asset" |
| `StatusBar.tsx` | reads `useJobStore` | rebuilding/error/triangle counts |

`PlacementBanner.tsx:13–19` re-runs the validator on every render — duplicating work `compileProject` already did and discarding the result attached to `BuildPlan`.

### 3.4 No UI for half the engine's domains

Engine domains with no panel: **Antennas, Fan mounts, Text labels, Mounting features, Display, Snap catches**. Every one has unit tests, store actions, schemas — and zero UI affordance.

### 3.5 `CasePanel` lists a removed joint type

`src/components/panels/CasePanel.tsx:8` lists `{ value: 'sliding', label: 'Sliding' }` in `JOINT_OPTIONS`. `JointType` is `'snap-fit' | 'screw-down' | 'flat-lid'` — `'sliding'` is not valid. The `<input value=opt.value>` is typed `string` not `JointType`, so the type system never catches it. Selecting "Sliding" calls `patch({ joint: 'sliding' })`, which writes the raw value (`projectStore.ts:152`); the engine routes through the `default:` branch in `lid.ts:161` and silently produces a flat-lid case.

---

## 4. Bucket D — Testing

77 spec files (53 unit + 24 e2e). Patterns of concern:

### 4.1 Tests are not type-checked

`tsconfig.app.json:28` `"include": ["src"]` — the `tests/` directory is **not** part of any tsc target. Vitest runs them via esbuild without type checking. Concrete evidence:

- `tests/unit/antennas.spec.ts:28`, `tests/unit/hatCutoutsRound.spec.ts:105`, `tests/unit/smartCutoutLayout.spec.ts:32` all spell `ventilation: { …, faces: [] }`. `VentilationParams` does **not** have a `faces` field.

### 4.2 Tests pass on the "wrong reason" branch

`tests/unit/gigaDmxTemplate.spec.ts:36–43` is the test issue #41 specifically called out. It asserts `cyls >= 2` after compilation. After the #35 fix the count is 2, but the same test passed before #35 — the bar `>= 2` is so low that any compiled project clears it.

### 4.3 Tests still exercise removed `'sliding'` joint

- `tests/e2e/joints.spec.ts:24–39` calls `patchCase({ joint: 'sliding' })` and asserts `lidYSpan < shellYSpan`. With `'sliding'` removed and routed to `'flat-lid'`, lid Y equals shell Y.
- `tests/unit/lidPostsAcrossJoints.spec.ts:15` declares `joints: JointType[] = ['flat-lid', 'snap-fit', 'sliding', 'screw-down']` — `'sliding'` is no longer a `JointType`.

### 4.4 Coverage holes for shipped features

| Feature | Test surface | Missing |
|---|---|---|
| `placementValidator` (#37) | overlap, off-PCB, mounting-hole spacing | Rim-margin warning never asserted; `unsupported-hat`, `hat-stack-collision`, `incompatible-hat` never asserted. |
| `boardVisualization` (#34) | cycle order | No test that any consumer changes behavior on cycle. |
| `fans.ts` side-mounted | only `+z` covered | Side-mounted fan ("just an open hole" v1 limitation) silently shipped untested. |
| `mountingFeatures.ts` VESA holes | count of features | The actual VESA hole geometry (Z-axis cylinder regardless of face) is never asserted. |
| `displays.computeDisplayFootprint` | function exercised in isolation | The function is **never called by the compile pipeline**. |
| `lidRecess` + HAT | `lidRecess.spec.ts` | All cases use a HAT-less project, missing the `computeShellDims(board, params)` HAT-blind bug from §1.2. |
| `smartCutoutLayout.ts` | spec file | Test math omits standoff; mirrors the bug rather than catching it. |
| `extraCavityZ` (#36) | `extraCavityZ.spec.ts:71–82` | Does not assert that cutout **Z positions** are unchanged — the explicit acceptance criterion. |

### 4.5 Compiler invariants nobody asserts

No test in the suite asserts:

- "Every wall-piercing cutout's world-frame Z range falls inside the case wall (`floor < z < outerZ`)."
- "Every cutout pierces exactly one wall (`OVERSHOOT` extends only on the facing axis)."
- "Two `compileProject` calls with the same `Project` produce structurally identical `BuildPlan`s" (purity).
- "`smartCutoutLayout`'s `cutoutTopWorldZ` matches the actual world-Z of the cutout op produced by `ports.ts`" — exactly the invariant whose violation produced the §1.1 regression.

---

## 5. Bucket E — Installer / runtime / deployment

### 5.1 Tauri CSP only allows loopback origins; explicit-IP bind breaks the SPA

`src-tauri/tauri.conf.json:25` whitelists exactly `http://localhost:*` and `http://127.0.0.1:*` for `default-src`, `connect-src`, `script-src`, `img-src`. When `--host=192.168.x.y` is set, the webview URL becomes `http://192.168.x.y:port`, but the page CSP forbids the page from making any network request to its own origin. The SPA will load the static bundle but every subsequent request — `fetch('/api/…')`, dynamic asset loads, vite-style chunk requests — will be CSP-blocked. **The installer-hook flow sets up exactly this scenario without warning.**

### 5.2 Webview reach to LAN-bound IP is fragile

If the bound IP becomes invalid mid-session (DHCP renewal, VPN connect/disconnect, hotspot change), the webview is dead until restart.

### 5.3 Firewall rule cleanup is partial

`installer-hooks.nsh:90` deletes only `"Case Maker (TCP 8000)"` on uninstall. If the user installed with `/PORT=9000`, the rule survives.

### 5.4 No port-conflict diagnostic in the UI

`server.rs:64–73` falls back to an ephemeral port on `AddrInUse`. The user is never told the port shifted; a colleague the user gave `192.168.10.16:8000` to will fail after the local user's port shifts.

---

## 6. Invariants we now believe (and the code mostly believes)

These are the implicit contracts the engine relies on; future issues should be sanity-checked against them.

1. **Host PCB top in world Z** equals `floor + standoff + pcb.z`. Used by `ports.ts:50`, `hats.ts:33`, `validation.ts:33`, `antennas.ts:122`. **Not centralized.** Should live in a single helper in `coords.ts`.
2. **Side-wall cutout center in world Z** equals `floor + standoff + port.position.z + size.z/2`. The smart-layout pre-pass currently violates this by omitting standoff. Two places that compute "the same thing" must use the same helper.
3. **HAT base Z (PCB bottom) in world** equals `floor + standoff + pcb.z + max(headerHeight, hostTallest+0.5) + sum(prevHat: pcb.z + tallestPlus + lift)`. Owned by `computeHatBaseZ`; `placementValidator.ts:263–293` re-derives it.
4. **`tallestPlusZ` of a profile** must include all components regardless of `facing` (issue #32). Two implementations: `caseShell.ts:21` and `hats.ts:28`.
5. **Outer shell Z (`outerZ`)** depends on HATs. Every caller of `computeShellDims` whose result feeds a Z-coordinate must pass `(hats, resolveHat)`. Today ten callsites violate this (§1.2).
6. **Compiler purity:** `compileProject(p)` should be a pure function of `p`. Today it mutates `lastSmartCutoutDecisions` (§1.5).
7. **Wall-piercing cutouts must reference the host PCB top, never the cavity top.** Implicit in #36; cutouts stay anchored when `extraCavityZ` grows the cavity.
8. **`BoardComponent` is the source of truth; `PortPlacement` is a derived view.** Mirroring is one-way; the asymmetry should be doc'd.
9. **Custom profiles only ever live in the project file.** `customHats[]` and `customDisplays[]` are project-scoped, not workspace-scoped.
10. **`PlacementReport` is informational only.** The export pipeline does not gate on errors.
11. **Build-plan shape is always exactly two nodes** named `'shell'` and `'lid'`.
12. **The webview URL must be loopback** as far as the Tauri CSP is concerned. Explicit-IP binds break this invariant unless CSP is widened (§5.1).

---

## 7. Prioritised follow-up issues

### Blocker

1. **Smart-cutout pre-pass has wrong Z formula** — `smartCutoutLayout.ts:44` omits `defaultStandoffHeight`, so issue #17's bridge-thickness check no longer fires. Add the standoff offset; add a regression test that constructs the `giga-parts.jpg` configuration explicitly.
2. **Screw-down validator off by one standoff** — `validation.ts:42` compares `componentTopZ` (without standoff) to `boardTopZ` (with standoff). Real `+z` collisions slip through.
3. **VESA mount holes do not pierce non-`-z` faces** — `mountingFeatures.ts:201–206` always uses a Z-axis cylinder; on `+y`/`+x`/`-x` faces this is a 20mm tall slug at the corner. Add an oriented-cylinder primitive.
4. **`computeShellDims` HAT-blind callsites** — ten compilers compute `outerZ` without HAT contribution. Pass `(hats, resolveHat)` everywhere or remove the optional defaults.
5. **Tauri CSP blocks LAN-bound origin** — `tauri.conf.json:25` whitelists loopback only. Extend `connect-src` to include the actually-bound origin or widen for LAN deployments.
6. **`'sliding'` joint references in tests** — `tests/e2e/joints.spec.ts:24–39` and `tests/unit/lidPostsAcrossJoints.spec.ts:15` still exercise the removed joint.
7. **No UI surfaces for antennas / fans / text labels / mounting features / displays** — five engine domains have no panel.

### Structural-debt

8. **Centralize coordinate-frame math in `engine/coords.ts`** — replace the three.js up-vector stub with `pcbTopZ`, `cavityOriginXY`, `faceFrame`, `axisCylinder`. Migrate `mountingFeatures.faceFrame`, `fans.faceFrame`, `textLabels.faceFrame` to one implementation.
9. **`BuildPlan` should carry all diagnostics** — fold `lastSmartCutoutDecisions` into `BuildPlan`. Have `PlacementBanner` consume `BuildPlan.placementReport` instead of re-running the validator on every render.
10. **Decide #37's gating story** — either revise the issue to record the deferral or land the export gate.
11. **Make `computeDisplayFootprint` actually drive `computeShellDims`** — today the function is exercised by tests but never called by the compile pipeline.
12. **Schema authoring with `.extend` chains** — `projectV{1..5}Schema` should `.extend` rather than re-declare.
13. **`useProjectStore` slice split** — split into `boardSlice`, `caseSlice`, `hatsSlice`, `featuresSlice`. Add `addAntenna`/`removeAntenna`/`patchAntenna` while doing so.
14. **`patchCase` should validate against the schema** — currently writes raw values, allowing `joint: 'sliding'` and similar.
15. **Type-check the test directory** — add `tests` to a `tsconfig.test.json` referenced from `tsc -b`.
16. **Add compiler invariant assertions** — for each invariant in §6, add a test that asserts it across every built-in board and every template.

### Nit

17. **Photo / 3D modes** — either wire them up or remove the `cycleBoardVisualization` action and the fallback banner.
18. **NSIS firewall cleanup** — extend `installer-hooks.nsh:90` to discover and drop any rule prefixed `"Case Maker (TCP "`.
19. **Templates docstring vs assertion** — `tests/unit/templates.spec.ts:7` says "5 starter templates" but asserts six.
20. **`piPoeStack` template still has `ports: []`** — `templates/index.ts:30–37` reproduces the same #35 bug for the PoE+ HAT.
21. **`exportLayout.ts:148–153` comment contradicts implementation** — comment claims winding is left wrong, but `applyLayoutToMeshes:170–176` does fix it.
