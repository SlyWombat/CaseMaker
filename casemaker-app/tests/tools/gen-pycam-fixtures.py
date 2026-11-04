#!/usr/bin/env python3
"""#964 — FILL THE CL FIXTURES' PYCAM COLUMN.

Run ONCE, by hand, after `gen-cl-fixtures.mjs` has written the OpenCamLib numbers. This script
reads each committed fixture's mesh, drops PyCAM's cylindrical / spherical / toroidal cutters at
the same grid points, and writes `pycamSamples` into the fixture beside the OpenCamLib `samples`.

   python3 -m venv /tmp/ocl-venv
   /tmp/ocl-venv/bin/pip install pycam==0.6.4
   /tmp/ocl-venv/bin/python tests/tools/gen-pycam-fixtures.py

LICENCE BOUNDARY. PyCAM is GPL-3.0. This script is ours; it imports PyCAM at run time and the
tree keeps only the NUMBERS PyCAM computed, exactly as the OpenCamLib (LGPL) column does. No
PyCAM code is copied or linked into the product or the tests.

TWO CONVENTIONS THAT MATTER (both are PyCAM's, both cost a debugging session each):

  * PyCAM's Triangle expects CLOCKWISE winding when seen from +Z; the fixtures store the standard
    counter-clockwise winding OpenCamLib takes. Every triangle is therefore built as (p1, p3, p2).
    Without the swap PyCAM reads the plane's normal upside-down and its flat/bull cutters return
    the contact on the wrong side of the slope.
  * Model(use_kdtree=False): PyCAM 0.6.4's kdtree has a Python 3.12 bug (`median` comes back as
    a float and indexes a list). The models here are tiny, so the brute-force query is fine.

The tilt of the ramp's cutter contact is why the fixture meshes are ONE triangle for the plane and
the ramp: a contact landing exactly on a shared triangle edge is resolved by the two libraries
differently, and a diagonal through the sample area makes several grid points ambiguous.
"""

import json
import math
import os
import sys
from datetime import date

from pycam.Cutters.CylindricalCutter import CylindricalCutter
from pycam.Cutters.SphericalCutter import SphericalCutter
from pycam.Cutters.ToroidalCutter import ToroidalCutter
from pycam.Geometry import Point3D
from pycam.Geometry.Model import Model
from pycam.Geometry.Triangle import Triangle
from pycam.PathGenerators import get_max_height_triangles

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, '..', 'unit', 'fixtures', 'parity', 'cl')
SHAPES = ('flat', 'ball', 'bull')  # the V cutter is OpenCamLib only (PyCAM has no cone)
ROUND = 6


def pycam_model(mesh):
    model = Model(use_kdtree=False)
    vertices = mesh['vertices']
    for a, b, c in mesh['triangles']:
        # PyCAM expects clockwise winding; the fixture stores CCW.
        model.append(Triangle(Point3D(*vertices[a]), Point3D(*vertices[c]), Point3D(*vertices[b])))
    return model


def cutter_for(entry):
    radius = entry['diameterMm'] / 2
    if entry['shape'] == 'flat':
        return CylindricalCutter(radius)
    if entry['shape'] == 'ball':
        return SphericalCutter(radius)
    if entry['shape'] == 'bull':
        return ToroidalCutter(radius, entry['cornerRadiusMm'])
    raise SystemExit(f'unknown shape {entry["shape"]}')


def main():
    touched = 0
    for name in ('plane', 'ramp', 'step'):
        path = os.path.join(FIXTURES, f'{name}.json')
        fixture = json.load(open(path))
        model = pycam_model(fixture['mesh'])
        xs = fixture['grid']
        minz = min(v[2] for v in fixture['mesh']['vertices']) - 10
        maxz = max(v[2] for v in fixture['mesh']['vertices']) + 10
        step = fixture['grid']['stepMm']
        for entry in fixture['cutters']:
            if entry['shape'] not in SHAPES:
                entry['pycamSamples'] = None
                continue
            cutter = cutter_for(entry)
            samples = []
            z_min = None
            z_max = None
            y = xs['y0']
            while y <= xs['y1'] + 1e-9:
                x = xs['x0']
                while x <= xs['x1'] + 1e-9:
                    z = get_max_height_triangles(model, cutter, x, y, minz, maxz)[2]
                    # A point with no contact comes back as minz; it is stated as null.
                    value = None if z is None or abs(z - minz) < 1e-9 else round(z, ROUND)
                    samples.append({'x': round(x, ROUND), 'y': round(y, ROUND), 'z': value})
                    if value is not None:
                        z_min = value if z_min is None else min(z_min, value)
                        z_max = value if z_max is None else max(z_max, value)
                    x += step
                y += step
            entry['pycamSamples'] = samples
            touched += 1
            print(f'{name} {entry["shape"]}: {len(samples)} samples, z {z_min}..{z_max}')
        fixture['provenance']['pycam'] = {
            'library': 'PyCAM',
            'version': '0.6.4',
            'licence': 'GPL-3.0 — NUMBERS ONLY: no PyCAM code is copied or linked into the product or the tests',
            'command': 'python3 tests/tools/gen-pycam-fixtures.py',
            'generated': date.today().isoformat(),
            'notes': 'Triangle order swapped to PyCAM’s clockwise convention; Model(use_kdtree=False) for the Python 3.12 kdtree bug; the V cutter is OpenCamLib-only.',
        }
        json.dump(fixture, open(path, 'w'), indent=1)
        open(path, 'a').write('\n')
    print(f'wrote pycamSamples into {touched} cutters')


if __name__ == '__main__':
    sys.exit(main())
