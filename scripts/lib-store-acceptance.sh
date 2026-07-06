#!/usr/bin/env bash
# Acceptance for one architecture — a NON-GATING validation. Obtain the store the
# way it is actually consumed, run the validation suite against it, and render a
# per-arch results table into the CI step summary. It promotes NOTHING: `latest`
# was already advanced by the build (see scripts/lib-store-publish.sh). A red run
# surfaces a failing status for a maintainer to review; it rolls nothing back.
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
# Runs from the repo root with Docker available.
#
# Usage: lib-store-acceptance.sh <amd64|arm64> <version> [--store <dir>]
# Env:   SANDBOX_IMAGE  the published sandbox image ref for this arch (baked path)

set -euo pipefail

ARCH="${1:?usage: lib-store-acceptance.sh <amd64|arm64> <version> [--store <dir>]}"
VERSION="${2:?version}"
shift 2 || true

STORE_DIR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --store) STORE_DIR="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

ARCH_DIR="linux-$ARCH"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The results table validate.py writes (via run.sh --summary-md); rendered into
# the CI run summary below. LIB_STORE_VERSION labels the table header.
SUMMARY_MD="${RUNNER_TEMP:-/tmp}/acceptance-$ARCH.md"
export LIB_STORE_VERSION="$VERSION"

echo "::group::Acceptance — $ARCH_DIR @ $VERSION"

RC=0
if [ -n "$STORE_DIR" ]; then
  # Managed path: mount the assembled tarball store read-only into sandbox-base.
  "$REPO_ROOT/scripts/lib-store-validate/run.sh" --summary-md "$SUMMARY_MD" --store "$STORE_DIR" || RC=$?
else
  # OSS path: boot the published image directly (baked store, no mount).
  : "${SANDBOX_IMAGE:?SANDBOX_IMAGE (published sandbox image ref for $ARCH) is required for the baked path}"
  "$REPO_ROOT/scripts/lib-store-validate/run.sh" --summary-md "$SUMMARY_MD" --image "$SANDBOX_IMAGE" || RC=$?
fi

# Render the per-arch results table into the CI run summary (no-op locally where
# GITHUB_STEP_SUMMARY is unset).
if [ -n "${GITHUB_STEP_SUMMARY:-}" ] && [ -f "$SUMMARY_MD" ]; then
  cat "$SUMMARY_MD" >> "$GITHUB_STEP_SUMMARY"
fi

echo "::endgroup::"

if [ "$RC" -eq 0 ]; then
  echo "GREEN: $ARCH_DIR validated"
else
  echo "::error::RED: $ARCH_DIR failed acceptance (exit $RC) — reported for review; latest was set by the build"
fi
exit "$RC"
