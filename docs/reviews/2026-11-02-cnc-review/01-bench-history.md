# Case Maker — what has physically happened on the Makera Z1 (2026-10-06 → 2026-11-01)

Read-only review of `docs/bench/`, `docs/bench/traces/`, `docs/bench/img/` (names + a few small PNGs), `docs/design/registration-flow-v2.md`, `docs/design/cut-this-blank-wizard.md`, and issues 165, 176, 209, 221, 238, 284, 304, 383, 391, 443, 444, 499, 501, 567, 569, 570, 584, 608, 618, 623, 628, 631, 767, 790 (plus 563, 580, 655, 656, 657 for cross-checks). Repo at main `5bcc5a88`.

Conventions: **O** = observation recorded in the repo/issue; **I** = my inference. Drive paths: **Studio** (Makera Studio GUI), **z1.mjs** (`casemaker-app/tools/z1/z1.mjs send/run` typed console lines from Windows), **scripts** (ad-hoc `.scratch/*.mjs` helpers over `protocol.ts`, incl. `upload.mjs`/`bench.mjs`), **web-app** (the k3 house build at `:8000`, driven by an agent through a headless Chromium / CDP), **desktop-app** (installed Tauri build on DAVE-1, or the k3 Linux `.deb` via tauri-driver).

---

## 1. Timeline

### Physical cuts — the whole list

| # | Date | What was cut | Blank | Cutter | Drive path | Program source | Result |
|---|---|---|---|---|---|---|---|
| C1 | 2026-10-12 | #165 depth ladder, rows A and B (2 × 6 squares, 0.6–1.6 mm) | printed 2-colour **PLA** badge 38.1×76.2×3.81, vise | yellow Spiral-O single flute 2×12 (`C1-BIT-O-FLUTE-2-12`), 12000 rpm F500 | **z1.mjs** (`M331`, `play /sd/gcodes/165-depth-ladder-row-A.nc`, `?` poll, `M332`) | `scripts/bench-files.ts` through the app pipeline | 12 clean squares, no alarm, ~103 s/row; row B tracks program to −0.1…−0.2 mm; row A (over pocket) compressed 0.9→1.4; colour light at 0.6–1.0, dark from ~1.3. Maintainer accepted accuracy for V1. (#165 comments; `traces/2026-10-12-cut-row{A,B}.log`; `img/2026-10-12-S3-*.jpg`) |
| C2 | 2026-10-15 | #185 V-grooves, four 10 mm grooves 0.6/0.8/1.0/1.2 deep | the same ladder blank, free strip left of row A | yellow 30°×0.3 engraver (`C1-BIT-ENGRAVE-30-0.3`) | **z1.mjs** (`play /sd/gcodes/185-v-groove.nc`, air run first) | hand-written `185-v-groove.nc`, verifier-passed | Cut completed Idle, no alarm (`traces/2026-10-15-185-cut.log` lines 6–87; `img/2026-10-15-185-grooves-cut.jpg`). **No caliper record of the groove openings is in docs/bench** (#185 closed 10-17; #284 carries "look closer at the V-groove edges"). |
| C3 | 2026-10-16 | `single.3mf` badge, rough pass `single.nc` | scrap ladder blank — **PETG**, not PLA as assumed | 2×12 O-flute | **scripts** (`.scratch/badge-2026-10-16/bench.mjs`) + z1.mjs `run`; upload via `runUpload` from `protocol.ts` | `scripts/engrave-job.ts --from-3mf` | Clean, 134 s (`2026-10-16-single-barrel.md`) |
| C4 | 2026-10-16 | rest pass `single-rest.nc` | same | 0.6×3 TiN corn bit | scripts | same | **Cutter broke at ~12 % (line ~5300/42 686), melted into the PETG**; `abort` by hand (#284 comment; `traces/2026-10-16-console.log`) |
| C5 | 2026-10-17 | `sb1017.nc` rough pass | NEW PETG badge blank | 2×12 O-flute | **scripts** (`step1–4.mjs`, `upload.mjs`), z1.mjs `run` | engrave-job-bench.ts | Clean, 136 s |
| C6 | 2026-10-17 | `sb1017-rest.nc` (yesterday's 0.6 mm rest toolpath) run with the V-bit fitted | same | 30°×0.3 engraver | scripts | same | 856 s, no alarm, no melt; second colour **patchy** ("could have been deeper"); "(Like the Whiskey)" not cut (#475/#486 filed) |
| **C7** | **2026-10-17 evening** | `sb1017-v.nc` — one-program V-carve (the #221 colour-plane model) | **purchased 2-colour laminate** 76×25.35×1.5 | 30°×0.3 engraver, S12000 F500/F200 | scripts (registration by hand scan), z1.mjs `run` | `engrave-job.ts --from-3mf single-thin.3mf --tool inv:kz-engrave-30-0-3 --rest none` | **437 s, clean floors, whiskey line legible at 6.2 mm cap, no melt, first try. Accepted as the V1 acceptance; #176 closed 2026-10-18.** |
| C8 | 2026-10-18 | four V feed coupons F400/F600/F800/F1000 | the laminate, re-seated, cut "as it sits" (crowned 0.18 mm) | 30°×0.3 engraver | **z1.mjs** (`lamF*.nc` uploaded, frames in air, each played from the console) | `engrave-job.ts --coupon` | All four crisp, no melt; maintainer chose **1000**; row entered as `measured` in the house feeds table — the first and only measured feeds row (#284 comment 2026-10-18; `450-laminate-v-feed-coupon-record.json`) |
| **C9** | **2026-10-25 13:42** | `single.nc` — the PLA badge V-carve ("Single Barrel" + "br") | PLA badge 38.1×76.2×3.81 (in the vise since 10-22) | 4 mm-shank 0.5 mm 30° engraver (`cat:…` "4*0.5mm*30º Engraving(Metal)") | **web-app** (k3 `29d0018c` at :8000, driven over CDP) for registration → origin → re-post → upload → Run; **z1.mjs by hand** for `M490.2` and the final `$H` | the app's own generate/freeze | ~4:15 cut, no alarm. "Single Barrel" reads, light plane exposed in every letter, interiors mottled, grey V-flank halo; **"br" unreadable** (gate had warned 13 % area loss); chipping at the lower-left edge. **No calipers taken.** (`2026-10-24-datum-path-bench.md` lines 140–161; `traces/2026-10-25-run9-cut-watch.log`; `img/2026-10-25-register/20261025-first-cut-badge-photo.jpg`) |

Nine cuts in four weeks; two produced a part the maintainer called good (C7, C8); one app-driven (C9), with hand intervention. **Nothing has been cut since 2026-10-25.**

**I:** The "2026-10-19 badge cut" cited in #580 ("the SAME job that was cut on the Z1 earlier this week… 2026-10-19 badge cut") and #584 ("the Z1 cut this exact program on 2026-10-19") is **not backed by any bench record**: `traces/2026-10-19-console.log` holds a single `$H` (timed out), `img/2026-10-19-badge-cut/` is 37 desktop-app UI screenshots (design → labels → generate → gate → sim → console → regplan → regapprove, 10:41–11:24) with no photo of a part, the 11-01 card listing (`traces/2026-11-01-console.log`) shows no file dated the 19th, and no bench `.md` mentions a cut that day. The PLA badge with the 0.5 mm V was first cut on 10-25. The claim most likely conflates C5–C7 (10-17).

### Session-by-session

**2026-10-06 — first contact (no motion).** `z1.mjs discover/identify/status` from the LAN: machine at 192.168.10.43, firmware framed protocol, `MPos:-1,-1,-1` idle. (`2026-10-bench-day-1.md` §B0, lines 369–409.)

**2026-10-06/07 — Studio session, no cut.** B2, B4 (partial), B5–B9, C1, A7 (one cutter: QR slug `C1-BIT-BALL-NOSE-1-4`), **D0** (Studio's five-step Machining Wizard walked end to end on a bare bed, empty collet: it probed, moved, changed tools, stopped before the cut), D1 partial, D2 answered (origin front-left, `length` = X). First **upload through the app's own bridge** (`asVerifiedProgram`/`uploadVerifiedProgram` over `transport.node.mjs`), md5 verified three ways; defect #291 found (a refused transfer reported as `alreadyPresent`). Side effect recorded: the wizard's auto-Z-probe rewrote the Z work offset by 6.5 mm and left tool `Probe` active (day-1 lines 1337–1392, 1611–1650).

**2026-10-08 — the #293 trip, console only.** C2 X/Y travel limits (Z deliberately not), **C4 wired-probe repeatability 0.001 mm slow / 0.004 fast**, blank flatness grid (**domed 0.33 mm across the width**), **C6 `M491` ×5 spread ≤ 0.001 mm**, C7 `T1 M6` no-op confirmed, A1 cutters photographed (38 boxes), A6 camera on the frame, library DB dumped. **Two network drops** (#304 body table). USB: no serial port on the bench PC. (`traces/2026-10-08-console.log`.)

**2026-10-12 — S1/S2/gate/S3: first chips (C1).** Three network drops with AP fallback `Makera_Z1_010290`, head light solid blue; two recovered by plug cycle, one on its own in ~4 min (#304 comments). C9: `G38.2` does **not** share the tool-setter input (miss → `ALARM: Probe fail`, `traces/2026-10-12-console.log` lines 444–482). D1b: `N`-numbered lines are silently ignored (`ok - ignore`). D3 timed air run via Studio; #303 stop controls; #386 `play` from our console works; D4 air run of row A at +20 mm clean (`traces/2026-10-12-D4-rowA.log`); then the ladder (C1). Machine facts learned: `G10 L2 P1` resets the tool-length reference to the current tool; the post's first move is `G0 X Y` with no retract (#384). The 2026-10-04 single-file ladder (wrong orientation, would have cut the moving jaw) deleted from the card (#383).

**2026-10-13 / 2026-10-15 — calipers and the grooves (C2).** Vise jaw tops 10/10 mm, step 3.1, ledge 1.9, bar 100 mm; blank 3.82 mm; wired probe tip **2.0 mm hollow cylinder, no ball** (day-1 A8; bench-plan lines 75–122). A hand material scan on 10-15 produced ~12 `ALARM: Probe fail` + `$X` cycles from `G38.2` misses (`traces/2026-10-15-console.log` lines 679–1154) — the origin of #518 (every probe as `G38.3`).

**2026-10-16 / 10-17 — the Single Barrel badge (C3–C7), DAVE-1.** All registration by scripts (probe `M491`, relative `G91 G38.2` surface, stepped edge scans, dome mapping, `G10 L2` by hand). Learned: `G38.2` is relative in effect; the blank is domed across its width with the colour line a **plane** under it (#475); the app has no V-bit program on a region design (→ #221/#486, built the same day); rapid-heavy ordering (#487). The evening laminate V-carve (C7) is the V1 acceptance.

**2026-10-18 — laminate day, DAVE-1 (C8).** Installed app rebuilt from `bccc2459`. **First app-driven registration attempt — refused by the planner** ("the jaw tops sit only −1.6 mm below the stock") → #517/#518 implemented at the bench, not re-run. Position re-check by probe scripts found the sheet moved 13.7 mm forward (re-mounted) and crowned 0.18 mm when over-tightened; maintainer: "cut it as it sits". Coupons cut (C8). **G32 grid partially proven** (`G32 R1 … I3 J4`, `M375.1`: compensation works at X 4/12.7; the right column read a jaw top, so a grid point must sit inside the sheet) — the `176-g32-stroke.nc` stroke was **not** run. `M499` after an XY-only `G10 L2`: reference untouched (R17). `M821/M822` light proven by eye. Vise/bracket/clamp calipers (#444 partial; 7 values entered as `measured`). Makera 3D Probe discovered unused in the box. Machine dropped off the network before power-off. (`2026-10-18-laminate.md`.)

**2026-10-19 — UI walks, no probe, no cut.** Morning: the Windows desktop app driven by `.scratch/drive.mjs` (CDP) through design → generate → sim → console `$H` → regplan → regapprove (`img/2026-10-19-badge-cut/`; `traces/2026-10-19-console.log` = one `$H`). Evening: the k3 Linux `.deb` via tauri-driver — #547 dry-run UI, #555 online indicator, two "register" presses at 20:41/20:48 whose result screen reads "The package of 23:39 is stale" (`img/2026-10-19-linux-drive/20261019-204215-register-result.png`, viewed). **I:** no probe moved on 10-19.

**2026-10-20 — #563 found and fixed.** Registration from the installed app twice: `M491` physically succeeded but the reply reader closed after ~800 ms and reported "no tool-length reading" (`traces/2026-10-20-m491.log` drained in 1060 ms; `-m491-full.log` shows the macro takes ~30 s, slow PRB −75.906). The k3 app's three register presses at 17:31–17:36 ended "could not open a console … timed out after 3000 ms" with the machine **Offline** (`…/20261020-173128-register-result.png`, viewed). First failure that session: controller off the LAN → plug cycle. Fix `97d6e01b` 20:08.

**2026-10-21 — #567 attempt.** Morning: stopped before motion — the stock in the vise was the PETG magnet-pocket piece, the persisted G54 was the **laminate** origin (`−181.200/−199.125`), and no app with #563 was running (#567 comment). Later, on k3 `276e1df9`: **two live runs reached the surface touch (~150 s of probing) and missed** — "found nothing down to machine Z −48.4" (`img/2026-10-21-register/20261021-110854-register-result.png`, viewed). Root cause recorded as operator error: a synthetic job with a label at (50, 30) and seat-Z −60 on a 44.6-mm-wide blank put the touch past the moving jaw (#567 body).

**2026-10-22 — web UI driving, no probe.** Web-app `fca5a8fa` → `34bc7516` → `0408a72d` driven over CDP; the F1–F8 beginner-UX findings; #580 (0.001 mm² oracle floor blocks Save/Upload on the badge job); the "Cut this blank" wizard (#573) designed and landed the same day. Badge clamped in the vise from here on.

**2026-10-23 — first live web-app registration runs (`ce6ffe68` → `8ea808d5`).** Z1 dropped off the LAN overnight; `power.sh on --cycle`. Run 1: "found nothing down to −51.59" (#585, seek window on a provisional seat). Hand taps by z1.mjs: the first jaw tap sent `G38.3` while the rapid was still in flight → `H:3`, head on the home switches, `$X`/`$H` (`traces/2026-10-23-jaw-tap.log` lines 1–20); second attempt: **fixed-jaw top −56.82**, badge top −54.98 (`-badge-top-tap.log`). Run 2 (seat −58.79): right extent nothing → 60 s silent park (#588). Run 3: driver error. Run 4: front extent miss → #591. **Run 5 (14:22Z): registration COMPLETED end to end from the web UI** (M491 → surface −55.008 → left edge ≈ 0 → front edge found at +5.6 by the inward search → five extents → home), verdict **`blank-bowed` 0.45 mm vs the 0.2 mm band, no origin written** (`traces/2026-10-23-run5-transcript.txt`, 26 PRB). Maintainer's ruling: the mount is normal, software must accept it → #608. Design doc `registration-flow-v2.md` written from these four stops.

**2026-10-24 — the datum path, five builds in one day (`ffd997fe`, `9b94d1cd`, `65034e22`, `264b3df8`, `3f1278a1`, `3360d793`).** Runs 1/3 (typed seat): complete, repeatable to 0.000–0.004 mm, no origin (X off 0.83 / Y off 6.38 > 0.5 margin, #620). Card jaw tap writes the datum −56.807. Run 2 (datum path): stopped — surface above the band (#619). Evening **run 4**: datum path complete → "Use the found position" → cutter fitted **2.5 h later** (19:15) → `M491` → **`G10 L2 P1 X-180.125 Y-192.750 Z-52.129`** → re-post against the tilt → **oracle 301 mm² under-cut, Upload disabled** (#623). Session 2: **run 5** (65034e22) → ordinary "Write the origin" → `G10 L2 P1 X-180.050 Y-192.925 Z-54.086` → package stale (#627) → re-post → 1.63 mm² (#628: column engine sweeps each ramped feed at its deep end); **run 6** (264b3df8): same reading; **runs 7–8** (3f1278a1): **DOME verdict, residual 0.208 vs 0.2 band, no origin** → maintainer: "Would makera refuse to cut this" → #631 (G32 route + operator-accepted floor) landed 23:05. Z0 moved 2–4 mm between runs purely from cutter re-fit stick-out (`M491` absorbs it); the probe re-fit moved the datum −56.801 → −56.754. (`2026-10-24-datum-path-bench.md`; `traces/2026-10-24-run*` and `2026-10-25-run5…run8*`.)

**2026-10-25 morning — THE FIRST APP-DRIVEN CUT (C9), k3 `29d0018c`.** Boot junk on the first status line; `$H` (no reply, as always); `M821`. New status strip live (#647 ✓), light/vacuum indicators (#648 ✓). **Run 9** datum path 12:50–12:55: verdict TILT 0.186 mm — "0.014 inside the 0.2 band" (the same blank read DOME at 0.208 the night before, #630). Write the origin → cutter fitted → `M491` → **`G10 L2 P1 X-180.150 Y-192.775 Z-52.661`**, no stale package (#627 ✓). Re-post → **oracle 0/0 in the surface frame — the first pass on the bench** (#623+#625+#628+#584 ✓). Then "over 7 minutes with nothing happening": six confirmations across three screens (#656). Upload 13:24–13:27 (`single.nc`, 256 813 bytes, md5 verified). **Run** 13:29 → the Z1 drove to the tool-change position and sat in firmware state **`Tool`**, blinking blue, for ~11 min (status trail `Tool` 13:30:58 → 13:41:53, 110 lines); the app showed `Tool · 0 % · line 0` with no prompt (#655). **Continued by hand: `M490.2` via z1.mjs** (`traces/2026-10-25-console.log` 17:41:58Z). Cut 13:41:59 → 13:46:20 (estimate 2:42, #657). Program ended **Idle at the clearance position, not homed** (the app's run watch had lost the run at the Tool state); **`$H` sent by hand** 13:52. Plug off 13:55. Owed and still owed: calipers (floor depth centre vs ends — the bow-vs-dome question, #631); antistatic `M331.4/M332.4` absent from the trace (#569 triage).

**2026-10-26 → 10-29 — no machine.** Demo-job runs off-bench ("No machine was used", `2026-10-28-z1-real-jobs/README.md`); rotary/indexing acceptance procedures written but "NOT been run" (`757-indexing-backlash.md`, `756-rotary-fluidity-procedure.md`); #767 checklist filed 10-29.

**2026-10-30 — 3D-probe survey, z1.mjs only, no cut.** Plug on, self-homed. **Probe plugged into the ionizer port first** (P:0) → #788 head diagram. Found: the 3D probe is powered by the toolsensor output `M831` (#789). Fixed-jaw survey with `M493.2T8888` + `M831` + `M491` (setter −66.977, TL0 6.084): jaw top −47.873, inner face −180.23, ledge 3.00 below top and 2.14 in from the face, moving jaw faces. **Alarms:** `G0` retract after a sideways contact → `ALARM: unexpected probe trigger` (`traces/2026-10-30-probe-survey.log` line 2033; fix: `G38.5` probe-away first), `Error: ZProbe triggered before move` (line 2215), and an alarm switches the probe supply off (re-send `M831`). Effective radius first read as 0.15 mm (wrong — later shown to be the wired probe's number, #790 comment). Plug left ON; active tool 8888. (`2026-10-30-3d-probe-survey.md`.)

**2026-10-31 — probe-bore session (`traces/2026-10-31-probe-bore.log`, 1264 lines).** `M831`; the first `G53 G0 X-186.2 Y-180` and `G91 G38.3 Z-10` both hit the 3 s reply timeout (lines 19–22); then `$X`, `abort`, `$X`, `G91 G1 X-20 F600` (lines 36–50) — **a loose wired-V2 probe body jammed the head against the side wall, H:3 alarm and a stalled home** (#790 comment "Bench lessons"). Jaw-top touches −47.86 ×3 (repeatable to 0.004), the counterbore walls at Z −60/−57.5 at F60 with `G38.5` releases, one more `ALARM: unexpected probe trigger` after a `G53 G1` with the stylus still deflected (line 503) and two `error:Alarm lock` (505–509), `$X`, `M831`. Result on #790: **3D probe effective radius 0.83 mm (bore), superseded by 0.875 mm from the 9.93 mm outside width; ball ⌀2.00 by calipers; pre-travel ≈ 0.125 mm**. `$H` 20:09Z. No cut.

**2026-11-01 — accessory switches, no motion.** `M811/812` spindle fan, `M801/802` PSU fan, **`M851/852` runs the vacuum** (same as `M331`), `M841/842` WP charger (nothing attached); `diagnose`; `ls -e -s /sd/gcodes` (#772 Files view) — the card still holds every program from 10-12 onward (`traces/2026-11-01-console.log`). The Z1 **joined the network first time at power-up** (#499 note), Linux discovery seen (#323 closed), k3 relay TCP connect ok (#821). (#767 comments 2026-11-01.)

---

## 2. Has the APP ever driven registration → upload → run → clean part?

**Once, partially: 2026-10-25, run 9 (C9).** The k3 web build (`29d0018c`) did, through its own UI: datum-path registration (jaw tap → surface → edges → five extents, tilt verdict) → "Write the origin" (`M491` on the cutter, `G10 L2 P1`, `$H`) → re-post against the tilt → oracle 0/0 → Upload (md5 verified) → "Run single.nc". Observed caveats that stop it being a clean end-to-end:

1. **The operator was an agent over CDP**, not a person at the GUI (`2026-10-24-datum-path-bench.md` line 3: "driving http://192.168.10.38:8000 from a headless Chromium"). Nobody has yet driven this path with a mouse. The installed **desktop (Tauri) app has never completed a registration** (10-18 refused by the planner; 10-20 #563 reader; the k3 Linux desktop reached the surface touch on 10-21 and missed).
2. **The run needed two hand rescues**: `M490.2` from z1.mjs after 11 min in the firmware `Tool` state (#655, fixed 095caeb3 on 10-25 but **unverified on the machine**), and `$H` by hand because the run watch lost the run.
3. **The part is not "clean"**: title legible, "br" unreadable (gate-warned), mottled interiors, chipping at the clamp edge; **no caliper measurement** of floor depth vs the colour plane, which is #569's pass criterion. #569 remains open.
4. The design doc's acceptance (`cut-this-blank-wizard.md` §8: "the badge job, through the wizard, from Open job to …") was not the route used — the expert Cut panel steps were.

**Furthest point reached on each earlier app attempt, and what stopped it:**

| Date | Build / app | Reached | Stopped by |
|---|---|---|---|
| 10-18 | desktop `bccc2459` | Plan registration | planner refused a stock below the jaw tops (→ #517) |
| 10-19 | desktop + k3 Linux | Register button | stale package / no console (`img/2026-10-19-linux-drive/*register-result.png`) |
| 10-20 | desktop + k3 Linux | `M491` | reply reader closed at 800 ms (#563); machine Offline (plug cycle) |
| 10-21 | k3 Linux `276e1df9` | surface touch | synthetic job, touch past the jaw; stale G54 (laminate origin) |
| 10-22 | web `0408a72d` | Cut checklist | oracle floor 0.001 mm² blocked Save/Upload (#580) |
| 10-23 runs 1–4 | web `ce6ffe68` | surface/extents | seek window (#585), 60 s park (#588), front extent before edge scan (#591) |
| 10-23 run 5 | web `8ea808d5` | **registration complete** | `blank-bowed` 0.45 mm — no origin (→ #608) |
| 10-24 runs 1/3 | web `ffd997fe` | registration complete | X/Y off > 0.5 mm margin, no "use found position" (#620) |
| 10-24 run 2 | same | surface | reading above the band (#619) |
| 10-24 run 4 | web `9b94d1cd` | **origin written**, re-post | oracle 301 mm² in the wrong frame (#623) |
| 10-24 runs 5–6 | web `65034e22`/`264b3df8` | origin written, re-post | stale package (#627); oracle 1.6/75 mm² — column engine (#628) |
| 10-24 runs 7–8 | web `3f1278a1` | registration complete | DOME verdict 0.208 vs 0.2 band — no origin (#630/#631) |
| 10-25 run 9 | web `29d0018c` | **cut** | `Tool` state stall (#655), run watch lost, no calipers |

---

## 3. Code-complete but never bench-verified

From #767 (unticked unless noted) and the record:

| Item | What one check needs |
|---|---|
| #655 Tool-state prompt + Continue → `M490.2` (landed 095caeb3 after the cut) | one single-tool run from the app: it stops at the prompt once and continues on Continue; the run watch keeps the run and homes at the end |
| #656 one-confirmation cutter→cut flow | time from the cutter prompt to spindle-on on the next run |
| #586 Cut step ③ open after a reconnect | reconnect mid-session, press Start once |
| #588 stop: `$X` only in Alarm, no 60 s park | one deliberate stop on an air registration |
| #615 two-stage jaw tap (fast seek then touch feed) | **I:** already seen — run 6 homed in 4:54 vs 5:40 (`datum-path-bench.md` run 6 row); tick it or time one tap |
| #627 no stale package after origin write | **O:** verified 10-25 run 9 ("No stale package… #627/#581 ✓") — unticked in #767 |
| #631 dome → G32 route / operator-accepted floor | a dome verdict on the badge → `G32 R1`+`M375.1` from the console with the PROBE in → tick → flat Upload → cut → calipers centre vs edge (also answers #501 Q13 bow-vs-dome) |
| #647 DRO strip at power-on and through a registration | **O:** seen 10-25 12:48; unticked |
| #659 state popover with cover open / probe triggered (C:/E: byte for byte) | raw capture via z1.mjs while the cover is opened and the probe pressed |
| #772 Files view list/delete | **O:** `ls -e -s` answered 11-01; `rm <file> -e` not sent |
| #562 QuickLZ upload | set `machine.uploadCompression = quicklz`, upload a >4096-byte program as `.bin`, md5, play |
| #289 four accessory switches | **O:** all four answered 11-01 (`M851` = vacuum) — tick |
| #525 3D-probe corner finding on a tape blank | tape a blank on the bare bed (vise off), two sideways lines per edge, read the origin/rotation |
| #790 `G38.5` release before any `G0` after a touched reading in `registration/execute.ts` (proposed, not landed) | an air registration with the 3D probe fitted: no `unexpected probe trigger` |
| #618 pause/resume (`suspend`/`resume`) — e2e only | air run then a scrap blank: pause, what the spindle/vacuum/Z do, resume, no step at the seam, a `suspend` with no reply, Stop while paused |
| #501 / #176 Q13 G32 stroke proof | `176-g32-stroke.nc` (badge blank, X 31.05) with the grid active; caliper both ends and the centre — decides endpoint-only compensation; `features.ts autoLevel.proven` stays false until then |
| `features.ts light.proven = false` | `M821/M822` proven 10-18 by eye; the flag was never flipped (#443 triage) |
| #443 items 3–6: bracket confirming touch, run-screen Stop mid-run and panel close/reopen, laser frame + point-to-origin + Set | air program on the card; the L bracket fitted once (never has been) |
| #444 remainder: `bracket.originOffsetX/Y`, `clamps.topReachMm`, `fitMm`, `repeatMm`, `seatMachineZ` | bracket pinned at anchor 1 + one probe touch; five plate seatings; one bed touch |
| #570 repeatability across re-seating | ≥ 3 unclamp/reclamp/re-register cycles; only same-clamping repeats exist (0.000–0.004 mm, 10-24) |
| #284 PLA coupons `284-PLA-feed-coupon-F{350…900}.nc` (`cutOn: null`) and the #249 restart file | four coupons on a PLA badge with the 2×12 O-flute; one deliberate mid-cut stop + `generateRestart` |
| #567 G54 pre-flight (`workOffset()` exists, nothing calls it) | not a bench item — but the stale-G54 miss it guards against happened on 10-21 |
| The Z-chain "cut a step, caliper it" number (#176/#209) | calipers on any cut floor vs its commanded depth; the ladder's nut method (0.1 mm resolution) is the only figure |
| #569 pass criterion (depth hits the colour plane evenly) | calipers on the 10-25 badge: centre vs ends |
| #743 P-7 two-sided PCB (#823) | FR-4 60×40×1.6, five cutters incl. 0.1×60° engraver, meter |
| #238 rotary (gate for #240/#241/#223; run path refused until measured) | vise off, module on, jog A vs dial indicator, +A sign photo, run-out, one Studio rotary header |
| #536 3D ball-engagement feeds | coupon cuts with a ball on the 150 W spindle |
| #529 touches layer in the viewport | fed by a live registration |

---

## 4. Recurring bench-time losses (with evidence)

1. **Network drops / failed joins (#304, #499).** 10-08 ×2 (#304 body), 10-12 ×3 (AP fallback, blue light; #304 comments), 10-18 end of day (`laminate.md` line 191), 10-20 first failure (#563 body), 10-22→23 overnight ("`power.sh on --cycle` brought it back in 11 s", ux-notes 10-23). Recovery is always a plug cycle. 11-01 joined first time. **I:** every session so far has spent its first minutes on whether the machine is on the LAN.
2. **The 3 s reply window vs long moves.** `$H` never answers within 3 s (every console log: 10-19, 10-20, 10-23, 10-25, 10-31); long `G53 G0` moves and `G38.3` seeks time out the same way (`2026-10-23-jaw-tap.log` lines 3–6, `2026-10-31-probe-bore.log` lines 19–22, 67–68, 261, 409; `2026-10-30-probe-survey.log` lines 1728, 1748, 2118…). Consequence on 10-23: a `G38.3` queued behind a still-moving rapid → `H:3 PROBE_FAIL` with the head on the home switches (ux-notes 10-23 bullet 1). #563 was the in-app form of the same thing.
3. **Alarms on probe misses and retracts.** `G38.2` miss → `ALARM: Probe fail` + `$X` — ~12 cycles in the 10-15 hand scan (`2026-10-15-console.log` 679–1154), 4 in the 10-16 log, C9 on 10-12; fixed by `G38.3` (#518). With the 3D probe: `G0` retract after a sideways touch → `ALARM: unexpected probe trigger` (10-30 line 2033; 10-31 line 503), which also **cuts the probe's supply** (#789/#790) — the registration executor still retracts with `G0` (#790 triage).
4. **Probe hardware handling.** Wrong connector on 10-30 (#788); loose wired-V2 body jammed the head on 10-31 (stop button, `$X`, manual move); each probe re-fit moves its length 0.05–0.11 mm (10-18 line 116; 10-24 datum −56.807 → −56.754); each cutter re-fit moves Z0 by 2–4 mm (10-24 runs 4→5→6) — harmless with `M491`, but every swap costs a `$H` + `M491` (~1 min) and a human at the machine.
5. **CRLF in `ha-api.sh`.** `power.sh` fails silently on the Windows checkout's copy ("could not read switch.makera_cnc"); a CR-stripped copy was needed on 10-17, 10-18, 10-24, 10-30 (`2026-10-17-single-barrel.md`; `laminate.md` line 8; `datum-path-bench.md` line 6; `3d-probe-survey.md` line 4).
6. **Waiting on the maintainer / confirmation gaps.** 10-24 run 4: registration done 16:50, cutter fitted 19:15; 10-25: "over 7 minutes with nothing happening" — six confirmations across three screens (#656); 11 min in the `Tool` state before `M490.2` (#655).
7. **Build staleness and churn.** 10-19/10-21: no running app with the needed fix (#567 comment); 10-24: six k3 builds in one evening, each publish dropping the browser session (`datum-path-bench.md` run 5 row: "Browser session dropped by the publish, as always"); #517/#518 written at the bench and not re-run.
8. **Driver/operator errors.** 10-21 synthetic job at (50, 30) (#567); 10-23 run 3 re-planned with the default seat; 10-24 run 7 transcript lost to "Run it again"; 10-18 touches placed on a coupon cell edge; stale G54 from the previous job (10-21).
9. **The blank itself.** The printed badge is domed 0.33 mm (10-08), bowed 0.45 mm across the cut (10-23), and sits at the 0.2 mm band edge (tilt 0.186 / dome 0.208 on the same clamping, #630): verdict flips on noise, and three registration runs were refused for the blank's shape, not the software. The maintainer's rule (#631): Makera would cut it.
10. **The oracle chain.** Three builds (#623 → #625 → #628, plus #584) between "origin written" (10-24 19:16) and "Upload enabled" (10-25 13:07).

---

## 5. Open bench issues — what each physically needs

| Issue | Physical need (est.) |
|---|---|
| **#569** end-to-end cut on a two-colour blank | **Calipers on the 10-25 badge (5 min, no machine)** to post the depth; or one repeat run on a fresh PLA badge (see §6): ~60 min, PLA badge, 0.5 mm 30° engraver (or the 0.3 for "br"), wired probe |
| **#567** app-driven registration | **O:** completed 10-23 run 5, 10-24 runs 1/3/4/5/6, 10-25 run 9 (origins written three times). Needs a results comment and the maintainer's call on the blank substitution (br.stl vs the 76.2×38.1 badge); 0 min at the machine |
| **#570** repeatability across re-seating | 3–5 cycles of unclamp/reclamp/register: ~8 min each (datum path 5–6 min + hands) ≈ 40 min; badge, wired probe, no cutter |
| **#501** G32 proof (+ #176 Q13) | ~20 min: probe in, `G32 R1` 3×3 over the stroke band, `M375.1`, swap to the 2×12 O-flute, `M491`, play `176-g32-stroke.nc` (needs the badge blank with X 31.05 clear — a fresh one), caliper both ends + centre |
| **#767** checklist | one air session ~45 min covers #586/#588/#615/#659/#562/#772 `rm`; #631 needs a domed blank and a cut (see #569); #525 needs the vise off and a taped blank (~30 min) |
| **#790** 3D-probe retract rule + radius storage | air registration with the 3D probe after the `G38.5` fix lands (~15 min); re-caliper ledge 1.9 vs probed 2.05/2.14 (5 min, vise) |
| **#443** air runs | ~60 min: Stop mid-run on an air program, panel close/reopen, laser frame + point-to-origin (needs #457 UI), bracket touch (needs the vise OFF and the L bracket pinned — a setup change) |
| **#444** bracket numbers | with the vise off: pin the bracket, one probe touch for the offsets + seat Z, five plate seatings (~45 min) |
| **#284** PLA coupons + restart proof | ~40 min: PLA badge, 2×12 O-flute, four `284-*.nc` + one deliberate stop and `generateRestart`; `cutOn` still null |
| **#304 / #499** network | watch-only; record firmware version each session; nothing to run |
| **#238** rotary R-1 | half a day: vise off, module on (power off), jog A vs dial indicator, run-out with a dowel, a Studio rotary job header; **no cut** |
| **#545** (gated on #238), **#536** 3D feeds (ball coupons), **#529** touches layer, **#823** PCB (FR-4 + 5 cutters + meter, ~2 h), **#208** runbook (B1/B3/C5/C8/D3 rows still blank) | as stated in each |

---

## 6. Assessment — the shortest physical path to one clean app-driven sample cut

**What already works (O):** the whole chain was exercised once on 10-25 and every stop found on 10-23/24 has a landed fix (#585, #588, #591, #619, #620, #623, #627, #628, #630, #631, #655, #656). The 10-17 scripts proved the cutters and feeds: the 2×12 O-flute is clean on PLA/PETG at 12000/F500, the 30°×0.3 engraver V-carves the laminate cleanly at the now-measured F1000 row (C7, C8). The one measured feeds row in the whole product is that laminate V row.

**Shortest path (I), one session of about 60–75 minutes at the machine:**

1. **Repeat 10-25 exactly, on the same k3 web build line, same job, same cutter, fresh PLA badge** — not a new job type. Every unknown has been retired once; the only new code on the path is #655/#656 (Tool-state prompt, one confirmation) and the dome routes (#631). Use the datum path (jaw tap → surface → edges → extents), accept tilt or dome as the verdict comes, Write the origin, cutter, re-post, Upload, Run. Expect: the prompt at the `Tool` state once → Continue → ~4:15 of cutting → the Done card → `$H` from the app.
2. **Fix the design before the run, not the software:** drop "br" (the gate said 13 % of it is lost to the 0.5 mm V — it was unreadable, as predicted) or fit the 30°×0.3 engraver (owned, proven on 10-17/18) and let the catalogue row drive the feeds. A part that matches the design needs a design the cutter can make.
3. **Take calipers immediately** (centre vs ends of the floor, against the 0.81 mm colour plane) — this is the single measurement that closes #569, decides #631's bow-vs-dome question, and gives the Z-chain number #176/#209 asked for a month ago.
4. **Pre-session (0 min on the machine):** `ha-api.sh` CR-stripped copy ready; `power.sh on` with `--cycle` on standby; confirm the k3 build is the one with 095caeb3 (#655) and the #656 single confirmation; the maintainer at the bench for the probe→cutter swap only.

**Alternative with the lowest material risk (I):** the purchased laminate with the 30°×0.3 engraver — the one combination that gave a first-try clean part (C7) with a measured feeds row (C8). Its catch is the app path: the laminate sits below the jaw tops and a 0.1 mm job has a thin depth band, so the datum path and the tilt re-post would be exercised on a new stock shape; the 10-18 app attempt on this sheet was refused before #517. Choose it only if the PLA badge's dome keeps refusing; otherwise the PLA repeat is the shorter road because every verdict on that blank is already on record.

**What not to spend bench time on before that cut:** rotary (#238), PCB (#823), bracket (#444), 3D-probe corner finding (#525) — all setup changes (vise off), none on the path to the sample cut.

---

### Evidence index (paths are repo-relative under `/mnt/c/Projects/Case Maker/`)
- `docs/bench/2026-10-bench-day-1.md` — §B0 369–409, C4 1097–1137, C6 1157–1192, C7 1194–1223, C9 1247–1275, D0 1279–1335, D1 1337–1392, D1b 1394–1431, "first upload" 1611–1650.
- `docs/bench/2026-10-bench-plan.md` — status 10-12 lines 14–74; vise constants 75–122.
- `docs/bench/2026-10-16-single-barrel.md`, `2026-10-17-single-barrel.md` (C3–C7), `2026-10-18-laminate.md` (C8; G32 lines 118–139; calipers 141–171), `2026-10-22-web-registration-ux-notes.md` (10-23 section lines 50–72), `2026-10-24-datum-path-bench.md` (runs 1–9; the cut lines 140–161), `2026-10-30-3d-probe-survey.md`, `756/757/761-*.md` (not run).
- `docs/bench/traces/` — `2026-10-12-cut-row{A,B}.log`, `2026-10-15-185-cut.log`, `2026-10-20-m491*.log`, `2026-10-23-jaw-tap.log`, `2026-10-23-run5-transcript.txt`, `2026-10-24-run4-*`, `2026-10-25-run9-cut-watch.log`, `2026-10-25-morning-status-trail.log` (Tool state lines 450–559), `2026-10-25-console.log` (M490.2 17:41:58Z), `2026-10-30-probe-survey.log` (alarms 2033, 2215), `2026-10-31-probe-bore.log` (jam 36–50; alarm 503), `2026-11-01-console.log`.
- Issues: #165 (ladder depths), #284 (corn bit, coupons), #563 (M491 reader), #567 (10-21 attempts; run-5 completion), #580/#584 (the "10-19 cut" claim), #623/#628 (oracle chain), #631 (dome), #655/#656/#657 (first-cut findings), #767 (checklist + 11-01 switches), #790 (3D probe numbers, 10-31 jam).
