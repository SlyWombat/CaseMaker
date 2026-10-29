# Simulate › Open .nc on a rod (#761)

Found by #753: a posted rotary program opened in the Simulate panel was path-only, with two
refusals — the interpreter's stale "the rotary axis is tracked but not interpreted" and the column
engine's "sweeps a cylinder stock; the setup's part is a prism". The engines simulate the file; only
the .nc door could not describe a rod in the chuck.

## What changed

- A file that moves `A` now offers a **rod** (`⌀ × length`) in the rotary chuck instead of the
  prism box. The diameter is prefilled from the file's own `;@CM|ROTARY|radius=` record; a vendor
  file that states none asks for it, and Simulate waits until it has one.
- The holding is the Holding step's own rule: the shop's grip, so the stick-out is the rod's length
  less the grip, and the tailstock is in. The line under the field states both.
- `buildSimSetup` builds a **cylinder** part and a rotary-chuck holding for a rod, so the session
  routes as the job path does: a wrapped program to the column engine, an indexed one (A held per
  run) to the exact sweeper. The stale interpreter sentence is retired; the parser keeps the
  file's ROTARY radius as a form hint.

## Proof (real screenshots, no machine)

`docs/bench/img/2026-10-29-761-sim-rotary/`:

- **j26-split-helix-A.nc** (#753's posted helicoid) on a ⌀20 × 100 rod, stick-out 85 mm:
  `j26-rod-step.png`, `j26-turning.png`, `j26-unroll-mid.png`, `j26-unroll-end.png`.
  The panel's Result: column sweep, 721 checkpoints, 4654.8 mm³ removed; the transport reads
  A 214° · 0 turns mid-program and the full turn at the end.
- **NefertitiRough.nc** (Makera's reference corpus, `Rotation/`; fetched, never committed) on a
  ⌀50 × 100 rod, stick-out 85 mm: `vendor-rod-step.png`, `vendor-turning.png`,
  `vendor-unroll-mid.png`, `vendor-unroll-end.png`. Column sweep, 4413 checkpoints, 1233311.1 mm³
  removed. The panel says the four cuts that dip within one tool radius of the axis were clamped
  (deepest −0.700 mm) — the engine's own sentence, not a refusal.

The Unroll screens are framed on the WHOLE map: the camera now fits BOTH axes (the narrow rail
panel cropped a 100 mm-wide map when only the vertical field was computed) and re-frames once when
the other design's frame arrives, so a Stock | Unroll switch lands on the new picture rather than
the previous view's box.

The corpus file is git-ignored (#186), so the e2e skips that card on a checkout without it; the
screenshots above are the record. The committed tests are `tests/unit/simRotaryNc.spec.ts` (rod step,
setup, both routings) and `tests/e2e/simRotaryOpen.spec.ts` (the two real door-to-screen walks).
