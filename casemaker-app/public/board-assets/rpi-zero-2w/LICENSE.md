# Raspberry Pi Zero 2 W — visual asset licence

**Verdict: NO ASSET** (no 3D model is published; the drawings cannot be turned into one)
**Researched: 2026-10-06**

| | |
|---|---|
| Asset | none usable — official mechanical drawings exist only as PDF, no STEP |
| Asset URL | https://pip.raspberrypi.com/documents/RP-008358-DS (mechanical drawings, PDF) |
| Licence | CC BY-ND 4.0 (the drawings) |
| Clause read at | https://www.raspberrypi.com/licensing/ |

## The clause

Under **Document licensing**, Raspberry Pi states that product documentation distributed as PDFs is

> "copyright © Raspberry Pi Ltd"

and is

> "licensed under a Creative Commons Attribution-NoDerivatives 4.0 International"

which permits you

> "to copy, distribute, and transmit the material in any medium or format for any purpose, even commercially"

but adds:

> "if you remix, transform, or build upon the material, you may not distribute the modified material."

## Why

Same finding as [[rpi-4b]]: the Zero 2 W has a mechanical drawing (PDF) and a schematic, but **no STEP package** — Raspberry Pi's mechanical-drawings page lists STEP for the Pi 5 only, and `datasheets.raspberrypi.com/rpizero2w/raspberry-pi-zero-2-w-step.zip` returns 404. The drawing is `NoDerivatives`, so it cannot become the top-view image the picker wants; the unmodified PDF is redistributable but unusable to us.

Nothing to bundle until Raspberry Pi publishes a STEP package for this board.

## Attribution to ship

n/a — nothing bundled. If a verbatim mechanical-drawing PDF reference is ever added as a feature, ship it unmodified with `CC BY-ND 4.0 — © Raspberry Pi Ltd` and the document URL.
