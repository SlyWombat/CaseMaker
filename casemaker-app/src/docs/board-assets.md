# Board Visual Assets

Per-board status of bundled 3D models / photos used by the **Board: photo / 3D** viewport mode (issue [#24](https://github.com/SlyWombat/case-maker/issues/24)). When `boardVisualization` is `schematic` (default) the viewport renders a synthesised placeholder built from `BoardProfile.pcb.size` + per-component bounding boxes (`engine/scene/boardPlaceholder.ts`) — green PCB, mounting-hole rings, and one coloured block per `BoardComponent`. This path is always available for every board and is the cutout-driving authority. The `photo` and `3d` modes are purely informational; when their assets are missing the viewport silently falls back to the schematic placeholder.

Authoritative geometry sources for hand-validating board / HAT JSONs live under `samples/cad-references/` (KiCad templates + Raspberry Pi HAT mechanical PDFs).

## Asset acquisition priority

For each board, find the most authoritative artifact in this order:

1. STEP / KiCad / OpenSCAD model from the manufacturer.
2. glTF / GLB if available from the manufacturer or an official partner.
3. PNG top-view + side-view as a textured fallback.

Store under `public/board-assets/<board-id>/{model.glb,top.png,side.png,LICENSE.md}`. The `LICENSE.md` MUST name the source URL and the redistribution terms (CC-BY-SA, manufacturer's redistribution clause, etc.). Never bundle non-redistributable assets.

A `LICENSE.md` sitting alone, with no model or image beside it, is not a mistake — it records a
verdict of *no* or *not cleared*, and is what stops that verdict being re-researched. Every board in
the table below has one.

The `visualAssets` schema enforces this: a `glb`, `topImage` or `sideImage` present without both `license` and `sourceUrl` fails validation, which rejects the board at load (built-ins at import, community boards on import) and fails CI via `npm test`. Community boards may point at absolute asset URLs instead of `public/` paths.

## Per-board status

All twelve boards were researched on **2026-10-06**, and every verdict — including every "no" — is
recorded with the clause that decides it, its source URL, and the date read, in
`public/board-assets/<board-id>/LICENSE.md`. An unrecorded "no" gets re-researched by the next
person, so a negative row here is a result, not a gap.

| Board ID | Verdict | Licence that decides it | What we could ship |
|---|---|---|---|
| `rpi-5` | **cleared** | MIT — © 2026 Raspberry Pi Ltd (shipped in the archive) | Official STEP → convert to GLB. |
| `m5stack-core2` | **cleared** | MIT — © 2021 M5Stack | Official `Core2.stl` → convert to GLB. |
| `arduino-uno-r3` | **cleared** (design files) | CC BY-SA 4.0 (shipped in the archive) | No official 3D model; official photo, or a GLB derived from the EAGLE files. Stays CC BY-SA. |
| `arduino-giga-r1-wifi` | CAD cleared; **STEP not** | CC BY-SA 4.0 (CAD) · none stated (STEP) | Same as the Uno; the published STEP carries no notice, so hold on that file. |
| `beaglebone-black` | design files cleared | CC BY-SA 3.0 (System Reference Manual) | No 3D model published — nothing to ship. |
| `microbit-v2` | schematic cleared | CC BY-SA 4.0 | No 3D model of the retail board — the reference design is a *different* board. |
| `rpi-pico` | **not cleared** | none — the STEP archive ships no notice | Hold. Raspberry Pi's newer packages (Pi 5, Pico 2) do ship an MIT `LICENSE.txt`; re-check. |
| `jetson-nano-b01` | **not cleared** | unreadable — gated behind an NVIDIA account | Hold. Docs/files sit in the Jetson Download Center; no grant is published outside it. |
| `rpi-4b` | no asset | CC BY-ND 4.0 (drawings) | No STEP is published; the drawing is NoDerivatives, so it cannot become an image or a GLB. |
| `rpi-zero-2w` | no asset | CC BY-ND 4.0 (drawings) | Same as the 4B. |
| `esp32-devkit-v1` | no asset | — (maker reserves all rights; publishes nothing) | DOIT clone: hand-model it, or ship the synthesised placeholder. |
| `teensy-41` | no asset | none stated | PJRC publishes no CAD; only forum-contributed models exist. |

**What is shippable today:** two boards with a manufacturer model and a clear licence
(`rpi-5`, `m5stack-core2`) plus two with official photography under CC BY-SA (`arduino-uno-r3`,
`arduino-giga-r1-wifi`). Nothing is bundled yet — see "Adding assets for a new board" below.

Two rows are deliberately unresolved rather than refused: `rpi-pico` and `jetson-nano-b01` are held
because the terms could not be read, not because they forbid us. If either clearance is obtained, its
record flips and the asset ships with the same gate as everything else.

## How the toggle works

1. Open the toolbar **Board: schematic / photo / 3D** button.
2. Click cycles the mode.
3. Mode persists to `localStorage` (`casemaker.viewport.boardVisualization`).
4. When `photo` or `3d` is selected and the current `BoardProfile` has no matching asset, the viewport falls back to schematic and shows a one-line note in the diagnostics panel.

## Adding assets for a new board

The clearance comes first and is recorded whether the answer is yes or no — an unrecorded "no" is
re-researched by the next person.

1. **Read the terms, don't assume them.** Find the clause that actually permits or forbids
   redistribution — the sentence itself, not a summary of the page — and record it in
   `public/board-assets/<id>/LICENSE.md` with its source URL and the date read. For a bundled
   archive the licence is often *inside* the download: the Raspberry Pi and Arduino STEP/CAD
   packages both ship their own `LICENSE.txt`, which is stronger evidence than any web page.
2. Place files under `public/board-assets/<id>/`.
3. Add `visualAssets` to the JSON profile:
   ```json
   "visualAssets": {
     "glb": "/board-assets/rpi-4b/model.glb",
     "topImage": "/board-assets/rpi-4b/top.png",
     "license": "CC-BY-SA-4.0",
     "sourceUrl": "https://www.raspberrypi.com/..."
   }
   ```
4. Update this table.
