# Goal placement: slicer-style handles and a numeric panel (#876)

Design note before the work. It answers two questions — **where the goal's transform lives today**
and **how the handles sit in the 3D view** — and then states the slices and the decisions this
issue still needs.

## Where the goal transform lives today

One document object, one arithmetic module, one write path.

- **The document.** `EngraveTargetObject` (`casemaker-app/src/types/engraveJob.ts`): `position`
  (bbox centre in X and Y, mm from the stock's front-left corner; Z is the placed bbox's **top**
  above the stock's top face, so a negative Z sinks it), `rotation` (Z, degrees), `rotationX` and
  `rotationY` (degrees; the three turns apply Z first, then Y, then X — three.js's "XYZ" order —
  about the bbox centre), `scale` (per-axis about the same anchor), and `size` (the file's bbox).
  A zero about X or Y is stored as an **absent key**, so documents written before those fields
  existed round-trip unchanged.
- **The arithmetic.** `casemaker-app/src/engine/cnc/engrave/targetScale.ts` is the one owner:
  `targetTurns`, `rotationMatrix`, `rotatedExtents`, `placedSize` and `targetPlacement`. The goal
  sampler, the preview worker's goal volumes and the viewport all read `targetPlacement`, so a
  placement edit cannot draw one part and cut another. Turning maths lives beside it in
  `goalOrientation.ts` (#831): `turnAboutAxis` composes a world-axis turn as a matrix and writes
  the three Euler angles back, `turnsFromMatrix`/`turnsPatch` are the conversion, `chooseLayFlat`
  searches the 24 axis-aligned orientations, and `describeTurn` words the result.
- **The write path.** The store action `updateTargetObject(patch)` (`engraveJobStore.ts:2276`,
  patch type at :257). Undo is `store/goalTransformUndo.ts`: `rememberGoalPlacement` takes ONE
  snapshot per gesture (a whole drag, or one button press), and Ctrl+Z / the row's Undo put turn,
  position and scale back together.
- **The panel.** `EngraveTargetObjectRow.tsx`: X/Y/Z position fields (Z is the top height, and is
  disabled for a mould because its cavity always opens at the stock top), `MeshSizeControls`
  (scale, placed size, aspect lock, Fit to the stock, reset) and `MeshTurnControls` (three angle
  fields, a +90° press per stock axis, Lay it flat with an unasked suggestion, Undo).

## How the handles sit in the 3D view

- **The scene.** react-three-fiber (`components/viewport`). `EngravePrimitives` draws, in order:
  the stock (ghosted while a goal is stated), the goal — the preview worker's compiled volumes
  when it has them, otherwise the raw target mesh, both placed by `targetPlacement` — and then
  `GoalTransformHandles` (#831) while the mesh is selected or its row is open. **#876: always for
  the job's own goal mesh.** The maintainer, holding a goal on a phone, reported "I don't have
  axis controls": a job from a file lands with its rows closed (#411), and selecting the mesh
  needs the Select tool (the default is orbit), so neither gate ever opened and no handles were
  drawn at all. A goal is what the job exists to place; its handles are always on.
- **The handle group.** A plain r3f group in **stock** coordinates, centred on the placed bbox
  centre (`goalHandleFrame.handleFrame`, from `placedSize` and the top at `position.z`), with
  `radius = max(6, half the largest extent + 4)` mm. Three torus rings (X red, Y green, Z blue)
  turn; two arrow meshes (X, Y) move. Each mesh has a larger invisible **pick tube** over the
  drawn one, so a phone finger does not need the visible line's width. Materials draw with
  `depthTest: false` so the handles read through the ghosted stock and the part.
- **The drag.** Press → ray/plane (ring) or ray/line (arrow) parameter; move → the angle or the
  line parameter; up → write the document. **Rings use the graduated-scale zone model below;
  arrows snap to 1 mm (Shift 0.1 mm).** The first write of a drag calls
  `rememberGoalPlacement`, so undo is one entry per drag. From the press to the release the drag
  is captured by the WINDOW — a fast hand leaves the ring at once, and the ring used to stop
  updating when it did — and `AutoFrame` is held off the camera while a handle is held (turning a
  tall goal changes the scene diagonal past its 35 % threshold and would reframe mid-drag). The
  orbit control is disabled only while a drag is live. A live readout (`<Html>`) sits by the
  dragged handle and states the angle or the displacement.
- **Testing surface.** `goalHandleFrame.setGoalHandleProbe` exposes the **client pixel** of any
  point on a ring or arrow, and the existing walk `tests/e2e/goalTransform.spec.ts` drags the X
  ring along its own circle, asserts the readout, and reads the stored transform. #876's walk
  extends this pattern at 400×900 and 1280×800.

### The rotate ring's graduated scale and zone snapping (maintainer, 2026-11-01)

Modelled on PrusaSlicer's rotate gizmo, replacing #831's "15° snap plus Shift" entirely:

- **The scale.** A graduated annulus round each ring: short ticks every **5°**, longer ticks at
  every **15°**, and long radial lines at every **45°**, running inward toward the centre. Drawn
  in the same handle group (depthTest off), under the live angle label.
- **The zones.** While a ring is dragged, the cursor's **screen distance from the projected
  centre** picks the behaviour; no modifier key:
  - outside the scale band → **free** rotation (0.1° rounding, as #831's Shift);
  - inside the band → **tracks the ticks**: the nearest **5°**, with the 15° ticks longer so they
    read as the natural stops;
  - within 3° of a **45° major line** → **locks** to that 45° value exactly.
- **The band.** An annulus centred on the ring's **projected** radius, measured in screen pixels:
  24 px deep on a fine pointer, and **at least 44 px on a coarse pointer** (a phone). The band is
  computed per frame from the ring's projected radius so zoom cannot make a finger's band thinner.
- **The label.** The readout beside the handle shows the live angle while the drag is in the band
  or free ("Y 11.7°" — the drag's own value about that axis, since the stored form is three
  composed Euler angles), and the ring itself shows the tick it is on.
- **The test.** A drag whose cursor is in the band lands exactly on a 45° or 15° value; the same
  drag path outside the band does not snap. The numeric panel stays the precise route on a phone.

## What #876 adds

1. **Place on face.** Raycast the **raw target mesh**: its local geometry carries the object's own
   normals, which is exactly what a face choice needs. Build near-flat regions once per geometry
   (`goalFacePick.ts`): a region grows across shared edges while a neighbour's normal is within
   **8° of the region's seed normal** — on a CAD box every face is one region, and on an organic
   mesh (the panther) the region is the large near-flat patch a hand would call a side. Regions are
   **ranked by area and only the largest 24 highlight**; a click on any other triangle still places,
   using its region's area-weighted mean normal (the point fallback), so a mesh with no large flats
   is still usable. Highlight the group under the pointer, click to choose. Apply the choice as a
   **minimal turn**: take the face's local normal `n`, map it with `R · S⁻¹` (the inverse transpose
   under a non-uniform scale) and rotate about `w × target` by the angle between them, then compose
   with the current turns and write the Euler angles back. **Face up first** puts the chosen face
   at `+Z` (it is the face machined first); **face down** puts it at `−Z` (the part's bottom). One
   undo entry. This supersedes Lay it flat but Lay it flat stays (it is the quick shallowest
   choice). Tested on a synthetic CAD box and on a bent strip standing in for a non-CAD mesh.
2. **The graduated rotate ring** above: scale ticks, the zone model, the ≥44 px phone band, and
   the in-band/out-of-band test.
3. **Z arrow.** A third arrow along +Z (depth in the stock), same 1 mm snap and Shift. Arrow keys
   nudge 1 mm, Shift+arrow 10 mm, on the focused row.
4. **Numeric panel actions.** Centre in stock (`x = length/2`, `y = width/2`), Drop to floor,
   Flush to top (`z = 0`), Reset rotation (Z 0; X/Y absent). Each is one undo entry.
5. **Fit sentence.** Compare the placed extents with the stock's room and state the tightest
   axis: "fits the stock with 2.1 mm to spare in X", or the miss: "6.3 mm too tall: Resize to
   fit, or Cut the top N mm". Inform, never refuse.
6. **Phone.** Every panel control is at least 44 px; every action exists both on the canvas and
   in the panel, so nothing is handle-only. The pick tubes scale up on a coarse pointer.
7. **Best orientation — last.** One press scores candidate rotations by the #872 coverage measure
   (b2's), states which it chose and why, and never rotates silently.

## Decisions this issue needs (proposed defaults)

- **Floor allowance** for Drop to floor: no such shop default exists today. Proposal: **0 mm** —
  the part's bottom at the blank's bottom face — with the value stated in the sentence, and the
  shop-default key added only if the bench asks for one.
- **Stock room for the fit sentence:** the blank less the job's edge margin in X/Y (the same room
  "Fit to the stock" already uses), and the stock thickness in Z.
- **"Cut the top N mm":** sink the goal by N (`position.z −= N`) so its top comes flush, rather
  than scaling it down; the sentence says which.
- **Face grouping:** normal-only growth, **8° from the region's seed normal** (not the running
  mean, so a region cannot creep round a curve); regions ranked by area, the largest 24 offered;
  the point fallback covers everything else. The manager's 2026-11-01 amendment: an organic mesh's
  large near-flat region must be pickable, which the earlier exact-coplanarity rule (±0.5°,
  ±0.01 mm) would have fragmented into slivers.

## Slices and dependencies

1. Face grouping + hover highlight + the place-on-face turn (unit test: a clicked normal maps to
   ±Z exactly).
2. The graduated rotate ring + the cursor-radius zone model + the band's phone width, with the
   drag test (in the band → a 45°/15° value; outside → no snap).
3. Z arrow + keyboard nudges.
4. Numeric actions + fit sentence.
5. Best orientation (blocked on #872's coverage measure).

The acceptance walk needs the panther-class fixture from **#873**, which does not exist in the
tree yet; until it lands the walk can use the existing box-with-boss STL from
`goalTransform.spec.ts` behind the same probe.
