# Case Maker

A web-based Single Page Application for designing custom 3D-printable enclosures for microcontrollers and single-board computers (ESP32, Arduino, Raspberry Pi, custom boards). Generates production-ready STL and 3MF files for slicers — fully client-side, no backend. Also ships as a Windows desktop app.

See [docs/casemaker.md](docs/casemaker.md) for the original design brief.

## Status

**Phase 6 shipped.** STL ASCII export option, code-split bundle (~53KB initial app code, three.js / drei / r3f / manifold split into separate vendor chunks), PCB-relative coordinate inputs in the component editor, selectable port markers with PivotControls drag handles in the 3D viewport, app settings panel with configurable port (default 8000) plus LAN-bind option. Default app port changed from 5173 → 8000 across Vite, Playwright, and Tauri.

## Stack

- **TypeScript (strict)** + React 19 + Vite 8
- **three.js** + `@react-three/fiber` + `@react-three/drei` — 3D viewport (Z-up coordinate frame)
- **Manifold-3d** (WASM) — CSG geometry, runs in a Web Worker
- **Zustand** + Immer — state
- **Comlink** — typed worker RPC
- **fflate** — 3MF zip writer
- **Tauri 2** — Windows/macOS/Linux desktop wrapper (~5MB installer, uses Windows WebView2)
- **Vitest** — unit tests
- **Playwright** — E2E with deterministic test mode and `window.__caseMaker` API

## Layout

The app lives in [`casemaker-app/`](./casemaker-app). Architecture rule: the parametric `Project` (JSON in the store) is the single source of truth; the rendered scene is derived state, recomputed in the geometry worker on every change.

## Run

```bash
cd casemaker-app
npm ci
npm run dev          # Vite dev server (http://localhost:8000)
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm test             # vitest unit tests
npm run test:e2e     # playwright E2E
npm run build        # production web bundle
npm run tauri:dev    # desktop app dev (requires Rust toolchain)
npm run tauri:build  # native installer (requires Rust toolchain)
```

## Windows installer

Don't have Rust locally? Push to `main` (or trigger the workflow manually) and grab the `.msi` / `.exe` from the **Windows installer** workflow's artifacts on GitHub Actions.

## Coverage

- 70 Vitest unit tests (compiler math, board zod schema, STL/3MF binary + ASCII writers, port cutouts/factory, joint compilation, persistence round-trip + version rejection, custom-board editor guards, component editor, heat-set insert resolver, screw-down geometry, hex vs slot ventilation, ASCII STL parser, 3MF round-trip parsing, external asset compilation pipeline, app settings clamping)
- 27 Playwright E2E tests (boot, board load, board swap across all 5 boards, parameter sensitivity, port cutout toggle, STL binary + ASCII round-trips, 3MF round-trip, snap-fit / sliding / screw-down lid bbox checks, ventilation cutout, project save/load round-trip, undo/redo restoration, clone-and-edit custom board, add mounting hole, STL asset import + subtract pipeline, port-marker selection, drag-handle position patch, settings port persistence + range clamp)

## Roadmap

- **Phase 1 ✓:** Pi 4B tray + flat lid + STL/3MF export
- **Phase 2 ✓:** all 5 built-in boards, automatic port cutouts, per-port toggles, Windows installer via Tauri
- **Phase 3 ✓:** snap-fit + sliding + screw-down joint types (UI selector), ventilation slots, project save/load with zod validation, undo/redo (Ctrl+Z / Ctrl+Shift+Z)
- **Phase 4 ✓:** custom-board editor UI (clone built-in → edit dims + holes), external STL import (reference visibility), heat-set insert variants with auto-sized bosses, hex ventilation pattern
- **Phase 5 ✓:** STL/3MF subtract/union geometry pipeline through the Manifold worker, 3MF asset import, ASCII STL parser with auto-format detection, component editor UI (port table for custom boards), real screw-down lid with corner holes sized by insert variant
- **Phase 6 ✓:** STL ASCII export, bundle code-splitting (initial 53KB), PCB-relative coordinate inputs, selectable port markers with PivotControls drag, app settings + configurable port (default 8000)
- **Phase 7 (deferred to issues):** [embedded HTTP server](https://github.com/SlyWombat/case-maker/issues/1) so the port setting drives a real server, [snap-fit physical print loop](https://github.com/SlyWombat/case-maker/issues/2), [NSIS installer custom port page](https://github.com/SlyWombat/case-maker/issues/3), [advanced drag-handle UX](https://github.com/SlyWombat/case-maker/issues/4)
