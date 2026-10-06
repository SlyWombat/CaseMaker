# ESP32 DevKit V1 (DOIT 30-pin) — visual asset licence

**Verdict: NO ASSET** — no manufacturer asset exists; hand-model or ship the generic placeholder
**Researched: 2026-10-06**

| | |
|---|---|
| Asset | none |
| Asset URL | n/a |
| Licence | n/a — DOIT reserves all rights and publishes no CAD |
| Clause read at | http://www.doit.am/ (checked 2026-10-06) |

## The clause

There is no licence to quote because there is no asset. The only rights statement on the maker's site is a blanket, all-rights-reserved notice:

> "Copyright © 2026 Shenzhen DOIT (Sibo Zhilian) Technology Co., Ltd. All Rights Reserved."

There is no downloads page, no resources section, and no CAD, STEP or 3D model of the 30-pin DevKit V1 anywhere on it.

Espressif does not cover this board either. Their KiCad 3D library (https://github.com/espressif/kicad-libraries) holds **module and chip** shapes — WROOM/WROVER/MINI/SOLO — and no devkit *board* model; their `esp-dev-kits` repository carries documentation, schematics and firmware only.

## Why

This board is a clone, so the usual "go to the manufacturer" route has no manufacturer to go to. Recorded as a deliberate verdict rather than left as an unanswered pending row: the honest outcomes are **hand-model it** or **ship the synthesised schematic placeholder**, and both are fine — the placeholder is already the cutout-driving authority for every board.

**Do not substitute Espressif's ESP32-DevKitC.** It is a different board (38-pin, different width and pin pitch) and a different reference design; using its model here would put a wrong shape in the picker under this board's name. Espressif's library has no DevKitC board model either, so the risk is a third-party STEP pulled from elsewhere and mislabelled — worth guarding against by name.

Third-party repositories (SnapEDA, GrabCAD, aggregators) exist for this board but are either click-through proprietary, paid, or explicitly self-described drafts with known dimension errors; none is a manufacturer asset we could record a licence for.

## Attribution to ship

n/a — nothing bundled.
