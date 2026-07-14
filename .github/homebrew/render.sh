#!/usr/bin/env bash
# Renders the Homebrew formula for one released version to stdout.
#
# Usage: render.sh <version> <assets-dir>
#   <version>    bare semver, no leading v (e.g. 0.1.0)
#   <assets-dir> holds that release's SHA256SUMS and THIRD-PARTY-NOTICES.txt
#
# Binary hashes come from the release's own SHA256SUMS — the file the release
# workflow generated and attested — never recomputed from re-downloaded
# binaries, so the formula pins exactly what that workflow built.
# THIRD-PARTY-NOTICES.txt is the one asset SHA256SUMS does not cover (the
# release job only sums inflexa-*), so its hash is computed here from the
# downloaded copy.
set -euo pipefail

version="$1"
assets="$2"
tmpl="$(dirname "$0")/inflexa.rb.tmpl"

# The version is spliced into sed programs and release URLs below; reject
# anything that isn't a plain semver (optionally with a pre-release/build
# suffix) before it can corrupt either.
if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]]; then
  echo "error: version must be bare semver (got: $version)" >&2
  exit 1
fi

sum_of() {
  local sha
  sha=$(awk -v name="$1" '$2 == name { print $1 }' "$assets/SHA256SUMS")
  if [ -z "$sha" ]; then
    echo "error: $1 not found in $assets/SHA256SUMS" >&2
    exit 1
  fi
  printf '%s' "$sha"
}

notices_sha=$(shasum -a 256 "$assets/THIRD-PARTY-NOTICES.txt" | awk '{ print $1 }')

rendered=$(
  sed \
    -e "s/{{VERSION}}/$version/g" \
    -e "s/{{SHA_DARWIN_ARM64}}/$(sum_of inflexa-darwin-arm64)/g" \
    -e "s/{{SHA_DARWIN_X64}}/$(sum_of inflexa-darwin-x64)/g" \
    -e "s/{{SHA_LINUX_X64}}/$(sum_of inflexa-linux-x64)/g" \
    -e "s/{{SHA_NOTICES}}/$notices_sha/g" \
    "$tmpl"
)

# A placeholder surviving the sed pass means the template gained a variable
# this script doesn't know — fail loudly rather than publish a broken formula.
if grep -q '{{' <<<"$rendered"; then
  echo "error: unrendered placeholders remain: $(grep -o '{{[A-Z_]*}}' <<<"$rendered" | sort -u | tr '\n' ' ')" >&2
  exit 1
fi

printf '%s\n' "$rendered"
