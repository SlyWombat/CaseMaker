# Fine detail in printed PETG and PA-GF on the Z1 (research, 2026-10-16)

Asked after the 0.6 mm corn bit melted into a PETG blank and broke (`docs/bench/2026-10-16-single-barrel.md`).
Summary of a sourced web search; vendor speeds for Makera's own cutters are in the already-cached wiki
(`docs/market-research/raw/makera/speeds-and-feeds.txt`), not repeated here.

## Consensus
- **Burr/corn bits fail in thermoplastics.** Many tiny teeth make fine chips that can't carry heat away; the
  plastic softens, packs the teeth and re-welds. Single-flute cutters make the largest, heat-carrying chips.
  Makera lists corn bits only for PCB and carbon fibre. ([cncrouterstore](https://www.cncrouterstore.ca/pages/why-acrylic-melts-cnc),
  [toolstoday](https://global.toolstoday.com/learn/how-to-cut-acrylic-with-a-cnc),
  [Carbide 3D](https://community.carbide3d.com/t/melting-abs-with-small-end-mill/3444),
  [eMastercam](https://www.emastercam.com/forums/topic/78602-cutting-plastic/))
- **Feed first:** melting comes from rubbing; raise feed into the chip-load band before touching rpm. Corners,
  where the machine slows, are where it melts. ([Carbide 3D](https://community.carbide3d.com/t/problem-with-cutting-plastic/10399))
- **Cool the chip, not the part:** air blast helps; on the Z1 the vacuum (M331) is the chip clearing available
  (M7 is a no-op).
- **Plunge slowly melts**, worst with a V-bit — ramp or arc in, plunge at ~50–60 % of feed.
  ([Carbide 3D](https://community.carbide3d.com/t/feed-and-speed-for-v-carving-hdpe/23385/10))

## The 30° × 0.3 mm single-flute V-bit as the rest pass (PETG)
- Starting point: **12 000 rpm (the Z1's ceiling, so feed is the lever), 800 mm/min, plunge 400–500, ramp
  entry**; push towards 1000 if chips are curls, not dust or strings. Converges with Carbide 3D HDPE V-carving
  (~0.003"/tooth) and acrylic engraving recipes.
- **One pass vs step-downs — sources disagree.** Practical split: full depth in one pass where the 2 mm already
  cut the floor (the V-bit only shaves wall slivers); two step-downs (0.6 + 0.6) plus a spring pass in untouched
  narrow counters. ([Carbide 3D acrylic](https://community.carbide3d.com/t/acrylic-engraving-recipe/23605))
- **Known failure:** the tip has ~zero surface speed and can drag; a melt ball on the tip at fixed 12 k rpm is
  reported in extruded acrylic. A fresh bit matters.
  ([Snapmaker](https://forum.snapmaker.com/t/cnc-engraving-extruded-acrylic-rpm-settings/18358/1))
- **Climb vs conventional — sources conflict;** test both on scrap (a V-bit is near-symmetric).

## Geometry caveat for the two-colour reveal (arithmetic, not sourced)
A 30° V at 1.0 mm deep is ~0.84 mm wide at the surface, but only its bottom ~0.19 mm is below the 0.81 mm
colour line — the second colour shows as a **thin ~0.4 mm line with first-colour sloped walls**; at 1.2 mm it
is ~0.5 mm. **The V-bit is a liner, not a filler:** flat floors (the 2 mm pass) show full colour; V-cut detail
shows a narrower line. If the line is too thin, go deeper (≤ 1.2 over the magnet pocket), not wider.

## PETG and PA-GF specifics
- **PETG:** Tg 75–85 °C; gummy and stringy; "chips when fed too slowly and melts when run too fast" (single
  forum thread, internally disagreeing). ([Vectric forum](https://forum.vectric.com/viewtopic.php?t=23922))
- **PA-GF (glass-fibre nylon):** abrasive — carbide only, tool life 50–75 % shorter, expect the 0.3 mm tip to
  dull fast; dull edges smear nylon. Vendors split on classing it as composite or filled plastic. One study:
  conventional milling gave smaller burrs than climb. ([Ready Plastics](https://www.readyplastics.com/resources/materials/nylon/machining),
  [Harvey](https://www.harveytool.com/products/end-mills-for-composites---square---2-straight-flutes),
  [Kuram 2016](https://acikerisim.gtu.edu.tr/items/7ea4f4b9-9656-4245-9f65-824f3967036b/full))

## What to watch tomorrow
Strings wrapping the tip, a bead along groove edges, a shiny ball on the tip, haze on the floor → stop,
inspect, **raise feed** (not lower).
