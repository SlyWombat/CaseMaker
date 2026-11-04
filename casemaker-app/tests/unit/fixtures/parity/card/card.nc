;@MKR|BEGIN
;@MKR|TOOL|number=1|id=|name=3.175mm Flat End|type=Flat End|handlediameter=3.175|sticklength=0|shoulderlength=25|flutelength=25|diameter=3.175|tipdiameter=3.175|cornerradius=0|angle=0|halfAngle=0
;@MKR|TIME|seconds=60.0
;@MKR|END

G21 G90
T1 M6
S10000 M3
G0 X0 Y0 Z1
G1 Z-1 F300
G1 X10 F1000
G1 Y10
G0 Z1
M2
