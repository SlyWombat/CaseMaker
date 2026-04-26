# Case Maker

A web-based Single Page Application for designing custom 3D-printable enclosures for microcontrollers and single-board computers (ESP32, Arduino, Raspberry Pi, custom boards). Generates production-ready STL and 3MF files for slicers — fully client-side, no backend.

See [docs/casemaker.md](docs/casemaker.md) for the original design brief.

## Status

**Phase 1 MVP shipped.** Raspberry Pi 4B parametric tray with mounting bosses and flat lid. STL + 3MF export.

## Stack

- **TypeScript (strict)** + React 19 + Vite 8
- **three.js** + `@react-three/fiber` + `@react-three/drei` — 3D viewport (Z-up coordinate frame)
- **Manifold-3d** (WASM) — CSG geometry, runs in a Web Worker
- **Zustand** + Immer — state
- **Comlink** — typed worker RPC
- **fflate** — 3MF zip writer
- **Vitest** — unit tests
- **Playwright** — E2E (with deterministic test mode + `window.__caseMaker` API)

## Layout

The app lives in [`casemaker-app/`](./casemaker-app). Architecture rule: the parametric `Project` (JSON in the store) is the single source of truth; the rendered scene is derived state, recomputed in the geometry worker on every change.

## Run

```bash
cd casemaker-app
npm ci
npm run dev          # Vite dev server
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm test             # vitest
npm run test:e2e     # playwright
npm run build        # production bundle
```

## Roadmap

- **Phase 1 (current):** Pi 4B tray + flat lid + STL/3MF export.
- **Phase 2:** all built-in boards (Pi 5, Pi Zero 2W, Arduino Uno/Nano/Giga, ESP32 DevKit/WROOM), drag-drop port cutouts, ventilation patterns, custom-board editor.
- **Phase 3:** snap-fit lids, sliding lids, screw-down bosses with heat-set inserts, external STL/3MF import, project save/load, undo/redo.
