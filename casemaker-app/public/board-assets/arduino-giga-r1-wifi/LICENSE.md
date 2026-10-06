# Arduino GIGA R1 WiFi — visual asset licence

**Verdict: CLEARED for the CAD files; the STEP model is NOT CLEARED**
**Researched: 2026-10-06**

| | |
|---|---|
| Asset | Official CAD archive (Altium: `PCB.PcbDoc`, `*.SchDoc`) — CC BY-SA 4.0. A STEP model is published alongside it but carries no licence. |
| Asset URL | CAD: https://docs.arduino.cc/static/5927a4ebbe3f363ebd68e7c50de5e0af/ABX00063-cad-files.zip · STEP: https://docs.arduino.cc/resources/models/ABX00063-step.zip (both linked from https://docs.arduino.cc/hardware/giga-r1-wifi) |
| Licence | CC BY-SA 4.0 (CAD files) · none stated (STEP) |
| Clause read at | `License.txt` inside the CAD archive (downloaded and extracted 2026-10-06) |

## The clause

The CAD archive ships its own `License.txt` — byte-identical to the Uno's — and its entire text is:

> "This project's hardware is licensed under the Creative Commons Attribution-ShareAlike 4.0 International License. To view a copy of this license, visit https://creativecommons.org/licenses/by-sa/4.0/deed.en"

The STEP archive contains **only** `GIGA_R1_WIFI.step` — no `License.txt`, no readme. There is no clause to quote for it.

## Why

The design files are clearly redistributable. The STEP model is the awkward case: Arduino publishes it on the official page right next to the CC BY-SA files, but nothing attached to it grants or forbids redistribution, so its status is implied by association rather than stated. Recorded as separate verdicts rather than assuming the STEP inherits the CAD licence.

Practically, the same two routes as [[arduino-uno-r3]] are open without touching the STEP: ship official product photography (Arduino's site texts and photos are CC BY-SA 4.0 per https://www.arduino.cc/en/trademark), or derive a GLB from the CC BY-SA Altium files. Both stay CC BY-SA 4.0. If the STEP specifically is wanted, ask Arduino to confirm its licence, or check whether a later archive gains a notice — the same pattern that cleared [[rpi-5]].

Trademarks remain excluded: "Arduino and the Arduino logo are trademarks or registered trademarks of Arduino S.r.l."

## Attribution to ship

`CC BY-SA 4.0 — © Arduino` with a link to the licence and the source URL. A GLB derived from the design files, or a bundled photo, **remains CC BY-SA 4.0**; the rest of Case Maker stays MIT.
