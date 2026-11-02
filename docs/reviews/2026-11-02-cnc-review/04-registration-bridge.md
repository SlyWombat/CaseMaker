# Registration path and machine bridge — read-only review

Repo `/mnt/c/Projects/Case Maker`, main at `5bcc5a88` (2026-11-02). All paths below are under
`casemaker-app/` unless they start with `docs/` or a root doc. Nothing was edited, installed or sent
to any machine. Specs were run from the Linux clone `~/projects/CaseMaker` (HEAD `07c499ed`, a
descendant of `5bcc5a88`; every file cited here is byte-identical in both checkouts — checked with
`diff -q`) because this checkout's `node_modules` is Windows-side (rolldown's Linux binding is
missing, so `npx vitest` cannot start here).

**One correction to the brief first.** The brief says the 10-21…10-25 runs ran registration but
"no cut followed". The bench record `docs/bench/2026-10-24-datum-path-bench.md` ("2026-10-25 morning —
THE FIRST CUT", lines ~140–161) says the app-driven path DID cut on 2026-10-25 13:42 on build
`29d0018c`: run 9 (datum path, tilt 0.751°) → Write the origin → re-post → oracle 0/0 in the surface
frame → Upload → `Run single.nc` → ~4:15 of cutting, "Single Barrel" reads. `#569` is still OPEN only
because the caliper depth reading and a results comment were never posted (#569 triage comment
2026-10-28). The 2026-10-31 session (`docs/bench/traces/2026-10-31-probe-bore.log`) was a hand-driven
3D-probe survey through the bench harness, not a registration run through the app.

---

## 1. The registration path as BUILT (vise, wired probe, datum path = the default badge job)

Orchestration: `src/components/panels/EngraveRegistrationStep.tsx` (`start()` :397–631,
`writeOrigin()` :633–728) → planner `src/engine/cnc/registration/plan.ts` (`planRegistration` :385–702),
input built by `src/engine/cnc/setups/registration.ts` (`registrationFor` :78–130, `expectedSurface`
:45–76) and `src/engine/cnc/registration/mountContext.ts` (`probeFor` :83, `mountDatumFor` :198,
`mountTapFor` :301) → executor `src/engine/cnc/registration/execute.ts` (`runRegistration` :1166–1452,
`applyCorrection` :1570–1610) → console `src/platform/machineConsole.ts` (`attachConsole` :251) →
bridge `src/platform/desktop/machineBridge.ts` (`openConsoleSession` :540) → protocol
`src/platform/desktop/protocol.ts` (`openConsole` :1814–1887) → sockets `src-tauri/src/machine.rs`.

### 1.1 Pre-flight (no motion)

| step | where | firmware line |
|---|---|---|
| settings sanity | `execute.ts:1174` `settingsProblem` (`settings.ts:121–140`) | — |
| machine must read Idle | `execute.ts:1179–1180`, `controllerState` (`machineUpload.ts:75`) | `?` |
| the one operator statement | `EngraveCutSurface.tsx:900` ("I am at the machine — the probe is fitted, the head is clear, and the stock is …", #797); the executor's `fit-probe` prompt is auto-answered from it, `EngraveRegistrationStep.tsx:454` | — |

### 1.2 Home and frame

`execute.ts:1181–1183`: `$H`, `G54`, `G92.1`. The `$H` reply is awaited like any line
(`session.send`, :190–204): `kind !== 'sent'` throws `Stop` (:195), so the run depends on the `ok`
arriving inside the console's first-reply window — 60 s (`machineConsole.ts:65` `CONSOLE_TIMING`,
shop seed `console.firstReplyMs` 60 000, `defaultsClient.ts:204`, `defaults.rs:381` "M491 about 32 s,
$H about 31 s").

### 1.3 Probe in, type known (v2 step 1)

| step | where | firmware |
|---|---|---|
| probe supply on (#789) | `execute.ts:1189–1190` | `M831` (off in `finally`, :1450 `M832`) |
| rest check (#599) | `execute.ts:1193–1196`: `Probe: 1` → Stop "reads touched at rest" | `M119` |
| probe length | `execute.ts:1197–1198`, `PROBE_TIMING` quiet 20 s (:93, #563) | `M491` → last `[PRB:…:1]` is `probeRefZ` |

### 1.4 Mount tap — one touch on the fixed-jaw top (v2 step 2)

Only when the plan carries `mountTap` AND an expected Z (`execute.ts:1211–1212`). `mountTapFor`
(`mountContext.ts:301–336`) computes the point from the bed profile's vise frame (`viseTapPoint`),
`expectZ = mountDatumFor(machine)?.jawTopZ` (:333). `mountTapTouch` (:670–704), two-stage (#615):

`G53 G0 Z<travel>` → `G53 G0 X Y` (machine XY) → `?`…Idle → `G91` → `G38.3 Z-<to expectZ+park> F<fast>`
(`missOk`) → if miss `G38.3 Z-<to floor = expectZ−2> F<touch>` → `G0 Z3` → `G90` → `M119` (must read
open, :698–701) → `G53 G0 Z<travel>`. Reading must be within ±2 mm of the stored datum
(`MOUNT_TAP_SLACK_MM`, :655, :1216); a touch outside says where it touched (#633, :1222–1227).

### 1.5 Find the surface (v2 step 3a)

`seekSurface` (`execute.ts:546–591`): `G53 G0 Z<fromMachineZ>` → `G90` → `G0 X Y` (work XY; the
bracket uses `G53` via `moveXY` :297–300) → Idle → `G91` → `G38.3 Z-<travel> F<surfaceFastFeed>` →
`inBand` (:497–514) → `G0 Z1` → Idle → `G38.3 Z-<surfaceSlowSeekMm> F<surfaceSlowFeed>` → `inBand` →
`G90`. Band: planner's `seek.band` (`plan.ts:447–451`) — on the datum path the floor is
`jawTopZ − surfaceToleranceMm` (a SEARCH), the ceiling is widened to `jawTop + thickness + tolerance`
(`datumCeiling` :522–526, #619/#633). Travel is capped by `surfaceSeekMm` (`plan.ts:455–461`).
Typed-seat path only: a miss offers ONE guarded deeper search (`seekDeeper` :614–647, operator prompt
`search-lower` :1275–1283).

### 1.6 Find the edges (v2 step 3b)

Park: `G53 G0 Z<surface + parkAboveSurfaceMm>` (:1316–1317). Then per scan (`plan.ts:665–666`: vise
rectangle = ONE left scan at mid-Y + ONE front scan at mid-X):

`scanEdge` (:344–381), bracket-and-bisect (#594): touch at `start` (3 mm inside the expected edge);
if stock → touch at `limit` (5 mm outside); bisect `on`/`off` until `|on−off| ≤ fineStep/2`. A first
touch that MISSES uses the surface point as the known-on (#593, :364–368). Each `touch` (:310–330):
`G0 X Y` → Idle → `G91` → `G38.3 Z-<park+cap> F<touchFeed>` (`missOk`) → `G90` → `G53 G0 Z<park>`;
`classifyTouch` (`readings.ts:43–47`) → stock / above / below / miss by `surfaceBandMm`.

With the 3D probe (`probeInstrumentOf(plan.probe) === 'xyz'`, :1328–1333) the FRONT/BACK edges of a
vise go sideways (`scanEdgeSideways` :394–477; `probe3d.ts` owns depth, ledge clearance and the ball
offset); LEFT/RIGHT keep the Z-only scan (`sideTouchAllowed`, `probe3d.ts:93–95`).

### 1.7 The cut-extent spread (#475) and the plane fit (#608/#631)

After the scans (#591): four more `seekSurface` calls at the cut area's extents, offset by the found
XY (:1381–1418), approached from `max(band.max, slow.z) + park` (#632, :1364), floor = the same band
floor. `assessSurfaceReadings` (`surfaceSpread.ts:669+`): least-squares plane; `ok = residual ≤
band.width`; verdict `dome` (residual > band) / `tilt` (plane holds, max axis drop > band) / `flat`.
Z0 = the LOWEST touch (`Z0_REFERENCE`, `surfaceSpread.ts:64`; `execute.ts:1432`).

Then `G53 G0 Z<travel>` → `$H` (:1421–1423) → `M832`.

### 1.8 Show it, record it

`EngraveRegistrationStep.tsx:503–615`: on a usable in-margin result the vise frame, the surface-top
datum and the jaw-top datum are written to the machine record in ONE save (`createFirstBed`,
`withVisePlacementFrame`, `withSurfaceTopDatum`, `withViseJawTopDatum`, :540–568); the probe's
M491/M119 go on the probe accessory (`recordProbeReading`, `mountContext.ts:128`); the tap on the
vise accessory (`recordMountReading`, :151). Out of margin → nothing written until the operator
presses **Use the found position** (#620/#638).

### 1.9 Cutter in, write the origin (v2 step 4)

`applyCorrection` (`execute.ts:1570–1610`): refuses an unusable outcome or `confirmed !== true`;
`$H` → prompt `fit-cutter` (a real prompt, :1597) → `M491` (20 s quiet) → `G10 L2 P1 X Y Z` with
`Z0 = surfaceZ + (cutterRef − probeRef)` (`outcome.ts:500–507`) → `$H`. The step then records
`{plane, z0}` when the verdict was a tilt (`surfaceFitForPost`, `EngraveRegistrationStep.tsx:704–712`).

### 1.10 Re-post (#608) and the gates

`EngraveCutSurface.tsx:481–512`: once the registration records a tilt, `repost()` runs generate →
verify → simulate → oracle with the plane and re-freezes — automatically, once per clamping (#656).
`surfaceRepostBlocker` (`engraveRunGate.ts:575–596`) refuses release while the frozen package's
`surface` differs from the registration's, both directions (#635). A dome adds `domeG32Blocker`
(`EngraveCutSurface.tsx:469–472`): tick "G32 run from the console" or "accept the un-levelled floor".

### 1.11 Branch count for the default badge-in-vise job

Forks the default job passes through (the alternative it does NOT take in brackets):

Planner (`plan.ts`): probe tip measured [null → refuse :411]; no corner [corner mode :426–442,
:634–663]; datum seek floor [typed-seat band :447–450]; vise [bracket :489–559 / tape :664];
proud from the datum [`fixtureBelowSurfaceMm` legacy :566]; proud > 0 [recessed/`jawAboveStock`
:594–610]; tolerance-reaches-jaw note [legacy stop :581]; rectangle [disc :616–633]. **8 forks, 8
roads not taken.**

Executor (`execute.ts`): no bracket confirm [:1199]; mount tap present with expectZ [no tap :1212];
tap in slack [touched-outside / miss stops :1216–1232]; `typedSeat` false [deeper search :1260–1291];
proud note [none]; per scan Z-only [sideways :1328–1333]; scan start = stock [start miss → inward
:364–368; above → stop :352]; spread present [none :1357]; verdict tilt [flat / dome].
**9 forks, ~10 roads not taken.**

Not reachable from this job at all but present in the module: reference scans (#429,
`references.ts`), disc (#743), corner (#525/#827), centre-find bore/boss (`runCentreFind` :827–990),
rotary chord tap (`runRotaryTap` :1043–1159), bracket tap (`bracketTapFor`, dormant until
`bracket.armTopMm` is measured, `mountContext.ts:346–353`), facing re-touch (`retouchSurface`
:1472–1555; facing is refused on plastic), standalone `runMountTap` (:715–761).

---

## 2. Compared with the 2026-10-17 procedure that cut

`docs/bench/2026-10-17-single-barrel.md` "Routine as run": `power.sh on` → `$H` → probe in →
`M491` → surface at a clean point (relative `G38.2`) → edge scans by script (front/back with a 0.6
band, MISS as the hard edge) → centre touch → `G10 L2` XY → `$H` → jaw top + the regions' extents →
cutter in → `M491` (PRB read from the trace) → `G10 L2` Z → upload → `M331` → play. Z0 was chosen by
hand (ridge peak − 0.2). Result: rough pass clean; the second colour "patchy — it could have been
deeper". The blank was DOMED 0.21 over the cut area / 0.6 across the width. The evening laminate
V-carve, same recipe, "clean floors … first try".

What v2 adds that is REQUIRED for a clean cut on a vise-held blank:

1. **X/Y from the blank as clamped.** The 10-17 blank sat 7 mm further back than the day before and
   the origin was re-written by hand from scans; the 10-24 app run found Y off by 6.38 mm the same
   way. The left + front edge scans and `G10 L2 P1 X Y` are not optional — the 10-17 recipe did them
   too, by script. (Rotation is only measured on tape, two left touches; the vise's fixed jaw is
   trusted for it — `plan.ts:31`, `outcome.ts:244–255`.)
2. **Z0 from a measured top with the cutter/probe `M491` delta** — identical to 10-17 (`cutterZ0`).
3. **A bounded search, not a dive.** 10-17 used `G38.2` with hand-chosen travels; the executor's
   caps (`capBelowSurfaceMm`, the band floor, `MOUNT_TAP_FLOOR_MM`) and `G38.3` (#518) are the
   difference between a reading and an alarm. Required for an unattended app, not for a scripted
   bench.
4. **`M119` rest check** — one cheap line that stops a PROBE_FAIL dive on an unplugged probe (observed
   2026-10-23). Keep.

What is precision beyond the job's need, or at least beyond what 10-17 needed:

- **The mount tap as a prerequisite** (#598/#599/#613/#614/#617 — five issues of plumbing). It
  measures the jaw top so the surface seek can be a search down to `jawTop − tol`. The same safety
  could come from the vise constant plus the stock thickness as a floor (the typed-seat path already
  has the 2 mm-below-seat guard, `SURFACE_RECOVERY_BELOW_SEAT_MM` :603). The tap is cheap at run
  time (~5 s with #615) but it drags in bed profiles, accessories, check-out and provenance before a
  first touch is allowed.
- **The five-touch plane fit and the re-post.** On the 10-24/25 badge the fit read 0.75–0.82°
  (0.34–0.37 mm toward +X and +Y over the cut extents, spread 0.43–0.47) against a 0.2 mm depth band.
  With a 1.0 mm programmed depth into a ~0.3 mm colour plane, a 0.47 mm drop across the blank WILL put
  one end outside the band — so for THAT clamping something had to give: re-post, G32, or a flatter
  seat. The re-post worked once (10-25: oracle 0/0, cut legible). But 0.8° in a low-profile vise is
  not a "normal" blank: it is a blank sitting on a chip or riding the ledge on one side, and the
  10-17 blank was domed rather than tilted. The honest first answer to a tilt > band is the one the
  stop sentence already gives for an extent miss ("loosen the vise, press it down on that side,
  re-clamp", `execute.ts:1375–1380`); the re-post is the right SECOND answer. Today the UI goes
  straight to the automatic re-post (#656 chain) and never suggests re-seating when the fit succeeds.
- **Dome handling** (G32 recipe, operator-accepted floor, the whole-blank-bow vs top-only-dome
  assumption text, #501/#631) — correct physics, but G32 is unproven on the Z1 (#501 open, Q13) and
  the caliper check that decides the physics for this badge was never taken (#569, #631 both say so).
- **Repeatability already measured:** runs 1 vs 3 (10-24) identical to 0.004 mm; runs 5/6/8 agree to
  ≤ 0.015 mm per point; X/Y offsets within 0.1 mm across probe re-fits (`2026-10-24-datum-path-bench.md`).
  The wired Z-only path is repeatable well inside the 0.5 mm margin — the remaining scatter is the
  blank, not the probe.

Bottom line for §2: the required additions over 10-17 are the edge scans + `G10 L2` XY, the Z0 delta,
`G38.3` with caps, and `M119`. The mount tap and the plane fit/re-post are precision/robustness that
the badge's own geometry (band 0.2, tilt 0.47) made necessary once the clamping was accepted as-is;
a flatter clamping (parallels, press-down) would have made them optional.

---

## 3. #628 — the oracle after the re-post

- **State on main:** fixed by `830054ae` (the column engine un-lifts the surface-frame program
  instead of seating the stock and lifting the grid per cell; #628 comment 2026-10-25 00:40). Closed
  2026-11-02 with a regression pin `69f85601` ("test(oracle): the real bench badge reads 0/0 in the
  surface frame (#628)").
- **Test that reproduces the 2026-10-25 numbers:** `tests/unit/engraveOracleSurface.spec.ts:309`
  "#628 the REAL bench badge job, re-posted against the 0.817° plane, reads 0/0 in the surface frame"
  — the plane is the run-6 fit (`offset −54.73947, slopeX −0.013348, slopeY −0.005035, z0 −55.466`,
  :121–128). The commit message states the control: the same lifted text judged in the WORK frame
  reads 302.45 mm² under at Z −0.985 — the bench's wrong-frame signature — so the test has teeth. The
  synthetic case at :256 (non-zero z0/offset plane on the V job) also fails on `264b3df8`'s code per
  the issue. The exact 1.66 / 75.5 numbers are reproduced in the issue's investigation comment
  (`#628` 2026-10-25 00:24, to four decimals), not pinned as a failing assertion — the pin asserts the
  FIXED value (0/0) and the wrong-frame control.
- **Run:** `npx vitest run tests/unit/engraveOracleSurface.spec.ts tests/unit/registrationSurfaceSpread.spec.ts
  tests/unit/engraveRegistrationStep.spec.tsx` in the Linux clone → 3 files, 41 tests passed (8.8 s).
- **Not "simulated only":** the fix was bench-confirmed on 2026-10-25 12:50–13:46 (run 9 on
  `29d0018c`: re-post → "under-cut 0.0000 / over-cut 0.0000, in the blank's fitted surface frame" →
  Upload → the cut). What IS still unmeasured is the physical depth (calipers centre vs ends, #569).

---

## 4. Bridge robustness

### 4.1 The 3 s "no reply within 3000 ms" on long `G53` moves and `$H`

- The 3000 ms is `openConsole`'s compiled default (`protocol.ts:1841`) and the bench harness's
  default (`tools/z1/z1.mjs:216` `--first-reply 3000`). Every timeout in
  `docs/bench/traces/2026-10-31-probe-bore.log` (lines 20, 22, 54, 68, 261, 409, 601…984) is the
  HARNESS: `G53 G0 X-186.2 Y-180` (a long rapid), `G91 G38.3 Z-30 F200` (9 s of travel), `$H`, and
  every sideways `G38.3 X±6 F60` (6 mm at F60 = 6 s). The controller answers `ok`/`[PRB]` only when
  the move ends.
- The app's console does NOT use 3 s: `attachConsole` sends with the shop's `console.firstReplyMs`
  (60 000 fallback, `machineConsole.ts:65, :106–113, :291`). Bench runs 4–9 homed and probed through
  the executor without a timeout.
- Two gaps in the app anyway: (i) the executor's `idle()` poll (`execute.ts:221–227`) calls
  `send('?')` with NO timing, so it inherits the 60 s window instead of `STATUS_POLL_TIMING`
  (`machineConsole.ts:72`, 3 s + 2 s headroom) — a silent link costs 60 s per poll, up to
  `idlePollLimit` 30 polls; (ii) `$H` is awaited as a normal line (`:1181`, `:1422`, `:1592`, `:1604`)
  and a `timeout` kind is a `Stop` (`:195`) — the run is hostage to the `ok` arriving within 60 s
  (bench: ~31 s). Neither is covered by a test; `machineConsole.spec.ts:178, :207` cover the timeout
  mapping only.
- Bench: executor `$H`/`M491` timing confirmed by every completed run; the 3 s figure is a harness
  default and should be raised there (`z1.mjs:216`) or passed per command.

### 4.2 `ALARM: unexpected probe trigger` on a `G0` after a sideways `G38.3` (#790)

- Handled with `G38.5 <axis>±3 F100` (probe-away) ONLY in `runCentreFind` (`execute.ts:879, :908,
  :932–934`) and `runRotaryTap` (`:1081, :1098, :1135`).
- NOT handled in the registration path: `scanEdgeSideways` `:436` (G0 after a touched descent) and
  `:457–458` (`G90` then `G53 G0 Z` straight after the sideways contact); `touch()` `:323–324`;
  `seekSurface` `:579` (`G0 Z1` between fast and slow); `mountTapTouch` `:696` (`G0 Z3`). The wired V2
  is a mechanical switch and tolerated this on the bench (runs 4–9); the 3D probe stays deflected and
  alarms (bench 10-30/10-31). #790's triage comment (2026-11-02) lists the same sites.
- Tests: `centreRun.spec.ts:139` and `rotaryTapRun.spec.ts` assert the release; nothing asserts it on
  the sideways registration scan. Bench: the app's sideways scan has never run on the machine.
- Also: the 10-31 alarm (log :495–503) followed a malformed `G91 G38.5 X0 Y F100` (`error:at least one
  of X Y or Z must be specified`) and then a `G53 G1` — the release never happened. A `G38.5` with a
  zero travel must be refused before the wire.
- Wording: `protocol.ts:607–630` `HALT_WORDS[3] = 'a probe touch did not trigger'`, but #790 reports
  `H:3` with `ALARM: unexpected probe trigger`. One of the two is wrong for the retract case; check
  `Kernel.h`'s enum before the popover (#659) prints it.

### 4.3 "Unexpected probe trigger" / alarms in general

`session.send` (`execute.ts:196–200`) stops on any `error:` and any `ALARM` in the reply OR in the
carried text, except a `Probe fail` on a `missOk` line. `stopped()` (`:258–285`) reads `?` and sends
`$X` only when the State word is `Alarm` (#588, `1b9ffbe7`), then `G90` if relative, and tells the
operator how low the probe may be. Tests: `engraveRegistrationStep.spec.tsx:635–693` (alarm at M491,
Idle stop without `$X`, alarmed relative stop with exactly one `$X`). Bench tick for #588 still open
in #767.

### 4.4 Network drop (#304/#499)

- A CLOSED socket: `tcpRead` rejects ("the machine closed the connection", `machine.rs:239`) →
  `machineConsole.ts:292–301` drops the session and returns `kind: 'error'` → `Stop`. The next line
  opens a fresh session (no re-send by design). A SILENT link (WiFi stack gone, TCP not closed — the
  #304 shape): each line waits its full window; see 4.1.
- No executor test for a mid-run drop; `platformMachineProtocol.spec.ts:523` covers the upload's
  inactivity cancel. Bench: drops observed 2026-10-08 only; 2026-11-01 the machine "joined the network
  first time" (#767 comment). #304/#499 remain open watches; USB serial (#775) exists as a second
  transport but no cable is on the bench.

### 4.5 Reconnect (#586)

Fixed: `EngraveCutSurface.tsx:151–166` (the `Step`'s `manual` resets when `current` changes);
`cutSurface.spec.tsx:784–806`. Bench tick pending (#767). The machine heartbeat
(`machineHeartbeat.ts`) is what flips online/offline.

### 4.6 Stop / abort semantics (#588, #424)

- The registration step's **Stop** button answers a PENDING PROMPT only (`EngraveRegistrationStep.tsx:
  874–882` `answer(false)`; unmount cancels only a pending prompt, `:313–328`). There is no mid-motion
  stop in a registration run: a `G38.3` in flight finishes on the controller while the app waits.
- The program stop (`machineStop.ts`) sends the console word `abort`, waits Idle, then `M332`; it
  refuses in alarm and sends nothing to an Idle machine (`machineStop.spec.ts:45–84`). The realtime
  halt byte is deliberately not used (`Z1-Bridge-Protocol.md` §8/§9, line ~170).
- Not bench-proven: whether `abort` cleanly stops a `G38.3` in flight (it drains the queue ~18 s for a
  program; a probe move is one line).

---

## 5. Executor safety

- **Hit vs miss:** `lastPrb(reply)` (`readings.ts:32`) — the controller's `[PRB:x,y,z:flag]`; flag 0
  = travelled the whole distance (a miss under `G38.3`, machine stays Idle); null = no PRB at all →
  Stop "answered no probe reading" (`:321`, `:434`, `:459`). Surface seeks: `inBand` (`:497–514`) —
  miss stops (unless typed-seat `missOk`), a touch outside `[band.min, ceiling]` stops. Scan touches:
  `classifyTouch` (`readings.ts:43–47`) by `surfaceBandMm` around the measured surface; `above` stops
  unless `aboveIsEdge`.
- **Travel caps:** surface seek `fromMachineZ − band.min ≤ surfaceSeekMm` (planner refuses otherwise,
  `plan.ts:455–461`); slow seek `surfaceSlowSeekMm ≤ lift + 1` (`settings.ts:133–138`); scan touch
  `park + capBelowSurfaceMm` (`:319`); mount tap floor `expectZ − 2` (`:654, :1214`), standalone tap
  to the work-envelope floor (`:743`); extents from `max(band.max, slow.z) + park` to the band floor
  (`:1364, :1390`); sideways descent is a GUARDED `G38.3`, not a `G0` (#643, `:412–431`).
- **Recovery:** `stopped()` as in 4.3; the step then `homeAfterStop` (`EngraveRegistrationStep.tsx:
  379–395`: `?`, `$X` only if Alarm, `$H`). Idle before every probe (`io.idle()`), bounded by
  `idlePollLimit`.
- **Motion the operator did not confirm at the moment it happens:** pressing **Start registering**
  homes and moves at once; the executor's `fit-probe` prompt is auto-answered by the step-1 statement
  ticked earlier (`EngraveRegistrationStep.tsx:401–403, :454`; #797). The bracket's `confirm-mount`,
  the typed-seat `search-lower` and `fit-cutter` are real prompts. The automatic re-post chain (#656)
  moves nothing. `applyCorrection` requires `confirmed: true` and a usable outcome (`:1585–1590`).
- **Probe identity / tool number / TL0 / supply:** the executor never sends a `T` word; `T9999`
  (wired V2) and `T8888` (3D) appear only as display words (`machineToolWords.ts:5–6`,
  `probeFitDiagram.ts:13–14`, `MachineStatusStrip.tsx:408`). `M491` keys off the controller's active
  tool (`Z1-Firmware-Dialect.md` §11.9); its `[PRB]` is the Z0 reference, and the 8.95 mm length
  difference between the probes (and every cutter re-fit) is absorbed by `cutterZ0 = surface +
  (cutterRef − probeRef)` (`outcome.ts:500–502`) — the bench saw Z0 move 2–4 mm between re-fits with
  the cut landing right. TL0 is never read (`M499` is only mentioned, `protocol.ts:725`); `G10 L2`
  resets the TLO reference (dialect §11.12), which is why the order is cutter-in → `M491` → `G10 L2`.
  A datum tapped by one probe cannot anchor a plan with another (`mountContext.ts:183–191, :210–212`,
  #611). `M831`/`M832` bracket every probe session (`:105–106`, `:1190`, `:1450`, also centre/rotary/
  re-touch). The planner refuses a checked-out probe with no measured tip (`plan.ts:411–419`); the 3D
  probe's tip (0.875 mm effective radius, #790 2026-10-31) is a bench number not yet on the accessory.

---

## 6. UI / state: the stale-package / freeze / re-post chain

`EngraveRegistrationStep` phases: `idle | running | measured | writing | recorded | failed`
(`:128`). `measured` subdivides into: usable + within margin → **Write the origin** (`:1026–1038`);
usable + margin only → **Use the found position** (`:1055–1062`, #620); unusable → **Run it again**
only (`:1090`); disc question pending (`:933–1048`); and the spread verdict flat/tilt/dome with the
G32 route / accepted-floor text (`:974–1024`). The Cut surface: `currentStep` 1/2/3/0
(`EngraveCutSurface.tsx:730`), `frozen = packageCurrent && !mountMismatch` (`:718`), the run store's
`phase` idle/generating/simulating/checking/ready/blocked (`engraveRunGate.ts:59`) with `staleSince`
+ `staleReason` job/machine/margins/shop/feeds/catalogue/cutters/surface (`engraveRunStore.ts:
1096–1183`), `surfaceRepostBlocker` (3 sentences) and `domeG32Blocker`. Counting only the states an
operator can be parked in at the Cut step: ~6 step phases × 4 measured sub-states + 4 package states
(none / current / stale / mount-gone) + 4 surface-gate states + 2 dome ticks ≈ 20 distinguishable
screens between "Start registering" and "Upload".

Which bench runs got stuck where (from the issues and `2026-10-24-datum-path-bench.md`):

| run | stuck state | issue → fix |
|---|---|---|
| 10-23 run 2 | `failed` after an extent miss; 58 s silent park; wrong "$X" advice | #588 → `6f23b626`, `1b9ffbe7` |
| 10-23 reconnect | step ③ folded after "Machine back online"; Start invisible | #586 → fixed, bench tick open |
| 10-23 runs 1–4 | seat band / inward scan / extents before edges | #585/#593/#591/#590 → v2 |
| 10-24 run 2 | `failed`: surface −55.033 ABOVE the band (blank 1.77 proud) | #619 → `datumCeiling` |
| 10-24 runs 1, 3 | `measured`, X off 0.83 / Y off 6.38 > 0.5 margin; no origin possible | #620 → Use the found position |
| 10-24 run 4 | after Use the found position: steps 1/2 "stale" | #621 → `cfb56150` |
| 10-24 run 4 | re-post → Upload disabled: under-cut 301 mm² (work frame vs lifted file) | #623 → `c7920af7` |
| 10-24 run 5 | after Write the origin: "package stale — the job or the machine frame changed" | #627 → `3f1278a1`, bench tick open |
| 10-24 runs 5, 6 | re-post → 1.63 / 1.66 mm² under, 74–75 mm² over (column engine) | #628 → `830054ae`, bench-confirmed run 9 |
| 10-24 runs 7, 8 | DOME verdict → "not usable", only Run it again | #630/#631 → G32 route + accepted floor |
| 10-25 run 9 | run step `Tool · 0 %` with no prompt (firmware Tool state after `T1 M6`) | #655 → closed |
| 10-25 | "over 7 minutes with nothing happening" — six confirmations across three screens | #656 → auto re-post chain |

---

## 7. Assessment

### (a) Converging or growing?

The vise + wired-probe + datum path CONVERGED on 2026-10-25: nine bench runs, a written origin, a
re-post that passes the oracle, a legible cut. Since then the module has grown SIDEWAYS, not deeper:
`git log` shows ~60 commits on `registration/` since 10-15, and the post-cut ones add instruments and
mounts — 3D-probe sideways scans and corner mode (#525/#827), bore/boss/round centre-find (#827),
disc rims (#743), drilled-hole references (#813), two-setup PCB flips (#743 P-8), the rotary chord
tap (#607), the bracket tap (dormant), the probe supply (#789). None of those has run through the app
on the machine, and the sideways path carries a known alarm defect (#790). The umbrella #592 is still
open with its design doc's "Open:" line stale (#592 triage). So: the core is done and repeatable; the
surface area is still growing faster than the bench can prove it.

### (b) The minimal registration to ship for milestone 1

One procedure, one probe, one mount: **vise, wired V2 probe, rectangular blank, datum path**, exactly
the run-9 sequence — `?` Idle → `$H G54 G92.1` → `M831` → `M119` → `M491` → jaw tap (two-stage, ±2) →
surface search → left + front bisect scans → five extents → `$H` → `M832`; verdict flat/tilt/dome;
Write / Use the found position; cutter `M491` → `G10 L2` → `$H`; tilt → the automatic re-post; dome →
the operator-accepted floor (not G32, see below). Keep #620, #656 and #638's write-back order.

Hide or freeze (keep the code, remove the UI entry and the planner's acceptance until each has one
bench run):
- the 3D probe as a registration instrument (sideways scans, corner mode, centre-find, rotary tap) —
  blocked on the #790 release fix and the radius on the accessory;
- bracket and tape mounts (the bracket tap is dormant anyway; tape has no bench run);
- disc and reference (hole) registration, the PCB flip;
- the typed-seat path and its deeper search (the datum path makes it the expert override it already is);
- the G32 recommendation text — unproven on the Z1 (#501), and its endpoint-only-compensation risk is
  the exact failure a V-carve would show;
- the facing re-touch (facing is refused on every plastic).
Also change one default: when the verdict is `tilt`, say "re-seat the blank (press down on the low
side) or follow the tilt" before the automatic re-post, since a 0.8° tilt in a vise is a seating
fault more often than a blank property.

### (c) Bridge fixes that must be bench-proven first, in order

1. **`G38.5` release before any `G0`/`G53 G0` after a touched reading** — at `execute.ts:324, :436,
   :457–458, :579, :696` — gated on `plan.probe.instrument === 'xyz'` or applied to both probes once an
   air run shows the wired V2 tolerates it. Also refuse a `G38.5` with zero travel before the wire.
2. **The executor's `?` polls use the status-poll window** (`STATUS_POLL_TIMING`, 3 s + 2 s) instead
   of inheriting 60 s, so a silent link stops the run in seconds, not 30 minutes; and the `$H` wait
   is proven once more on a cold start (auto-home) where the `ok` may not come inside 60 s.
3. **A mid-motion stop for a registration run** — today the Stop button only answers a prompt. Prove
   on the bench what `abort` does to a `G38.3` in flight (spindle off is irrelevant; does the probe
   move stop, does the controller alarm, does `$X` clear it), then wire it.
4. The `HALT_WORDS[3]` wording vs `unexpected probe trigger` — one grep of `Kernel.h`, then the popover.
5. The #767 ticks that cost nothing: #586 fold-open after reconnect, #588 no 60 s park, #627 no stale
   after Write the origin, #615 tap time (already seen: 4:54 vs 5:40).
6. The G54 pre-flight (`workOffset`, `protocol.ts:728`, computed and never called — #567 triage).

### (d) The three riskiest unknowns

1. **The 3D probe path.** Never run through the app; the retract alarm is known and unfixed in the
   registration scans; the effective radius (0.875 mm, from an outside width; 0.83 from a bore; the
   0.15 in #790's body was the WIRED probe) is not on the accessory, so the planner would refuse — or,
   if a number is typed, every sideways edge is off by the radius error. Repeatability 0.004–0.02 mm
   is good; the correction is the unknown.
2. **Dome vs tilt physics on printed blanks.** The whole chain (plane re-post vs G32 vs accepted
   floor) rests on whether the colour plane bows with the blank or lies flat under a domed top. The
   10-17 blank was domed (patchy reveal); the 10-24/25 blank read tilt or dome on 0.01 mm of noise
   (#630); the one cut that could decide it (calipers, centre vs ends, #569/#631) was never measured.
   G32 itself is unproven on the Z1 and may compensate only at move endpoints (#501 Q13).
3. **The link under a silent drop, mid-motion.** #304's shape (IP gone, TCP not closed) meets an
   executor that waits 60 s per line with no abort path and a controller that finishes the queued
   `G38.3` on its own. Nothing tests it; the bench has not reproduced a drop since 10-08. Second
   order: the run's hard dependency on `$H` answering `ok` within `console.firstReplyMs`.

---

### Appendix — files read

`docs/design/registration-flow-v2.md`, `cut-this-blank-wizard.md`, `bed-profiles.md` (§0–§2 and headings),
`z1-accessory-install.md` and `status-strip-dro.md` (headings); `Z1-Firmware-Dialect.md` (§11.2, §11.9,
§11.12 via grep), `Z1-Bridge-Protocol.md` (§8/§9 via grep), `docs/reverse/makera-studio/03-commands-homing-probing.md`
(:20–50); `docs/bench/2026-10-17-single-barrel.md`, `2026-10-24-datum-path-bench.md`,
`traces/2026-10-31-probe-bore.log`; `src/engine/cnc/registration/{plan,execute,probe3d,outcome,readings,
mountContext,settings}.ts`, `setups/registration.ts`, `engrave/surfaceSpread.ts` (verdict code),
`platform/desktop/{machineBridge,protocol}.ts`, `platform/machineConsole.ts`, `platform/machineStop.ts`,
`platform/defaultsClient.ts` (seeds), `src-tauri/src/machine.rs` (grep), `src-tauri/src/defaults.rs` (seeds),
`store/{engraveRunGate,engraveRunStore,engravePackageStore,engraveRegistrationStore}.ts`,
`components/panels/{EngraveRegistrationStep,EngraveCutSurface}.tsx`, `tools/z1/z1.mjs` (:216);
specs `engraveOracleSurface`, `registrationSurfaceSpread`, `engraveRegistrationStep`, `cncRegistration`,
`machineConsole`, `platformMachineBridge`, `platformMachineProtocol`, `machineStop`, `centreRun` (headings);
issues #304 #391 #430 #496 #499 #501 #525 #563 #567 #569 #570 #584 #585 #586 #588 #592 #593 #594
#598–#608 #613–#618 #623 #627 #628 #630 #631 #647 #655 #659 #689 #767 #790 #882 (bodies + comments).
