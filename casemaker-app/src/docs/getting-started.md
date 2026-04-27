# Getting Started

A 10-minute walkthrough that gets you from "freshly cloned repo" to "Pi 4B enclosure STL on disk."

## 1. Dependencies

| Tool | Required version | Why |
| --- | --- | --- |
| Node.js | 20 or 22 | Vite 8 + Vitest 4 |
| npm | bundled with Node | install / run scripts |
| A modern browser | Chrome, Edge, Firefox, Safari | runtime (WebGL2 + WebAssembly) |
| (optional) Rust toolchain | stable, ≥ 1.75 | required only to build the **desktop** app via Tauri |

> **Note:** Case Maker has **no Python, no OpenSCAD, no slicer dependency**. Everything runs in the browser via Three.js + Manifold WASM. A slicer (PrusaSlicer / Bambu / OrcaSlicer / Cura) is needed only to print the STL/3MF you export.

## 2. Install

```bash
git clone https://github.com/SlyWombat/case-maker.git
cd case-maker/casemaker-app
npm ci
```

The `npm ci` step downloads Three.js, Manifold-3d, React, Vite, Playwright, Tauri CLI, and dev dependencies (~700 packages, ~250MB on disk).

## 3. First render

```bash
npm run dev
```

1. Open <http://localhost:8000> in your browser.
2. The viewport boots with a Raspberry Pi 4B tray (the default project).
3. Drag the **Wall thickness** slider in the sidebar from 2mm → 3mm — the case rebuilds in ~50ms.
4. Open the **Board** dropdown and switch to `rpi-5`. Bbox grows; the lid lifts to expose the new shell.
5. Toggle individual ports under **Port cutouts** to see USB/HDMI cutouts disappear and reappear.
6. In the **Joint type** radio, select **Snap-fit** — the lid grows a downward lip ring.
7. Open **Export** and click **STL (binary)**. Save to disk.
8. Drag the file into your slicer of choice. PrusaSlicer / Bambu / OrcaSlicer / Cura will all open it. The model is in mm, Z-up — no rotation required.
9. Slice with default 0.2mm layer height. Print. Confirm a real Pi 4B fits the bosses.

If anything went wrong, see [Troubleshooting](#troubleshooting) below.

## 4. Run the test suites

```bash
npm test                 # Vitest unit tests (~1.5s)
npm run test:e2e         # Playwright E2E (~60s, requires Chromium)
npm run typecheck        # TypeScript --noEmit
npm run lint             # ESLint
```

The Playwright suite spins up the Vite dev server on port 8000 automatically. If port 8000 is taken, set `VITE_PORT=8001 npm run test:e2e` (or change [`vite.config.ts`](../casemaker-app/vite.config.ts)).

## 5. Build the production bundle

```bash
npm run build            # outputs to casemaker-app/dist/
npm run preview          # serves the bundle on http://localhost:8000
```

## 6. Build the desktop app (optional)

Requires the Rust toolchain. On Linux:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env
npm run tauri:build      # produces .msi / .exe / .deb / .AppImage / .dmg per OS
```

If you don't have Rust locally, push to `main` and grab the Windows installer from the **Windows installer** GitHub Actions workflow artifacts.

## Troubleshooting

> **Note:** Most issues are caught by `npm run typecheck` and the test suites. Run those first.

- **`npm install` fails on WSL with `sharp` ENOENT** — your project lives under `/mnt/c/...` (a Windows-mounted drive). Move the working copy into your Linux home (`~/casemaker-app`) and reinstall.
- **`Module not found: manifold-3d/manifold.wasm?url`** — you skipped `vite-plugin-wasm`. Reinstall dev deps.
- **Worker silently fails after editing `ProjectCompiler.ts`** — open `window.__caseMaker.getJobError()` and `getLastDiag()` in the browser console. A common cause is a dropped import (`buildExternalAssetOps`).
- **Port 8000 already in use** — set `VITE_PORT=8001 npm run dev`, or change the port in **Settings** in the UI.

## Next steps

- [User Manual](user-manual.md) — every parameter, every joint type
- [Technical Reference](technical-reference.md) — module API, coordinate system, adding new boards
- [CHANGELOG](../CHANGELOG.md) — what shipped in each phase
- [CONTRIBUTING](../CONTRIBUTING.md) — how to add a board profile or fix a bug
