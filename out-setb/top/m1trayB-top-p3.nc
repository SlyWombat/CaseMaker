;@MKR|BEGIN
;@MKR|SCHEMA|v=1.0.0
;@MKR|MACHINE|id=Z1|name=Makera Z1
;@MKR|MATERIAL|id=0|name=hardwood
;@MKR|STOCK|id=cuboid|length=160|width=126|height=25|diameter=1
;@MKR|ORIGIN|id=0|type_name=topFrontLeft|x=-80|y=-63|z=12.5
;@MKR|CAM|id=CaseMaker|name=Case Maker|v=1.0.0
;@MKR|UNIT|value=MM
;@MKR|TOOL|number=1|id=0|name=Haocher corn (PCB router) bit ⌀0.9|type=Flat End|handlediameter=0|sticklength=0|shoulderlength=0|flutelength=0|diameter=0.9|tipdiameter=0.9|cornerradius=0|angle=0|halfAngle=0
;@CM|TOOL|key=inv:haocher-corn-0.9
;@CM|START|tool=empty
;@MKR|TIME|seconds=22
; cycle estimate: cutting + rapids through the trapezoid, timed on Makera Z1's rapid model (1200 mm/min XY, 600 mm/min Z, 150 mm/s² accel, config read 2026-10-07 + stopwatch 2026-10-08) — a planning estimate, not a measured cycle time
;@MKR|TOOLPATH|number=1|tool_number=1|name=[T1] Pocket "pocket-0"
;@MKR|TOOLPATH|number=2|tool_number=1|name=[T1] Pocket "pocket-1"
;@MKR|TOOLPATH|number=3|tool_number=1|name=[T1] Pocket "pocket-4"
;@MKR|END

G90 G21
;@MKR|TOOLPATH_START|toolpath_number=1

; T1-Haocher corn (PCB router) bit ⌀0.9

T1 M6
G53 G0 Z-3
G0 X35.942 Y20.356
S12000 M3
G0 Z5
G0 Z1
G1 Z-0.3 F150
G1 X35.958 Y20.331 F400
G1 X35.999 Y20.386
G1 X36.037 Y20.417
G1 X35.938
G1 Y20.389
G1 X35.942 Y20.356
G1 Z-0.577 F150
G1 X35.958 Y20.331 F400
G1 X35.999 Y20.386
G1 X36.037 Y20.417
G1 X35.938
G1 Y20.389
G1 X35.942 Y20.356
G0 Z5
;@MKR|TOOLPATH_START|toolpath_number=2
G0 X61.549 Y19.034 Z1
G1 Z-0.3 F150
G1 X61.551 Y19.032 F400
G1 X61.618 Y18.976
G1 X61.646 Y18.961
G1 X61.65
G1 Y19.076
G1 X61.549 Y19.034
G1 Z-0.577 F150
G1 X61.551 Y19.032 F400
G1 X61.618 Y18.976
G1 X61.646 Y18.961
G1 X61.65
G1 Y19.076
G1 X61.549 Y19.034
G0 Z5
;@MKR|TOOLPATH_START|toolpath_number=3
G0 X141.53 Y18.875 Z1
G1 Z-0.3 F150
G1 X141.565 Y18.873 F400
G1 X141.562 Y18.875
G1 X141.546 Y18.893
G1 X141.53 Y18.875
G1 Z-0.577 F150
G1 X141.565 Y18.873 F400
G1 X141.562 Y18.875
G1 X141.546 Y18.893
G1 X141.53 Y18.875
G0 Z5
G0 Z15
M05
G28
M02
