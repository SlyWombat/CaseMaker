# Driving the engrave→registration flow in the web UI — beginner-UX notes (2026-10-22)

Observations while driving the proven badge job (`single-pla`) through the :8000 web UI to a
registration probe, from a beginner's point of view. The build is `fca5a8fa` (#571 web machine
bridge + #572 cutter override live). Goal: the path from "open a job" to "probe the blank" should be
obvious with no insider knowledge.

## The happy path actually requires this order (not obvious)
1. Open project → **Engrave text** section → **Open job…** (loads `single-pla`).
2. **Connect the machine** (Manage → address → Connect) — easy to miss; registration later just says
   "no machine" with no pointer back here.
3. Design tab → **cutter** is refused (metal bit on PLA) → **#572 override** (two-step) to unblock.
4. Design tab → **Generate toolpath**.
5. Design → **Setups** → **plan the registration** → **approve it**. ← the hidden step.
6. Cut tab → ① Check ✓ → ② **Freeze the plan** → ③ **Register the blank** → run the probe.

## Friction points a beginner hits (ranked)

- **F1 — "Plan its registration in Design → Setups, approve it, then run it here."** Cut step 3 is a
  dead end until you go BACK to Design → Setups, plan+approve, then return to Cut. A beginner reading
  step 3 has no button to press there; the instruction is the only breadcrumb and it points to a
  different tab/section. The register step should offer to plan+approve inline, or deep-link to it.
- **F2 — Connect-the-machine is decoupled from the flow.** Nothing in the Design/Cut steps prompts
  "connect a machine first"; you only discover it when registration says there's no machine. The Cut
  flow could carry a "① connect your machine" affordance.
- **F3 — The cutter refusal is a hard stop with no in-context recovery before #572.** Generate is
  just disabled with "Fix the errors above first"; the actual error is behind a "show" toggle. #572's
  "Use this cutter anyway" helps, but the error→show→override path is several clicks deep.
- **F4 — Section vs tab navigation is confusing.** Left rail (Part/Export/Engrave text/Simulate .nc)
  vs the in-panel Design/Cut tabs vs the top-bar Manage overlay. Entering Manage swaps the left rail
  entirely (House/Machines), and leaving it is a non-obvious toggle. A beginner loses their place.
- **F5 — "no-plan" wording.** Cut step 3 shows a bare "no plan" state; the reason ("plan it in Design
  → Setups") is easy to miss as body text.

- **F6 — Ordering trap: plan/approve AFTER generate invalidates the freeze.** If you Generate, then
  go to Setups and approve the registration plan, the frozen package goes stale ("Save is disabled —
  the job or the machine frame changed since it was generated") and you must re-generate/re-freeze.
  The only order that doesn't bite: override cutter → Setups plan+approve → Generate → Freeze →
  Register. Nothing tells a beginner this order; they'll loop through stale-package warnings.
- **F7 — The registration plan is buried in a Setups sub-panel.** The approve control
  (`engrave-setups-replan` → `engrave-setups-use-plan`, i.e. "replan" then "use plan") is small, in a
  Setups accordion, and the words "replan"/"use plan" don't read as "plan the probe / approve it".
- **F8 — Easy to lose which tab you're on.** After approving in Design → Setups, returning to Cut and
  finding step 3 is manual; the app doesn't walk you forward (no "next: register" affordance). For a
  beginner the steps feel like a checklist with no guide between them.

## The one-line takeaway
The *capabilities* all work (connect, override, generate, plan, approve, freeze, register) — but the
**sequence and the cross-tab hops are insider knowledge**. An intuitive version would be a single
guided "Cut this blank" wizard that: connects the machine, offers the cutter override in place,
generates, plans+approves the registration for you (seat-Z already known from the vise), freezes, and
lands you on "put the probe in and press Start" — in that order, without the operator hunting across
Design/Cut/Setups/Manage.

(extended as the run continues)

## 2026-10-23 bench — the #567 registration probe, first live run on ce6ffe68

- Z1 dropped off the LAN overnight (plug on); `power.sh on --cycle` brought it back in 11 s.
- Cut panel step ③ was a folded `<details>` after the reconnect — three Start presses landed on nothing (#586). Opened by DOM, Start ran.
- Run (07:55:46 → +166 s): home → M491 → cut centre (work 19.05, 38.1 = machine −162.15, −161.03) → fast seek → **stopped: "found nothing down to machine Z −51.59"** (seat −55 + 3.81 − 0.4), homed. Panel said only "Talking to the machine…" throughout (#587). Filed #585 (seek window on a provisional seat).
- Bench tap on the fixed-jaw top (machine X −186.2, Y −180.0; 5 mm left of the jaw face, mid-blank in Y), wired probe fitted, after M491 in the run above:
  - 1st attempt sent the G38.3 while the XY rapid was still in flight → the firmware halted `H:3` = `PROBE_FAIL` ("probe triggered before move"; Carvera firmware Kernel.h/ZProbe.cpp) and the status read MPos 0,0 with `M119 X_max:1 Y_max:1 Probe:0` — head on the home switches. `$X`, `$H` cleared it. Cause not pinned (the pin read triggered at the pre-move check; clear before and after) — never queue a G38 behind a rapid.
  - 2nd attempt, one line per Idle: `G53 G0 Z-40` · `G53 G0 X-186.2 Y-180` · `M119 → Probe: 0` · `G91 G38.3 Z-20 F150` → **stopped at MPos Z −56.8178** (contact; the cap was −60) · `G0 Z3` → −53.818 · `M119 → Probe: 0` · `G53 G0 Z-5` · `$H`.
  - **Fixed-jaw top = machine Z −56.82** (probe TLO as set by the run's M491). Seat (ledge, 3.1 mm down, calipered 2026-10-15) ≈ **−59.92**; badge top (3.81 mm) ≈ −56.11. Trace: `docs/bench/traces/2026-10-23-jaw-tap.log`; frames: `docs/bench/img/2026-10-23-register/camera-jaw/`.
- Badge-top tap at the cut centre (machine X −162.15, Y −161.025 = work 19.05, 38.1), same probe fit (TLO 0.046), one line per Idle: pin clear · fast `G38.3 Z-20 F150` → **−54.985** · `G0 Z1` · slow `G38.3 Z-2 F50` → `[PRB:-162.150,-161.025,-54.982:1]` · pin clear · `$H`. **Badge top = machine Z −54.98** (raw MPos). It stands 1.84 mm above the jaw top (−56.82) — the blank does not sit on the ledge bottom (the ledge arithmetic would have put it 0.7 above). Seat for Setup 1 = −54.98 − 3.81 = **−58.79**. Trace `docs/bench/traces/2026-10-23-badge-top-tap.log`; frames `img/2026-10-23-register/camera-top/`.
- **Run 2 (12:19:31 UTC, seat −58.79 typed):** home → M491 → spread touches (#475) at Y 38.4: centre (19.05) **−55.0**, (19.55) **−55.03**, left extent (5.6) **−55.14**, right extent (33.5) **nothing down to −55.38** (band floor) → parked there ~60 s ("Talking to the machine…") → homed. Stop sentence: "the fast surface touch found nothing down to machine Z −55.38 … (the surface touch at the cut area's right extent) … the machine may be in alarm. To recover: $X …" — it was not in alarm; it had homed itself. Finding: the badge's moving-jaw end sits > 0.4 mm below its centre (tilted blank); the left half is flat within 0.14. Reseating the blank, then re-run. Frames `img/2026-10-23-register/camera-run2/`.
  - Frames `camera-run2/frame-0009` (08:22:04) and `frame-0021` (08:22:30) are identical: the probe tip resting at Z −55.38 at the right extent, visually on the badge surface, for the whole park. The surface there is only a hair below the band floor — a 0.4–0.5 mm drop from the centre over 14 mm; a printed badge can be bowed that much (#496), so a reseat may not cure it.
- **Run 3 (12:38):** stopped at the first touch, "found nothing down to −51.89" — the driver's Generate phase had re-planned with the row's default seat (−55). Driver fixed; not a product finding.
- **Run 4 (12:43, seat −58.79, tolerance 0.7):** centre **−55.005**, (19.55, 38.44) **−55.03**, left extent ✓, right extent ✓ (below −55.38, above −55.68 — the ±0.4 band WAS the run-2 problem), then the **front extent (19.55, 4.88): nothing down to −55.68**. Frame `camera-run4/frame-0012`: the probe tip is at the badge's END — the blank is clamped ≈5 mm further along the jaws (+Y) than the saved G54 origin says. The spread touches run before the edge scans and trust the saved origin, so a re-clamped blank fails them before the scans can find it. Filed #591.
