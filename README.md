# Case Maker

A web-based Single Page Application for designing custom 3D-printable enclosures for microcontrollers and single-board computers (ESP32, Arduino, Raspberry Pi, custom boards). Generates production-ready STL and 3MF files for slicers — fully client-side, no backend. Also ships as a Windows desktop app.

See [docs/casemaker.md](docs/casemaker.md) for the original design brief.

## Status

**Phase 2 shipped.** Five built-in board profiles (Pi 4B, Pi 5, Pi Zero 2W, Arduino Uno R3, ESP32 DevKit V1), automatic port cutouts with per-port toggles, mounting bosses, parametric flat-lid case, STL + 3MF export. Windows desktop installer built via Tauri 2 in CI.

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
npm run dev          # Vite dev server (http://localhost:5173)
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

- 19 Vitest unit tests (compiler math, board zod schema, STL/3MF writers, port cutouts, port factory)
- 11 Playwright E2E tests (boot, board load, board swap across all 5 boards, parameter sensitivity, port cutout toggle, STL round-trip with parsed binary, 3MF round-trip with parsed XML)

## Roadmap

- **Phase 1 ✓:** Pi 4B tray + flat lid + STL/3MF export
- **Phase 2 ✓:** all 5 built-in boards, automatic port cutouts, per-port toggles, Windows installer via Tauri
- **Phase 3:** snap-fit lids, sliding lids, screw-down bosses with heat-set inserts, ventilation patterns, custom-board editor UI, external STL/3MF import, project save/load, undo/redo
