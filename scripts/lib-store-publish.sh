#!/usr/bin/env bash
# Publish a built library store to S3 — immutable versions, candidate-only
# (this never moves `latest`; promotion happens after acceptance goes green, see
# .github/workflows/lib-store-acceptance.yml):
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

# Best-effort: publish the manifest for exactly the tracks that packed (the floor
# already dropped empty tracks). Only guard the R triple's all-or-none invariant.
lib_store_assert_r_triple "$(tr '\n' ' ' < "$DIST/tracks.txt")" || exit 1

# manifest.json is immutable too, not just the tarballs. Nothing pins upstream package
# versions, so a same-version retry (VERSION = date+sha) can rebuild different bytes: the
# immutable tarballs stay old while a fresh manifest would advertise new digests — one a
# verifying client can never satisfy. So treat an existing manifest as immutable: compare
# and FAIL LOUD on drift (cut a new version) rather than overwrite.
"$SCRIPT_DIR/lib-store-write-manifest.sh" "$ARCH" "$VERSION" "$DIST" > manifest.json
MANIFEST_KEY="$VERSION/$ARCH_DIR/manifest.json"
if aws s3api head-object --bucket "$S3_BUCKET" --key "$MANIFEST_KEY" >/dev/null 2>&1; then
  aws s3 cp "s3://$S3_BUCKET/$MANIFEST_KEY" manifest.published.json
  # Drop buildTimestamp (per-run `date` stamp) before comparing — the check is about
  # integrity, not the publish wall-clock; everything else is deterministic per VERSION.
  strip_ts() { sed 's/"buildTimestamp":"[^"]*",//' "$1"; }
  if [ "$(strip_ts manifest.json)" = "$(strip_ts manifest.published.json)" ]; then
    echo "immutable: s3://$S3_BUCKET/$MANIFEST_KEY already published and identical — skipping"
  else
    echo "::error::Manifest for $VERSION/$ARCH_DIR is already published with DIFFERENT content — the version was rebuilt with different bytes while its tarballs are immutable. Refusing to overwrite; cut a new version." >&2
    rm -f manifest.json manifest.published.json
    exit 1
  fi
  rm -f manifest.published.json
else
  aws s3 cp manifest.json "s3://$S3_BUCKET/$MANIFEST_KEY"
fi
rm -f manifest.json

# Candidate pointer (mutable, but NOT latest): the version awaiting acceptance.
echo "$VERSION" | aws s3 cp - "s3://$S3_BUCKET/candidate/$ARCH_DIR.txt"
echo "Published candidate $VERSION for $ARCH_DIR (latest NOT moved — awaits acceptance)"
