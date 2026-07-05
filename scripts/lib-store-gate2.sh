#!/usr/bin/env bash
# Gate 2 for one architecture: pull the candidate store the way an end user
# does (the real `inflexa libs pull` handler, anonymous HTTP), run the full
# validation suite against it, and promote the candidate manifest to
# latest/linux-<arch>/manifest.json on green. A red run leaves latest untouched
# and exits non-zero.
#
# Runs from the repo root with the CLI already installed (cli/ deps + built
# harness) and AWS credentials configured for the promotion copy.
#
# Usage: lib-store-gate2.sh <amd64|arm64> <version>
# Env:   S3_BUCKET  (promotion target)
#        INFLEXA_LIB_STORE_URL  (the public base URL the pull resolves)

set -euo pipefail

ARCH="${1:?usage: lib-store-gate2.sh <amd64|arm64> <version>}"
VERSION="${2:?version}"
: "${S3_BUCKET:?}"

ARCH_DIR="linux-$ARCH"
# Must match the CLI's XDG-aware libStorePath (cli/src/lib/env.ts dataDir): a
# runner that exports XDG_DATA_HOME would otherwise pull one place and validate
# another.
STORE="${XDG_DATA_HOME:-$HOME/.local/share}/inflexa/libs"

echo "::group::Gate 2 — $ARCH_DIR @ $VERSION"
rm -rf "$STORE"

# Pull the candidate the way a user does: the real handler, anonymous HTTP,
# --pin'd to the candidate (latest not moved yet).
( cd cli && bun run src/index.ts libs pull --pin "$VERSION" --yes )

# Full Gate 2 suite: import-all + anchors + R examples + the invariant.
if scripts/lib-store-validate/run.sh --full --store "$STORE"; then
  echo "GREEN: $ARCH_DIR — promoting latest"
  aws s3 cp \
    "s3://$S3_BUCKET/$VERSION/$ARCH_DIR/manifest.json" \
    "s3://$S3_BUCKET/latest/$ARCH_DIR/manifest.json"
  echo "::endgroup::"
  exit 0
fi

echo "::error::RED: $ARCH_DIR failed Gate 2 — latest NOT moved"
echo "::endgroup::"
exit 1
