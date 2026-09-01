#!/usr/bin/env bash
# Acceptance for one architecture — a NON-GATING validation. Obtain the store the
# way it is actually consumed, run the validation suite against it, and render a
# per-arch results table into the CI step summary. It promotes NOTHING: `latest`
# was already advanced by the build (see the build workflow). A red run
# surfaces a failing status for a maintainer to review; it rolls nothing back.
#
# The store arrives one way (design.md "acceptance obtains the store from the
# published store artifact"): pass --store <dir> at a store extracted from the
# published artifact, and the suite mounts it read-only into sandbox-base. This
# is the store a user pulls, thus it is the honest source for the import-all
# invariant. The image bakes no package, thus no baked-image route exists.
#
# Runs from the repo root with Docker available.
#
# Usage: package-store-acceptance.sh <amd64|arm64> <version> --store <dir>
# Env:   SANDBOX_BASE_IMAGE  the published sandbox-base ref to mount into

set -euo pipefail

ARCH="${1:?usage: package-store-acceptance.sh <amd64|arm64> <version> [--store <dir>]}"
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
# the CI run summary below. PACKAGE_STORE_VERSION labels the table header.
SUMMARY_MD="${RUNNER_TEMP:-/tmp}/acceptance-$ARCH.md"
export PACKAGE_STORE_VERSION="$VERSION"

echo "::group::Acceptance — $ARCH_DIR @ $VERSION"

# A store mount is the ONE mode: the image bakes no package, thus a baked-image
# path has nothing to validate and cannot pass.
: "${STORE_DIR:?STORE_DIR (an extracted store root with farms/catalog) is required}"
RC=0
"$REPO_ROOT/scripts/package-store-validate/run.sh" --summary-md "$SUMMARY_MD" --store "$STORE_DIR" || RC=$?

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
