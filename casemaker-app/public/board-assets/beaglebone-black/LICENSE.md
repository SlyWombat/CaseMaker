# BeagleBone Black — visual asset licence

**Verdict: CLEARED for the design/documentation files; NO ASSET for a 3D model**
**Researched: 2026-10-06**

| | |
|---|---|
| Asset | Design + documentation files (Cadence Allegro source, schematic `BBB-SCH.pdf`, BoM). No STEP/glTF/GLB is published. |
| Asset URL | https://github.com/beagleboard/beaglebone-black |
| Licence | CC BY-SA 3.0 Unported |
| Clause read at | the BeagleBone Black System Reference Manual — https://github.com/beagleboard/docs.beagleboard.io/blob/master/boards/beaglebone/black/System-Reference-Manual.asciidoc |

## The clause

The System Reference Manual, on its copyright page (original author Gerald Coley), states:

> "This work is licensed under the Creative Commons Attribution-Share Alike 3.0 Unported License."

and:

> "All derivative works are to be attributed to Gerald Coley of BeagleBoard.org."

## Why

Two separate things had to be pinned down. First, the obvious trap: the `beagleboard/beaglebone-black` repository **declares no licence of its own** — GitHub reports none, and its README is silent (it carries only the OSHWA certification mark, US000236). The grant lives in the System Reference Manual, which is where the share-alike and the attribution line come from.

Second, there is no 3D model to ship: the repo holds Allegro design files and a schematic PDF, and the OSHWA certification lists the *documentation* as "CC BY-SA" while the *hardware* is "Other" — so the certificate does not independently clear the CAD. Nothing here converts to a GLB with the tools in this checkout.

The BeagleBoard.org name and logo are trademarks and are not covered by the CC grant.

## Attribution to ship

If any of these files are ever bundled or adapted: `CC BY-SA 3.0 — © Gerald Coley / BeagleBoard.org`, with a link to the licence and an indication of changes. Any adapted asset stays CC BY-SA 3.0.
