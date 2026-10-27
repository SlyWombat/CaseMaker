# Typical desktop-CNC jobs: Makera Z1 + comparable machines (web research, 2026-10-27)

Legend: **[S]** = stated by the source; **[E]** = my estimate/conversion; "n/s" = not stated.
Honesty note: Z1-specific job write-ups with numbers are scarce. The one rich source is the cnx-software
Z1 review (7 jobs with feeds). Makera's own blog/project pages mostly omit feeds; Makera's numbers live
in per-bit "Tool Reference Parameters" tables on store pages (captured below). Makerables project pages,
Reddit r/Makera, overclock3d, hackster and Bantam support pages were not fetchable (403/timeout/not indexed).

## A. Makera Z1 facts (for context)

- Work area 200 x 200 x 100 mm [S makera.com/pages/makera-z1 via search summary; makera.com/blogs/cnc-buying-guide/makera-z1-review]. 115 mm gantry clearance [S search summary only].
- Spindle 150 W, 0-13,000 RPM closed-loop [S cnx]; one outlet says 15,000 (outlier). Carvera Air: 3k-13k, "do not run well under 6000" [S carvera-community gitbook].
- Collet: 1/8" (3.175) standard; 4 mm, 6 mm, 1/4" optional [S wiki.makera.com/en/Z1/QuickStart; notebookcheck]. Bit collars, default ~12 mm exposed [S wiki].
- 4th axis: Ø80 x 150 mm, belt drive, ~2.5 N·m, self-centring 3-jaw chuck (reverse jaws by default; standard jaws for small parts) + adjustable tailstock; MDF wasteboard removed; zero preset at centre of right edge [S cnx; wiki.makera.com/en/Z1/Accessories/4Axis; makera.com/blogs/cnc-buying-guide/makera-z1-vs-carvera-air]. Carvera Air rotary Ø92 x 200.
- Workholding: anchor system - thin L-bracket at Anchor 1 (lower-left, 2x M5 in semicircular slots), top clamps on upper-right; auto Z-probe and lower-left-corner origin [S wiki QuickStart]. Optional Low-Profile Vise (6x M5x20 on locating pins, slotted soft jaws for thin parts, lifts stock for through-cuts) [S wiki Low-Profile-Vise]; Vacuum Bed; double-sided tape ~0.2 mm thick, 20 mm x 10 m roll included [S makera.com/products/strong-fixation-transparent-double-sided-tape]; PCB rivets sold. Top clamps for stock < 20 mm; side clamps + thick bracket > 20 mm (Carvera wording) [S].
- Box kit (cnx): wired probe, starter bit set, collets, clamp+screw set, locating pins, double-sided tape, sample materials.
- Makera "Essential Milling Bit Set" 26 pcs, all 1/8" shank [S core-electronics.com.au/makera-common-milling-bits-26-pcs.html]: O-flute single-flute metal 3.175x12, 2x8, 1x3; O-flute non-metal 3.175x25, 3.175x42; single-flute engraving (metal) 0.1x60°, 0.2x30°, 0.3x30°; 2F ball nose metal 3.175/2/1, non-metal 3.175/2/1; TiN drills 1/2/2.5/3; TiN corn 0.6/1/2/3; thread mills M3 (d2.4, 9 mm) and M5 (d4, 15 mm); 90° chamfer x2.
- Makera per-bit reference feeds [S, store-page tables; columns = RPM / feed mm/min / plunge mm/min / DOC mm]:
  - O-flute **metal** 3.175x12 (also 2.5x12): Al 12000/500/200/0.2; brass & copper 12000/300/100/0.1; hardwood & plastic 10000/1000/300/1; softwood 10000/1000/300/2; PCB "-". Small sizes (1x3, 1.5x6) Al DOC 0.1, brass 0.05; 2x8 Al 0.15. [makera.com/products/spiral-o-single-flute-bit-for-metal-1-8-shank]
  - O-flute **non-metal** 3.175 (17/25/32/42 mm): hardwood & plastic 10000/1000/300/1; softwood DOC 2; 1-2 mm sizes DOC 0.5 (softwood 1). [makera.com/products/spiral-o-single-flute-bit-1-8-shank]
  - Engraving (metal) 0.1x60°, 0.2-0.5x30°: Al 12000/500/200/0.2; brass/copper 12000/300/100/0.1; **PCB 12000/500/200/0.1**; plastic & hardwood 12000/1000/500/1; softwood DOC 2. [global.makera.com/products/single-flute-engraving-bit-for-metal-1-8-shank]
  - 90° chamfer (for 0.1 mm chamfer): Al 12000/600/200/0.2; brass/Cu/CF/PCB 12000/500/200/0.1; plastic & hardwood 12000/1000/500/1; softwood 12000/1200/500/2. [makera.com/products/chamfering-bit]
  - Thread mill: 60°, solid carbide, M1-M5 (M3 d2.4/9 mm, M4 d3.15/12, M5 d4/15); no feeds published. Corn-bit table: not retrievable (store rate-limited).
- Makera acrylic guide, "desktop" row: 3.175 / 4 / 6 mm O-flute, 10,000 RPM, 1,000 mm/min, 1 mm DOC [S makera.com/blogs/cnc-beginner-guide/acrylic-cnc-machining-guide].

## B. Jobs

**1. Aluminium Top Clamp - the Z1's preloaded first job** (Z1, official)
- URL: https://wiki.makera.com/en/Z1/QuickStart (NC: github.com/MakeraInc/CarveraProfiles/releases/download/v0.9.1/TopClamp.nc)
- Material/stock: aluminium plate 100 x 100 x 5 mm (included) [S].
- Holding: 4x M5x20 + 2 top clamps at the anchor position; origin Anchor 1, offsets 0/0 [S].
- Ops: profile cut-out with tabs (tabs removed with screwdriver, edges filed) [S]; holes/slot [E from the part being a clamp]. Auto-leveling 3x3, probe height 2 mm; Scan Margin; Auto Vacuum/Blow [S].
- Cutter: Tool #1, 3.175 x 12 mm single-flute spiral (O-flute) for metal [S].
- Feeds: n/s on the page; Makera's table for that bit in Al = 12000 RPM, 500, 200 plunge, 0.2 DOC [S table, not the job].

**2. Letters milled into soft plastic sheet** (Z1) - engraved sign/name type
- URL: https://www.cnx-software.com/2026/09/01/makera-z1-desktop-cnc-review-smart-milling-4-axis-module-and-5w-laser-engraving/
- Stock: n/s. Holding: n/s (wired probe for position + levelling).
- Cutter: 3.175 2-flute flat [S]. 12,000 RPM, 500 mm/min, plunge 150, 0.5 mm stepdown, ~1 mm deep, 2 passes, ~7-10 min [S].

**3. Small "CNX Software" text, part in the vise** (Z1) - vise-held job
- Same URL. Soft synthetic sheet, size n/s. **Low-profile vise** [S].
- ~1 mm 2-flute flat [S]; 12-13k RPM, 250 mm/min, plunge 80, ~0.25 stepdown, ~0.5 mm deep, 2D pocket + one contour, ~10-15 min [S].

**4. Engraved text on aluminium and brass discs** (Z1) - name tag/badge in metal
- Same URL. Two small round blanks, size n/s; holding n/s.
- ~1 mm single-flute carbide flat [S]. 12-13k RPM; pocket + contour; 0.3-0.5 mm total depth [S].
  - Al: 200-250 mm/min, plunge 50-60, 0.10-0.15 stepdown, 30-45 min [S].
  - Brass: 150-200 mm/min, plunge 40-50, 0.08-0.10 stepdown, 40-60 min [S].

**5. Two-colour plastic sign on the vacuum bed** (Z1) - colour-layer engraving; vacuum workholding
- Same URL. Red-over-white sheet, size n/s. **Vacuum Bed** (suction from Dust Collector Lite) [S].
- 3.175 2F flat; 12,000 RPM, 350-450 mm/min, plunge 100, 0.2-0.3 per pass, 0.3-0.5 mm total, 2D pocket, ~10-15 min [S].

**6. 3D relief "wolf" from a model** (Z1) - 3D relief from mesh
- Same URL. Material/stock/holding n/s.
- Rough: 3.175 2F flat, 12k RPM, 500 mm/min, plunge 150, 1 mm/pass, 40% stepover, 45-90 min [S].
- Finish: ~1 mm ball nose, 13k RPM, 250-300 mm/min, 0.08-0.12 mm stepover, parallel/raster, 7-10 h [S]. Total 8-12 h.

**7. Photo-to-3D relief in synthetic stone** (Z1, Makera blog)
- URL: https://www.makera.com/blogs/cnc-beginner-guide/photo-to-3d-cnc-relief-ai
- Stock ~100 x 150 x 10 mm [S]; relief ~90 mm across, ~3 mm deep [S].
- Holding: wasteboard + L-bracket at Anchor 1 + screws + top clamps; probe point ~5 mm in from X/Y [S].
- Ops: 3D rough (Tool 4, also used for the contour), 3D finish (Tool 2, "fine engraving or detail bit"), cut-out 0.5 mm into wasteboard with tabs [S]. Bit sizes/feeds n/s - thin.

**8. Rotary sculpture (epoxy) on the 4th axis** (Z1) - rotary job
- cnx URL above; also Makera demo https://www.makera.com/blogs/cnc-beginner-guide/makera-z1-4th-axis-demo-rotary-3d-carving-indexed-milling (epoxy block + indexed Gridfinity holder; no numbers).
- Holding: 3-jaw chuck + tailstock [S]; stock must fit Ø80 x 150 [S spec].
- Rough: 3.175 2F flat, 12k, 400-500 mm/min, plunge 100-150, 0.8-1 mm/pass, 35-40% stepover, 45-90 min [S].
- Finish: ~1 mm ball, 13k, 250-300 mm/min, 0.08-0.12 stepover, rotary parallel, 5-8 h [S].
- Rod/pen/tumbler *engraving*: no Z1 or Carvera example found. Pen-turner threads (community.inventables.com/t/pen-engraving/21726) are speculative (suggest an ~11° V-bit, no numbers). A tumbler won't fit Ø80 x 150 unless small [E].

**9. PCB isolation + drill + outline** (Carvera, Makera CAM)
- URL: https://raajthakur1.github.io/Thakur-Raaj-Portfolio/courses/senior_engineering/pcb_milling/
- Stock: PCB 127 x 101 x 1.7 mm, placed at (6,6) [S]. Clamped (tape not mentioned); auto-leveling on [S].
- Ops: 2D pocket of copper (isolation equivalent) end depth 0.05 mm with 0.2 mm x 30° engraving (metal) + 0.8 mm corn; drill to 1.70 mm with 0.8 corn; contour 1.70 with 0.8 corn, 3 tabs; ~30 min [S].
- Feeds n/s; Makera's engraving-bit PCB row: 12000/500/200/0.1 [S table].

**10. PCB on a 3018, taped down** (Genmitsu-class 3018) - tape-held job
- URL: https://hackerspacenijmegen.nl/Milling_PCB%27s_with_3018_Chinese_Desktop_CNC
- Holding: PCB taped on all four sides in a pocket of a sacrificial plate [S].
- Isolation: tool dia 0.5 set in CAM, Z -0.1 (or -0.15), F30 ("60 works too"), 9000 RPM, 2 passes 80% overlap [S].
- Drill: 0.8 / 0.9+ (headers) / 1.0 mm, Z -2.5, F60, 9000 RPM [S]. Outline: 2 mm 2F endmill, -2.5 in 0.2 passes, F200 (up to 400) [S].
- Height map 5x5, F100 fast / F25 final probe [S]. Usable area 170 x 120 [S].

**11. V-carved sign / coaster (90° V-bit)** (Shapeoko, Carbide Create)
- URLs: https://community.carbide3d.com/t/v-carving-depth-of-cut-help-me-understand/13992 and related threads in that search (coaster note: 1/8" 90° bit simulates right only once flute length set to true 0.125").
- Cutter: Carbide 3D #301, 90°, 1/2" (12.7 mm), 1/4" shank [S].
- CC library defaults quoted by a user: 7639 RPM, feed 22.9, plunge 5.7, DOC 0.151" (3.8 mm), stepover 0.225" [S; units n/s, almost certainly in/min = ~580 / 145 mm/min E]. Another user, MDF: 15,000 RPM, 39.4 ipm (~1000 mm/min E), plunge 13.8 ipm (~350 E), DOC = max depth 6 mm [S].
- Stock: n/s; typical coaster ~100 x 100 x 6-19 mm [E]. Depth is set by feature width, not a setting [S].

**12. V-carve inlay** (Shapeoko, VCarve/Carbide Create)
- URL: https://community.carbide3d.com/t/vcarve-inlays-with-vcarve-desktop-details-and-discoveries/6552 (plus "inlay question again" thread from the same search).
- Cutter: 60° V-bit recommended; avoid 90°; 20-30° for fine detail [S].
- User recipe: pocket 0.20" (5.1 mm); plug start 0.15" (3.8 mm) + flat 0.05" (1.3 mm) glue gap [S, mm E]. Note VCarve's flat depth is relative to start depth; Carbide Create's are absolute [S].
- Feeds/stock n/s; wood (hardwood pairs) [S implied].

**13. Pocketed aluminium medallion (pocket + profile)** (Shapeoko XXL) - aluminium plate with pocket
- URL: https://blog.patshead.com/2019/07/my-first-attempt-to-cnc-aluminum.html
- Stock: 6061, 1/4" (6.35 mm) from a 6 x 12" (152 x 305 mm) sheet [S].
- Cutter: 2 mm carbide endmill, 1/8" shank, flutes n/s [S]. Router dial "1" (~16-17k RPM E).
- 355 mm/min, plunge 7.1 mm/min, DOC 0.187 mm, stepover 0.8 mm, pocket 1.5 mm [S]. Two broken endmills; pocket good, contour failed at ~1.5 mm on chip clearing [S].

**14. Tool tray (2.5D pockets)** (Nomad 3, official starter project)
- URL: https://my.carbide3d.com/pdf/Nomad3_Starter_Project.pdf (PDF >10 MB, I could not open it; details from search snippet + community.carbide3d.com/t/nomad-3-tool-tray-starter-project-remixed/28163).
- Material: bamboo [S]. Cutter: #102 1/8" (3.175) flat [S]. Feeds/stock n/s. A third-party Nomad tutorial sets #102 feed "75" for Soft Plastic (units n/s) [S, possiblezone.super.site/nomad-3-milling-machine-tutorial]. Nomad ships with double-sided tape; 8x8x3" area, 130 W, 9-24k RPM [S].

**15. Engraved anodised-aluminium dog tag** (Bantam Tools) - name tag
- URL: https://support.bantamtools.com/hc/en-us/articles/360038821814-Engraving-Dog-Tags (403 to me; from search snippet only).
- Cutter: 80° engraving bit, 0.005" (0.13 mm) tip [S snippet]; Bantam table for that bit in Al lists 28,000 RPM [S snippet, other columns cut off]. Bantam normally holds stock with tape and asks for tape thickness in setup [S, bantamtools.com/blog/how-to-make-custom-name-cutouts-alj3l snippet]. Tag size n/s (standard dog tag ~51 x 28 mm E).

**16. Acrylic keychain / cut-out** - **no proper source found**
- Closest: Easel "Darth Vader keychain" (X-Carve 2016, cast acrylic, carved then paint-filled and sanded; bits/feeds/stock n/s) https://easel.com/gallery/nSjDUyHE. Inventables' acrylic projects use a 1/8" single-flute straight or 1/16" fishtail [S search snippet].
- Use Makera numbers instead: 3.175 O-flute in plastic 10000 RPM / 1000 mm/min / 300 plunge / 1 mm DOC [S table]; typical 3 mm cast acrylic, ~50 x 30 mm, tape or vacuum, tabs [E].

**17. Chamfered part** - **no project found**; Makera 90° chamfer-bit table (section A) is the best source: 0.1 mm chamfer in Al at 12000/600/200/0.2 [S]. The Z1 kit includes 2 chamfer bits [S set listing].

**18. Enclosure faceplate with cut-outs** - **no desktop write-up with numbers found**
- Typical target: Hammond 1590B lid, 111.9 x 60.9 mm footprint [S lovemyswitches.com/1590b-enclosure-cnc-pro-bare-aluminum]; die-cast, thin-wall "CNC Pro" variant sold for machining.
- Comparable numbers: 1/8" 2F in 5 mm Al ~600 mm/min, DOC <= 1/16" (1.6 mm) [S Ooznest via search snippet, WorkBee]; Bantam 1/4" flat in Al 28k RPM, 30 ipm, 0.02" DOC [S snippet]. On a Z1 I'd use the Makera O-flute metal row (500 mm/min, 0.2 DOC) [E].

**19. Threads / tapped holes in aluminium** - **no desktop job found**
- Makera sells 60° single-form thread mills M1-M5 and the Essential set ships M3 + M5 [S]. No published feeds. Industrial 6061 field data (8,000 RPM, 50 ipm, 5/16-24) is not desktop-relevant [S industrialmonitordirect.com]. Treat as an open gap.

## C. Patterns worth keeping
- Z1 jobs consistently run 12-13k RPM (spindle top end) with small single-flute or 2-flute 1/8"-shank cutters; metals use 0.05-0.2 mm DOC and 200-500 mm/min; plastics/wood 1 mm DOC at ~1000 mm/min [S across Makera tables + cnx].
- Fine work is slow: 1 mm ball finishing runs 5-10 h on the Z1 [S cnx].
- Holding by job: plate/sheet = anchor bracket + top clamps; small or thick part = low-profile vise; thin sheet/PCB/2-colour = vacuum bed or tape; round = 3-jaw chuck + tailstock [S].
- PCB isolation depths 0.05-0.15 mm; 0.2 x 30° engraving + 0.8 corn is Makera's pairing [S].
