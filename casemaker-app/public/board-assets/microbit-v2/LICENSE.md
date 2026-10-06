# BBC micro:bit V2 — visual asset licence

**Verdict: CLEARED for the schematic and BOM; NO ASSET for a 3D model**
**Researched: 2026-10-06**

| | |
|---|---|
| Asset | Hardware design files (`MicroBit_V2.0.0_S_schematic.PDF`, `Bill.of.Materials-BBC-microbit_V2.0.0.csv`). No STEP/GLB of the retail board. |
| Asset URL | https://github.com/microbit-foundation/microbit-v2-hardware |
| Licence | CC BY-SA 4.0 |
| Clause read at | that repository's `README.md` (fetched 2026-10-06) |

## The clause

The repository's Licensing section states:

> "These are made available under the terms of the Attribution-ShareAlike 4.0 International (CC BY-SA 4.0)."

> "The copyright holder is the Micro:bit Educational Foundation."

> "You may incorporate these files into your own products, commercial or not. You must distribute your contributions under the same license"

and, as a carve-out:

> "Trademarks (including the micro:bit logo) are licensed separately under different terms."

## Why

The **V2 hardware repository is a trap for the wrong asset.** It holds only a schematic PDF and a bill of materials — no STEP, KiCad, Altium, EAGLE or Gerber — so there is no model here to convert.

The Foundation's separate `microbit-reference-design` repository *does* publish STEP and KiCad files, but its own README says that design "uses a module and **isn't identical in size/shape to the BBC micro:bit**", and it is licensed under the Solderpad License, not CC BY-SA. It is a different board and must not be bundled as the retail V2 — which is the same substitution error flagged for [[esp32-devkit-v1]].

So: cleared to redistribute the V2 schematic/BOM, but there is no 3D or photographic asset to bundle for the picker.

## Attribution to ship

If the schematic or BOM is ever bundled: `CC BY-SA 4.0 — © Micro:bit Educational Foundation`, with a link to the licence. Do not use the micro:bit logo.
