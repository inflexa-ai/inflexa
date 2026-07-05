#!/usr/bin/env bash
# Publish a built library store to S3 — immutable versions, candidate-only
# (this never moves `latest`; promotion happens after Gate 2 goes green, see
# .github/workflows/validate-lib-store.yml):
#   1. Upload each packed track tarball write-once to <version>/linux-<arch>/<track>.tar.zst.
#   2. If the arch's full track set built, write the per-arch manifest (the
#      lockfile the CLI pulls) to <version>/linux-<arch>/manifest.json and
#      record the candidate pointer at candidate/linux-<arch>.txt.
#      An incomplete build uploads its tarballs (they are content-addressed and
#      reusable) but publishes no manifest and no candidate.
#
# Usage: lib-store-publish.sh <amd64|arm64> <version> <dist_dir>
# Env:   S3_BUCKET PUBLIC_URL  (+ BASE_IMAGE R_VERSION PYTHON_VERSION GIT_SHA
#        forwarded to lib-store-write-manifest.sh as manifest metadata)

set -euo pipefail

ARCH="${1:?usage: lib-store-publish.sh <amd64|arm64> <version> <dist_dir>}"
VERSION="${2:?version}"
DIST="${3:?dist_dir}"
: "${S3_BUCKET:?}" "${PUBLIC_URL:?}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib-store-common.sh
source "$SCRIPT_DIR/lib-store-common.sh"

ARCH_DIR="linux-$ARCH"

# Immutable: a version is never rewritten; skip an object that already exists.
while read -r track; do
  [ -n "$track" ] || continue
  KEY="$VERSION/$ARCH_DIR/$track.tar.zst"
  if aws s3api head-object --bucket "$S3_BUCKET" --key "$KEY" >/dev/null 2>&1; then
    echo "immutable: s3://$S3_BUCKET/$KEY already exists — skipping"
  else
    aws s3 cp "$DIST/$track.tar.zst" "s3://$S3_BUCKET/$KEY"
  fi
done < "$DIST/tracks.txt"

for t in $(lib_store_arch_tracks "$ARCH"); do
  if ! grep -qx "$t" "$DIST/tracks.txt"; then
    echo "::warning::Track '$t' did not build — no manifest or candidate published for $ARCH_DIR"
    exit 0
  fi
done

"$SCRIPT_DIR/lib-store-write-manifest.sh" "$ARCH" "$VERSION" "$DIST" > manifest.json
aws s3 cp manifest.json "s3://$S3_BUCKET/$VERSION/$ARCH_DIR/manifest.json"
rm -f manifest.json

# Candidate pointer (mutable, but NOT latest): the version awaiting Gate 2.
echo "$VERSION" | aws s3 cp - "s3://$S3_BUCKET/candidate/$ARCH_DIR.txt"
echo "Published candidate $VERSION for $ARCH_DIR (latest NOT moved — awaits Gate 2)"
