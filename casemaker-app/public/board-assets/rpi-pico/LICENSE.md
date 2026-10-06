# Raspberry Pi Pico — visual asset licence

**Verdict: NOT CLEARED**
**Researched: 2026-10-06**

| | |
|---|---|
| Asset | Official 3D STEP model (`Pico-R3.step`) — the package contains no licence file |
| Asset URL | https://pip.raspberrypi.com/documents/RP-008311-DS (zip: `RP-008311-DS-1-Pico-R3-step.zip`) |
| Licence | none stated in the archive |
| Clause read at | archive contents — downloaded 2026-10-06; `Pico-R3.step` plus macOS metadata, nothing else |

## The clause

**There is none.** The Pico STEP archive ships the model and nothing that states a licence, so there is no clause to quote.

For contrast, Raspberry Pi's *newer* CAD packages do ship one — the Pico 2 package (`https://pip.raspberrypi.com/documents/RP-009061-CA`) contains a `LICENSE.txt` reading "This 3D model is provided under the MIT license included at the end of this file." with "Copyright (c) 2025 Raspberry Pi Ltd". The Pi 5 package does the same with 2026. The Pico 1 package predates that practice.

Raspberry Pi's licensing page (https://www.raspberrypi.com/licensing/) says "Most of the design files released and hosted by us are made available openly, with no limitations" and grants "Permission to use, copy, modify, and/or distribute these designs for any purpose with or without fee", but it never enumerates what counts as a "design file" — nothing there names STEP files, CAD, mechanical drawings, or 3D models — so it cannot be read as covering this archive.

## Why

The intent is plainly permissive and the sibling packages prove it, but the document attached to *this* file grants nothing. Recording the gap rather than assuming the sibling's terms, so the next person re-checks instead of re-researching from scratch.

## What would clear it

Ask Raspberry Pi to attach the same `LICENSE.txt` to RP-008311-DS, or confirm on the record that the design-file clause covers the STEP packages. Re-check the download periodically — if the archive gains a `LICENSE.txt`, this verdict flips to CLEARED on the same MIT terms as [[rpi-5]].
