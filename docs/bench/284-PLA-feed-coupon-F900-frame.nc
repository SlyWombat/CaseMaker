;@MKR|BEGIN
;@MKR|SCHEMA|v=1.0.0
;@MKR|MACHINE|id=Z1|name=Makera Z1
;@MKR|MATERIAL|id=0|name=pla
;@MKR|STOCK|id=cuboid|length=38.1|width=76.2|height=3.81|diameter=1
;@MKR|ORIGIN|id=0|type_name=topFrontLeft|x=-19.05|y=-38.1|z=1.905
;@MKR|CAM|id=CaseMaker|name=Case Maker|v=1.0.0
;@MKR|UNIT|value=MM
;@MKR|TOOL|number=1|id=C1-BIT-O-FLUTE-2-12|name=Spiral O single flute 2 × 12|type=Flat End|handlediameter=3.175|sticklength=0|shoulderlength=0|flutelength=12|diameter=2|tipdiameter=2|cornerradius=0|angle=0|halfAngle=0
;@CM|TOOL|key=inv:kz-o-flute-2-12
;@MKR|TIME|seconds=5
; cycle estimate: cutting + rapids through the trapezoid, timed on Makera Z1's rapid model (1200 mm/min XY, 600 mm/min Z, 150 mm/s² accel, config read 2026-10-07 + stopwatch 2026-10-08 (#281)) — a planning estimate, not a measured cycle time
;@MKR|TOOLPATH|number=1|tool_number=1|name=Frame trace
;@MKR|END

G90 G21
;@MKR|TOOLPATH_START|toolpath_number=1

; T1-Spiral O single flute 2 × 12

T1 M6
M331
G53 G0 Z-3
G0 X2.369 Y62.524
S12000 M3
G0 Z20
G0 X35.731
G0 Y73.524
G0 X2.369
G0 Y62.524
G0 Z15
M332
M05
G28
M02
