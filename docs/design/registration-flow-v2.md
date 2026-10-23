# Registration flow v2 — probe in, mount tap, find the stock, cutter in

Maintainer, bench 2026-10-23, after four live registration runs on the badge job:

> Once the job is ready to execute the rough steps are: 1/ ensure a probe is in and know what type;
> 2/ check to see if the mounting is correct — one tap on the fixed jaw, or the 4th-axis spindle, or
> the angle bracket; 3/ find the object where it is; once found update the UI view; 4/ switch to the
> tool and continue with cutting.

This replaces the "verify the stock is where the job expects it" shape of `execute.ts` (#430/#475)
with "measure the mount, then find the stock". Every stop of the 2026-10-23 bench was the old shape
failing on a normally mounted blank: a provisional seat (#585), a band too tight for a printed blank
(#589), extent touches placed before the edges were found (#591), a scan that cannot look inward (#592).

## The four steps

### 1. Probe in, type known

- The operator fits the probe; the run names which probe the plan is for (wired touch probe today;
  the 3D probe / tool-setter-only variants later) and the UI shows it.
- **Check the input before anything descends:** `M119` reports `Probe: 0|1`. A probe that reads
  triggered at rest (`1`) is unplugged/shorted or NC-miswired — stop with *"the probe reads touched
  with nothing under it — check its plug"* (the Carvera firmware halts `PROBE_FAIL` on exactly this,
  observed 2026-10-23).
- `M491` for the probe's length (the Z0 reference; the reading goes into the run record — today it is
  shown nowhere, #585).

### 2. Mount check — one tap on the mount's own reference

The mount is a product constant with a known tappable surface; one guarded touch on it confirms the
mount is the planned one AND supplies the Z datum the rest of the run needs. No typed seat.

| mount | reference surface | tap point | what the reading gives |
|---|---|---|---|
| Z1 low-profile vise | fixed-jaw top (10 mm wide, calipered) | 5 mm in from the jaw face, mid-stock in Y, away from the stock | `jawTopZ` — the floor for the stock search is `jawTopZ − margin` (over the stock the probe can only meet the stock); the stock stands `stockProud` above it (the bench: 1.84 mm for the 3.81 badge) |
| Angle bracket | the bracket's top face (or its corner stop) | per the bracket record | `bracketTopZ` + confirms the bracket is on and where the plan put it (replaces the text-only confirm) |
| 4th axis | the chuck/spindle nose top | per the rotary record | the axis datum; later slices |

- The reading is compared with the mount record's stored value (`probed`, decision 28); a miss or a
  reading far from the stored one stops with the mount named: *"no jaw top at (x, y) down to Z — is
  the vise where the machine record says?"*. A reading inside the record's scatter **updates the
  record** (provenance `probed`, date). The first tap on a fresh machine writes it.
- One tap, ≈ 5 s with the #590 approach heights.

### 3. Find the stock where it is; show it

- **Surface:** from the travel height down to `jawTopZ − margin` at the cut area's centre — a search,
  not a band. The reading is the surface. (Tolerance becomes a *plausibility* check against
  `jawTopZ + stockProud ± generous`, worded as a warning, not a stop.)
- **Edges:** scan each planned edge from a start that may MISS: a missed first touch steps **inward**
  (coarse) until the stock is found, then outward fine as today (#592). Reach along the jaws is the
  jaw length; across the jaws it is the opening.
- **Extents (#475 spread):** after the edges, placed by the found offset (#591), approached from just
  above the surface (#590). A spread beyond the depth band is the existing `blank-bowed` refusal.
- **Update the view:** the found origin (XY offset, rotation, surface Z) moves the stock in the
  viewport and the setup's reading, *before* the origin is written — the operator sees where the
  blank actually is relative to the design, and the run sheet records it. The stop sentences compare
  to the run's own readings (#588) and the step narration shows what is happening (#587).

### 4. Cutter in, continue

Unchanged (`applyCorrection`): the operator fits the cutter, `M491`, `G10 L2 P1 X Y Z` with Z0 =
surface + (cutter PRB − probe PRB), home — then the job's own run.

## What this retires

- The typed **Seat machine Z** field (expert override only, hidden by default) — #585.
- The planner's `seat + ledgeStep` jaw-top estimate — the jaw top is measured (step 2).
- `surfaceToleranceMm` as a stop — it becomes the plausibility warning; the per-stock recommendation
  of #589 stays as the warning's width.
- The spread-before-scan order — #591.

## Order of work

1. Step 2 for the vise (jaw tap + record update) and step 3's search-not-band surface seek — this
   alone would have passed runs 1–3.
2. #592 inward scan — would have passed run 4.
3. Step 1's `M119` check and the probe-type naming.
4. Step 3's "update the view" + #587/#588 wording.
5. Bracket and 4th-axis reference taps.

Bench evidence: `docs/bench/2026-10-22-web-registration-ux-notes.md` (2026-10-23 section), traces
`docs/bench/traces/2026-10-23-*.log`, frames `docs/bench/img/2026-10-23-register/`.
