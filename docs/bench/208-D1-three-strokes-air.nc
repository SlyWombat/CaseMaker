;@MKR|BEGIN
;@MKR|SCHEMA|v=1.0.0
;@MKR|MACHINE|id=Z1|name=Makera Z1
;@MKR|MATERIAL|id=0|name=Test stock
;@MKR|STOCK|id=cuboid|length=60|width=30|height=6|diameter=1
;@MKR|ORIGIN|id=0|type_name=topFrontLeft|x=-30|y=-15|z=3
;@MKR|CAM|id=CaseMaker|name=Case Maker|v=0.0.0-test
;@MKR|UNIT|value=MM
;@MKR|TOOL|number=1|id=0|name=3.175 flat|type=Flat End|handlediameter=3.175|sticklength=0|shoulderlength=12|flutelength=12|diameter=3.175|tipdiameter=3.175|cornerradius=0|angle=0|halfAngle=0
;@MKR|TIME|seconds=30
;@MKR|TOOLPATH|number=1|tool_number=1|name=[T1]three strokes
;@MKR|END

G90 G21
; #208 D1 air tip. Every motion Z below is the #199 fixture's, raised 25 mm, so nothing
; touches. The raise is what this file needs room for:
;
;   REQUIRED: the blank's top face (work Z0) at machine Z -40 or lower — at least 20 mm below
;   the -20 tool-change SAFE height. Above that, the topmost move (`G0 Z40`) leaves the Z travel
;   (the enclosure is -100..0).
;
;   MEASURED 2026-10-12: the bench set work Z0 to machine Z -56.544 (`G10 L2 P1 ... Z-56.544`,
;   `traces/2026-10-12-console.log`; the probe touched at -56.107). `G0 Z40` therefore lands at
;   ~-16.5 machine, ~16.5 mm inside the travel.
;@MKR|TOOLPATH_START|toolpath_number=1
; #395 — the POST's order, word for word (#384): the vacuum comes on, then the machine-frame Z
; lift, and only then a word that moves in X/Y. The spindle start sits after the lift, so it
; comes on with the head at the controller's own clearance, and before `G0 Z5` — the first word
; that establishes a work Z, and the height the approach runs at. The accessory words are `M331`
; / `M332`, which is what our post writes and what a Z1 obeys; `M7`/`M9` are answered `ok` and
; blow nothing (#283), and this file used to carry them.
T1 M6
M331
G53 G0 Z-3
G0 X10 Y8
S12000 M3
G0 Z30
G1 Z24.5 F200
G1 X50 F500
G0 Z30
G0 X10 Y15
G1 Z24 F200
G1 X50 F500
G0 Z30
G0 X10 Y22
G1 Z23 F200
G1 X50 F500
G0 Z40
M332
M05
G28
M02
