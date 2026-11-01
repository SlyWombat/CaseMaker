#!/usr/bin/env bash
# Removes what bin/install.sh put in place (#866).
#
#     sudo bin/uninstall.sh [prefix]      # default prefix: /usr/local
#
# The app's DATA is not touched: the servers, the cutter library, the run records and the settings
# live under the invoking user's data directory (`casemaker --print-config` names the file), which
# is not the package's to delete.
set -euo pipefail

PREFIX="${1:-/usr/local}"

rm -f "$PREFIX/bin/casemaker"
rm -rf "$PREFIX/lib/casemaker"
rm -f "$PREFIX/share/applications/casemaker.desktop"
rm -f "$PREFIX/share/icons/hicolor/128x128/apps/casemaker.png"

echo "removed casemaker from $PREFIX (the app's data is left where it was)"
