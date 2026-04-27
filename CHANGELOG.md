# Changelog

All notable changes to Case Maker. The project follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

> **Note:** Until 1.0.0, parameter shapes are not API-stable. The `.caseproj.json` schema is versioned (`schemaVersion: 1`) and load-validated; old projects are rejected with a clear error rather than silently misinterpreted.

## [Unreleased]

Open issues:

- [#2](https://github.com/SlyWombat/case-maker/issues/2) Snap-fit physical print validation loop (blocked on hardware).
- [#8](https://github.com/SlyWombat/case-maker/issues/8) Display mounting system + library of common displays.
- [#9](https://github.com/SlyWombat/case-maker/issues/9) External case mounting features (screw tabs, zip-tie slots, VESA, DIN rail, keyhole, magnets).

## [0.7.3] — Phase 8a — 2026-04-27

### Added

- **HAT / shield stacking foundation** (closes [#7](https://github.com/SlyWombat/case-maker/issues/7), Phase 8a). Data model (`HatProfile`, `HatPlacement`), strict zod schema with mandatory `source` URL on built-ins, compiler-side stack-Z math (`computeStackedHatHeight`, `computeHatBaseZ`), and wall-piercing cutouts at the HAT's Z (`buildHatCutoutsForProject`). `zClearance` auto-grows when HATs are enabled. Project schema bumps to `schemaVersion: 2` with a v1 → v2 migration that defaults `hats: []` and `customHats: []`.
- **Built-in HAT: CQRobot DMX Shield (MAX485)** (`cqrobot-dmx-shield-max485`) — Arduino-shield form factor, 8.5 mm header gap, two XLR connectors on +y, screw terminal on -y. Compatible with Arduino Uno R3 and Arduino GIGA R1 WiFi.
- **Test API expansion** — `addHat`, `removeHat`, `patchHat`, `getHats`.
- **Sample STLs for issue #2** snap-fit print validation. `samples/snap-fit-calibration-30x30.stl` (tiny tolerance test, 72 tris) and `samples/esp32-devkit-snap-fit.stl` (real ESP32 case, 828 tris). New `npm run sample:export` script (`tsx scripts/export-sample.ts`) drives the real `compileProject` pipeline against Manifold WASM in Node.

### Tests

- 98 Vitest unit tests, 35 Playwright E2E tests (133 total).

## [0.7.2] — 2026-04-27

### Added

- **Built-in Arduino GIGA R1 WiFi profile** (closes [#6](https://github.com/SlyWombat/case-maker/issues/6)). 101.6 × 53.3 × 1.6 mm PCB with 4 M3 mounting holes, USB-C / USB-A / USB-B / barrel-jack side-facing components, three GPIO header rows, and side SD-card slot. Datasheet source URL: <https://docs.arduino.cc/resources/datasheets/ABX00063-datasheet.pdf>.
- New regression tests: `tests/unit/gigaR1.spec.ts` (5 assertions), GIGA-specific outer-bbox check in `tests/e2e/board-swap.spec.ts`, and the all-builtins E2E loop now covers 6 boards.

### Tests

- 88 Vitest unit tests, 32 Playwright E2E tests (120 total).

## [0.7.1] — Phase 7 follow-up — 2026-04-27

### Added

- **Drag-handle axis-lock + grid snap** (closes [#4](https://github.com/SlyWombat/case-maker/issues/4)). The PivotControls translate gizmo on a selected port now disables the wall-perpendicular axis (e.g. `-y` ports lock Y) so the cutout stays attached to its wall. Drag motion snaps to a 0.5 mm grid and clamps to PCB-relative bounds. A live Δx/Δy/Δz readout floats over the gizmo while dragging.
- **Keyboard nudge** for the selected port. Arrow keys nudge by 0.1 mm; `Shift+Arrow` by 1 mm. Direction is wall-aware (a `-y` port's left/right nudges X; a `+x` port's left/right nudges Y). Suppressed inside form inputs.
- **NSIS installer `/PORT=N` argument** (closes [#3](https://github.com/SlyWombat/case-maker/issues/3) — silent install path). The packaged `.exe` accepts `casemaker_setup.exe /PORT=9000` (works alongside `/S` for unattended deployment) and writes the chosen port to `%APPDATA%\casemaker\config.json` before first launch. Hook implemented at `src-tauri/installer-hooks.nsh`. The interactive GUI port-prompt page is filed as a new issue for follow-up.

### Tests

- 83 Vitest unit tests, 31 Playwright E2E tests (114 total).

## [0.7.0] — Phase 7 partial — 2026-04-27

### Added

- **Embedded HTTP server in Tauri** (closes [#1](https://github.com/SlyWombat/case-maker/issues/1)). The desktop app now spawns an `axum` + `rust-embed` HTTP server on the configured port (default 8000); the Tauri window navigates to `http://127.0.0.1:PORT`. Falls back to an OS-ephemeral port if the configured one is taken. New CLI flags (`--bind-all`, `--port N`, `--print-config`).
- **LAN access** via `--bind-all` rebinds the embedded server to `0.0.0.0`. Off by default; only enable on trusted networks.
- **Documentation suite** (closes [#5](https://github.com/SlyWombat/case-maker/issues/5)) — Getting Started, User Manual, Technical Reference, CHANGELOG, CONTRIBUTING.
- **In-app docs viewer** — toolbar `📖 Docs` button opens a modal with sidebar navigation between docs; markdown rendered with `marked`. Works offline in both web and desktop builds.
- New Rust modules `src-tauri/src/{config,server}.rs` with inline unit tests.

### Changed

- CSP in `tauri.conf.json` widened across `default-src` / `img-src` / `script-src` / `connect-src` to allow `http://localhost:*` and `http://127.0.0.1:*`.
- Bundle main code grew from ~53 KB to ~132 KB (the docs strings ride along in the main chunk).

### Tests

- 76 Vitest unit tests, 29 Playwright E2E tests (105 total).
- 87.4% line coverage in Vitest; effective E2E coverage substantially higher (Playwright drives the full pipeline including stores and workers).

## [0.6.0] — Phase 6 — 2026-04-27

### Added

- **STL ASCII export** alongside binary STL and 3MF. ExportPanel now offers three buttons.
- **Bundle code-splitting** — initial app code drops from 1.2 MB to ~53 KB. Three.js, drei, R3F, manifold-3d, react/react-dom, zustand+zundo+immer, and zod are split into separate vendor chunks.
- **Component editor coordinate inputs** — position xyz and size xyz NumInputs replace the read-only summary in the custom-board component editor.
- **Selectable port markers** in the 3D viewport. Click a marker (or the matching sidebar row) to select; selected port gains a drei `PivotControls` translate gizmo whose drag updates `port.position`.
- **App settings panel** with configurable port (default `8000`, range 1024–65535) and `bindToAll` flag for LAN access. Persisted to `localStorage` under `casemaker.settings.v1`.

### Changed

- **Default app port** changed from `5173` to `8000` across `vite.config.ts`, `playwright.config.ts`, and `tauri.conf.json`.
- Playwright workers reduced from 4 to 1 to dodge dev-server `optimizeDeps` reload races on the larger test surface.

### Tests

- 70 Vitest unit tests, 27 Playwright E2E tests (97 total).

## [0.5.0] — Phase 5 — 2026-04-26

### Added

- **STL/3MF subtract/union pipeline** — `BuildPlan` grew `mesh` and `scale` op kinds; `collectMeshTransferables` enumerates ArrayBuffers for Comlink zero-copy transfer.
- **3MF asset import** — `threeMfParser.ts` (fflate + regex on the unzipped XML, multi-object accumulation).
- **ASCII STL parser** with auto-format detection.
- **Component editor UI** in `BoardEditorPanel` — table of components with kind+facing dropdowns; component edits propagate to matching auto-generated ports.
- **Real screw-down lid** — `buildScrewDownLid` subtracts corner holes sized by `getScrewClearanceDiameter(insertType)`; bosses extend to `floor + cavityZ` when joint = screw-down.
- **Diagnostics surface** — `getLastDiag()` and `getJobError()` test API methods (Playwright doesn't reliably capture Web Worker console logs).

### Tests

- 62 Vitest unit tests, 21 Playwright E2E tests (83 total).

## [0.4.0] — Phase 4 — 2026-04-26

### Added

- **Custom-board editor** — clone-built-in-then-edit pattern in `BoardEditorPanel.tsx`. Built-in profiles stay read-only; cloning flips `builtin=false` and unlocks PCB dimension and mounting-hole editing.
- **External binary-STL import** — `AssetsPanel` → `ExternalAssetMeshes` renders reference-visibility assets in the scene.
- **Heat-set insert variants** — `resolveInsertSpec` in `bosses.ts` (self-tap=2.5, heat-set-m2.5=3.6, heat-set-m3=4.2, pass-through=3.2; auto-grows outerDiameter to ≥ hole + 2 mm).
- **Hex ventilation pattern** — triangular grid of 6-sided cylinders rotated normal-to-wall.

### Tests

- 42 Vitest unit tests, 19 Playwright E2E tests (61 total).

## [0.3.0] — Phase 3 — 2026-04-26

### Added

- **Four joint types** — `flat-lid`, `snap-fit`, `sliding`, `screw-down` (the latter aliased to flat-lid until Phase 5).
  - **Snap-fit:** lid + downward lip ring (`SNAP_FRICTION=0.2`, `SNAP_LIP_DEPTH=4`).
  - **Sliding:** lid Y-inset by 4 mm, two `slidingRails.ts` rails on +y/-y inner walls.
- **Ventilation slots** through the +y wall, driven by a 0–1 coverage slider.
- **Project save/load** to `.caseproj.json` via `store/persistence.ts` + `store/projectSchema.ts` (zod, schemaVersion=1 enforced).
- **Undo/redo** via zundo temporal middleware (50-state limit, project-only). Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z shortcuts (suppressed inside form inputs).

### Tests

- 26 Vitest unit tests, 16 Playwright E2E tests (42 total).

## [0.2.0] — Phase 2 — 2026-04-26

### Added

- **5 built-in board profiles** — Pi 4B, Pi 5, Pi Zero 2W, Arduino Uno R3, ESP32 DevKit V1. Each schema-validated with a required datasheet `source` URL.
- **Automatic port cutouts** — `src/engine/compiler/ports.ts` + `portFactory.ts`. Cutouts auto-generated from `board.components`. Per-port enable/disable toggle in `PortsPanel`.
- **Tauri 2 desktop wrapper** in `src-tauri/`.
- **Windows installer CI** — `.github/workflows/windows-installer.yml` builds MSI + NSIS bundles on `windows-latest`.

### Tests

- 19 Vitest unit tests, 11 Playwright E2E tests (30 total).

## [0.1.0] — Phase 1 MVP — 2026-04-26

### Added

- Pi 4B parametric tray with mounting bosses + flat lid.
- STL and 3MF export via dedicated worker.
- Manifold WASM CSG running in a Web Worker with cancellation via generation counter.
- `window.__caseMaker` test API (apiVersion 1).
- Z-up mm-units coordinate frame.
- CI workflows for unit + E2E testing.

### Tests

- 14 Vitest unit tests, 5 Playwright E2E tests (19 total).
