#!/usr/bin/env bash
# Publish a built library store to S3 — immutable versions, and advance `latest`
# for this arch (build-floor gated; acceptance is non-gating and moves nothing):
#   1. Upload each packed track tarball write-once to <version>/linux-<arch>/<track>.tar.zst,
#      together with the two store files no tarball carries — the assembled
#      packages.txt and meta.json. The harness mounts a `current/` only when both
#      are present, so a puller downloads them instead of deriving them.
#   2. If the arch's full track set built, write the per-arch manifest (the
#      lockfile the CLI pulls) to <version>/linux-<arch>/manifest.json and
#      record the candidate pointer — version plus the top image ref — at
#      candidate/linux-<arch>.json.
#      An incomplete build uploads its tarballs (they are content-addressed and
#      reusable) but publishes no manifest and no candidate.
#   3. Advance latest/linux-<arch>/manifest.json to this version, mirroring the
#      image :latest tag the build also advances. This is gated by the build's own
#      load check + non-empty floor + coverage regression guard — the same gate
#      that decides whether the build publishes at all.
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

# Scratch dir for the generated meta.json and the intermediate manifest.json /
# manifest.published.json — keep them off CWD so a stray repo-root file is never
# clobbered.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Immutable: a version is never rewritten; skip an object that already exists.
put_once() {
  local src="$1" key="$VERSION/$ARCH_DIR/$2"
  if aws s3api head-object --bucket "$S3_BUCKET" --key "$key" >/dev/null 2>&1; then
    echo "immutable: s3://$S3_BUCKET/$key already exists — skipping"
  else
    aws s3 cp "$src" "s3://$S3_BUCKET/$key"
  fi
}

while read -r track; do
  [ -n "$track" ] || continue
  put_once "$DIST/$track.tar.zst" "$track.tar.zst"
done < "$DIST/tracks.txt"

# Best-effort: publish the manifest for exactly the tracks that packed (the floor
# already dropped empty tracks). Only guard the R triple's all-or-none invariant.
lib_store_assert_r_triple "$(tr '\n' ' ' < "$DIST/tracks.txt")" || exit 1

# The two files the harness requires before it mounts a store: packages.txt (what
# list_available_packages reads) and meta.json (the version the store carries).
# Neither is in a track tarball, so both travel as their own write-once objects
# beside them.
"$SCRIPT_DIR/lib-store-write-meta.sh" "$ARCH" "$VERSION" "$DIST" > "$WORK/meta.json"
put_once "$DIST/packages.txt" packages.txt
put_once "$WORK/meta.json" meta.json

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

# Advance latest for this arch to the just-published version (build-floor gated:
# the load check + non-empty floor + coverage regression guard already decided
# this build is publishable). Acceptance is non-gating and never moves latest;
# the image :latest tag is advanced the same way by the build's manifest job.
aws s3 cp "s3://$S3_BUCKET/$MANIFEST_KEY" "s3://$S3_BUCKET/latest/$ARCH_DIR/manifest.json"

# Candidate pointer: records the exact top image ref for this arch (sandbox-python-r,
# or sandbox-python where R did not build) so a dispatch-triggered acceptance
# validates the real image rather than assuming the R variant.
printf '{"version":"%s","image":"%s","publish":"true"}\n' "$VERSION" "$TOP_IMAGE" \
  | aws s3 cp - "s3://$S3_BUCKET/candidate/$ARCH_DIR.json"
echo "Published $VERSION ($TOP_IMAGE) for $ARCH_DIR and advanced latest/$ARCH_DIR"
