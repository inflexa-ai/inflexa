#!/usr/bin/env bash
# Publish a built library store to S3 — immutable versions, and advance `latest`
# for this arch (build-floor gated; acceptance is non-gating and moves nothing):
#   1. Pack, upload and TEAR DOWN one track at a time: pack <track>.tar.zst out of
#      the staging tree, upload it write-once to
#      <version>/linux-<arch>/<track>.tar.zst, then delete the tarball AND that
#      track's staging subtree before the next track packs. The peak disk is one
#      track, not six. This is serial on purpose: a parallel pack raises the peak,
#      and the job has time to spare. The digest and size sidecars and the
#      packages.txt fragment stay behind — the manifest and packages.txt are
#      written from them once the loop ends.
#   2. Upload the two store files no tarball carries — the assembled packages.txt
#      and meta.json. The harness mounts a `current/` only when both are present,
#      so a puller downloads them instead of deriving them.
#   3. Write the per-arch manifest (the lockfile the CLI pulls) to
#      <version>/linux-<arch>/manifest.json and record the candidate pointer —
#      version plus the top image ref — at candidate/linux-<arch>.json. Both land
#      after the loop, so a track that failed to upload can never reach a
#      published manifest.
#   4. Advance latest/linux-<arch>/manifest.json to this version, mirroring the
#      image :latest tag the build also advances. This is gated by the build's own
#      load check + non-empty floor + coverage regression guard — the same gate
#      that decides whether the build publishes at all.
#
# PUBLISH_ENABLED=false packs and tears down exactly the same and uploads nothing,
# so a run with no S3 configuration still proves the pack and still holds the same
# disk peak.
#
# Usage: lib-store-publish.sh <amd64|arm64> <version> <staging_dir> <dist_dir>
# Env:   S3_BUCKET PUBLIC_URL TOP_IMAGE  (TOP_IMAGE is the extracted top image ref
#        recorded in the candidate pointer; BASE_IMAGE R_VERSION PYTHON_VERSION
#        GIT_SHA are forwarded to lib-store-write-manifest.sh as manifest metadata)
#        PUBLISH_ENABLED  "true" (default) uploads; anything else packs only

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib-store-common.sh
source "$SCRIPT_DIR/lib-store-common.sh"

ARCH="${1:?usage: lib-store-publish.sh <amd64|arm64> <version> <staging_dir> <dist_dir>}"
VERSION="${2:?version}"
STAGING="${3:?staging_dir}"
DIST="${4:?dist_dir}"
PUBLISH_ENABLED="${PUBLISH_ENABLED:-true}"
if [ "$PUBLISH_ENABLED" = "true" ]; then
  : "${S3_BUCKET:?}" "${PUBLIC_URL:?}" "${TOP_IMAGE:?}"
fi

[ -d "$STAGING" ] || { echo "ERROR: staging dir not found: $STAGING" >&2; exit 1; }
mkdir -p "$DIST"

ARCH_DIR="linux-$ARCH"

# Scratch dir for the generated meta.json and the intermediate manifest.json /
# manifest.published.json — keep them off CWD so a stray repo-root file is never
# clobbered.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Does this key already exist? Only a 404 answers "no". Every other failure —
# a 403 from a publish role missing s3:GetObject, throttling, a transport error —
# means the question went unanswered, and the immutability guards below both
# treat "unanswered" as "absent" if we let them: put_once would re-upload over a
# published tarball, and the manifest check would skip its drift comparison and
# overwrite. Both silently destroy exactly what they exist to protect, so an
# indeterminate HEAD is fatal rather than a shrug.
object_exists() {
  local key="$1" err rc=0
  err="$(aws s3api head-object --bucket "$S3_BUCKET" --key "$key" 2>&1 >/dev/null)" || rc=$?
  [ "$rc" -eq 0 ] && return 0
  case "$err" in
    *404*|*"Not Found"*) return 1 ;;
  esac
  echo "::error::Could not determine whether s3://$S3_BUCKET/$key already exists (aws exited $rc): $err" >&2
  echo "::error::Refusing to publish — the immutability guard cannot run, and continuing risks overwriting a published object. A 403 here usually means the publish role is missing s3:GetObject on this bucket." >&2
  exit 1
}

# Immutable: a version is never rewritten; skip an object that already exists.
put_once() {
  local src="$1" key="$VERSION/$ARCH_DIR/$2"
  if [ "$PUBLISH_ENABLED" != "true" ]; then
    echo "publish disabled: skipped the upload of $key"
    return 0
  fi
  if object_exists "$key"; then
    echo "immutable: s3://$S3_BUCKET/$key already exists — skipping"
  else
    aws s3 cp "$src" "s3://$S3_BUCKET/$key"
  fi
}

# Decide the track set BEFORE anything uploads, so a partial R triple fails the
# run rather than leaving half of one in the bucket. Tracks that did not build
# have neither a subtree nor a fragment and are simply absent; the floor already
# dropped the empty ones.
tracks=""
for track in $LIB_STORE_ALL_TRACKS; do
  if lib_store_track_staged "$STAGING" "$track"; then tracks="$tracks $track"; fi
done
if [ -z "$tracks" ]; then
  echo "ERROR: no complete tracks (subtree + fragment) found in $STAGING" >&2
  exit 1
fi
lib_store_assert_r_triple "$tracks" || exit 1

packed=""
for track in $tracks; do
  lib_store_pack_track "$STAGING" "$DIST" "$track" "$LIB_STORE_ZSTD_LEVEL"
  echo "packed $track -> $DIST/$track.tar.zst ($(du -h "$DIST/$track.tar.zst" | cut -f1), sha256 $(cut -c1-12 "$DIST/$track.tar.zst.sha256")…)"
  put_once "$DIST/$track.tar.zst" "$track.tar.zst"
  rm -rf "${DIST:?}/$track.tar.zst" "${STAGING:?}/$(lib_store_track_dir "$track")"
  packed="$packed $track"
  echo "tore down $track — free on $DIST: $(df -Ph "$DIST" | awk 'NR==2 {print $4}')"
done

# shellcheck disable=SC2086 # packed is an intentional word list, one per line
printf '%s\n' $packed > "$DIST/tracks.txt"

# The two files the harness requires before it mounts a store: packages.txt (what
# list_available_packages reads) and meta.json (the version the store carries).
# Neither is in a track tarball, so both travel as their own write-once objects
# beside them. packages.txt reads the fragments, which the teardown keeps.
"$SCRIPT_DIR/lib-store-write-packages.sh" "$STAGING" "$packed" > "$DIST/packages.txt"
"$SCRIPT_DIR/lib-store-write-meta.sh" "$ARCH" "$VERSION" "$DIST" > "$WORK/meta.json"
put_once "$DIST/packages.txt" packages.txt
put_once "$WORK/meta.json" meta.json

if [ "$PUBLISH_ENABLED" != "true" ]; then
  echo "publish disabled: packed and tore down [$packed]; no manifest, no latest, no candidate."
  exit 0
fi

# manifest.json is immutable too, not just the tarballs. Nothing pins upstream package
# versions, so a same-version retry (VERSION = date+sha) can rebuild different bytes: the
# immutable tarballs stay old while a fresh manifest would advertise new digests — one a
# verifying client can never satisfy. So treat an existing manifest as immutable: compare
# and FAIL LOUD on drift (cut a new version) rather than overwrite.
"$SCRIPT_DIR/lib-store-write-manifest.sh" "$ARCH" "$VERSION" "$DIST" > "$WORK/manifest.json"
MANIFEST_KEY="$VERSION/$ARCH_DIR/manifest.json"
if object_exists "$MANIFEST_KEY"; then
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
