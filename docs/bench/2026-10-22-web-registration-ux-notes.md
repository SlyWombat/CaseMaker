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
