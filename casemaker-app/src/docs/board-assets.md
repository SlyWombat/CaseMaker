# Board Visual Assets

Per-board status of bundled 3D models / photos used by the **Board: photo / 3D** viewport mode (issue [#24](https://github.com/SlyWombat/case-maker/issues/24)). When `boardVisualization` is `schematic` (default) the viewport renders a flat colored PCB plus rectangular component blocks derived from `BoardComponent` — that path is always available and is the cutout-driving authority. The other modes are purely informational; if assets are missing the viewport silently falls back to schematic.

## Asset acquisition priority

For each board, find the most authoritative artifact in this order:

1. STEP / KiCad / OpenSCAD model from the manufacturer.
2. glTF / GLB if available from the manufacturer or an official partner.
3. PNG top-view + side-view as a textured fallback.

Store under `public/board-assets/<board-id>/{model.glb,top.png,side.png,LICENSE.md}`. The `LICENSE.md` MUST name the source URL and the redistribution terms (CC-BY-SA, manufacturer's redistribution clause, etc.). Never bundle non-redistributable assets.

## Per-board status

| Board ID | License-cleared | Source | Notes |
|---|---|---|---|
| `rpi-4b` | _pending_ | https://www.raspberrypi.com/products/raspberry-pi-4-model-b/specifications/ | Raspberry Pi STEP files exist in their docs site; check Raspberry Pi Trading Ltd. T&C for redistribution. |
| `rpi-5` | _pending_ | https://www.raspberrypi.com/products/raspberry-pi-5/ | |
| `rpi-zero-2w` | _pending_ | https://www.raspberrypi.com/products/raspberry-pi-zero-2-w/ | |
| `rpi-pico` | _pending_ | https://www.raspberrypi.com/products/raspberry-pi-pico/ | |
| `arduino-uno-r3` | _pending_ | https://store.arduino.cc/products/arduino-uno-rev3 | EAGLE / KiCad files are CC-BY-SA. Convert to GLB. |
| `arduino-giga-r1-wifi` | _pending_ | https://store.arduino.cc/products/giga-r1-wifi | |
| `esp32-devkit-v1` | _pending_ | DOIT 30-pin clone — manufacturer assets unavailable; consider hand-modeling or skip |
| `teensy-41` | _pending_ | https://www.pjrc.com/store/teensy41.html | PJRC publishes mechanical drawings. |
| `jetson-nano-b01` | _pending_ | https://developer.nvidia.com/embedded/jetson-nano-developer-kit | NVIDIA carrier board — check redistribution clause. |
| `beaglebone-black` | _pending_ | https://github.com/beagleboard/beaglebone-black | Open-hardware; CAD redistributable. |
| `microbit-v2` | _pending_ | https://tech.microbit.org/hardware/2-1-revision/ | |
| `m5stack-core2` | _pending_ | https://docs.m5stack.com/en/core/core2 | M5Stack publishes glTF for some products. |

## How the toggle works

1. Open the toolbar **Board: schematic / photo / 3D** button.
2. Click cycles the mode.
3. Mode persists to `localStorage` (`casemaker.viewport.boardVisualization`).
4. When `photo` or `3d` is selected and the current `BoardProfile` has no matching asset, the viewport falls back to schematic and shows a one-line note in the diagnostics panel.

## Adding assets for a new board

1. Verify license terms — record in `public/board-assets/<id>/LICENSE.md`.
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
