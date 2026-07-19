# Getting Started

A 10-minute walkthrough from zero to "enclosure STL on disk."

## 0. The fast path — no install at all

Case Maker runs entirely in the browser: **<https://electricrv.ca/casemaker>**.

1. On the **Start a New Project** screen, search for your board (29 built-ins,
   plus anything you import or enable from an online source).
2. Click a card to see its specs, connector inventory, and provenance in the
   detail rail. Boards marked **★** have a curated quickstart recipe.
3. Click **★ Create from quickstart** (or **Blank shell**) — the case
   generates around the board's real connector and mounting-hole geometry.
4. Tweak parameters, then **Export → STL** and slice.

Board not in the library? **Import board JSON** on the same screen, or open
**Sources** and add the community library. To author your own profile, point
Claude Code at the
[community library's AGENT.md](https://github.com/SlyWombat/casemaker-library/blob/main/AGENT.md)
and it will walk you through measuring, authoring, testing, and publishing it.

The rest of this guide covers running the app from source.

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
2. The **board picker** greets you: search "rpi-4b" and click the Raspberry
   Pi 4B card, then **★ Create from quickstart**.
3. Drag the **Wall thickness** slider (sidebar → Case parameters) from
   2mm → 3mm — the case rebuilds in ~50ms.
4. Toggle individual ports under **Port cutouts** to see USB/HDMI cutouts
   disappear and reappear.
5. Under **Case parameters → Joint**, select **Snap-fit** — snap catches
   populate automatically.
6. Open **Export** and click **STL (binary)**. Save to disk.
7. Drag the file into your slicer of choice. PrusaSlicer / Bambu / OrcaSlicer / Cura all open it. The model is in mm, Z-up — no rotation required.
8. Slice with default 0.2mm layer height. Print. Confirm a real Pi 4B fits the bosses.

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
