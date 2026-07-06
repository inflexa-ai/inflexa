#!/usr/bin/env bash
# Acceptance for one architecture — obtain the store the way it is actually
# consumed and run the full validation suite against it, then promote the
# candidate tarball manifest to latest/linux-<arch> on GREEN. A RED run leaves
# latest untouched and exits non-zero.
#
# The store is obtained one of two ways (design.md "acceptance obtains the store
# the way it is consumed"):
#
#   * baked image (the OSS path — the default): boot the published sandbox image
#     for this arch (SANDBOX_IMAGE) directly, no mount. This is exactly what
#     `inflexa sandbox pull` fetches and what OSS users run.
#   * mounted tarballs (the managed path): pass --store <dir> pointing at an
#     assembled tarball store to mount it read-only into sandbox-base instead.
#
# The extracted tarballs are cut FROM the published image, so validating the
# image validates the same content the managed mount ships.
#
# Runs from the repo root with Docker available and AWS credentials configured
# for the promotion copy.
#
# Usage: lib-store-acceptance.sh <amd64|arm64> <version> [--store <dir>]
# Env:   S3_BUCKET      promotion target
#        SANDBOX_IMAGE  the published sandbox image ref for this arch (baked path)

set -euo pipefail

ARCH="${1:?usage: lib-store-acceptance.sh <amd64|arm64> <version> [--store <dir>]}"
VERSION="${2:?version}"
shift 2 || true
: "${S3_BUCKET:?}"

STORE_DIR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --store) STORE_DIR="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

ARCH_DIR="linux-$ARCH"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "::group::Acceptance — $ARCH_DIR @ $VERSION"

PASSED=0
if [ -n "$STORE_DIR" ]; then
  # Managed path: mount the assembled tarball store read-only into sandbox-base.
  "$REPO_ROOT/scripts/lib-store-validate/run.sh" --full --store "$STORE_DIR" && PASSED=1 || true
else
  # OSS path: boot the published image directly (baked store, no mount).
  : "${SANDBOX_IMAGE:?SANDBOX_IMAGE (published sandbox image ref for $ARCH) is required for the baked path}"
  "$REPO_ROOT/scripts/lib-store-validate/run.sh" --full --image "$SANDBOX_IMAGE" && PASSED=1 || true
fi

if [ "$PASSED" -eq 1 ]; then
  echo "GREEN: $ARCH_DIR — promoting latest"
  aws s3 cp \
    "s3://$S3_BUCKET/$VERSION/$ARCH_DIR/manifest.json" \
    "s3://$S3_BUCKET/latest/$ARCH_DIR/manifest.json"
  # Move the coverage baseline forward too so the next build's regression diff
  # references the accepted version (best-effort — absence is not fatal).
  aws s3 cp \
    "s3://$S3_BUCKET/$VERSION/$ARCH_DIR/coverage.json" \
    "s3://$S3_BUCKET/latest/$ARCH_DIR/coverage.json" 2>/dev/null || true
  echo "::endgroup::"
  exit 0
fi

echo "::error::RED: $ARCH_DIR failed acceptance — latest NOT moved"
echo "::endgroup::"
exit 1
