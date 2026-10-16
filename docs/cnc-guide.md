# The CNC guide

This is the user guide for Case Maker's CNC work, written for someone who owns a
**Makera Z1** and has never driven a CNC before. It covers the whole workflow: simulating
a G-code file, and engraving text into a printed PLA blank held in the vise — the two-colour
badge is the first job. Chapter 5 says which parts of the engraving side are in the app today.

Two things to hold on to before you read on:

- **Case Maker produces a file. It does not drive the machine.** There is no connection to
  the Z1 here. You export a `.nc` file, upload it to the machine with **Makera Studio**, and
  set the work origin there. Every chapter that could be read otherwise says so again.
- **Case Maker supports the Z1 only.** Carvera and Carvera Air are different machines; the
  app does not model them.
- **On the public site the CNC side is a beta switch.** [electricrv.ca/casemaker](https://electricrv.ca/casemaker)
  hides the Engrave and Simulate sections, the cutting-job door, Manage and this guide
  unless the address carries `?BETA=yes`:
  `https://electricrv.ca/casemaker/?BETA=yes`. Dev builds and the desktop build have it on
  without the switch. The switch does not let a browser reach a machine — nothing can.

For the rest of the app — building cases around boards — see the
[User Manual](https://github.com/SlyWombat/CaseMaker/blob/main/docs/user-manual.md). This
guide is about the CNC side only.

**Every section opens with a status line, and the status is true.** The three values are
**Available** (you can do it in the app today), **Partly available** (some of it works; the
rest is planned, and the rest names its issue), and **Planned** (not in the app yet; the
section describes the design). A planned section is written in the future tense on purpose —
if a sentence says "will", it is not shipping yet. Everything is in millimetres.

---

## 1 · What this is, and what it is not

> **Status: Available** — a statement of scope.

**What it is.** Case Maker can do two CNC things for a Makera Z1: **simulate** a G-code file
you already have (so you can see what it cuts before risking a blank), and **write** an
engraving program for a printed PLA blank — the two-colour badge — held in the vise. Both end
at a `.nc` file on disk.

**What it is not.** It is not machine control. It does not talk to the Z1. You take the
`.nc` file to **Makera Studio**, upload it, set the work origin on the machine, and press
go on the machine itself. Nothing is sent to the machine from Case Maker, ever.

**What is deliberately not built** (from `/Fabrication.md` §9.1 — each is a decision, not an
oversight):

- Machine control over WiFi.
- Automatic probing.
- Autolevelling (`G32`) *in the file*. The printed blank is domed (about 0.33 mm across its
  width), so the job runs `G32 R1` at the machine before cutting and `M370` after — a run-sheet
  step (#176), in the firmware; the `.nc` the app writes is unchanged.
- 3D surfacing.
- V-carving.
- Laser work.
- The 4th axis.
- Multi-tool jobs.

> **⚠ Safety.** The simulation assumes a **rigid, ideal machine**: no deflection, no runout,
> no Z-chain error, no chatter. It does not know about a clamp you added, a cutter you fitted
> differently, or a blank that is not the size you typed. A simulated file that looks clean is
> still a file cut by a real machine on a real block. **Never run a job unattended**, and keep
> your hand on the stop.

---

## 2 · The machine, and what you need

> **Status: Available** — reference.

**The Makera Z1** (from `/Fabrication.md` §1; figures are Makera's own machine-database row,
not a wiki page):

| | Makera Z1 |
|---|---|
| Work volume | 200 × 200 × 100 mm |
| Max spindle | 13 000 RPM (150 W, closed loop, 0.01 mm runout) |
| Max feed rate | 1 200 mm/min |
| Automatic tool changer | **none** — you change cutters by hand |

**The three probes.** Three things ship or are sold under nearly identical names, they all
install the same way and plug into the same connector. Makera's pages rate only one of them
for non-conductive material like PLA — and the bench says otherwise, so read the table with
the paragraph under it.

| Probe | Axes | Materials |
|---|---|---|
| **Wired probe** (in the box) | Z only, plus surface levelling and area scanning | not stated by Makera — **measured 2026-10-08: a mechanical tip that triggers on PLA** |
| **3D Probe Rod** (in the box) | X, Y and Z | **conductive only** — the workpiece must be electrically connected to the aluminium table |
| **Makera 3D Probe** (separate accessory) | X, Y and Z | both conductive **and non-conductive** |

**The wired probe is the one in use.** It is a mechanical touch tip — it registers on
contact, conductive or not — and on 2026-10-08 it touched the printed PLA blank five times
with a 0.001 mm spread between slow touches (`/Fabrication.md` decision 8, revised that day).
So the Z touch-off and the surface levelling both use the probe that came in the box, with
nothing to unplug. The **Makera 3D Probe** is held in reserve; the 3D Probe Rod cannot touch
PLA at all.

**The low-profile vise.** The **fixed jaw is on the left**. It locates the part in X and in
rotation, and leaves it free to slide in Y. It mounts with the wasteboard removed. Its
dimensions are published nowhere, which is why the app ships defaults and asks you to
measure your own (chapter 5).

**Cutters: flat end mills only, for now.** A V-bit *couples depth to stroke width* — cut
deeper and the groove grows wider — so a per-label depth control would stop meaning what the
screen says (`/Fabrication.md` §7.4). A flat end mill pockets the glyph region, where depth
is genuinely independent. That is the honest reason the app sweeps flat end mills only; it is
not that a V-bit is worse at small text.

**The console.** Manage → Machines carries a one-line console, collapsed under the machine's card,
in the desktop build only. Type a line, press Send, and the controller's answer appears beside it
with how long it took and how many frames it arrived in; the record is a "Copy transcript" button,
and nothing is written to disk. The panel refuses anything that would change the machine rather
than move it — `config-set`, card writes (`rm`, `mv`, `format`), a reset or reflash (`dfu`, `flash`,
`upgrade`, `reboot`), and transfers, which belong to the verified upload — and it deliberately does
not wire the `!` and `~` realtime bytes. **The physical stop is the stop**: the console has no hold
and no jog, so anything that moves needs a person standing at the machine (chapter 8.4, and
`/Fabrication.md` §8).

**A macro keeps talking after its line is answered.** `M491` runs the tool-length probe for about
fifteen seconds, so its tail — including `ERROR: Probe dead or not set, please charge or set first!`
— arrives long after the reply to `M491` was closed and shown. The panel does not hand that tail to
whatever you send next: it shows it in its own block above the reply, labelled "the controller said
this while no line was in flight", and it is never counted as the answer to the line you just typed
(so a `?` that nothing answered still reads as a timeout, not as "Idle" or "Alarm"). The same rule
runs the other way for anything that decides: a `M331`/`M332` press, an upload, and `z1.mjs run`'s
own checks all refuse on an alarm wherever the controller said it, the reply or the late tail alike.
A transcript copy marks those lines with `(no line in flight)` for the same reason — it is the one
thing in the text that says the line answered nothing.

**One line, one command — the console is not a way to run a program.** The box holds one line, and
so does the controller: paste a program in and it arrives as a single line whose commands all run.
Doing that is what faulted the machine on 2026-10-12 — the spindle kept turning, the front button
did nothing, and cutting the power was the only stop — so a line the controller would run as more
than one command is now refused, and the refusal says so. To run a program, upload it and start it
with `play /sd/gcodes/<file>`, which is how the machine's own software starts one. Progress while it
runs is the `P:<line>,<percent>,<seconds>` field of the status line; the job is finished when that
percent reaches 100 **and** the state reads `Idle`, because `Idle` also appears partway through a
program. The bench harness has exactly that path as one command —
`tools/z1/z1.mjs run <host> <path> --i-am-at-the-machine` polls the status once and refuses to start
anything that is not `Idle` with no alarm, then sends `play` and polls, printing a line per poll and
stopping when the job ends. Ctrl-C there sends `abort`, the word Studio's own grey
Stop sends: the spindle stops at once, the moves it had already queued finish, and the vacuum is
switched off once the controller says that queue is done — because an aborted program never reaches
its own.

---

## 3 · Ideas you need first

> **Status: Available**.

Short, each with a picture.

**The work origin.** The corner every coordinate is measured from is the **top-front-left
corner of the blank**. Z = 0 is on its **top face**, so cuts go to negative Z.

```text
        +Y (away from you)
         ^
         |
         |   top face:  Z = 0,  cuts go DOWN to -Z
   back  +---------------------+  back-left
         |                     |
         |      the blank      |     +X (to the right)
         |                     |
   front +---------------------+  <-- work origin (top-front-left)
        (you)  +Z up out of the page is +Z
```

You do not type this origin into Case Maker as a machine position. On the machine you set
it with Studio and the probe; Case Maker's simulation carries it as an input, tagged with
where it came from (see *Provenance*, below).

**The cutter's radius decides what can be engraved.** The cutter can only reach the part of
a stroke its centre can enter. Anything thinner than the cutter's **diameter** vanishes
entirely, and inside corners come out rounded at the cutter's radius. This is the
morphological *opening* of the glyph (`/Fabrication.md` §7.5). Measured on the bundled
bold sans with a 1 mm cutter (#191): a 4 mm cap height keeps **3.9 %** of its area, 6 mm
keeps **88.9 %**, 10 mm keeps **98.8 %**. Small text does not "look a bit rough" — most of
it is simply gone.

| Cap height | Kept with a 1 mm cutter |
|---|---|
| 4 mm | 3.9 % |
| 6 mm | 88.9 % |
| 10 mm | 98.8 % |

**Depth per label.** Each label carries its own depth. Depth is what decides how deep the
floor of an engraved word sits below the top face. On a one-colour blank it is a look; on a
two-colour blank it is what reveals the lower colour (chapter 6).

**What "simulated" means here.** The app sweeps the cutter along the file's **own moves** and
subtracts the result from the stock. It is **exact for a flat end mill cutting at a constant
depth**. Material updates at a limited number of points along the program; between those
points the tool moves over a still picture of the stock. So the simulation is not an
animation of every chip — it is a set of correct snapshots with the tool moving between them.

**Provenance.** Every number the app did not compute itself is tagged with where it came
from, and "unmeasured" is not "measured". You will see badges like:

- **"unmeasured defaults"** — a shipped guess (a vise's jaw numbers, a starting feed). Fine
  to run with, but the app tells you it is a guess.
- **"from file header"** — read from the `.nc` file's own `;@MKR|` header. Untrusted input:
  it prefills a form, it does not decide anything.
- **"placement: stub"** — the part's position on the bed is **assumed, not measured**.

That last one matters most. A real placement comes from probing on the machine; Case Maker's
simulation works from an assumed one until you give it a better number.

---

## 4 · Simulate a G-code file — CNC-1

> **Status: Partly available** — the Simulate panel (#196) works today; the viewport layers
> (#197), playback (#198) and the end-to-end browser tests (#199) are planned.

You have a `.nc` file — from Makera Studio, from another CAM tool, or from Case Maker's own
engraver once it lands — and you want to see what it does before it touches a blank.

The **Simulate .nc** entry sits in the sidebar under a **CNC** divider, below Export. It is
present in rack mode too.

![The sidebar with the two CNC entries](https://raw.githubusercontent.com/SlyWombat/CaseMaker/main/docs/assets/cnc/cnc-mockup-sidebar.png)

*Design mockup — not the shipped screen.*

**Opening a file.** Click **Open .nc…** or drop a file onto the panel. Accepted extensions
are `.nc`, `.gcode`, `.cnc` and `.tap`, up to 64 MB. The file is parsed, run and swept **in
the app** — nothing is uploaded, and nothing is sent to a machine.

![The Simulate panel with no file open](https://raw.githubusercontent.com/SlyWombat/CaseMaker/main/docs/assets/cnc/cnc-mockup-sim-idle.png)

*Design mockup — not the shipped screen.*

**Confirming stock and tool.** If the file carries a `;@MKR|` header, the stock length,
width and thickness are prefilled from it, each tagged **“from file header”**. A `TOOL`
record is matched against your cutters and pre-selects the one it names, tagged as matched
from the header — but the geometry it states is not always reliable, so the dropdown is yours
to change and a cutter you already chose is **kept** when a file is opened. **Simulate** stays
disabled until both a file and a tool are present. A file with no header is fine; you just
type the three stock numbers yourself. Whatever you have already chosen — a stock number you
typed, the cutter in your spindle — survives opening a file; **Reset** is the way back to the
file's own numbers (#315).

![The Simulate panel asking for a tool](https://raw.githubusercontent.com/SlyWombat/CaseMaker/main/docs/assets/cnc/cnc-mockup-sim-tool-required.png)

*Design mockup — not the shipped screen.*

An **Advanced** disclosure lets you state the **tool in the spindle at the start** (unknown,
empty, or T1–T6). A program cannot know the machine's starting tool, and on the Z1 an `M6`
to the already-active tool does nothing — no change and no length calibration. If you leave
it *unknown*, the runner treats the first tool change as real and warns that it cannot know
better.

**Running.** Press **Simulate**. Parsing and running finish quickly; the **sweep** — unioning
the cuts at each checkpoint — is the slow part, a few seconds on a dense job. A progress bar
shows `sweeping n / m checkpoints`, and **Cancel** terminates the worker and disposes the
session.

![The Simulate panel sweeping](https://raw.githubusercontent.com/SlyWombat/CaseMaker/main/docs/assets/cnc/cnc-mockup-sim-running.png)

*Design mockup — not the shipped screen.*

**Reading the picture** — *planned (#197)*. When the sweep finishes, the viewport will draw
the stock as cut so far, the removed material as a translucent ghost you can toggle, the cuts
as bright paths (with the cuts still to come dimmed), the rapids dashed in a third colour,
the tool as a cylinder at its current position, and any **gouge** — a rapid that passes
through material the program has not removed yet — in the alarm colour. A **Layers** panel
will toggle each one. The vise jaws will draw as translucent grey, labelled with their
source.

![The viewport with the stock, ghost, gouge and tool drawn](https://raw.githubusercontent.com/SlyWombat/CaseMaker/main/docs/assets/cnc/cnc-mockup-viewport-ready.png)

*Design mockup — not the shipped screen.*

**Playback** — *planned (#198)*. A transport bar at the bottom of the viewport will carry
start, step-back, play/pause, step-forward and run-to-completion, speeds of 1×, 5×, 20× and
100×, and a scrubber whose only tick marks are the program's **pause points**. The
read-out is **simulated time**, not a measured cycle time — rapids are timed on the machine
profile's rapid model (#281), the same model the printed estimate uses.
Material updates at checkpoints, not every frame, so the tool moves smoothly over a still
stock between them. When the program reaches a tool change, playback **stops at the pause**,
names the change and waits: a virtual tool swap is a pause, not an error, unless you said the
starting tool was unknown.

![The transport bar](https://raw.githubusercontent.com/SlyWombat/CaseMaker/main/docs/assets/cnc/cnc-mockup-transport.png)

*Design mockup — not the shipped screen.*

![Playback stopped at a tool-change pause](https://raw.githubusercontent.com/SlyWombat/CaseMaker/main/docs/assets/cnc/cnc-mockup-sim-paused.png)

*Design mockup — not the shipped screen.*

When the run is done — or refused — the panel reports the result: volume removed,
checkpoint count, sweep time, a **placement: stub** badge, and the **diagnostics**, grouped
by source (parser / runner / sweep) with errors first and true per-code counts.

![The Simulate result with diagnostics](https://raw.githubusercontent.com/SlyWombat/CaseMaker/main/docs/assets/cnc/cnc-mockup-sim-ready.png)

*Design mockup — not the shipped screen.*

**When the app refuses a file.** Some jobs the app will not sweep at all, and it says why
instead of guessing:

- **A laser job** (`M321`): a mill simulation refuses it rather than drawing a cut.
- **A rotary job** (an `A` axis move): V1 does not simulate rotary work.
- **A 3D or dense job**: too many separate Z levels for the 2.5D sweep. When this happens the
  **tool path is still drawn** so you can inspect the file; the stock is not, because the
  sweep that would produce it was refused. A **Try again with a longer limit** button may
  appear.
- **A tool shape it has no model for**: the simulator sweeps a flat end mill, a V-bit or chamfer,
  a drill (its point cone on its cylinder) and a thread mill (as its cutting-diameter cylinder,
  labelled `thread-envelope`, with its neck checked). A ball or bull nose, or a cutter whose record lacks the tip, angle or
  diameter its model needs, is refused with `tool-refused`, and the message names what is missing.

Every refusal and warning has a short code. Chapter 8 lists all of them.

![The refused state with a path-only viewport](https://raw.githubusercontent.com/SlyWombat/CaseMaker/main/docs/assets/cnc/cnc-mockup-sim-refused.png)

*Design mockup — not the shipped screen.*

**What it cannot tell you.** The six-word version sits at the bottom of every result: *"This
simulation assumes a rigid, ideal machine: no deflection, no runout, no Z-chain error, no
chatter."* Spelled out: it does not model how the cutter bends under load, how much the
spindle and collet wobble, how far the Z stack creeps between a probe and a cut, or how the
blank chatters when the cutter bites. It does not know about the fixture unless the fixture
has been given to it, and it does not know whether your blank is the size you typed. It
answers *"does this file's geometry overlap the stock where I think it does"*. It does not
answer *"will this come out clean"*.

---

## 5 · Engrave text into the blank — CNC-2

> **Status: Partly available** — CNC-2's bench half is open: #208 (at the machine), #209 and #165 (measured feeds).
> The **Engrave text** panel itself is in the app — steps 1–8 below (#200, #201, #202, #203,
> #204, #205, #206, #207, all shipped, with #213, #244 and #271 beside them); steps 9 and 10
> are the unconfirmed bench half. Each step is marked.

This is a walkthrough of the default job, start to finish: a printed two-colour PLA blank in
the vise, with words engraved to different depths. Steps marked **in the app** describe the
shipped screen; the two marked **bench** are written in the future tense on purpose, because
nothing has confirmed them on a machine yet.

The **Engrave text** entry sits in the sidebar next to **Simulate .nc**, and — like every
other part of this — **it ends at a `.nc` file you upload with Makera Studio.** Case Maker
does not start the machine.

**1. Describe the blank (#205, #271) — in the app.** Type the stock's length (X), width (Y)
and thickness (Z), and pick a material. The job's material is **PLA**, the printed blank; the
starting table also carries softwood, hardwood and MDF rows for a blank that is not the badge.
Or press **Use the badge blank**: it takes the stock and the magnet pocket from the project's
own badge, so nobody retypes 76.2 × 38.1 × 3.81 (chapter 6). Taking a blank also brings the
vise's **stock proud** with it when the vise is still the shipped default — half the blank, at
most 4 mm (#344) — because a flat 4 mm stands taller than a 3.81 mm badge. A vise you saved or
measured is never touched. X runs between the vise jaws; the fixed jaw is on the left. The
stock's front-left corner is the work origin.

A new blank also re-works the **lines** on it — where the job's set is still one the app laid out
itself. Those three demo words were laid out for the 100 × 60 mm default plank, so on a badge they
ran off its edges; pressing **Use the badge blank** replaces them with **one** placeholder name,
centred on the blank and clear of the magnet pocket (#363). A **bare** blank that is not that
100 × 60 plank does the same thing one archetype over: the three demo words go and one **Text**
placeholder is set in their place, sized to the blank (#364). The one blank that keeps them is the
plank they were written for — 100 × 60, at *any* thickness, because a thinner slab of the same face
does not move a line, only its depth. Either way, the depth of every line nobody has claimed is then
recommended for the blank it is really on (#362), and the two limits in that answer belong to the
line and not to the blank: the void limit is taken from the voids the **line's own extent** reaches
(#365), and the jaw limit only from a jaw that extent comes within reach of (#369). So the seeded
line — in the free band beside the magnet pocket, no nearer than 6.9 mm to either jaw — is advised
the blank's own colour-split reveal, 1.0 mm on the default badge, and told "clear of both jaws by at
least 6.9 mm; the jaws set no limit here". A line placed over the pocket carries the pocket's number
and names it ("Magnet pocket" leaves 0.51 mm of material), and one run out to a jaw face takes that
jaw's floor and names it too. The extent is the line's whole ink box — the honest superset of the
cut, since the check it answers to is a positional one — measured from the same face the layout was,
and where that face is not parsed yet the box falls back to a documented upper-bound estimate, which
the sentence says where it is used ("measured against the line's estimated extent — its face is not
parsed yet"). The reach behind both the jaw limit and the `stock-proud-too-small` warning is the
vise's own uncertainty plus the cutter's radius on that same box, and nothing else (#394): the band
is where an unmeasured vise's faces may be, the radius is how far the cutter's disc works outside the
line's box, and the job's **jaw clearance** is not in it — that is a Z rule, charged to the depth
(`deepest + clearance`, the blank standing that much higher than the floor) rather than a claim about
which region of the blank in XY the rule applies over. One reader asks a stricter question of the
same reach: the run sheet's stop step prints a threshold only where the cutter's own disc — no band
allowed for — really comes over a jaw face, and names the cut and the jaw that trip it, because a stop
line is an instruction to someone standing at the machine and the operator has to be able to see why.
A job whose cuts all sit clear of the jaws prints no threshold and says so; the warning still fires
inside the band, because with the jaws unmeasured that is where a face may be. A line **you** typed or placed is left
exactly where it is, text and position both — and so is one an earlier take seeded, once you have
touched it: taking a second badge blank re-lays only what the app still owns.

**The material list is the machine's list as well as this app's (#347).** It offers the four
materials the starting table has rows for — softwood, hardwood, MDF, PLA — and then every material
the **machine profile** declares, which on the Z1 is **ABS**, **Acrylic** and the four metals:
**6061 aluminium**, **7075 aluminium**, **brass** and **copper**. Those are the vendor's own
`t_MaterialList` in this app's words, and the two halves are two different claims. A *table*
material is cut on this app's numbers, as before. A *profile* material is cut on **Makera's own
numbers for that exact cutter and material**, from the catalogue you synced (#310) — their four
numbers, with this app's step-over, peck and air — because nothing here has measured a metal. There
is no guessing underneath: with no catalogue row for that cutter and material the job is
**refused**, and the refusal names the row that is missing. A material the app has no word for
(Delrin, polycarbonate, PCB and the rest of the vendor's list) is not offered at all, rather than
offered and then refused. The two aluminium alloys are two materials, deliberately: a 7075 row can
never answer a 6061 job.

**Which machine the job is for is a question, not a constant (#347).** Step 1 of the **Start**
wizard shows a **Machine** picker on every build — the desktop instance puts the network **check**
under it, and the web build asks the picker alone, since it cannot reach a machine at all. The job
carries that answer, and the work area, the spindle ceiling and every clamp come from it, whether
or not a machine is switched on. The check never repoints the job: a machine that answers with a
different profile is named as such, and the picker is where you change it.

**2. Add labels (#200, #205) — in the app.** Each label carries its own text, font, weight,
cap height, position on the blank, rotation and **depth**. Depth is a box you type a number
into — never a slider: a slider cannot express 11.5 mm reliably, and on a two-colour blank the
choice is not continuous anyway (chapter 6). Labels at different depths are normal: the default
job is three words at 2.0, 1.0 and 0.5 mm.

![The Engrave panel being edited](https://raw.githubusercontent.com/SlyWombat/CaseMaker/main/docs/assets/cnc/cnc-mockup-engrave-editing.png)

*Design mockup — not the shipped screen.*

**3. Choose the cutter; read the lost-detail warnings (#201) — in the app.** With the labels
set, the app works out which cutter keeps the most of each glyph and puts the best one first —
*"Largest cutter that keeps every label intact."* You can pick another; the app keeps your
choice and offers the recommendation back. A **Why?** disclosure lists every cutter
considered with its worst label and the percentage kept. When a label loses detail, a warning
under that row says what to do — *"‘Maker' at 4 mm loses 96 % of its area with a 1.0 mm
cutter — increase to 6 mm or more."* When a label breaks through the floor, an error, not a
warning, and Generate stays disabled until it is fixed.

The list holds every cutter a job can name: the app's two built-ins always, and — once the
**house** (§7) is reachable — **the cutters you own** beside them. The recommendation ranks all of
them, including the ones you added yourself.

![The cutter recommendation with its reason](https://raw.githubusercontent.com/SlyWombat/CaseMaker/main/docs/assets/cnc/cnc-mockup-engrave-tool-recommendation.png)

*Design mockup — not the shipped screen.*

![Findings under the labels they belong to](https://raw.githubusercontent.com/SlyWombat/CaseMaker/main/docs/assets/cnc/cnc-mockup-engrave-findings.png)

*Design mockup — not the shipped screen.*

**4. Describe the vise; what "unmeasured defaults" means; save your own measurements
(#203) — in the app.** The jaws are what hold the blank and what the tool must not hit. Their
dimensions are published nowhere, so the app ships **unmeasured defaults** and says so. Two
buttons record your own: **Save as my vise** and **I just measured these**. Until you measure,
`vise-default` is a standing warning and collisions cannot be trusted.

**Sacrificial material (#213).** Alongside the vise you can say what else is in the setup: a
**board under the part**, and **strips beside it** — left and right, which sit between the jaw
and the part and are clamped with it, and front and back, which only make sense on a board
because nothing else holds them. The **Engrave panel** has the controls, under *Sacrificial
material*, with a source badge and **Save as my setup**, and two one-click presets for the two
setups people actually build: **"Part on a larger board"** and **"Strips between the jaws"**.

The work origin and Z = 0 stay on the **part's** top face, so the board's thickness can never
change a cut depth — and the run sheet says so in as many words when a board is in the stack.
Where material is declared beside the part, an item may run off the part's edge onto it — up to
the edge margin short of the sacrificial material's own outer edge — and the verifier's depth
limit follows the same supported footprint: `thickness − minFloor` over the part, the strip's
height over a strip, `thickness + breakthrough` over a board's overhang, and 0 over air. The
jaws move out to grip the strips or the board's overhang, so what the collider checks is what
the vise really holds.

The simulation sweeps the sacrificial material as a **second body** and says in its disclaimer
that it modelled it; the run sheet gains a **side view** of the assembly (see step 8). Until you
enter your own sizes the dimensions are unmeasured defaults and `sacrificial-default` warns,
exactly as for the vise.

**5. Cutting parameters (#202) — in the app.** Spindle speed, feed, plunge, step-down and
step-over are shown with **where the number came from**, and none of it is a recommendation. Where
Makera's own library has a row for your cutter and your material, the panel starts from
**their** numbers: the fields it actually answers are tagged `Makera` and the section is labelled
**"Makera's catalogue — not measured"** (#310), clamped to the Z1 — a 15 000 RPM row arrives
as 13 000, and that field stops being tagged `Makera`, because the ceiling is the machine's and
not theirs. When that happens the heading also carries a plain **`clamped to this machine (n)`**
tag beside the label, so a number the machine moved is never silent: hover it for each moved
value and what it was moved from (#317). It is a notice, not a finding — a clamp is the
machine's limit applied correctly, and the job can still be generated. A row stating a number
this job cannot use — a `0` in a cell Studio never filled, or
a speed far past the ceiling — does **not** fail the job: that one field comes from the app's
starting table instead, and `catalogue-ignored` names the row and the number it passed over
(#325). Where the library has no row — PLA, the badge job's material, has none at all — the
panel keeps **"starting values — unmeasured"**. Step-over is always the app's own 45 %, never
the catalogue's 63 % of the tip (#191). You can override each one.

**6. Generate — the three checks (#206) — in the app.** Pressing **Generate** produces the
toolpath and then runs three gates, each a row with a tick or a cross:

- **Toolpath generated** — operations, move count and an estimated time.
- **Verified** — the toolpath re-read and checked against the stock: it does not exit the
  stock, does not cut deeper than the floor allows, and stays clear of the fixture.
- **Simulated** — the toolpath swept and compared against the predicted region.

**Nothing is written to disk until all three rows are ticks.** The **Save .nc…** button
stays disabled while any gate fails, with the reason beside it. This is the answer to *"why is
Save disabled?"* in the troubleshooting table: one of the three checks has not passed, and
the failing row says which.

**Saving writes two files, not one** (#244, #273): the job itself, and `<job>-frame.nc` beside
it — the same toolpath traced in the air, 20 mm up, with the height baked into the file. The
run sheet's dry-run step sends you to that frame file by name, so the two always arrive
together. Nothing is re-derived at save time: the frame is the one the verifier already passed.

![All three checks passed; Save and Run sheet are enabled](https://raw.githubusercontent.com/SlyWombat/CaseMaker/main/docs/assets/cnc/cnc-mockup-engrave-generated.png)

*Design mockup — not the shipped screen.*

![Verification failed; Save is disabled with the reason](https://raw.githubusercontent.com/SlyWombat/CaseMaker/main/docs/assets/cnc/cnc-mockup-engrave-generated-blocked.png)

*Design mockup — not the shipped screen.*

**7. Watch it in the simulator before the machine — in the app.** The engrave preview draws
the blank with each label's floor cut in and coloured by depth on a fixed ramp, so the same
depth is the same colour in every job. On a two-colour blank, whose whole point is which colour
shows through, the floors are drawn in the **colour** they land in instead (chapter 6) — a fixed
ramp would colour two floors differently that come out the same colour. What it draws is the **opened region** — the glyph grown and shrunk
back by the cutter's radius — so inside corners are rounded and strokes thinner than the
cutter have vanished. That is what the cutter will actually make, not an idealised glyph.

![The engraved floors, coloured by depth](https://raw.githubusercontent.com/SlyWombat/CaseMaker/main/docs/assets/cnc/cnc-mockup-engrave-viewport.png)

*Design mockup — not the shipped screen.*

**8. Print the run sheet (#207) — in the app.** A **Run sheet** lists, on one page, the
cutter, the work origin, the stock, the feeds and the steps to follow at the machine, so you
are not reading a phone next to a spinning cutter. Its work-origin section is **derived from how the part is
held** (#272, decision 26), not written out by hand: it says what the jaws already reference and
to what accuracy, names each edge to touch on the blank in physical words ("the back edge — the
one furthest from you, about 19 mm along from the left end"), and reports the residual the
registration leaves. If no reachable edge can resolve an axis, it prints the refusal and names
what is in the way instead of a sequence it cannot stand behind. **Where the blank really is** is a
separate, later check (#391) and is **not printed yet**: the wire probe is Z-only, so it cannot
touch a side — it finds an edge by touching *down* at points across it and watching where the
reading changes, and the steps that would tell you to do that are held until a review's findings
are fixed (a travel limit named as a field the machine has, a tip diameter stated as measured when
no tip has been measured, a correction that reads back to front). The plan itself is written and
tested (`materialScan.ts`); it reaches no sheet until those steps are safe to follow. When the job
declares
sacrificial material (#213) the loading
section also carries a **side view** of the assembly — the jaws at the faces they really clamp,
the board, the strips and the part, each at its own thickness, with Z = 0 drawn on the *part's*
top face so the datum cannot be probed on the board by mistake.

> **Placeholder — no capture yet.** The run sheet shipped with #207 but has not been
> captured for this guide. A screenshot will go here.

**9. At the machine — bench.**

> **⚠ These steps have not yet been confirmed on a machine.**

> **Placeholder — no capture yet.** #208 records the at-the-machine steps and #209 records
> the feeds and finishes. Until they land the steps below are unverified, and this is where
> their photographs will go.

The steps, in prose, will be: mount the correct cutter and probe its length; fit the blank in
the vise and confirm it is proud of the jaws; set the work origin with the **wired probe**
(chapter 2 — it touches PLA, and the single Z touch is what sets the depth window); run
`G32 R1` over the engraved area, because the printed blank is domed, and `M370` when the job
is done (#176); upload the `.nc` with Makera Studio; run the job with your hand on the stop.
When #208 and #209 record the real screens and numbers, the assumed numbers here become
measured ones.

**10. After the cut — bench.** Measure the actual depth of each floor and compare it with
what you asked for. The difference is the Z-chain error the simulation cannot see (`/Fabrication.md`
§7.6) — the sum of probe repeatability, `M491` tool-length repeatability and how the collet
seats. Writing it down is how the assumed numbers become measured ones.

---

## 6 · Two-colour badges — CNC-3

> **Status: Partly available** — CNC-3 (#165, #205). The badge blank is in the app: **Use
> the badge blank** on the Engrave panel takes the stock and the magnet pocket from the
> project's badge (#271). The surface/reveal depth choice (decision 20) is in the label rows
> (#170) — on a blank that states how it was printed. Nothing writes that statement yet
> (#166), and #165's measurement pass has not run.

A **two-colour badge** is a blank printed in two colours stacked in Z — the lower colour
underneath, the top colour above. Where the engraving cuts deeper than the boundary between
them, the lower colour shows through. Shallow labels stay in the top colour; deep labels
reveal the bottom one. That is the whole effect.

**What must be measured before it can be built (#165).** The badge's blank is printed, so its
thickness carries print error, and the height of the colour boundary is what a label's depth
is measured against. Until that boundary is measured on a real print, no depth means
anything. #165 is the measurement pass.

**Why depth is two choices, not a slider (decision 20).** On a two-colour badge, a label's
depth is not free: it either stays in the top colour (**"surface"**) or goes through to the
bottom one (**"reveal"**). A continuous slider would imply a continuous set of outcomes that
the two-colour stack does not have. So the label row offers those two states beside the
number, and typing a depth is the override for anyone who wants one.

**What is on screen today, and what is not.** One button: **Use the badge blank**, at the top
of the Engrave panel's *Stock* section (chapter 5, step 1). It reads the project's badge —
76.2 × 38.1 × 3.81 mm PLA by default — and sets the stock to that blank and declares its
magnet pocket as a void the depth limit respects, then states back in a sentence what it set.
Nothing else in the job changes.

**The two-state depth choice (#170).** On a blank that says how it was printed, every label row
carries **surface** and **reveal** beside its depth field. Each one writes the depth it means —
clear of the colour boundary by one printed layer, or by the **boundary margin** where that is
further, so a blank running on a margin of its own (a domed badge, say) still gets a floor the
checker accepts and the recommendation beside it quotes the same number — so the choice is a
colour, not a number to work out. The depth field stays: type in it and the
number is yours (the app marks it as your own, and neither state stays lit over it). The preview
follows the COLOUR wherever a boundary is known — every floor is drawn in the colour it lands in,
and the legend names the two, calls them stand-ins (the app cannot know which filament you
loaded), and says where the boundary sits.

A badge says how it was printed through its **print** specification — layer height and first
layer height — and since #368 the badge template and a badge created from the app's own defaults
both state one (0.2 mm layers, marked **provisional**: the print spec's default, not a reading of
your slicer, until #165's measurement lands). It is edited on the badge's **Part** panel, where the
layer height is the control that matters: the colour boundary lands on that grid, so moving it
moves the split, every recommended depth, and every colour reading — and a depth measured at the
bench was measured against the print it was cut on. The change reaches an existing job when you
press **Use the badge blank**, which takes the new grid across and re-reads the label depths
against it. A badge that states no print still loads, and this whole half is then off for its job:
the blank is a shape the app knows rather than a job it knows the depths for, the depth limit stays
analytic, and the label rows show the depth field alone.

**Every floor keeps clear of a plane it must not cross (#345).** A depth in this app is never "as
deep as you like": each floor has to stay clear of the planes the job knows about — a void's
ceiling, the stock's underside, and on a two-colour blank the colour split. ONE number, the
**boundary margin** (0.2 mm by default; while the house setting is still the shipped default it is
re-read as one printed layer of the blank in hand, so a badge with 0.3 mm layers gets 0.3 without
anyone typing it — and for the blank in hand the app works out a recommendation it will put on the
job for you in one click), is how far every floor stays from every one of them — except a void's
ceiling on a blank that states no print, where the layers are unknown and the job's own
minimum-floor rule stands in instead. The stock's
underside keeps that minimum-floor rule because it is a different quantity — material that must
remain, not a Z-error allowance. WHICH check reports a broken bound depends on the plane: the
colour split and a void's ceiling are both judged per item as `item-depth-bound` (chapter 8.1),
naming the plane and which side the floor belongs on; a void's ceiling is ALSO a moving target —
the cutter reaches it part-way through a move — so `cut-too-deep` catches it per move as well, the
backstop for a cut the item's own check never saw; and the stock's underside is
`depth-exceeds-stock`, the minimum-floor rule that was always the per-item answer there. The colour
split is one example of that rule, not a special case: a label's depth intent only chooses WHICH
SIDE of the split its floor must be on — *surface* above it, *reveal* through it — so a blank that
states no split, and a label that states no intent, have no bound between them and are left alone.
Where the split IS known, it is read off the printer's real layers rather than the nominal design
height when the blank states how it is sliced (#285, #166), so changing the layer height moves the
boundary — and the refusal says where it actually is. A void's ceiling follows the same rule: it is
taken off the layer stack when the blank states its print, and off the design's own membrane (the
material left over the pocket) when it does not.

---

## 7 · Your cutters — the house (CNC-6)

> **Status: Partly available** — the **Manage** screen (#311, tracking #212), the house service
> behind it (#306, #308) and the three **Register** doors (#309) are in the app, so you can see and
> register the cutters you own today. Nothing in CNC-4 (§7.1) has started.

**What this is, first.** Your cutters are not a property of the case you are building, and not a
property of the Z1: they belong to the **house**. They outlive the machine they were bought for and
get shared between machines, so they live in their own place — and that place opens with **no
project open**.

**Where it is.** **🧰 Manage** sits in the toolbar beside **✨ New**. It is a **mode**, not a
sidebar section: a sidebar section belongs to a project, and there is no project here. Opening it
replaces the working area; closing it puts you back where you were.

**The rail.** Two scopes today — **House → Tools** (the cutters) and **Machines** (the Z1's
connection and profiles). **Materials** is drawn in the rail greyed and tagged *later*: the slot is
shown so you can tell a reserved place from a broken one, but nothing is built behind it. The foot
of the rail states the service in one line.

**House → Tools: the list.** Every cutter a job could name, **grouped by where it came from** —
**Owned**, **Yours**, **Makera catalogue**, **Built-in** — so a shipped assumption is never sitting
beside a cutter you own without a label between them. Each row carries shape, tip ⌀, shank, flute,
shoulder, stick-out, quantity and its tier. A length nobody stated prints as **—**, never `0`. A
search box and one chip per tier narrow the list, and the counts line says how many definitions
there are and how many fall in each tier.

![Manage, House → Tools, with a service present](https://raw.githubusercontent.com/SlyWombat/CaseMaker/main/docs/assets/cnc-mockup-manage-tools.png)

*Design mockup — not the shipped screen.*

**The four tiers, and why they are labelled.** **Built-in** is the two cutters the app has always
had, and they are permanent — they are in the list with no service running, because a simulation has
to have something to run with. One of them is literally named *"1 mm flat end (assumed)"*: its
geometry is an assumption, and the name says so rather than dressing it up as a measurement.
**Makera catalogue** is Makera Studio's own cutter library, imported read-only; you **pick** from
it, you never edit it. **Yours** is a cutter you own whose definition you changed — a slower speed,
a different reach out of the collet. **Owned** is a physical cutter in your drawer, with a quantity
and the code printed on its box.

**Changing a vendor's cutter: clone, never edit.** A catalogue row states what Makera says about
that cutter, and that is not yours to rewrite. Changing anything makes a **clone** — a *Yours* row
that keeps the numbers it was copied from and records, in a sentence, what it was cloned from. The
cutter in the drawer stays a separate **Owned** row pointing at a definition, so one physical
cutter can show up twice, once owned and once yours, by design: one is the thing you hold, the other
is the numbers you chose for it.

**The detail rail.** Selecting a row shows the definition read-only, with the catalogue id it came
from when it came from the catalogue; **Clone to change**; the inventory (quantity, when it was
added, your notes); and the codes printed on the box. **Codes are never looked up online** — a code
is matched against what has already been recorded on this machine.

**The actions.** **Register ▾** opens the three ways to add a physical cutter. **Scan** takes a
barcode scanner's keystrokes or a typed code — the field has the focus, and Enter is the read. What
a code names is shown rather than guessed: a cutter you already have becomes a **count** (a code
names a possession, so scanning one you own adds one rather than making a second row); catalogue rows
that fit the reading are offered for you to pick the one on the label; a code nothing fits is read
back and offered to the other two doors. The reading is **provisional** — the format is fitted to one
label, and the panel says so. The camera is an addition where the browser can drive one, and never
the only way in. **Catalogue** is a search over the synced rows. **Type** is the form, where a blank
length means *unknown*, never `0`. A blank **quantity**, by contrast, means **one** — in all three
doors and in the inventory editor alike: a person holding the box owns at least one cutter, and the
screen that shows the rule is the screen that would otherwise refuse the blank it produced itself
(#331). Registering makes an **Owned** row and leaves the definition
Makera's. **Clone** copies the selected row.
**Sync catalogue** re-reads Makera Studio's library on this PC (#308). A sync can succeed and still
have something to say — a library file it could not read and replaced, feed rows whose cells Studio
left empty — and those sentences are listed under the result, below the counts, where they stay
until the next sync (#328). Each carries its weight: a sync that **lost** something (a replaced
file, an emptied feed matrix) is marked in amber, information is not. The service remembers the
last sync's notes, so they are still there after a restart, dated. **Export** and **Import** move the location — its machine, your tool definitions and the inventory — as one `location.json` file (#412). An older `house.json` still imports: it replaces the two tool tiers and leaves the machine.

**No service: the Tools scope is absent, not broken.** The cutters live in a small service the
desktop app runs. With nothing running, the app does not show you an empty list or a broken one — it
says why, in the service's own words, and reminds you that the two built-ins need no service at all.
**Check again** asks the origin a second time. This is the same treatment the Start wizard gives a
machine it cannot find.

![No house service — Tools is absent, not broken](https://raw.githubusercontent.com/SlyWombat/CaseMaker/main/docs/assets/cnc-mockup-manage-absent.png)

*Design mockup — not the shipped screen.*

**Machines.** The Z1's card is the record of a moment: the connection state in the machine's own
words, when it was checked, and the profile it resolved. **Check for a machine** and an address
field sit in the header — the same probe the Start wizard uses, two doors onto it — and **Check
again** re-runs it. The **"my machine" file** (Export / Import) moves here. A card for printers is
drawn muted, claiming no connection, because Machines reads as everything that makes a part.
**Forget** is the only thing here that writes. Bench power is deliberately *not* here: switching
the machine on is a physical act, not a setting.

![Machines — the Z1's card](https://raw.githubusercontent.com/SlyWombat/CaseMaker/main/docs/assets/cnc-mockup-manage-machines.png)

*Design mockup — not the shipped screen.*

### 7.1 · Still later — CNC-4

> **Status: Planned** — CNC-4 (#181, #185, #189). None of these is started.

Three things are on the far side of this work, and none of them is in the app.

**Sending the job to the machine (#181).** A bridge that uploads the `.nc` to the Z1 over
WiFi and starts it, so you do not open Studio at all. This is the "one flag for the user"
narrowing in `/Fabrication.md` §9.1: V1 stops at a verified file on purpose, because the
bridge is the most environment-bound part of the whole job. Not started.

**Using the camera to find the part (#189).** The Z1 has an integrated camera. It cannot
measure Z, and Studio does not use it for origin-setting, so today it is a webcam you can
watch. The plan is to calibrate it against the machine's own motions — the machine is a far
better ruler than a printed sheet — and use it as a coarse datum so a probe starts from a
confident position instead of a blind one. Not started.

**V-carving small text (#185).** A V-bit couples depth to stroke width, so it can reach
strokes a flat end mill cannot — but it needs a medial-axis engine, and it is V2 by decision
(`/Fabrication.md` §7.4). Not started.

---

## 8 · Reference

> **Status: Available** — reference. The rows marked *planned* inside §8.4 are the one exception, and each names its issue.

### 8.1 Every diagnostic the app can raise

> **Status: Available** — every code the engine raises today is listed. A new code gets its row here in the same change that adds it to the engine.

You will see these short kebab-case codes in the diagnostics list and in the refusal banner.
The severity is **error** (the app refuses or the cut is unsafe), **warning** (it proceeded,
but something is assumed or unmeasured), or **info** (worth knowing).

**Reading the file** (parser):

| Code | Severity | What it means in plain words | What to do |
|---|---|---|---|
| `bad-number` | error | A word's number is not a number the machine would accept. | Fix the line the message names. |
| `stray-text` | error | A line holds text the dispatcher cannot read as G-code. | Fix or delete the line. |
| `console-line` | error | A line starting with a lowercase letter or `$` went to the controller's console, not the G-code dispatcher. | Nothing happened; if you meant G-code, fix it. |
| `n-line-ignored` | error | An `N`-numbered line whose command follows the number is **ignored** by the firmware — confirmed on the machine 2026-10-12 (`N10 M5` → `ok - ignore: [M5]`). | Put the command on its own line, or drop the `N`. |
| `lone-f-switches-g1` | warning | A line starting with `F` becomes `G1`, and that makes `G1` the modal motion — following bare moves now cut. | Check the program's intent. |
| `comment-contains-g90-g91` | error | A comment mentioning `G90`/`G91` is hoisted out of the comment and applied by the firmware. | Remove `G90`/`G91` from comments. |
| `paren-comment-truncates` | error | Text **after** a `(` comment is discarded by the firmware, not run. | Move it out of the line. |
| `unterminated-comment` | warning | A `(` comment has no closing `)`. | Close it. |
| `ignored-line` | warning | A line starting with a character the firmware ignores. | Remove or fix it. |
| `multiple-codes` | error | One command holds both a `G` and an `M` word. | Split them onto separate lines. |
| `t-without-m6` | warning | A `T` word without `M6` on the same command does nothing. | Add `M6`, or remove it. |
| `m6-without-t` | error | `M6` with no `T` word does nothing on this firmware. | Put the `T` in the same command. |
| `unknown-code` | error | A `G` or `M` code the app does not know. | Check the code against §8.2. |
| `unsupported-code` | error | A known code the app will not model (inverse-time feed, canned cycles — the Z1 translates drill cycles instead). | Rewrite it as plain moves. |
| `unsupported-g10` | warning | Only `G10 L2`/`L20` sets a work offset; another `L` is ignored. | Use `G10 L2`. |
| `g10-without-p` | warning | `G10` with no `P` word is ignored by the firmware. | Add `P1` (G54) or `P0`. |
| `g53-invalid` | error | `G53` must be followed on the same line by `G0` or `G1`. | Put them on one line. |
| `g53-params-ignored` | warning | Axis words on a `G53` followed by `G0`/`G1` are discarded. | Remove the extra words. |
| `bad-feed` | error | A feed rate that is not positive. | Give a positive `F`. |
| `no-feed` | error / warning | A cut with no feed rate defined; an arc with none raises a firmware alarm. | Add an `F`. |
| `arc-zero-radius` | error | The arc's `I`/`J`/`K` offsets give a zero radius. | Fix the offsets. |
| `arc-from-unknown` | error | An arc starts or ends somewhere the program never established. | Establish the position first. |
| `arc-r-unsupported` | error | The firmware has no radius-form (`R`) arcs; only `I`/`J`/`K`. | Convert to `I`/`J`/`K`. |
| `arc-radius-mismatch` | warning | The arc's start and end do not sit at the same radius from its centre. | Check the offsets. |
| `no-arc-centre-mode` | error | `G90.1`/`G91.1` are the arc-centre-mode pair, and this firmware has no arc-centre mode: `I`/`J`/`K` are always incremental. The distance mode is left unchanged, not reinterpreted. | Use plain `G90`/`G91`; this is not our post's output. |
| `unknown-g28-subcode` | error | `G28.<n>` carries a subcode, and the dialect records only plain `G28` (the clearance position, not home). Whether the firmware matches the plain code's prefix on it is unverified, so the position is left unchanged and the file is treated as foreign — the same shape as `G90.1`/`G91.1`. | Use plain `G28`; this is not our post's output. |
| `atc-self-check` | warning | A bare `M490` is the ATC motor self-check, which this machine (no ATC) does not have. | Remove it. |
| `rotary-axis` | info | An `A` word: the rotary axis is tracked but not interpreted. | V1 does not simulate rotary work. |

**Running the program** (runner):

| Code | Severity | What it means in plain words | What to do |
|---|---|---|---|
| `tool-change-noop` | info | `M6` to the tool that is already active does nothing — no change, no length calibration. | Confirm the tool in the spindle. |
| `tool-change-ambiguous` | info | The starting tool was not stated, so whether this is a real change cannot be known; it is treated as one for the picture. If it is in fact a no-op the head never moves, so the height the change's macro ends at is **not** counted as an established Z: a `M3` after it still reports `spindle-at-unknown-z`, and an X/Y rapid after it still reports `rapid-too-low`. | State the starting tool if you know it. |
| `g92-4-manual-home` | warning | `G92.4` redefines the machine position; the setup no longer holds and positions are unknown from here. | Avoid it, or re-establish the origin. |
| `wcs-set-unmodelled` | warning | `G10 L…` writes an offset other than G54, which the app does not model; ignored. | Use G54. |
| `wcs-unmodelled` | warning | `G55`–`G59` selects an offset the app was not given; positions are unknown until G54 returns. | Stay on G54. |
| `outside-envelope` | error | A move leaves the machine's work envelope. | Fix the coordinates. |
| `cut-unknown-z` | warning | A cutting move at a Z the program never established — not swept, so the picture has a gap here. | Establish the Z first. |
| `cut-unknown-xy` | warning | A cutting move to an X or Y the program never established — not swept. | Establish XY first. |
| `cut-from-unknown-xy` | info | A cut starting from an unknown X,Y is swept as a plunge at its end point only. | Expect a small gap at the start. |

**Verifying the program** (verifier). These are the codes the *verifier* raises when it reads a saved
program back — what the **Verified** row in the engrave flow is: the parser, the dialect whitelist,
the runner and the depth checks run over the file itself, and every error any of them finds is
carried under one of these names. Two of them (`parse-error`, `runner-error`) wrap the reading and
running passes above; the rest are the checks the runner does not do on its own.

**It runs on what the app produces, and is not a gate on imports.** The three callers are the engrave
run, a restart, and the bench file generator — so a file you open or import is read and simulated,
never verified, and nothing below checks a foreign program's depths, feeds or spindle starts. What a
simulation does report about one is the sweep's own list, next:

| Code | Severity | What it means in plain words | What to do |
|---|---|---|---|
| `parse-error` | error | The file could not be read as G-code and was not simulated: either the parser refused a line, or the program could not be lowered to moves at all. The message carries the inner reason. | Fix the line the message names, then generate again. |
| `runner-error` | error | The runner refused the program — a move that leaves the machine's envelope, an arc with no feed rate or in a form it cannot read, or an arc from a position the program never established. (A *warning* the runner raises — an unknown Z, an unknown X,Y — is not carried here.) The message names the runner's own code and what it found. | Fix the move the message names. |
| `not-our-dialect` | error | A word in the file is not one this post writes (`G0 G1 G21 G28 G53 G90`, `M2 M3 M5 M6 M7 M9 M331 M332`, and only G/M/T/S/F/X/Y/Z words). The file did not come from the app, or was hand-edited. | Re-post it, or fix the word. |
| `numbered-line` | error | A line carries an `N` word. The firmware strips the number but keeps testing `N`, so it answers `ok` and **runs nothing on the line** — a numbered program runs as a stream of silently skipped lines (confirmed at the bench 2026-10-12, #385). The post writes no line numbers. | Remove the `N` words (or the numbers' line), then re-post. |
| `cut-too-deep` | error | A cutting move reaches Z deeper than the material permits at that (X, Y): past the stock floor, through a colour or void ceiling, or into material the job says must remain. The message names the limit and, when the job can say, why. | Reduce the depth, move the cut clear, or switch the label's intent. |
| `cut-outside-stock` | error | The cutter's *edge*, not just its centre, reaches a point where no material may be cut — off the blank onto air. | Move the cut back inside the stock. |
| `feed-missing` | error | A cutting move has no feed rate set. | Add an `F` before the cut. |
| `feed-too-high` | error | A cutting feed is above the machine's ceiling. (The planner's softer `feed-clamped` is a different code, raised earlier.) | Lower the feed. |
| `spindle-off-cut` | error | A feed move reaches below the top face with the spindle off. | Turn the spindle on with `M3` — it is the dialect's only spindle-on word (`M4` is not one of them). |
| `spindle-at-unknown-z` | error | The spindle starts with no Z established: nothing placed the tool in Z first, so the cutter comes on **wherever the head was left** — after a manual `M6` that can be inside the part. Read on every start, so a later `M3` is judged where the head is then, not on the file's opening lift. | State the Z first: a `G53` lift in the machine frame (what the app's own post and restarts write), or an absolute Z move. |
| `rapid-too-low` | error | An X/Y rapid runs below the permitted rapid height, or at a Z the program never established. | Raise the rapid height, or state the Z first. |
| `rpm-too-high` | error | A spindle speed is above the machine's ceiling. (The planner's `rpm-clamped`/`rpm-refused` are separate.) | Lower the speed. |
| `multi-tool` | error | The program uses more than one tool; V1 is single-tool. Raised for an `M6` to a new tool after the first cut, or for more than one distinct tool anywhere. | Post the job with one tool. |
| `bad-preamble` | error | The first motion is not preceded by `G90` and `G21`. | Open the program the way the app's post does. |
| `bad-ending` | error | The program does not end with `M02`/`M30`, or the spindle is still on at it, or no `M5`/`M05` turns it off first. | End with `M5`, `G28`, `M02`. |

**Sweeping the cuts** (sweep):

| Code | Severity | What it means in plain words | What to do |
|---|---|---|---|
| `stock-unsupported` | error | V1 sweeps a rectangular (prism) block only. | Use a rectangular blank. |
| `stock-invalid` | error | Stock thickness is not positive. | Type a real thickness. |
| `prior-removal-invalid` | error | A rest pass was told what material a previous program left (#410), and that material is not a closed solid — so the sweep has no starting material to subtract from. | Simulate the first program and pass ITS result. |
| `prior-removal-column` | error | A rest pass was asked for on a job the COLUMN engine sweeps — a rotary job, a V-bit (whose cutting width changes with depth), a drill or a thread mill (#382). Only the exact 2.5D sweep can start from the material a previous program left, so the pair is refused by name rather than swept from the blank (#410). | Measure the rest with a flat cutter, or cut the second program as a program of its own. |
| `air-moves-unchecked` | warning | More air moves than the app checks; some were not verified. | Split a very long job. |
| `spindle-off-near-bed` | error | A feed move with the spindle off comes within a hair of the bed. | Turn the spindle on, or move it away. |
| `rapid-below-bed` | error | A rapid goes below the bed. | Fix the Z. |
| `spindle-off-near-stock` | error | A feed move with the spindle off comes within a hair of material still present. | Turn the spindle on, or move it away. |
| `rapid-through-stock` | error | A rapid passes through material the program has not removed yet — a gouge. | Slow/insert a feed move, or reorder. |
| `holder-unproven` | warning | The cutter's reach past the collet is unknown, so holder clearance cannot be proven. | Record the cutter's shoulder/flute length. |
| `holder-collision` | error | The cut is deeper than the cutter's shoulder/flute length: the shank would rub. | Use a longer cutter or a shallower cut. |
| `laser-job` | error | A laser job (`M321`); a mill simulation refuses it. | Simulate it elsewhere. |
| `rotary-job` | error | The exact 2.5D sweep was handed a job that moves the A axis; rotary work is swept by the column engine instead. Only a direct caller of the exact sweep sees this. | Nothing to do — a rotary job loads the column engine. |
| `rotary-stock` | error | A rotary job needs cylindrical stock; the setup's blank is not a cylinder, so the column engine cannot hold it. | Use a cylindrical blank for a rotary job. |
| `flat-stock` | error | The column engine's flat (3-axis) parameterisation was handed a job whose blank is not a prism. | Use a rectangular blank. |
| `axis-crossing` | error | A rotary cut reaches the axis deeper than the tool radius (the cutter tip at radius Z ≤ −r); a single-valued radius column cannot represent a cut that crosses the axis. | Keep the cutter off the axis, or use a shorter tool. |
| `axis-clamped` | warning | A rotary cut dipped just past the axis (within one tool radius) and was clamped to it; the far-side hollow is not modelled, and the cut did not come out the depth the program asked for. | Keep the cutter off the axis, or accept the clamped picture. |
| `tool-refused` | error | The simulator has no model for this cutter, or the cutter's record does not state what its model needs. The exact sweep takes a flat end mill. The column engine also takes a V-bit or chamfer with a stated tip and angle, a drill with a stated diameter, and a thread mill with a stated cutting diameter (#405, #382). A ball or bull nose is refused, and so is anything on a rotary job except a flat end mill. The message names what is missing, for example a chamfer box code that states no tip, or a thread mill whose only size is its thread. | Type the missing number on the cutter, or pick a cutter the simulator models. |
| `drill-point-angle` | info | A drill is simulated as a cone point on a cylinder. The message names the included point angle used and where it came from: the drill's own record, or the shop default `drill.pointAngleDeg`, which is *chosen*, not measured. The #434 drilling CAM plans the hole's tip depth from the same rule and hands the simulation the angle it planned with (#382). A drill with no angle of its own is refused (`tool-refused`) when no default reaches the simulation. | If the drill's point is not the default, type its angle on the cutter. |
| `thread-envelope` | warning | A thread mill is simulated as a plain cylinder of its cutting diameter all the way up, an **envelope**, widened by half a grid cell so no column the cutter touches is missed. Around the teeth and the neck that over-removes. The wider shank above the neck is **not** modelled, so a cut deeper than the neck would show less than the shank takes. The neck check says whether it is: `holder-collision` past a stated flute or shoulder length, `holder-unproven` when the cutter states neither. The thread form is not modelled (#382). | Read the drawn hole as the mill's reach, not as the thread. Type the mill's flute length so the neck can be checked. |
| `probe-fitted-cut` | error | A cutting move was made with `T0` active — `T0` is the **probe**, and a probe is contact, not removal. No cutter is modelled for it, and nothing is drawn as removed. The post never writes a probe cut, so the file is foreign or broken. | Check the tool numbers; re-post the job. |
| `dense-3d-refused` | error | Too many separate cut runs at one (segment, Z): a 3D or dense job the 2.5D sweep will not take on. | — |
| `sweep-budget-exceeded` | error | The sweep would take longer than the allowed budget, so it was stopped. | Retry with a longer limit, or simplify the job. |
| `ramp-over-removed` | info | A checkpoint changes Z; it was swept at its lowest Z, removing more than the machine would. | Expect a slightly pessimistic picture. |
| `gouges-truncated` | info | Only the first few gouges are drawn; the rest are reported, not drawn. | Read the other diagnostics. |
| `fixture-unchecked` | info | The fixture is not modelled as an obstacle, so the cutter's proximity to it is **not** checked. The message names what is in the way — the vise's jaws, a clamp. Nothing is reported for a fixture that puts nothing over the part (tape-down, a nest wall outside the outline). | Model the vise (chapter 5). |
| `tool-into-fixture` | error | The cutter's own swept column at a checkpoint drives into a modelled obstacle. The message names WHICH box — a jaw, a clamp — and the volume removed. | Move the cut clear of it, or correct the fixture's declared size. |
| `rapid-into-fixture` | error | A rapid move drives the tool body into a modelled obstacle. | Fix the clearance height, or reorder the moves. |
| `feed-into-fixture` | error | A feed move with the spindle **off** drives the tool body into a modelled obstacle — the same test as the rapid, with nothing being cut away as it goes. | Turn the spindle on, or move the move away. |
| `holder-into-fixture` | error | The collet nut (its declared diameter), placed at the lowest it can sit at any seating, overlaps a modelled obstacle. | Use a shorter seating or a shorter holder, or move the work clear. |
| `holder-vs-fixture-unproven` | warning | A modelled obstacle rises above the stock top while the collet nut's size is unknown, so the clearance to it cannot be proven. The message names the obstacle and how far it rises — and, when the rise is really the unmeasured band around a box that is declared below the stock top, says that instead. | Declare the holder's nut size, or keep the fixture below the stock top. |
| `nothing-to-sweep` | warning | The program has no cutting moves at a known position. | Check the program. |
| `gaps` | warning | Some cutting moves could not be placed and are missing from the picture. | Read the `cut-unknown-*` rows. |
| `item-empty` | error | An item has nothing the cutter can reach: a label has no text, or a shape (a hole, a slot) is smaller than the cutter. Formerly `label-empty`. | Type text, enlarge the shape, or disable it. |
| `item-chars-lost` | error | A label loses whole characters to the cutter's radius. Formerly `label-chars-lost`. | Increase the size or use a smaller cutter. |
| `item-detail-lost` | warning | An item loses detail (thin strokes, inside corners) to the cutter's radius. Formerly `label-detail-lost`. | Increase the size, enlarge the shape, or use a smaller cutter. |
| `item-outside-stock` | error | An item hangs off the blank, or off the sacrificial material beside it (#213). Formerly `label-outside-stock`. | Move it back inside the edge margin, or declare a strip or board under the overhang. |
| `item-over-void` | warning | An item cuts over a declared under-surface void (#231), whose membrane has nothing under it (#171). True at any depth — even a shallow cut there will chatter and finish rough. A single-line trace is warned about the same way (#270); a plunge drill is not, because a drill into a void is a breach `cut-too-deep` refuses, and a drilled hole has no pocketed floor to finish. | Move the cut clear of the void. A cut deep enough to break through is refused separately, as `cut-too-deep`. |
| `item-depth-bound` | error | An item's floor lands on the wrong side of a plane it must stay clear of (#345). Raised for the colour split on a two-colour blank — a label's `depthIntent` chooses which SIDE of the split its floor belongs on, *surface* above it, *reveal* through it (#285) — and for a void's ceiling under the item's own footprint: the label cut over a magnet pocket is told where that ceiling is and how far above it the floor must stay (#345). Only a plane the job knows about can be broken, so a blank that states no split and a label that states no intent (or *custom*) are left alone. Where the split is known it is read off the printer's real layers, not the nominal design height, so changing the layer height moves it; a void's ceiling is read off the layer stack when the blank states its print and off the design's own membrane when it does not. `cut-too-deep` is the per-move backstop for both these planes — the cutter reaches a void's ceiling part-way through a move — and is the only check for an item that is not a label (a drawn shape, a traced path). An item past the stock's minimum floor is `depth-exceeds-stock`. Formerly `item-wrong-colour`. | Set the depth to the other side of the plane, or switch the label's intent. The message names the plane, where it is in mm, and which side the floor must be on. |
| `trace-outside-stock` | error | A single-line trace runs off the blank (#219). | Move it back inside the stock. |

**Checking the engraving job** (job):

| Code | Severity | What it means in plain words | What to do |
|---|---|---|---|
| `depth-exceeds-stock` | error | An item cuts so deep the floor left under it is below the minimum. | Make it shallower or use thicker stock. |
| `no-items` | error | The job has no enabled label with text or shape. Formerly `no-labels`. | Add one. |
| `polygon-self-intersecting` | error | A polygon shape crosses itself, so the outline is not a simple region. | Fix the points so the outline does not cross itself. |
| `item-reference` | error | A frame or cut-away names an item that is missing, disabled, or part of a cycle, so the ring or pocket cannot be built. | Point it at a real, enabled item that does not depend on it. |
| `trace-self-overlap` | warning | Two strokes of a single-line trace come closer than the cutter is wide, so the cut fills in (#219). For a V-bit the width is the groove the cone opens AT THAT TRACE'S DEPTH — `tip + 2·d·tan(halfAngle)` — not the tip (#405). | Space the lines apart, or use a smaller cutter. |
| `region-v-carve-unavailable` | error | A label or a shape (a REGION) is cut with a V-bit. Opening a region means offsetting its outline by the cutter's width, and a cone has no single width — it widens as it deepens — so cutting a region with one is a V-carve, which this app does not do yet (#221). A V-bit still cuts single-line traces and stroke labels perfectly well. | Use a flat end mill for labels and shapes (keep the V-bit for stroke traces), or wait for the V-carve work (#221). |
| `drill-outside-stock` | error | A plunge-drilled hole's rim reaches past the edge of the blank (#220). | Move the hole back inside the stock. |
| `plunge-unproven` | warning/error | The job drills, but nothing recorded says the cutter is centre-cutting, so a straight plunge cannot be proven safe (#220). An error when the tool is recorded as NOT centre-cutting. | Use a centre-cutting end mill; #208 A1 records it for owned cutters. |
| `drill-too-deep` | error | A hole is deeper than the cutter's flute, so chips cannot clear (#220). | Drill shallower, or use a cutter with a longer flute. |
| `drill-through-unavailable` | error | The hole is asked to cut all the way through, which needs a sacrificial board (#213) and the through-cut rules (#218) that are not in yet (#220). | Drill to a floor instead, or wait for the through-cut work. |
| `tool-missing` | error | The job names a tool that is not in the library. | Pick a real tool. |
| `tool-metal-line` | error | The cutter is on Makera's "for Metal" line — its name says so (the `(Metal)` suffix a catalogue row uses, or the phrase `for Metal` the printed label carries), or its box code holds the `-M-` segment — and this job cuts wood or plastic. Its geometry and its coating are ground for metal, and no feed row was written for it on this material, so the pass is refused (#405). | Use a wood/plastic engraving bit for this blank, or change the stock to a metal before cutting. |
| `stock-proud-too-small` | warning | A cut comes within the cutter's reach of a jaw — the vise's own uncertainty plus the cutter's radius — and the blank stands too far below the jaw tops for its depth, so the cutter would work below the jaws. | Seat the blank higher. |
| `vise-default` | warning | The vise dimensions are unmeasured defaults, so collisions cannot be trusted. | Measure your vise. |
| `vise-stock-not-proud` | error | The blank is not proud of the jaws at all — the cutter would hit the vise. | Seat the blank proud. |
| `vise-stock-proud-exceeds-thickness` | error | The blank stands proud by more than its own thickness; the numbers do not add up. | Re-check the vise and stock numbers. |
| `vise-grip-shallow` | warning | The jaws grip too little of the blank to hold it safely. | Seat the blank deeper, or use thicker stock. |
| `vise-jaw-short` | warning | The jaws are shorter than the blank, so part of it is unsupported. | Check the jaw length. |
| `side-strip-unsupported` | error | A front or back sacrificial strip has no board under the part to rest on. | Add a board under the part, or remove the strip. |
| `strip-taller-than-part` | error | A sacrificial strip rises above the part's top face, where the first pass would hit it. | Make the strip flush with the part or shorter. |
| `under-too-thin` | error | The board under the part is too thin to absorb the breakthrough a through-cut allows. | Use a thicker board. |
| `under-loose` | warning | The part is only resting on the board and may move. | Tape, glue or screw it down. |
| `sacrificial-default` | warning | The sacrificial dimensions are unmeasured defaults, so cut depths onto them cannot be trusted yet. | Enter your own board and strip sizes. |
| `feed-clamped` | warning | The requested feed is above the machine's ceiling and was clamped down. | Expect a slower cut. |
| `rpm-clamped` | warning | The requested spindle speed is above the Z1's 13 000 RPM and was clamped. | Expect a slower spindle. |
| `feed-refused` | error | The requested feed is so far above the ceiling it was refused rather than clamped. | Use a sane feed. |
| `rpm-refused` | error | The requested spindle speed is so far above the ceiling it was refused. | Use a sane spindle speed. |
| `catalogue-ignored` | warning | Makera's own table states a number this job cannot use — a `0` (Studio writes one into a column it never filled) or a speed past the ceiling — so that one field comes from the app's starting table instead of from Makera (#325). The job cuts; it does not fail. | Nothing. If every cut of this material reads this way, the vendor's row is not the one you want — set your own value for that field. |

**Planning the probe** (probe plan — #188). The run sheet's work-origin section is this plan,
printed (#272); the codes below are raised by no screen yet — a refusal reaches the sheet as the
step's text:

| Code | Severity | What it means in plain words | What to do |
|---|---|---|---|
| `no-outline` | error | The part's outline needs a geometry kernel to evaluate (a boolean or offset shape), and the planner is kernel-free, so it has nothing to measure against. | Nothing you can do from the app — this is a wiring gap the caller closes by evaluating the outline in the worker first. |
| `no-reachable-edge` | error | On an axis the fixture leaves open, that axis still has a straight edge long enough and clear of the fixture. The message names the obstruction. | Move or remove whatever the message names — that is what is sitting on the edge. |

**Checking where the blank really is** (material-position scan — #391). **No screen and no run
sheet raises these yet.** The plan is written and tested, but its operator-facing steps are held
while a review's findings stand, so `planMaterialScan` is called by nothing that prints: a refusal
below reaches no one until that changes. They refuse the *check*, never the job — the check is
optional, so a refusal would cost the operator the sentence and nothing else.

| Code | Severity | What it means in plain words | What to do |
|---|---|---|---|
| `not-proud-enough` | error | The blank stands so little proud of the jaw tops that the probe cannot tell the blank's own top from the jaw's — every reading would sit within the dial's own tolerance of both. | Seat the blank higher, or set the origin as usual and check the blank against it with a rule. |
| `dome-covers-the-jaw` | error | The blank's stated dome is as deep as the height it stands proud, so the top of the dome and the level of the jaw tops read the same. | Say what the dome really is, seat the blank higher, or check with a rule instead. |

**Reading the file header** (form prefill only; these never change the sweep):

| Code | Severity | What it means in plain words | What to do |
|---|---|---|---|
| `stock-multiple` | warning | More than one `STOCK` record; only the first is read. | Keep one. |
| `origin-multiple` | warning | More than one `ORIGIN` record; only the first is read. | Keep one. |
| `stock-shape-unsupported` | warning | The `STOCK` record is not a cuboid, so its geometry is not prefilled. | Type the stock yourself. |
| `stock-field-missing` | warning | A stock dimension is absent from the header. | Type it yourself. |
| `stock-field-invalid` | warning | A stock dimension is not a positive number. | Type it yourself. |
| `stock-axes-unverified` | warning | Length and width differ, and which runs along X is unverified (the one known sample is square). | Check the orientation. |
| `stock-incomplete` | warning | The header lacks a usable length, width or height. | Type the stock yourself. |
| `origin-preset-unverified` | warning | The `ORIGIN` corner is not one with any evidence behind it. | Set the origin on the machine. |
| `origin-unchecked` | warning | The origin cannot be cross-checked without a valid stock. | Type the stock first. |
| `origin-semantics-unverified` | warning | The origin's numbers do not match the expected corner for this stock. | Set the origin on the machine. |

**Which coordinate frame is in force** (machine calibration — #279). Raised by the app rather
than by a program: the machine's own `coordinate.*` positions decide where the head parks and where
the tool-length probe is predicted to touch off, and a stock machine's shipped defaults are not
what a machine on a bench has been trammed to:

| Code | Severity | What it means in plain words | What to do |
|---|---|---|---|
| `machine-calibrated-frame` | info | Positions come from this machine's own configuration, read from it, with the date it was read. | Nothing — this is the good state. |
| `machine-vendor-frame` | warning | Positions are the vendor's shipped defaults for a STOCK Z1: this machine's own configuration has not been read, and a machine that has been trammed keeps its anchors — and so its tool-length sensor and change position — elsewhere. | Run the machine check in the start wizard with the machine on the network. |
| `machine-calibration-ignored` | warning | A saved calibration was read from a DIFFERENT machine (its own id is in the message), so it is deliberately not used here. | Check which machine this job is set for. |
| `cannot-seat` | error | In this setup the stock is too short to sit on the vise ledges with its top above the jaw tops (#428). | Use another mount for this setup (tape or the bracket), or choose another face to go up. |
| `clamp-on-cut` | error | A jaw would close on a part of the stock that an earlier setup already cut, so the grip is not sound (#428). | Move the item to a later setup, or change the setup order so that face is clamped before it is cut. |
| `cuts-clamped-face` | error | This setup cuts into the face that one of the jaws grips (#428). | Move the item to a setup where that face is not clamped. |
| `rests-on-cut` | error | The face going down rests on the ledges, or the bed, where an earlier setup cut it, so it will not sit flat (#428). | Reorder the setups, or add a sacrificial board under the stock. |
| `thin-grip` | warning | The jaws grip less of the stock than the shop's minimum grip (`setups.minGripMm`) (#428). | Raise the stock, use a shorter grip setting only if you accept it, or choose another mount. |
| `clamp-in-path` | error | A move of the program passes over a top clamp lower than the clamp's top, so the tool would hit it (#427). The clamp is named by its edge and how far it is from a corner. | Slide the clamp along its edge, or move it to the other free edge (back or right), clear of the cut. |
| `bracket-in-path` | error | A move of the program passes over one of the anchor bracket's arms (the left arm, or the front arm nearest you) lower than the arm's top (#427). | Keep the cut inside the stock's edge on that side. The bracket does not move. |
| `clamp-unchecked` | error | Part of the toolpath could not be checked against the clamps and the bracket (#427). There are three cases: the tool has no stated diameter; a move starts from a position the program never set, below the clamps' tops; or the collet nut comes down below a clamp's top and the nut's size is not recorded. | State the cutter's diameter. Lift to a known height before moving sideways. Record the collet nut's size, or use a longer stick-out. |
| `clamp-off-stock` | error | A top clamp hangs past the end of the edge it is on, so it would not hold the stock (#427). | Move the clamp in along the edge. |
| `clamps-overlap` | error | Two top clamps are placed on top of each other (#427). | Move one of them along the edge. |
| `stock-past-arm` | warning | The stock's edge is longer than the bracket arm it sits against, so only the part along the arm is squared, and the bracket's fit error grows toward the far end (#427). | Accept it for a rough part, or check the far end before cutting. |
| `mount-unmeasured` | info | The bracket and clamp sizes are the shop's defaults, not measurements, so the clearances are only as good as those defaults (#427). | Measure the bracket and clamps with calipers and save the values in the shop defaults. |

### 8.2 G-code the simulator understands

> **Status: Available**.

From `/Z1-Firmware-Dialect.md`; the Z1 runs a branch of **Smoothieware** in grbl mode, so the
semantics are LinuxCNC-flavoured.

| Group | Codes |
|---|---|
| Motion | `G0`, `G1`, `G2`, `G3`, `G4` (dwell, seconds) |
| Units / distance | `G20` / `G21`, `G90` / `G91` |
| Planes | `G17`, `G18`, `G19` |
| Work offsets | `G10 L2` (set), `G54`–`G59` (select) |
| Probing / clearance | `G28` (clearance position, **not** home), `G38.2` |
| Machine coordinates | `G53` (the next `G0`/`G1` only) |
| Offsets | `G92`, `G92.1`, `G92.4` |
| Program | `M2`, `M30` (end of program) |
| Spindle | `M3` / `M4` / `M5` |
| Tools | `M6 T<n>` (with the `T` on the same command), `M491` (re-measure tool length) |
| Manual tool change | `M490.1` / `M490.2` (the operator handshake) |
| Vacuum | `M331` / `M332` (bare; what this app's programs use) |
| Air (no-op) | `M7` / `M9` — answered `ok`, blow nothing on a Z1 |
| Laser (refused) | `M321`–`M325` |
| Pause | `M600` |

**What it refuses:** inverse-time feed, canned cycles, radius-form (`R`) arcs, and anything
on an `A` axis (rotary). A laser job or a rotary job is refused outright rather than drawn as
a cut. `G90.1`/`G91.1` are refused too — the firmware has no arc-centre mode, so the code
cannot mean what RS274 says; the distance mode is deliberately left unchanged and the file is
reported (`no-arc-centre-mode`). **Line numbers are refused as well**: an `N` word makes the
firmware ignore the line it numbers, so a numbered program would run as a stream of silently
skipped lines (`numbered-line`, #385).

### 8.3 The `;@MKR|` file header

> **Status: Available**.

Makera Studio writes a self-documenting header, and the machine UI reads it for material,
stock, time estimate and thumbnail. Case Maker reads it too — **as untrusted input that
prefills a form**, never as a decision.

A record is a tag followed by `key=value` fields separated by `|`:

```text
;@MKR|TOOL|number=1|id=112111313812|name=3.175*12mm Flat End(Metal)|type=Flat End|...
```

| Tag | Fields the app reads | What it is used for |
|---|---|---|
| `STOCK` | `id`, `length`, `width`, `height` | Prefills the stock dimensions (cuboid only). |
| `ORIGIN` | `type_name`, `x`, `y`, `z` | A corner preset hint, cross-checked against the stock. |
| `TOOL` | `number`, `id`, `name`, `type`, `diameter`, … | Matches a file to a tool in the library — the built-ins, and the cutters you registered (§7). |

The full sequence Studio writes is `BEGIN`, `SCHEMA`, `MACHINE`, `MATERIAL`, `STOCK`,
`ORIGIN`, `CAM`, `UNIT`, `TOOL`, `TIME`, `TOOLPATH`, `END` (`/Fabrication.md` §2). The
origin defaults to the stock's **top-front-left** corner. Only the **first** `=` in a field
splits it, and a field with no `=` is kept rather than dropped.

**A file Case Maker posts carries one line of ours.** Immediately after the `TOOL` record
sits `;@CM|TOOL|key=<your tool key>` — the key the cutter has in your tool list (`flat-1.0`,
`cat:…`, `user:…`, `inv:…`). Makera's `id=` names a cutter from Makera's catalogue, and a
clone or a hand-typed cutter has none, so this is the only way such a file can say which
cutter it was written for. Studio ignores the line, and everything that reads `.nc` files
treats it as a comment.

The Simulate form reads it first: when the key is in your tool list it settles the question
outright, and when it is not, the form says so — *this file names a cutter this house does
not have* — instead of passing the closest match off as the answer.

### 8.4 Troubleshooting

> **Status: Partly available** — answers exist for what is built; entries that name a planned feature name it, such as #206 or #207.

| Symptom | What it means |
|---|---|
| **Save is disabled** (engrave) | One of the three gates has not passed (#206). The failing row — Toolpath generated, Verified, Simulated — says which, with the reason beside it. Fix it and generate again. |
| **My text disappeared** (engrave) | The cutter's radius opened the glyph and removed the stroke (#201). Read the `item-detail-lost` / `item-chars-lost` row; use a bigger size or a smaller cutter. |
| **The simulation says the cutter hits the vise** | A `holder-collision` or fixture finding (#203). The jaws and the blank's height above them disagree; re-check the vise numbers and how proud the blank sits. |
| **The simulator refuses my file** | See the refusal banner's code: `laser-job`, `rotary-job`, `dense-3d-refused`, or `tool-refused`. Chapter 8.1 explains each. |
| **The part came out mirrored / rotated / offset** | The work origin or the placement is wrong. The app's `placement: stub` badge means it assumed the position; on the machine, re-probe the origin. Also check `stock-axes-unverified` — which stock dimension runs along X is unverified. |
| **Why does it say "starting values, unmeasured"?** | No feed or speed has been measured on this machine in this material yet — #165 for the PLA blank, #209 for the first chips. They are a place to start, not a recommendation. |
| **Why does it say "Makera's catalogue — not measured"?** | Makera's own library has a row for your cutter and material, so the panel starts from their numbers instead of ours (#310). Still not a measurement *of this machine* — and still clamped to its 13 000 RPM ceiling. Cut a coupon and the bench's reading replaces it. |

### 8.5 Glossary

> **Status: Available**.

- **Stock** — the block you are cutting.
- **Work origin** — the point all coordinates are measured from: the stock's top-front-left
  corner, with Z = 0 on the top face.
- **WCS** — work coordinate system: the offset that puts the program's coordinates onto the
  physical blank (G54 and friends).
- **Rapid** — a fast move that does not cut (`G0`). It carries no feed rate.
- **Feed** — a cutting move at a controlled rate (`G1`), with an `F` in mm/min.
- **Plunge** — a vertical cutting move, straight down.
- **Step-down** — how deep each pass cuts.
- **Step-over** — how far the cutter moves sideways between passes.
- **Stick-out** — how far the cutter protrudes from the collet.
- **Collet nut** — the nut that clamps the cutter in the spindle.
- **Checkpoint** — a point in the program where the simulation updates the stock.
- **Gouge** — a rapid that passes through material the program has not removed yet.
- **Opened region** — the area a cutter of a given radius can actually reach: the glyph grown
  and shrunk back by the radius. Strokes thinner than the diameter vanish; inside corners
  round to the radius.
- **Under-surface void** — a pocket the blank already has, cut into its **bottom** face: the
  magnet pocket of a badge blank is the one V1 works with. You declare it under **Stock** in the
  Engrave panel — its footprint and its **ceiling**, measured *up* from the bottom face, the
  opposite direction from every depth in the panel. What is left above the ceiling is the
  **membrane**, and a cut over the void is allowed only as deep as the membrane less the minimum
  floor. A cut that merely overlaps the void is warned (`item-over-void`); one deep enough to
  break through is refused (`cut-too-deep`). An unmeasured void is not reserved at all — a job
  that declares none cuts as it always did.
- **TLO** — tool length offset: the measured length of the fitted cutter, reset by `M491`.
