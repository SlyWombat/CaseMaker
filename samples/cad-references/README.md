# CAD references

Authoritative geometry sources for filling in / verifying built-in board and HAT JSON profiles in `casemaker-app/src/library/`. Reference material only — none of this is bundled into the app build.

## HAT references

- `RPi_Hat_Template/` — KiCad project template for Raspberry Pi B+ HATs (devbisme).
  Source: https://github.com/devbisme/RPi_Hat_Template
- `raspberrypi-hats/` — Raspberry Pi Foundation HAT design guide, EEPROM format, and the canonical mechanical drawings (`hat-board-mechanical.pdf`, `uhat-board-mechanical.pdf`).
  Source: https://github.com/raspberrypi/hats

## Board references

One subdirectory per built-in board id, each with a `NOTES.md` describing what's bundled, the canonical upstream URLs, and license terms.

| Board id                  | Bundled contents                                       | Source quality                                                                       |
|---                        |---                                                     |---                                                                                   |
| `arduino-giga-r1-wifi`    | Datasheet PDF + full pinout PDF                        | Official, complete                                                                   |
| `arduino-uno-r3`          | Datasheet PDF + schematic PDF                          | Official, complete                                                                   |
| `beaglebone-black`        | SCH + SRM + assembly drawing PDFs                      | Open hardware, full Allegro source upstream                                          |
| `esp32-devkit-v1`         | Community KiCad symbol + footprint                     | Community-maintained (DOIT clone — verify against physical board)                    |
| `jetson-nano-b01`         | NOTES only (NVIDIA design files require account login) | Mechanical drawing in NVIDIA-account-gated zip                                       |
| `m5stack-core2`           | Schematic PDF                                          | Official; no public KiCad / Allegro source                                           |
| `microbit-v2`             | Full upstream hardware repo (V2.00 + V2.21)            | Solderpad-licensed open hardware                                                     |
| `rpi-4b`                  | Mechanical + brief + reduced-schematics PDFs           | Official, complete (full schematics not public)                                      |
| `rpi-5`                   | Mechanical + brief PDFs                                | Official; full schematics PDF available on datasheets.raspberrypi.com                |
| `rpi-pico`                | Datasheet + Allegro schematic + DSN + BRD + BOM        | Official CC-BY-4.0 — full PCB source                                                 |
| `rpi-zero-2w`             | Mechanical + brief PDFs                                | Official                                                                             |
| `teensy-41`               | Schematic PNG + dimensions HTML                        | Official; PJRC has never released KiCad / Eagle source (Pads-only layout)            |

## Use

When updating a JSON profile in `casemaker-app/src/library/boards/`, cross-check `pcb.size`, `mountingHoles`, and component positions against the bundled reference. Cite the directory URL in the JSON's `crossReference` field (already wired for all 12 built-in boards).

## License

Each board / HAT subdirectory carries its own `LICENSE` (or `LICENCE` / `LICENSE.txt`) from upstream, plus a `NOTES.md` that summarises terms. Don't copy non-redistributable assets into `casemaker-app/public/`.

## Adding more references

Drop additional manufacturer KiCad / STEP / OpenSCAD trees under `boards/<board-id>/` or `RPi_Hat_Template/`-style at the top level. Keep upstream `LICENSE` files intact and add a `NOTES.md` summarising the canonical URL and bundled subset.
