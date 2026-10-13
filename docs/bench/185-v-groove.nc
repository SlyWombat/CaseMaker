;@MKR|BEGIN
;@MKR|SCHEMA|v=1.0.0
;@MKR|MACHINE|id=Z1|name=Makera Z1
;@MKR|MATERIAL|id=0|name=pla
;@MKR|STOCK|id=cuboid|length=38.1|width=76.2|height=3.81|diameter=1
;@MKR|ORIGIN|id=0|type_name=topFrontLeft|x=-19.05|y=-38.1|z=1.905
;@MKR|CAM|id=CaseMaker|name=Case Maker|v=1.0.0
;@MKR|UNIT|value=MM
;@MKR|TOOL|number=1|id=C1-BIT-ENGRAVE-30-0.3|name=Single Flute Engraving Bit 30 x 0.3|type=Engraving|handlediameter=3.175|sticklength=0|shoulderlength=0|flutelength=0|diameter=3.175|tipdiameter=0.3|cornerradius=0|angle=30|halfAngle=15
;@CM|TOOL|key=inv:kz-engrave-30-0-3
;@MKR|TIME|seconds=13
; hand-written: the app cannot generate a V-bit program (no sweep; see the comment in the body)
; TIME is a hand estimate with no accel term, so it reads a little low
;@MKR|TOOLPATH|number=1|tool_number=1|name=[T1]V-groove 0.6 deep at X 2.5, predicted top opening 0.622mm
;@MKR|TOOLPATH|number=2|tool_number=1|name=[T1]V-groove 0.8 deep at X 5.5, predicted top opening 0.729mm
;@MKR|TOOLPATH|number=3|tool_number=1|name=[T1]V-groove 1.0 deep at X 8.5, predicted top opening 0.836mm
;@MKR|TOOLPATH|number=4|tool_number=1|name=[T1]V-groove 1.2 deep at X 11.5, predicted top opening 0.943mm
;@MKR|END

G90 G21

; T1-Single Flute Engraving Bit 30 x 0.3
;
; #185 V-groove reach test, HAND-WRITTEN by casemaker-app/scripts/bench-files.ts.
; Our pipeline cannot emit this file: a V-bit has no sweep (cuttingRadiusForSweep refuses a
; non-flat tool), so no engrave job can generate a program for one. It was checked by the
; app's own verifier (verifyProgram) before being written, the same gate the upload path uses.
;
; Cut it on the LADDER blank in the free section LEFT OF ROW A (the fixed-jaw side), after
; #165's ladder and #176's stroke, with the 30 V-bit in T1 (M491, plan S3 step 6). Four
; grooves, 10 mm long along +Y (Y 4..14, in front of the magnet pocket's 15.6 front edge), at
; #165's first four depths, shallowest first.
;
; The section is full 3.81 mm thickness — the magnet pocket's left wall is at X 12.55 — and the
; grooves are 3 mm apart across it. X 2.5 and X 11.5 are the section's own bounds, not taste:
; the unmeasured jaws' 2 mm band starts at X 2, and the pocket wall ends the strip at 11.5.
;
; CALIPER the TOP OPENING width of each groove (across the top, not the floor) and compare it
; with
;   w(d) = tip + 2 d tan(halfAngle)   (tip 0.3 mm, half angle 15 deg):
;   X 2.5  d 0.6 mm  ->  predicted 0.622 mm
;   X 5.5  d 0.8 mm  ->  predicted 0.729 mm   <-- the 0.81 mm reveal depth: #185's own reading
;   X 8.5  d 1.0 mm  ->  predicted 0.836 mm
;   X 11.5  d 1.2 mm  ->  predicted 0.943 mm
;
; Every groove's FLOOR is the tip's own 0.3 mm flat, at every depth: that is why the check
; above is on the opening. The tip and the included angle are MEASURED under a loupe first
; (#185 step 1, plan desk item 3): w(d) above is only as good as the tip they report.
; Stage 1 of #185 — the morphological opening over the bundled fonts - needs no machine; it
; is docs/bench/185-font-opening.md.
;
T1 M6
M331
G53 G0 Z-3

G0 X2.5 Y4
S12000 M3
G0 Z5
;@MKR|TOOLPATH_START|toolpath_number=1
; groove 1 of 4: 0.6 mm deep at X 2.5, top opening 0.622 mm
G0 Z1
G1 Z-0.6 F200
G1 Y14 F500
G0 Z1
G0 Z5
;@MKR|TOOLPATH_START|toolpath_number=2
; groove 2 of 4: 0.8 mm deep at X 5.5, top opening 0.729 mm
G0 X5.5 Y4 Z1
G1 Z-0.8 F200
G1 Y14 F500
G0 Z1
G0 Z5
;@MKR|TOOLPATH_START|toolpath_number=3
; groove 3 of 4: 1.0 mm deep at X 8.5, top opening 0.836 mm
G0 X8.5 Y4 Z1
G1 Z-1 F200
G1 Y14 F500
G0 Z1
G0 Z5
;@MKR|TOOLPATH_START|toolpath_number=4
; groove 4 of 4: 1.2 mm deep at X 11.5, top opening 0.943 mm
G0 X11.5 Y4 Z1
G1 Z-1.2 F200
G1 Y14 F500
G0 Z1
G0 Z5
G0 Z15
M332
M05
G28
M02
