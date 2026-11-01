#!/usr/bin/env python3
"""Fills snapcraft.yaml from snapcraft.yaml.in and an app version (#866).

    tools/linux/snap/make-snapcraft-yaml.py <version> <out-file>

The version is tools/linux/package-version.sh's (tauri.conf.json's version, plus a packaging
revision when one applies). Snapcraft wants a plain version string; it accepts the Debian-style
"-<n>" suffix.
"""
import sys
from pathlib import Path

if len(sys.argv) != 3:
    print('usage: make-snapcraft-yaml.py <version> <out-file>', file=sys.stderr)
    sys.exit(2)
version, out = sys.argv[1], Path(sys.argv[2])
template = Path(__file__).with_name('snapcraft.yaml.in').read_text()
if '@VERSION@' not in template:
    print('snapcraft.yaml.in has no @VERSION@ line', file=sys.stderr)
    sys.exit(1)
out.write_text(template.replace('@VERSION@', version))
print(f'wrote {out} (version {version})')
