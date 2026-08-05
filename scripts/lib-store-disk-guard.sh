#!/usr/bin/env bash
# Hold the self-hosted builders inside their disk budget, and stop a build early
# when the box cannot hold one.
#
# The BuildKit cache is deliberately persistent: the Buildx step uses the docker
# driver, so warm layers live in /var/lib/docker on the box's EBS volume and
# survive its stop/start. The runner user has no sudo, and nothing else reclaims
# that volume. Persistent plus uncapped is the growth vector — the cache holds one
# more generation of build records after every run, and `docker image prune -f`
# drops a dangling image only, never an unused tagged one.
#
# Modes:
#   preflight  Report, reclaim to the cap, and report again. When the box is still
#              short, drop the unused tagged images and the whole cache, then
#              report again. Exit 1 with the shortfall when even that is too
#              little, so the run fails with a legible message instead of a
#              confusing mid-build error.
#   cleanup    Report, reclaim to the cap, and report again. Never fails.
#
# The floors below come from the measured content of one amd64 build. Each figure
# is the uncompressed byte total of the published image's own layers:
#   * the sandbox-python-r chain is 11.4 GB of GHCR layers, and overlay2 holds
#     them unpacked — about 23 GB;
#   * `staging/` holds the store extracted out of that image — about 21 GB
#     (python 9.2, bioconductor 6.4, conda 3.0, github 1.6, cran 0.9, node 0.04),
#     and more wherever the extract dereferences a symlink;
#   * `dist/` holds one track tarball at a time — at most about 4 GB, for python.
# The build frees the images before the pack, and the pack tears each track down
# as it publishes, so the two do not add up. One build therefore needs about
# 23 GB under the docker root and about 25 GB under the workspace. The cap keeps
# one build generation of warm layers and no more.
#
# Usage: lib-store-disk-guard.sh <preflight|cleanup>

set -euo pipefail

MODE="${1:?usage: lib-store-disk-guard.sh <preflight|cleanup>}"

BUILDKIT_CAP="23GB"
DOCKER_ROOT_FLOOR_GB=26
WORKSPACE_FLOOR_GB=27

DOCKER_ROOT="$(docker info --format '{{.DockerRootDir}}')"
WORKSPACE="${GITHUB_WORKSPACE:-$PWD}"

# The device of a path, as df names it. Two paths on one device share one budget.
fs_of() { df -P "$1" | awk 'NR==2 {print $1}'; }

# Free space in whole GB. `df -B1G` prints the count of 1 GB blocks and no unit.
free_gb() { df -P -B1G "$1" | awk 'NR==2 {print $4}'; }

report() {
  echo "--- disk ($1) ---"
  # awk drops the duplicate line when the two paths share one filesystem.
  df -h "$DOCKER_ROOT" "$WORKSPACE" | awk '!seen[$0]++'
  docker system df || true
}

# Reclaim what a finished build leaves behind, and cap the cache instead of
# clearing it: the warm layers are the reason the volume is persistent.
reclaim_to_cap() {
  docker container prune -f >/dev/null 2>&1 || true
  docker image prune -f >/dev/null 2>&1 || true
  if ! docker builder prune -f --keep-storage "$BUILDKIT_CAP"; then
    echo "::warning::Could not cap the BuildKit cache at $BUILDKIT_CAP — \`docker builder prune --keep-storage\` failed on this docker version. The cache is uncapped."
  fi
}

# The last resort before a hard failure. It costs the warm layers and a base-image
# pull on the next run, which is cheaper than a build that dies out of disk.
reclaim_all() {
  echo "Still short after the capped reclaim — dropping the unused tagged images and the whole BuildKit cache."
  docker image prune -af >/dev/null 2>&1 || true
  docker builder prune -af >/dev/null 2>&1 || true
}

# Name each path that is under its floor, one tab-delimited
# "<path> <label> <free> <floor>" per line. Paths on one device share one budget,
# so their floors add up.
shortfalls() {
  local free floor
  if [ "$(fs_of "$DOCKER_ROOT")" = "$(fs_of "$WORKSPACE")" ]; then
    floor=$((DOCKER_ROOT_FLOOR_GB + WORKSPACE_FLOOR_GB))
    free="$(free_gb "$DOCKER_ROOT")"
    if [ "$free" -lt "$floor" ]; then
      printf '%s\t%s\t%s\t%s\n' "$DOCKER_ROOT" "docker root + workspace" "$free" "$floor"
    fi
    return 0
  fi
  free="$(free_gb "$DOCKER_ROOT")"
  if [ "$free" -lt "$DOCKER_ROOT_FLOOR_GB" ]; then
    printf '%s\t%s\t%s\t%s\n' "$DOCKER_ROOT" "docker root" "$free" "$DOCKER_ROOT_FLOOR_GB"
  fi
  free="$(free_gb "$WORKSPACE")"
  if [ "$free" -lt "$WORKSPACE_FLOOR_GB" ]; then
    printf '%s\t%s\t%s\t%s\n' "$WORKSPACE" "workspace" "$free" "$WORKSPACE_FLOOR_GB"
  fi
  return 0
}

case "$MODE" in
  cleanup)
    report "before cleanup"
    reclaim_to_cap
    report "after cleanup"
    ;;
  preflight)
    report "before reclaim"
    reclaim_to_cap
    report "after reclaim"
    if [ -n "$(shortfalls)" ]; then
      reclaim_all
      report "after full reclaim"
    fi
    short="$(shortfalls)"
    if [ -n "$short" ]; then
      while IFS=$'\t' read -r path label free floor; do
        [ -n "$path" ] || continue
        echo "::error::Not enough disk on the builder: $path ($label) has ${free} GB free, and this build needs ${floor} GB — short by $((floor - free)) GB. Grow the EBS volume, or reclaim the box by hand."
      done <<< "$short"
      exit 1
    fi
    ;;
  *)
    echo "ERROR: unknown mode '$MODE' (expected preflight or cleanup)" >&2
    exit 2
    ;;
esac
