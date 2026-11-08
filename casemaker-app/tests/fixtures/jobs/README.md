# Job fixtures

## `j30-panther-rotary.job.json` — #1059

The panther figure on the Z1's fourth axis: a 120 × 44.5 × 44.5 mm block in the chuck, the figure
baked at scale 0.5421 with its long axis on X and its section centred on the axis (placed
62.716 × 27.170 × 35.998 mm, largest radius 19.097 mm), the ⌀2 ball. It is the job the #1059
readiness run generated from (`1059-cylinder-stock` @ `177305ab7`): one rotary relief program —
rotary 3D rough (32 layers, 1 mm step-down, 0.9 mm step-over, 0.2 mm left) then the ball finish at
0.9 mm step-over — 2,271,164 cutting moves, cycle 27 h 41 min, air 37.5 %.

**The mesh is NOT committed.** `nude_pantherv2-final.stl` is not ours to license (it is local-only,
at `/mnt/house/casemaker/943-inputs/nude_pantherv2-final.stl` on dave-1). The fixture carries the
goal's identity only — `targetObject.name`/`format`/`sha256`/`size` — with **no `data`**: attach
the mesh's bytes to the job to run it, and the baked frame's sha256 does NOT equal the raw file's
(the job's transform is baked into the bytes it was generated with). The bake, as used:
scale 0.5421 uniformly, then Ry(+90) (local Z → X), then the section's bbox centre shifted to
(0, 0) and X's bbox to start at 0; binary STL records are 12 floats + a 2-byte attribute word
(50 bytes each) and the parser requires `bytes == 84 + triangles × 50` exactly.

Known at the time of writing (reported on #1059): the goal check cannot stamp a rotary goal, so the
relief's coverage/cut-into are unstated and its cut-into 0 is not a pass; a `goal-object-oversize`
warning fires falsely on this axis-centred goal; and a job carrying `faces` alongside the goal posts
only the faces program — the relief is dropped silently, so "the corners first, then the relief" is
two programs and not this one job.
