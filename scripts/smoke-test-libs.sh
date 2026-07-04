#!/usr/bin/env bash
# Back-compat wrapper. The hardcoded per-language load-test list has been retired
# in favour of the derived Gate 2 suite, which validates EVERY package the
# mounted store advertises in packages.txt (plus curated compiled anchors).
#
# This delegates to scripts/lib-store-validate/run.sh. Pass --full to also run
# the R example pass. See that script for all options.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/lib-store-validate/run.sh" "$@"
