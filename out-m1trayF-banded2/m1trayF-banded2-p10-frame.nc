;@MKR|BEGIN
;@MKR|SCHEMA|v=1.0.0
;@MKR|MACHINE|id=Z1|name=Makera Z1
;@MKR|MATERIAL|id=0|name=hardwood
;@MKR|STOCK|id=cuboid|length=160|width=126|height=25|diameter=1
;@MKR|ORIGIN|id=0|type_name=topFrontLeft|x=-80|y=-63|z=12.5
;@MKR|CAM|id=CaseMaker|name=Case Maker|v=1.0.0
;@MKR|UNIT|value=MM
;@MKR|TOOL|number=1|id=111011313842|name=Spiral 'O' Single Flute Bit - 1/8" Shank 3.175mm * 42mm|type=Flat End|handlediameter=3.175|sticklength=0|shoulderlength=0|flutelength=42|diameter=3.175|tipdiameter=3.175|cornerradius=0|angle=0|halfAngle=0
;@CM|TOOL|key=inv:kz-o-flute-3-175-42
;@CM|START|tool=empty
;@MKR|TIME|seconds=19
; cycle estimate: cutting + rapids through the trapezoid, timed on Makera Z1's rapid model (1200 mm/min XY, 600 mm/min Z, 150 mm/s² accel, config read 2026-10-07 + stopwatch 2026-10-08) — a planning estimate, not a measured cycle time
;@MKR|TOOLPATH|number=1|tool_number=1|name=Frame trace
;@MKR|END

G90 G21
;@MKR|TOOLPATH_START|toolpath_number=1

; T1-Spiral 'O' Single Flute Bit - 1/8" Shank 3.175mm * 42mm

T1 M6
G53 G0 Z-3
G0 X153 Y34.8
S10000 M3
G0 Z20
G0 X159
G0 Y91.2
G0 X153
G0 Y34.8
G0 Z15
M05
G28
M02
