"""Build light-saber cap variants from the prizma watch case samples.

Top file:    remove the 4 band mounts (lugs) outside |Y| <= 25.5 and cap the
             4 holes left in the hex side walls.
Bottom file: extend the floor (the z = min_z plane) downward by 10 mm,
             splicing in a vertical wall so the chamfer above is preserved.
"""
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
import trimesh

ROOT = Path(__file__).resolve().parent.parent
SAMPLES = ROOT / "samples"

TOP_IN  = SAMPLES / "prizma_case_top.stl"
BOT_IN  = SAMPLES / "prizma_case_bottom.stl"
TOP_OUT = SAMPLES / "prizma_lightsaber_cap_top.stl"
BOT_OUT = SAMPLES / "prizma_lightsaber_cap_bottom.stl"

BAND_Y_THRESHOLD = 25.5   # core hex |Y| extent — anything outside is a lug
EXTEND_DOWN_MM   = 10.0   # extra first-layer thickness


def trace_loops(boundary_edges):
    """Walk degree-2 boundary edges into ordered vertex loops."""
    adj = defaultdict(set)
    for a, b in boundary_edges:
        adj[int(a)].add(int(b))
        adj[int(b)].add(int(a))
    visited = set()
    loops = []
    for start in list(adj):
        if start in visited:
            continue
        loop = [start]
        visited.add(start)
        prev = start
        cur = next(iter(adj[start]))
        while cur != start and cur not in visited:
            visited.add(cur)
            loop.append(cur)
            nxt = [n for n in adj[cur] if n != prev]
            if not nxt:
                break
            prev = cur
            cur = nxt[0]
        loops.append(loop)
    return loops


def boundary_edges_of(mesh):
    es = np.sort(mesh.edges, axis=1)
    eu, cnt = np.unique(es, axis=0, return_counts=True)
    return eu[cnt == 1]


def cap_loop_with_fan(verts, loop_idx, mesh_centroid):
    """Add a centroid-fan triangulation that closes a planar-ish loop.

    Returns (new_vert, new_faces) where new_vert is the centroid (1 new vertex)
    and new_faces are triangle indices using the loop's original verts plus the
    centroid (centroid is appended at the end).

    Winding is chosen so the cap's normal points away from `mesh_centroid`
    (i.e. outward from the case body).
    """
    pts = verts[loop_idx]
    centroid = pts.mean(axis=0)

    # SVD plane fit (normal = least-variance direction)
    cd = pts - centroid
    _, _, vh = np.linalg.svd(cd, full_matrices=False)
    plane_n = vh[-1]
    # Make the plane normal point outward from mesh centroid
    if np.dot(plane_n, centroid - mesh_centroid) < 0:
        plane_n = -plane_n

    # Build triangle list (centroid as last vertex). We pick the winding for
    # the first triangle by checking its normal vs plane_n; if wrong, reverse
    # the loop order.
    n = len(loop_idx)
    a = pts[0] - centroid
    b = pts[1] - centroid
    if np.dot(np.cross(a, b), plane_n) < 0:
        loop_idx = list(reversed(loop_idx))

    return centroid, loop_idx  # caller assembles faces


def build_cap_top():
    """Strip lugs by intersecting the top case with the bottom case's hex
    footprint, extruded vertically to cover the top's Z range.

    The bottom case has no lug geometry — its XY cross-section IS the pure
    hex profile we want — so projecting it up gives a clean cookie-cutter."""
    src = trimesh.load(TOP_IN)
    bot = trimesh.load(BOT_IN)
    print(f"[top] src: {len(src.vertices)} verts, {len(src.faces)} faces, "
          f"watertight={src.is_watertight}")

    z_min, z_max = src.bounds[0][2], src.bounds[1][2]
    pad = 5.0
    # The full hex outline only appears in a narrow Z band of the bottom
    # case where the outer wall is at max extent. Slicing higher hits the
    # hollow interior; slicing at the floor gives the chamfered-in profile.
    # z = -12 is squarely inside the full-extent band (max|X|=23.09 spans
    # z = -12.28 to -10.66). Take the OUTER ring only — drop any inner
    # cavity hole so the cookie-cutter is solid.
    from shapely.geometry import Polygon
    slice_z = -12.0
    section = bot.section(plane_origin=[0, 0, slice_z],
                          plane_normal=[0, 0, 1])
    if section is None:
        raise RuntimeError("could not slice bottom case for hex footprint")
    planar, _ = section.to_2D()
    polys = planar.polygons_full
    if len(polys) == 0:
        raise RuntimeError("bottom slice produced no polygons")
    # Pick the polygon with the largest exterior bounding area (the outer
    # hex shell), and replace it with just its exterior ring so any inner
    # cavity hole is filled in.
    def ext_bbox_area(p):
        minx, miny, maxx, maxy = p.bounds
        return (maxx - minx) * (maxy - miny)
    outer = max(polys, key=ext_bbox_area)
    poly = Polygon(outer.exterior.coords)
    print(f"[top] hex footprint area: {poly.area:.1f} mm^2 "
          f"(bounds {poly.bounds})")

    height = (z_max - z_min) + 2 * pad
    stamp = trimesh.creation.extrude_polygon(poly, height)
    stamp.apply_translation([0, 0, z_min - pad])
    print(f"[top] stamp: {len(stamp.vertices)} verts, "
          f"watertight={stamp.is_watertight}, vol={stamp.volume:.1f}")

    out = trimesh.boolean.intersection([src, stamp])
    print(f"[top] intersection: {len(out.vertices)} verts, "
          f"{len(out.faces)} faces, watertight={out.is_watertight}, "
          f"winding_consistent={out.is_winding_consistent}")
    out.export(TOP_OUT)
    print(f"[top] wrote {TOP_OUT}")


def build_cap_bottom():
    src = trimesh.load(BOT_IN)
    print(f"[bot] loaded {len(src.vertices)} verts, {len(src.faces)} faces, "
          f"watertight={src.is_watertight}")

    verts = src.vertices.copy()
    faces = src.faces.copy()
    min_z = float(verts[:, 2].min())
    floor_mask = np.abs(verts[:, 2] - min_z) < 1e-3
    n_floor = int(floor_mask.sum())
    print(f"[bot] floor verts at z={min_z:.4f}: {n_floor}")

    f_floor_verts = floor_mask[faces]                # (F,3) bool
    floor_face_mask = np.all(f_floor_verts, axis=1)  # face fully on floor
    chamfer_face_mask = np.any(f_floor_verts, axis=1) & ~floor_face_mask
    print(f"[bot] floor faces: {floor_face_mask.sum()}, "
          f"chamfer faces touching floor: {chamfer_face_mask.sum()}")

    # Boundary of the floor polygon = floor edges that appear in exactly one
    # floor face (their other side is a chamfer face above).
    edge_count = defaultdict(int)
    edge_dir = defaultdict(list)  # store directed orientation in floor faces
    for f in faces[floor_face_mask]:
        for a, b in [(f[0], f[1]), (f[1], f[2]), (f[2], f[0])]:
            key = tuple(sorted([int(a), int(b)]))
            edge_count[key] += 1
            edge_dir[key].append((int(a), int(b)))
    boundary_edges = [e for e, c in edge_count.items() if c == 1]
    print(f"[bot] floor perimeter edges: {len(boundary_edges)}")

    # Floor faces normals point DOWN (-Z). For each boundary edge, the
    # directed orientation in the floor face is consistent: if (a,b) was the
    # ordering in the floor face, then walking a->b with -Z normal, the
    # outward direction (away from polygon centroid in XY) is to the LEFT of
    # the walk vector (right-hand rule with normal -Z gives right of walk
    # = inside).
    # We just record the directed (a,b) so we can build wall quads later.
    boundary_dir = {e: edge_dir[e][0] for e in boundary_edges}

    # Duplicate every floor vertex so we have a "lowered" copy at z-=10mm.
    # The originals stay anchoring the chamfer above; the duplicates will
    # form the new lowered floor and be tied to the originals by vertical
    # wall faces around the perimeter.
    dup_index = {}
    new_verts = [verts]
    next_idx = len(verts)
    for v_idx in np.where(floor_mask)[0]:
        nv = verts[v_idx].copy()
        nv[2] -= EXTEND_DOWN_MM
        dup_index[int(v_idx)] = next_idx
        next_idx += 1
        new_verts.append(nv[None, :])
    new_verts = np.vstack(new_verts)
    print(f"[bot] duplicated {len(dup_index)} floor verts (now "
          f"{len(new_verts)} total)")

    # Rewrite floor faces to use the lowered duplicates.
    new_faces = []
    for fi, f in enumerate(faces):
        if floor_face_mask[fi]:
            new_faces.append([dup_index[int(v)] for v in f])
        else:
            new_faces.append(list(f))

    # Add vertical wall faces around the perimeter.
    # boundary_dir[e] gives (a, b) in the order the floor face traversed it.
    # The chamfer face above (which also contains this edge) traversed it
    # b -> a (opposing winding, since they share the edge in a closed mesh).
    # We rewrote the floor face to use duplicate vertices, so the lowered
    # floor traverses (dup_a -> dup_b).
    # For the new wall to be winding-consistent with both:
    #   - share edge a -> b with chamfer's b -> a  (opposite -> ok)
    #   - share edge dup_b -> dup_a with new floor's dup_a -> dup_b  (opposite -> ok)
    # That dictates the quad winding (a, b, dup_b, dup_a), triangulated as
    # (a, b, dup_b) and (a, dup_b, dup_a). With the floor normal pointing
    # -Z (so a->b runs CW around the polygon as seen from above), the
    # geometric normal of (a, b, dup_b) is outward-radial automatically.
    walls_added = 0
    for e in boundary_edges:
        a, b = boundary_dir[e]
        da, db = dup_index[a], dup_index[b]
        new_faces.append([a, b, db])
        new_faces.append([a, db, da])
        walls_added += 2
    print(f"[bot] added {walls_added} wall triangles")

    out = trimesh.Trimesh(
        vertices=new_verts,
        faces=np.array(new_faces),
        process=False,
    )
    out.merge_vertices()
    print(f"[bot] result: {len(out.vertices)} verts, {len(out.faces)} faces, "
          f"watertight={out.is_watertight}")
    print(f"[bot] new bounds: min={out.bounds[0]}, max={out.bounds[1]}")
    out.export(BOT_OUT)
    print(f"[bot] wrote {BOT_OUT}")


if __name__ == "__main__":
    build_cap_top()
    print()
    build_cap_bottom()
