#!/usr/bin/env bash
# Emit the store metadata to stdout: `{version, arch, tracks}` — the version the
# store carries, its arch segment (`linux-<arch>`), and the tracks it holds.
#
# The sandbox client refuses to mount a `current/` that lacks meta.json next to
# packages.txt, so a store without it is never mounted. It is a different thing
# from manifest.json: manifest.json is the lockfile a puller resolves BEFORE it
# downloads (track paths, digests, sizes), meta.json describes the store AFTER it
# is assembled.
#
# Usage: lib-store-write-meta.sh <amd64|arm64> <version> <dist_dir>

set -euo pipefail

ARCH="${1:?usage: lib-store-write-meta.sh <amd64|arm64> <version> <dist_dir>}"
VERSION="${2:?version}"
DIST="${3:?dist_dir}"

[ -f "$DIST/tracks.txt" ] || { echo "ERROR: $DIST/tracks.txt not found — nothing packed for $ARCH" >&2; exit 1; }
tracks="$(tr '\n' ' ' < "$DIST/tracks.txt")"
[ -n "$(printf '%s' "$tracks")" ] || { echo "ERROR: no packed tracks for $ARCH" >&2; exit 1; }

tracks_json=""
for t in $tracks; do
  tracks_json="${tracks_json:+$tracks_json,}$(printf '"%s"' "$t")"
done

printf '{"version":"%s","arch":"linux-%s","tracks":[%s]}\n' "$VERSION" "$ARCH" "$tracks_json"
