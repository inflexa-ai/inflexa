#!/usr/bin/env bash
# Publish a built library store to S3 — immutable versions, candidate-only
# (this never moves `latest`; promotion happens after acceptance goes green, see
# .github/workflows/lib-store-acceptance.yml):
#   1. Upload each packed track tarball write-once to <version>/linux-<arch>/<track>.tar.zst.
#   2. If the arch's full track set built, write the per-arch manifest (the
#      lockfile the CLI pulls) to <version>/linux-<arch>/manifest.json and
#      record the candidate pointer — version plus the top image ref — at
#      candidate/linux-<arch>.json.
#      An incomplete build uploads its tarballs (they are content-addressed and
#      reusable) but publishes no manifest and no candidate.
#
# Usage: lib-store-publish.sh <amd64|arm64> <version> <dist_dir>
# Env:   S3_BUCKET PUBLIC_URL TOP_IMAGE  (TOP_IMAGE is the extracted top image ref
#        recorded in the candidate pointer; BASE_IMAGE R_VERSION PYTHON_VERSION
#        GIT_SHA are forwarded to lib-store-write-manifest.sh as manifest metadata)

set -euo pipefail

ARCH="${1:?usage: lib-store-publish.sh <amd64|arm64> <version> <dist_dir>}"
VERSION="${2:?version}"
DIST="${3:?dist_dir}"
: "${S3_BUCKET:?}" "${PUBLIC_URL:?}" "${TOP_IMAGE:?}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib-store-common.sh
source "$SCRIPT_DIR/lib-store-common.sh"

ARCH_DIR="linux-$ARCH"

# Scratch dir for the intermediate manifest.json / manifest.published.json — keep
# them off CWD so a stray repo-root file is never clobbered.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

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
"$SCRIPT_DIR/lib-store-write-manifest.sh" "$ARCH" "$VERSION" "$DIST" > "$WORK/manifest.json"
MANIFEST_KEY="$VERSION/$ARCH_DIR/manifest.json"
if aws s3api head-object --bucket "$S3_BUCKET" --key "$MANIFEST_KEY" >/dev/null 2>&1; then
  aws s3 cp "s3://$S3_BUCKET/$MANIFEST_KEY" "$WORK/manifest.published.json"
  # Drop buildTimestamp (per-run `date` stamp) before comparing — the check is about
  # integrity, not the publish wall-clock; everything else is deterministic per VERSION.
  strip_ts() { sed 's/"buildTimestamp":"[^"]*",//' "$1"; }
  if [ "$(strip_ts "$WORK/manifest.json")" = "$(strip_ts "$WORK/manifest.published.json")" ]; then
    echo "immutable: s3://$S3_BUCKET/$MANIFEST_KEY already published and identical — skipping"
  else
    echo "::error::Manifest for $VERSION/$ARCH_DIR is already published with DIFFERENT content — the version was rebuilt with different bytes while its tarballs are immutable. Refusing to overwrite; cut a new version." >&2
    exit 1
  fi
else
  aws s3 cp "$WORK/manifest.json" "s3://$S3_BUCKET/$MANIFEST_KEY"
fi

# Candidate pointer (mutable, but NOT latest): the version awaiting acceptance,
# carrying the exact top image ref for this arch (sandbox-python-r, or
# sandbox-python where R did not build) so a dispatch-triggered acceptance
# validates the real image rather than assuming the R variant.
printf '{"version":"%s","image":"%s","publish":"true"}\n' "$VERSION" "$TOP_IMAGE" \
  | aws s3 cp - "s3://$S3_BUCKET/candidate/$ARCH_DIR.json"
echo "Published candidate $VERSION ($TOP_IMAGE) for $ARCH_DIR (latest NOT moved — awaits acceptance)"
