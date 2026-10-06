# Arduino Uno Rev3 — visual asset licence

**Verdict: CLEARED** (design files CC BY-SA 4.0; no official 3D model — ship a photo, or derive a GLB from the EAGLE files)
**Researched: 2026-10-06**

| | |
|---|---|
| Asset | Official CAD archive (`UNO-TH_Rev3e.brd`, `.sch`) and official product photography |
| Asset URL | https://docs.arduino.cc/static/6bb7a3ca51ebee82a252f60c0b418787/A000066-cad-files.zip (linked from https://docs.arduino.cc/hardware/uno-rev3) |
| Licence | CC BY-SA 4.0 |
| Clause read at | `License.txt` inside that archive (downloaded and extracted 2026-10-06); photography terms at https://www.arduino.cc/en/trademark |

## The clause

The CAD archive ships its own `License.txt`, and its entire text is:

> "This project's hardware is licensed under the Creative Commons Attribution-ShareAlike 4.0 International License. To view a copy of this license, visit https://creativecommons.org/licenses/by-sa/4.0/deed.en"

For the photography route, the Arduino trademark page's Copyright Notice states the site's

> "texts and photos"

are under

> "Creative Commons Attribution BY-SA 4.0"

which may be reused in whole or in part "as long as you also adopt the same license" (page revised 2020-11-25).

## Why

The hardware design is unambiguously CC BY-SA 4.0 by Arduino's own shipped notice — stronger evidence than any web page, because the grant travels with the file. That permits redistribution, including commercially, on three conditions: credit Arduino, link the licence, and license the adaptation under CC BY-SA 4.0 as well.

Two caveats. **No official 3D model exists** for the Uno — `docs.arduino.cc/hardware/uno-rev3` lists pinout, datasheet, schematics and CAD files, no STEP — so a GLB would have to be derived from the EAGLE board file, which no tool in this checkout does. **Trademarks are not covered**: "Arduino and the Arduino logo are trademarks or registered trademarks of Arduino S.r.l." — name the board descriptively (and, if needed, "Arduino® is a trademark of Arduino S.r.l."), never ship the logo as branding.

## Attribution to ship

`CC BY-SA 4.0 — © Arduino` with a link to the licence and the source URL. Any GLB derived from the EAGLE files, or any bundled photo, **remains CC BY-SA 4.0** — the rest of Case Maker stays MIT; only the asset carries the share-alike. Indicate that changes were made if the asset is modified.
