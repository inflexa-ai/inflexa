#!/usr/bin/env bash
# Emit a per-bundle-per-arch manifest (the lockfile) to stdout, pinning each of
# the bundle's tracks to its published tarball URL + sha256 + byte size. This is
# the producer half of the build<->CLI contract consumed by
# cli/src/modules/libs/manifest.ts (schema: {version, tracks:{<t>:{url,sha256,size}}}).
#
# Fails if any track in the bundle is missing from <dist_dir> (an incomplete
# bundle is never published). Env:
#   PUBLIC_URL   base URL of the published store (e.g. https://lib-store.inflexa.ai)
#   BASE_IMAGE R_VERSION PYTHON_VERSION GIT_SHA   informational metadata
#
# Usage: lib-store-write-manifest.sh <bundle> <amd64|arm64> <version> <dist_dir>

set -euo pipefail

BUNDLE="${1:?usage: lib-store-write-manifest.sh <bundle> <arch> <version> <dist_dir>}"
ARCH="${2:?arch}"
VERSION="${3:?version}"
DIST="${4:?dist_dir}"
PUBLIC_URL="${PUBLIC_URL:?PUBLIC_URL env (published store base URL) is required}"
PUBLIC_URL="${PUBLIC_URL%/}"

# shellcheck source=scripts/lib-store-common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib-store-common.sh"

tracks="$(lib_store_bundle_tracks "$BUNDLE")" || { echo "ERROR: unknown bundle: $BUNDLE" >&2; exit 1; }
arch_dir="linux-$ARCH"

for t in $tracks; do
  [ -f "$DIST/$t.tar.zst.sha256" ] && [ -f "$DIST/$t.tar.zst" ] \
    || { echo "ERROR: bundle $BUNDLE track '$t' not in $DIST (incomplete build)" >&2; exit 1; }
done

tracks_json=""
for t in $tracks; do
  sha="$(cat "$DIST/$t.tar.zst.sha256")"
  size="$(stat -c%s "$DIST/$t.tar.zst" 2>/dev/null || stat -f%z "$DIST/$t.tar.zst")"
  # Emit BOTH a store-relative `path` (the CLI joins it onto its RESOLVED base, so an
  # INFLEXA_LIB_STORE_URL/libStoreUrl mirror redirects the payload downloads too) and the
  # absolute `url` baked at PUBLIC_URL (a compat fallback for a client predating `path`).
  path="$VERSION/$arch_dir/$t.tar.zst"
  url="$PUBLIC_URL/$path"
  entry="$(printf '"%s":{"path":"%s","url":"%s","sha256":"%s","size":%s}' "$t" "$path" "$url" "$sha" "$size")"
  tracks_json="${tracks_json:+$tracks_json,}$entry"
done

printf '{'
printf '"version":"%s",' "$VERSION"
printf '"bundle":"%s",' "$BUNDLE"
printf '"arch":"%s",' "$arch_dir"
printf '"baseImage":"%s",' "${BASE_IMAGE:-}"
printf '"rVersion":"%s",' "${R_VERSION:-}"
printf '"pythonVersion":"%s",' "${PYTHON_VERSION:-}"
printf '"gitSha":"%s",' "${GIT_SHA:-}"
printf '"buildTimestamp":"%s",' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '"tracks":{%s}' "$tracks_json"
printf '}\n'
