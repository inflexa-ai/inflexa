#!/usr/bin/env bash
# Keeps CITATION.cff's version in step with cli/package.json's.
#
# Usage: sync.sh [--check]
#   (no args)  rewrite CITATION.cff in place
#   --check    exit non-zero if it is out of step, changing nothing
#
# cli/package.json is the single source of truth for the product version: its
# version field is what mints the v* tag and the GitHub release
# (.github/workflows/release.yml), so the citation metadata follows it rather
# than being maintained by hand.
#
# --check compares ONLY the version. date-released is written from the clock at
# sync time and would otherwise make the check fail every day after a release.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
manifest="$root/cli/package.json"
citation="$root/CITATION.cff"

check_only=false
if [ "${1:-}" = "--check" ]; then
  check_only=true
elif [ $# -gt 0 ]; then
  echo "error: unknown argument '$1' (expected --check or nothing)" >&2
  exit 2
fi

version=$(jq -r .version "$manifest")
if [ -z "$version" ] || [ "$version" = "null" ]; then
  echo "error: $manifest has no version field" >&2
  exit 1
fi

# The version is spliced into a sed program below; reject anything that isn't a
# plain semver before it can corrupt the file.
if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]]; then
  echo "error: version must be bare semver (got: $version)" >&2
  exit 1
fi

# Both keys are top-level, so the ^ anchor is what keeps `version:` from also
# matching `cff-version:`. A restructured file that no longer has them at column
# zero must fail loudly here rather than silently sync nothing.
for key in version date-released; do
  if ! grep -qE "^$key: " "$citation"; then
    echo "error: $citation has no top-level '$key:' key — the sync patterns no longer match this file" >&2
    exit 1
  fi
done

current=$(sed -nE 's/^version: (.*)$/\1/p' "$citation")

if [ "$check_only" = true ]; then
  if [ "$current" != "$version" ]; then
    echo "::error file=CITATION.cff::CITATION.cff declares version $current but cli/package.json is $version. Run .github/citation/sync.sh and commit the result."
    exit 1
  fi
  echo "CITATION.cff is in step with cli/package.json ($version)"
  exit 0
fi

# Stamped in UTC so the value does not depend on the contributor's timezone.
# This is the bump date, which may precede the release by the PR's review time —
# accepted, because the alternative (writing it after the release publishes)
# means committing to main from the release workflow.
today=$(date -u +%F)

# -i.bak, not a bare -i: BSD sed (macOS, where this is run by hand) requires an
# argument to -i while GNU sed (the CI runner) treats one as the next script, so
# the explicit suffix is the only spelling both accept. The backup is discarded.
sed -E -i.bak \
  -e "s/^version: .*$/version: $version/" \
  -e "s/^date-released: .*$/date-released: \"$today\"/" \
  "$citation"
rm -f "$citation.bak"

if [ "$current" = "$version" ]; then
  echo "CITATION.cff already at $version (date-released stamped $today)"
else
  echo "CITATION.cff: $current -> $version (date-released $today)"
fi
