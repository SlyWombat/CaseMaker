# Changelog

All notable changes to Case Maker. The project follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

> **Note:** Until 1.0.0, parameter shapes are not API-stable. The `.caseproj.json` schema is versioned (`schemaVersion: 1`) and load-validated; old projects are rejected with a clear error rather than silently misinterpreted.

## [Unreleased]

Phase 7 work-in-progress. See open issues:

- [#1](https://github.com/SlyWombat/case-maker/issues/1) Embed HTTP server in Tauri (lands as part of Phase 7 — gives the port setting end-to-end meaning).
- [#2](https://github.com/SlyWombat/case-maker/issues/2) Snap-fit physical print validation loop.
- [#3](https://github.com/SlyWombat/case-maker/issues/3) NSIS installer custom port page.
- [#4](https://github.com/SlyWombat/case-maker/issues/4) Advanced drag-handle UX (axis-lock, snap-grid, delta readout).

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
