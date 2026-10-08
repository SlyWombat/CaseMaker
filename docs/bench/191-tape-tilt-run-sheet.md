# Run sheet — the tape tilt under a blank (#191 item 10)

**What this is.** A taped blank's residual Z error is not *thickness* — the Z probe absorbs
that (`/Fabrication.md` §7.3, decision 24) — but *tilt*. One probe touch is a **point** datum:
it fixes the face where the probe landed, and if the tape is thinner under one corner than
another the blank sits tipped about that point, so the commanded cut depth is exact at the touch
and wrong by (tilt × distance) everywhere else. Nobody has measured whether that drift is a
tenth of the badge's 0.810 mm colour boundary or half of it, which is the one live reason `G32`
might come back for tape (§9.1). **This row produces that number.** No cutting, no `.nc`, no job
file — four probe touches and a subtraction.

**Share the session, not the setup.** Tape-down and the vise are mutually exclusive fixtures —
mounting the vise removes the MDF wasteboard and tape goes on the bare table (§7.3) — so this
runs **before the vise goes on or after it comes off**, never between the vise items. It also
needs **C4** in the same sitting: see the trap below.

## 1 · What you need

1. The blank — the **76.2 × 38.1 × 3.81 mm PLA** badge blank, the same one `/Fabrication.md` §7
   works from. Its length (76.2 mm) runs left–right, its width (38.1 mm) front–back.
2. Double-sided tape. Record the brand and nominal thickness: \_\_\_\_\_\_\_\_  *(type / nominal mm)*
3. The **Makera 3D Probe** — rated for non-conductive material, not the 3D Probe Rod.
4. A straightedge, to check the tape lies flat under the blank before you rely on it.
5. **C4's answer for this session.** ⚠ *C4 has not been run — its only figure is one point
   probed twice, 0.017 mm apart (`docs/bench/2026-10-bench-day-1.md`, C4).* Run C4 in this
   sitting, before this row. **A spread at or below C4's repeatability is not a tilt** — it is
   the probe, and this row has no answer until C4 does.

## 2 · Set the blank

1. Vise off, **MDF wasteboard out**, bare aluminium table (or a sacrificial sheet on it).
2. Tape on the **annulus around the magnet recess, never across it**, and around the blank's
   whole footprint. The blank sits **pocket-down**; the face you will probe is the flat top.
3. Press the blank down evenly, then check it does not rock: \_\_\_\_\_\_\_\_  *(rocks? yes/no)*
   A blank that visibly rocks is a different fault than a tilt; note it and fix it first.

## 3 · Four touches, one datum

Probe the top face at **four points, one near each corner** — about 5 mm in from **both** the
edges that meet there, so the probe lands on the flat top and not on the badge's R3.175 corner
radius. **Do not re-zero between touches**: take every reading in the same coordinate
consistently (machine Z, or work Z after the first touch — only the differences matter), so the
differences are the tilt and nothing else.

| Corner | Machine Z (mm) | Δ from the front-left (mm) |
|---|---|---|
| Front-left (nearest the operator) — **this is Z0** | | 0 by definition |
| Front-right | | |
| Back-left | | |
| Back-right | | |

**Recorded:** _not yet run._

| Field | Value |
|---|---|
| Spread along the length X (front-left vs front-right, over 76.2 mm) | |
| Spread along the width Y (front-left vs back-left, over 38.1 mm) | |
| Overall spread (max − min of all four, mm) | |
| **Highest** corner | |
| **Lowest** corner | |
| C4's repeatability this session (mm) — the floor this must beat | |
| Tilt, mm per 100 mm — from whichever axis spread is larger, over that axis's own span | |

**Do it twice.** Peel it off, re-tape, and run the four touches again. One application is a
sample of one.

| Field | Value |
|---|---|
| Second mounting: spread (mm) | |
| Second mounting: highest / lowest corner | |

## 4 · What the number decides

Read against `/Fabrication.md` §7.3's own scale for the badge: **0.1 mm of depth error is 12 %
of the badge's 0.810 mm colour boundary** (§7.1). A spread small enough to stay under that leaves
tape free and `G32` out; a spread that does not is what re-opens `G32` **for taped setups only**
(§9.1, decision 12), and then §9.4's question — does `G32` compensate a long straight `G1`? —
stops being hypothetical.

- **Goes to:** `/Fabrication.md` §7.3 and §7.6 (the measured tilt), §9.1 and decision 12 (whether `G32` re-opens for tape).
- **Also closes:** #191 item 10's measurement. The nut and jaw dimensions in §7.3 are #208's, not this row's.
- **Then:** if the tilt is live, the follow-up is a `G32` option in the post and a probe-grid plan in `probePlan.ts` (#188); if it is dead, §7.3 keeps the number and `G32` stays retired.
