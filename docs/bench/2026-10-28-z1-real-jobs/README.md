# Z1 demo jobs, cut for real (2026-10-28)

This run replaces `docs/bench/2026-10-27-z1-typical-jobs/` as the record of whether Case Maker can make the 18 typical jobs. That run counted "a program was written and passed its own simulation" as success, and most of its inputs were stand-ins that did not resemble the parts. In this run, each job models the part in the maker's photo or file. Every card was then compared by eye with that photo.

- Main **ce5fdbc3**, `casemaker cut <job> --json --location <house location>` (one cutter per job file: #733).
- Location: a read-only copy of the desktop app's `location.json` (29 owned cutters, the house feed rows). No Makera catalogue is loaded on this path (#732).
- No machine was used.
- `manifest.json` holds each job's verdict, its sentence, the issues filed and every run's result.
- The page: https://claude.ai/artifact/EZ2yRActt2oECe57cYGhGc

## Verdicts

| Verdict | Jobs |
|---|---|
| Matches the photo | j03 |
| Partly | j02 (raised "Software" fuses, #739), j06 (wolf relief only 3.5 mm deep, #738) |
| Fails | j01, j04, j05, j12, j14, j15, j17 (no feeds for the material, #732); j07 (own simulation refuses the program, #738); j13 (own simulation refuses the program; a false positive of the sweep floor, #734 item 1); j08, j09 (cannot be described, #723, #743); j10, j11 (V-bit planning and inlay plug, #740, #741, #742) |
| No photo to compare | j16, j18 |

On a PLA stand-in, the Top Clamp (j01) comes out matching Makera's own program, and so do the sign (j05) and the wrench plate (j12). The coin (j04) and the keychain outline (j15) come out partly.

## Inputs not in the repository

The job files that embed them are committed **without** the bytes (`targetObject.data` removed). Rebuild them as follows:

- **j06 wolf relief:** "Wolf Relief Sculpture Wall Art" by Triple G Workshop, https://www.printables.com/model/1261158 (CC BY-NC-ND 4.0), file `wolf relief wall art stl.stl`. For the job it is scaled to 80 mm wide and to 8 mm deep (2 mm ball) or 3.5 mm deep (1 mm ball), and turned 180° (the file lies ears-down). The reviewer's own model is not published.
- **j07 portrait:** Alexander Gardner's 1863 portrait of Abraham Lincoln, public domain, Wikimedia Commons `File:Abraham_Lincoln_O-77_matte_collodion_print.jpg`, 960 px wide, greyscale, resized to 360 × 464. The PNG is embedded in the committed job (128 KB).
- **j15 helmet artwork:** OpenMoji `darth-vader` (CC BY-SA 4.0), via https://api.iconify.design/openmoji/darth-vader.svg. The polygons in the job files are derived from it.
- **j01 intended:** Makera's own `TopClamp.nc`, https://github.com/MakeraInc/CarveraProfiles/releases/download/v0.9.1/TopClamp.nc. The clamp's geometry in `j01-*.json` was read from it.

## How the "after" pictures were made

They come from an independent height-field sweep of the posted `.nc`, with the cutter's real cutting shape on a ≤0.1 mm grid. On flat and ball cutters it agrees with the app's removed volume to within about 2%. On V-bits the app removes 20–60% more (#741).

The 2026-10-27 sweep drew every ball and drill at its 3.175 mm shank, not its cutting diameter. That is part of why the old wolf card showed a dish. It also produced the "terraced" inlay plug: today's plug (`j11-v1-star-male-90.json`) has a flat floor.

## Fixtures

Each issue names its job files in `jobs/`:

- #738: j06-wolf-2mm-ball, j07-photo-relief, j07-photo-relief-1mm-ball
- #739: j02-raised-cnx, j04-coin-pla-proxy
- #740: j10-plaque-90v, j11-inlay-female-90v
- #741: j11-v1-star-female-90, j11-v1-star-male-90, j11-inlay-female-30v
- #742: j11-inlay-female-30v
- #743: j04-coin-pla-proxy
- #734: j15-vader-pla-proxy-b-engrave, j17-faceplate-pla-proxy, j13-tool-tray (a false positive of the sweep floor, not a surfacing defect)
- #735: j13-tool-tray-b-small-holes, j18-thread-a-bore-pla-proxy
