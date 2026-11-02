# For developers

Building Case Maker from source: the dependencies, the dev loop, the test suites, and the desktop
build. If you only want to *use* the app, see **Getting Started** instead — this page is for
working on the app itself.

## Dependencies

| Tool | Required version | Why |
| --- | --- | --- |
| Node.js | 22.12+ (24 LTS recommended) | Vite 8 + Vitest 4 |
| npm | bundled with Node 22.12+ | install / run scripts |
| A modern browser | Chrome, Edge, Firefox, Safari | runtime (WebGL2 + WebAssembly) |
| (optional) Rust toolchain | stable, ≥ 1.90 | required only to build the **desktop** app via Tauri |

> **Note:** Case Maker has **no Python, no OpenSCAD, no slicer dependency**. Everything runs in the browser via Three.js + Manifold WASM. A slicer (PrusaSlicer / Bambu / OrcaSlicer / Cura) is needed only to print the STL/3MF you export.

## Install

```bash
git clone https://github.com/SlyWombat/CaseMaker.git
cd CaseMaker/casemaker-app
npm ci
```

The `npm ci` step downloads Three.js, Manifold-3d, React, Vite, Playwright, Tauri CLI, and dev dependencies (~700 packages, ~250MB on disk).

## First render

```bash
npm run dev
```

1. Open <http://localhost:5173> in your browser (Vite's default; set `CASEMAKER_PORT` to use a
   different one).
2. The **board picker** greets you: search "rpi-4b" and click the Raspberry
   Pi 4B card, then **★ Create from quickstart**.
3. Drag the **Wall thickness** slider (sidebar → Case parameters) from
   2mm → 3mm — the case rebuilds in ~50ms.
4. Toggle individual ports under **Port cutouts** to see USB/HDMI cutouts
   disappear and reappear.
5. Under **Case parameters → Joint type**, select **Snap-fit** — snap catches
   populate automatically.
6. Open **Export** and click **STL (ASCII)** (the default). Save to disk.
7. Drag the file into your slicer of choice. PrusaSlicer / Bambu / OrcaSlicer / Cura all open it. The model is in mm, Z-up — no rotation required.
8. Slice with default 0.2mm layer height. Print. Confirm a real Pi 4B fits the bosses.

If anything went wrong, see [Troubleshooting](#troubleshooting) below.

## Run the test suites

```bash
npm test                 # Vitest unit tests (9k+ tests, about 11-13 min)
npm run test:e2e         # Playwright E2E (about 242 tests, about 20 min, requires Chromium)
npm run typecheck        # TypeScript --noEmit
npm run lint             # ESLint
```

The Playwright suite spins up its own dev server on a port derived from the checkout's own path
(5300-5399), so two worktrees' runs rarely collide; `CASEMAKER_PORT` overrides it if you need a
specific port. There's no `VITE_PORT` — that's not read anywhere in this project. The **App port**
in Settings is a different thing again: it's the desktop build's own embedded server (default
**8000**), not the dev server.

## Build the production bundle

```bash
npm run build            # outputs to casemaker-app/dist/
npm run preview          # serves the bundle on http://localhost:5173 (or CASEMAKER_PORT)
```

## Build the desktop app (optional)

Requires the Rust toolchain. On Linux:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env
npm run tauri:build      # produces the Windows NSIS installer (.exe)
```

That's the only bundle target configured by default. A Linux `.deb` needs an explicit
`npm run tauri:build -- --bundles deb`; there's no `.dmg` or `.AppImage` target set up.

If you don't have Rust locally, the **Windows installer** GitHub Actions workflow builds one from a tag or a manual run.

## Driving a job from the command line

Case Maker's CLI (`npm run casemaker --`) opens a saved project or job and runs the same compiler
and exporter the app uses, headless — useful for scripted builds or regression-checking a change
without opening a browser:

```bash
npm run casemaker -- export path/to/project.caseproj.json --out /tmp/casemaker-sample
```

The CNC side has an equivalent `simulate` / `post` path; see the CNC Guide's command-line section
for the full list of subcommands and what each one writes.

## Troubleshooting

> **Note:** Most issues are caught by `npm run typecheck` and the test suites. Run those first.

- **`npm install` fails on WSL with `sharp` ENOENT** — your project lives under `/mnt/c/...` (a Windows-mounted drive). Move the working copy into your Linux home (`~/casemaker-app`) and reinstall.
- **`Module not found: manifold-3d/manifold.wasm?url`** — you skipped `vite-plugin-wasm`. Reinstall dev deps.
- **Worker silently fails after editing `ProjectCompiler.ts`** — open `window.__caseMaker.getJobError()` and `getLastDiag()` in the browser console. A common cause is a dropped import (`buildExternalAssetOps`).
- **Port 5173 already in use** — set `CASEMAKER_PORT=5174 npm run dev`. (The **App port** in
  Settings is the desktop server's own port, 8000 by default, and is separate from this.)

## Next steps

- [User Manual](https://github.com/SlyWombat/CaseMaker/blob/main/casemaker-app/src/docs/user-manual.md) — what the app makes, worked examples, every parameter
- [Technical Reference](https://github.com/SlyWombat/CaseMaker/blob/main/casemaker-app/src/docs/technical-reference.md) — module API, coordinate system, adding new boards
- [CHANGELOG](https://github.com/SlyWombat/CaseMaker/blob/main/CHANGELOG.md) — what shipped in each phase
- [CONTRIBUTING](https://github.com/SlyWombat/CaseMaker/blob/main/CONTRIBUTING.md) — how to add a board profile or fix a bug
