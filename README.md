# Case Maker

[![CI](https://github.com/SlyWombat/case-maker/actions/workflows/ci.yml/badge.svg)](https://github.com/SlyWombat/case-maker/actions/workflows/ci.yml)
[![Playwright](https://github.com/SlyWombat/case-maker/actions/workflows/playwright.yml/badge.svg)](https://github.com/SlyWombat/case-maker/actions/workflows/playwright.yml)
[![Windows installer](https://github.com/SlyWombat/case-maker/actions/workflows/windows-installer.yml/badge.svg)](https://github.com/SlyWombat/case-maker/actions/workflows/windows-installer.yml)
[![License: TBD](https://img.shields.io/badge/license-TBD-lightgrey.svg)](#license)

**Parametric 3D-printable enclosure designer** for microcontrollers and single-board computers (ESP32, Arduino, Raspberry Pi, custom boards). Generates production-ready STL and 3MF files for slicers — fully client-side, no backend. Also ships as a Windows desktop app.

> **Hero render placeholder:** drop a render at `docs/assets/hero.png` and inline it here. A high-quality preview makes the landing page sell itself.

## Key features

- **5 built-in board profiles** out of the box (Pi 4B, Pi 5, Pi Zero 2W, Arduino Uno R3, ESP32 DevKit V1) — each schema-validated against a manufacturer datasheet URL.
- **Real-time parametric editing** — every slider rebuilds the case in ~50ms via Manifold WASM CSG on a worker thread.
- **Four lid joint types:** flat lid, snap-fit (lip-ring friction fit), sliding (rail), and screw-down (M2.5 / M3 inserts).
- **Automatic port cutouts** for USB-C, USB-A, USB-B, micro-USB, HDMI, micro-HDMI, barrel jack, RJ-45, and more — per-port enable/disable.
- **Custom boards** — clone any built-in profile into an editable copy; add/remove mounting holes and components in a table editor.
- **External STL / 3MF import** with `reference` / `subtract` / `union` visibility — drop a fan grille STL, mark it `subtract`, watch it carve through the shell.
- **Project save/load** to schema-versioned `.caseproj.json` files; **undo/redo** with Ctrl+Z / Ctrl+Shift+Z.
- **STL (binary)**, **STL (ASCII)**, and **3MF** export.
- **Embedded HTTP server** in the desktop build — configurable port (default `8000`), optional LAN access via `--bind-all`.
- **Built-in docs viewer** — press 📖 Docs in the toolbar to read the full manual without leaving the app.

## Stack

- **TypeScript (strict)** + React 19 + Vite 8
- **three.js** + `@react-three/fiber` + `@react-three/drei` — 3D viewport (Z-up coordinate frame, mm units)
- **Manifold-3d** (WASM) — CSG geometry, runs in a Web Worker
- **Zustand** + Immer + zundo — state + history
- **Comlink** — typed worker RPC
- **fflate** — 3MF zip writer + 3MF asset import
- **marked** — in-app markdown rendering
- **Tauri 2** + axum + rust-embed — Windows/macOS/Linux desktop wrapper, embedded HTTP server
- **Vitest** — unit tests
- **Playwright** — E2E with deterministic test mode and `window.__caseMaker` API

## Layout

The app lives in [`casemaker-app/`](./casemaker-app). Architecture rule: the parametric `Project` (JSON in the store) is the single source of truth; the rendered scene is derived state, recomputed in the geometry worker on every change.

Documentation lives in [`docs/`](./docs):

- [Getting Started](docs/getting-started.md) — 10-minute walkthrough from clone to printed case.
- [User Manual](docs/user-manual.md) — every parameter, every joint type, every export format.
- [Technical Reference](docs/technical-reference.md) — module API, coordinate system, adding new boards.
- [Changelog](CHANGELOG.md) — phase-by-phase history.
- [Contributing](CONTRIBUTING.md) — bug-workflow + code-style guidelines.

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

## LAN access

The desktop app embeds a tiny Rust HTTP server (axum + rust-embed) that serves the SPA bundle on a configurable port (default `8000`). The Tauri window navigates to `http://127.0.0.1:PORT`. To make the UI reachable from another device on the same network:

```bash
casemaker.exe --bind-all
```

The `--bind-all` flag rebinds the embedded server to `0.0.0.0`. **Anyone on your LAN can now load the UI** — only enable on trusted networks. The actual bound port is logged at startup (and shown in the Settings panel) since it falls back to an OS-assigned port if the configured one is taken.

CLI flags:

| Flag | Effect |
| --- | --- |
| `--bind-all` | Bind to `0.0.0.0` for LAN access (default: `127.0.0.1`) |
| `--port N` | Override the configured port for this run only |
| `--print-config` | Print effective config as JSON and exit |

The port can also be set via the **App settings** panel in the UI; changes persist to `%APPDATA%/casemaker/config.json` on Windows (or `$XDG_CONFIG_HOME/casemaker/config.json` on Linux).

## Coverage

- 76 Vitest unit tests (compiler math, board zod schema, STL/3MF binary + ASCII writers, port cutouts/factory, joint compilation, persistence round-trip + version rejection, custom-board editor guards, component editor, heat-set insert resolver, screw-down geometry, hex vs slot ventilation, ASCII STL parser, 3MF round-trip parsing, external asset compilation pipeline, app settings clamping, in-app docs registry)
- 29 Playwright E2E tests (boot, board load, board swap across all 5 boards, parameter sensitivity, port cutout toggle, STL binary + ASCII round-trips, 3MF round-trip, snap-fit / sliding / screw-down lid bbox checks, ventilation cutout, project save/load round-trip, undo/redo restoration, clone-and-edit custom board, add mounting hole, STL asset import + subtract pipeline, port-marker selection, drag-handle position patch, settings port persistence + range clamp, in-app docs modal navigation + Escape close + blockquote rendering)

## Roadmap

- **Phase 1 ✓:** Pi 4B tray + flat lid + STL/3MF export
- **Phase 2 ✓:** all 5 built-in boards, automatic port cutouts, per-port toggles, Windows installer via Tauri
- **Phase 3 ✓:** snap-fit + sliding + screw-down joint types (UI selector), ventilation slots, project save/load with zod validation, undo/redo (Ctrl+Z / Ctrl+Shift+Z)
- **Phase 4 ✓:** custom-board editor UI (clone built-in → edit dims + holes), external STL import (reference visibility), heat-set insert variants with auto-sized bosses, hex ventilation pattern
- **Phase 5 ✓:** STL/3MF subtract/union geometry pipeline through the Manifold worker, 3MF asset import, ASCII STL parser with auto-format detection, component editor UI (port table for custom boards), real screw-down lid with corner holes sized by insert variant
- **Phase 6 ✓:** STL ASCII export, bundle code-splitting (initial 53KB), PCB-relative coordinate inputs, selectable port markers with PivotControls drag, app settings + configurable port (default 8000)
- **Phase 7 ✓ (this release):** embedded HTTP server in Tauri ([#1](https://github.com/SlyWombat/case-maker/issues/1)) — port setting drives a real server, optional LAN access via `--bind-all`. Documentation suite + in-app docs viewer ([#5](https://github.com/SlyWombat/case-maker/issues/5)).
- **Open issues:** [#2](https://github.com/SlyWombat/case-maker/issues/2) snap-fit physical print loop · [#3](https://github.com/SlyWombat/case-maker/issues/3) NSIS install-time port prompt · [#4](https://github.com/SlyWombat/case-maker/issues/4) advanced drag-handle UX

## License

License terms are still being finalized. Contact `dave@drscapital.com` for usage questions.
