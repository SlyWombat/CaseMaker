# Raspberry Pi 4 Model B — visual asset licence

**Verdict: NO ASSET** (no 3D model is published; the drawings cannot be turned into one)
**Researched: 2026-10-06**

| | |
|---|---|
| Asset | none usable — official mechanical drawings exist only as PDF/DXF, no STEP |
| Asset URL | https://pip.raspberrypi.com/documents/RP-008343-DS (mechanical drawings, PDF) · https://pip.raspberrypi.com/documents/RP-008342-DS (DXF) |
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

The Raspberry Pi 4 ships **no STEP file** — Raspberry Pi's own schematics-and-mechanical-drawings page (https://github.com/raspberrypi/documentation/blob/master/documentation/asciidoc/computers/raspberry-pi/raspberry-pi-schematics.adoc) lists STEP for the Pi 5 only, and probing `datasheets.raspberrypi.com/rpi4/raspberry-pi-4-step.zip` returns 404. What exists is the mechanical drawing, and the `NoDerivatives` term is the blocker: we cannot render it to a top-view image or build a GLB from it. The unmodified PDF *is* redistributable with attribution, but the picker has no field for a PDF reference and its `topImage` needs an image.

So the honest outcome is: nothing to bundle for `rpi-4b` until Raspberry Pi publishes a STEP package (as they have since for the Pi 5), at which point this becomes a straight [[rpi-5]]-style MIT clearance.

## Attribution to ship

n/a — nothing bundled. If a verbatim mechanical-drawing PDF reference is ever added as a feature, ship it unmodified with `CC BY-ND 4.0 — © Raspberry Pi Ltd` and the document URL.
