# Raspberry Pi 5 — visual asset licence

**Verdict: CLEARED**
**Researched: 2026-10-06**

| | |
|---|---|
| Asset | Official 3D STEP model (`rpi-5b_no_graphics.step`), 77 MB, no silkscreen graphics |
| Asset URL | https://pip.raspberrypi.com/documents/RP-010083-CA (zip: `RP-010083-CA-1-rpi-5 3D STEP - No Graphics small file.zip`) |
| Licence | MIT — Copyright (c) 2026 Raspberry Pi Ltd |
| Clause read at | `LICENSE.txt` inside that archive (read by extracting the downloaded zip) |

## The clause

The archive ships its own `LICENSE.txt`, which opens:

> "This 3D model is provided under the MIT license included at the end of this file. The 3D model may incorporate individual 3D models that have been provided by third parties with permission to redistribute."

and then the standard MIT grant:

> "Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software ... The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software."

The same notice carries a warranty disclaimer ("provided here for guidance only and without guarantee of accuracy") — a print-notes statement, not a licence restriction.

## Why

MIT permits modification and redistribution, so converting the STEP to a GLB for the viewport is expressly allowed. The `LICENSE.txt` travels inside the archive, so the grant is evidenced at the source rather than inferred from a licensing page.

A second, larger package (RP-010082-CA, "including silkscreen graphics") exists and should carry the same notice; not yet extracted.

## Attribution to ship

`MIT — Copyright (c) 2026 Raspberry Pi Ltd` plus a copy of the upstream `LICENSE.txt` in this directory, and the source URL above. Raspberry Pi's name and logo are trademarks and are not covered by the MIT grant — use the board name descriptively only.
