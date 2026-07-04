# Board Library Audit

Per-board status of the dimensional research backing each built-in `BoardProfile`. Tracking issue: [#22](https://github.com/SlyWombat/case-maker/issues/22).

For each entry the table records:

- **Source** — primary mechanical drawing (manufacturer datasheet or board file).
- **Cross-reference** — independent confirmation (open-source CAD, well-cited community wiki).
- **Method** — `datasheet` (transcribed from PDF), `open-source-cad` (parsed from KiCad/STEP), or `physical-measurement` (measured by hand against a reference unit).
- **Notes** — anything surprising or not matchable to the datasheet.

Initial population: only the `Source` columns reflect the JSON `source` field. The other columns are blank pending the manual audit. Once a board has been verified, fill in the other columns and add the matching fields to the JSON profile.

## Audit status

| Board ID | Source | Cross-reference | Method | Notes |
|---|---|---|---|---|
| `rpi-4b` | https://datasheets.raspberrypi.com/rpi4/raspberry-pi-4-mechanical-drawing.pdf | _pending_ | _pending_ | |
| `rpi-5` | https://datasheets.raspberrypi.com/rpi5/raspberry-pi-5-mechanical-drawing.pdf | _pending_ | _pending_ | |
| `rpi-zero-2w` | https://datasheets.raspberrypi.com/rpizero2/raspberry-pi-zero-2-w-mechanical-drawing.pdf | _pending_ | _pending_ | |
| `rpi-pico` | https://datasheets.raspberrypi.com/pico/Pico-R3-A4-Pinout.pdf | _pending_ | _pending_ | |
| `arduino-uno-r3` | https://docs.arduino.cc/resources/datasheets/A000066-datasheet.pdf | _pending_ | _pending_ | |
| `arduino-giga-r1-wifi` | https://docs.arduino.cc/resources/datasheets/ABX00063-datasheet.pdf | _pending_ | _pending_ | Antenna connector position is approximate; verify against board-edge µFL pad. |
| `esp32-devkit-v1` | https://docs.espressif.com/projects/esp-idf/en/latest/esp32/hw-reference/esp32/get-started-devkitc.html | _pending_ | _pending_ | DevKit V1 (DOIT 30-pin) — non-Espressif clone — silicon spec ≠ board spec. |
| `teensy-41` | https://www.pjrc.com/store/teensy41.html | _pending_ | _pending_ | |
| `jetson-nano-b01` | https://developer.nvidia.com/embedded/dlc/jetson-nano-developer-kit-b01-mechanical-drawing | _pending_ | _pending_ | |
| `beaglebone-black` | https://github.com/beagleboard/beaglebone-black/raw/master/SRM/BBB_SRM.pdf | _pending_ | _pending_ | |
| `microbit-v2` | https://tech.microbit.org/hardware/2-1-revision/ | _pending_ | _pending_ | |
| `m5stack-core2` | https://docs.m5stack.com/en/core/core2 | _pending_ | _pending_ | LCD active-area dims need verification. |
| `esp32-s3-touch-lcd-4.3b` | https://www.waveshare.com/wiki/ESP32-S3-Touch-LCD-4.3B | verified | 2026-07-04 | Dims from Waveshare's dimensional drawing + STEP (`ESP32-S3-Touch-LCD-4in3B_Drawing.zip`): 112.4×75.1 glass, VA 95.54×54.36 (8.43 X-border, 12.31 from terminal edge), 17.4 mm stack. NO screw holes — modelled screen-DOWN: LCD window is a `-z` (floor) cutout intrinsic to the board (appears board-alone, not just in the template); screwless snap-fit bezel case (`boardRetention: 'snap'` + `retentionShoulder: true` seat rim + snap-fit back lid). Connectors face up: **one** USB-C (-X, 34–44 mm from the +Y/top edge per the STEP `TYPE-C_16PIN-9X3X7` placement), 16-pos 3.5 mm terminal block (-Y). Seat shoulder added after a test print: internalClearance (≥1.5 mm/side) exceeded the 1.2 mm finger overhang, so the glass floated past the snaps. |

## Authoritative external references

These references are checked alongside the per-board datasheet during the audit:

- **KiCad symbol/footprint libraries** — https://gitlab.com/kicad/libraries — manufacturer-contributed PCB footprints with verified mechanical dimensions. Use the relevant `<board>.kicad_pcb` for any board where a community KiCad project exists.
- **Pi HAT+ specification (RP-008281-DS-1)** — https://pip-assets.raspberrypi.com/categories/1215-raspberry-pi-hat/documents/RP-008281-DS-1-hat-plus-specification.pdf?disposition=inline — official Raspberry Pi spec for HAT+ form factor: 65 × 56.5 mm PCB, 2.7 mm mounting holes at 3.5/49/52.5 mm offsets, 40-pin GPIO, EEPROM addressing, mechanical tolerances. Required source-of-truth for any new HAT profile that targets the standard Pi GPIO connector.
- **Arduino EAGLE / KiCad files** — https://www.arduino.cc/en/Main/ArduinoBoardUno (and equivalent product pages) — Arduino publishes board files under CC-BY-SA. Verify Uno / GIGA / Nano outlines against these.

## Process

When auditing a board:

1. Open the source datasheet and confirm:
   - PCB outline (`pcb.size`)
   - Each `mountingHoles` entry (position, diameter)
   - Each `BoardComponent` (position, size, facing)
2. Find one independent cross-reference (an open-source CAD file, an authoritative community wiki) and link it.
3. Record `datasheetRevision` (e.g., `"Rev 1.4 — 2023-08"`).
4. Update the JSON profile with the new fields.
5. Update this table with the cross-reference URL and method.

## Schema gate

`tests/unit/boardLibraryAudit.spec.ts` lists which boards have been audited. As each is verified, move it into the "audited" set and the test will assert the new fields are populated.
