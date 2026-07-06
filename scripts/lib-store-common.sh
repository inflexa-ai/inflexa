#!/usr/bin/env bash
# Shared metadata for the per-track library store: the track set, each track's
# tarball members (subtree + packages.txt fragment), the R-triple invariant, and
# the canonical packages.txt concat order + header.
#
# Source this; do not execute it. Consumed by lib-store-pack.sh,
# lib-store-extract-tarballs.sh, lib-store-write-manifest.sh, lib-store-publish.sh,
# scripts/build-libs-local.sh, and the CI workflows.
#
# Store layout (relative to a version's <arch> root / the mounted `current/`):
#   r/cran  r/bioconductor  r/github  python/  conda/  node/
#   <track>.packages.txt          (one fragment per track, at the root)
#   packages.txt                  (the concatenation the harness reads)

# All tracks, in canonical order.
# shellcheck disable=SC2034 # consumed by the scripts that source this file
LIB_STORE_ALL_TRACKS="cran bioconductor github python conda node"

# packages.txt fragment concat order (R sections, then python, tools, node).
# shellcheck disable=SC2034 # consumed by the scripts that source this file
LIB_STORE_CONCAT_ORDER="cran bioconductor github python conda node"

# The per-arch published track set is now BEST-EFFORT, not a fixed list: each
# arch publishes exactly the tracks its image build produced (extracted from the
# published image, listed in <dist>/tracks.txt). Both arches attempt every track;
# arm64 MAY carry R when it builds. The R triple still travels all-or-none because
# cran/bioconductor/github share one .libPaths() and form a dependency chain —
# {@link lib_store_assert_r_triple} enforces that at manifest time.

# Fail if a track list carries a PARTIAL R triple (some but not all of
# cran/bioconductor/github). The three share one R library path and dependency
# chain, so a partial set would advertise a broken R stack. $1 is a
# whitespace-delimited track list.
lib_store_assert_r_triple() {
  local list=" $1 "
  local have=0
  case "$list" in *" cran "*) have=$((have+1)) ;; esac
  case "$list" in *" bioconductor "*) have=$((have+1)) ;; esac
  case "$list" in *" github "*) have=$((have+1)) ;; esac
  if [ "$have" -ne 0 ] && [ "$have" -ne 3 ]; then
    echo "ERROR: partial R triple in track set ($1) — cran/bioconductor/github must travel together" >&2
    return 1
  fi
  return 0
}

# The subtree whose presence marks a track as built.
lib_store_track_dir() {
  case "$1" in
    cran)         echo "r/cran" ;;
    bioconductor) echo "r/bioconductor" ;;
    github)       echo "r/github" ;;
    python)       echo "python" ;;
    conda)        echo "conda" ;;
    node)         echo "node" ;;
    *) return 1 ;;
  esac
}

# The track's packages.txt fragment filename (at the store root).
lib_store_track_fragment() {
  case "$1" in
    cran)         echo "cran.packages.txt" ;;
    bioconductor) echo "bioconductor.packages.txt" ;;
    github)       echo "github.packages.txt" ;;
    python)       echo "python.packages.txt" ;;
    conda)        echo "conda.packages.txt" ;;
    node)         echo "node.packages.txt" ;;
    *) return 1 ;;
  esac
}

# The paths (relative to the staging root) a track's tarball packs: its subtree
# plus its fragment. Extracting into `current/` reproduces the store layout.
lib_store_track_members() {
  case "$1" in
    cran)         echo "r/cran cran.packages.txt" ;;
    bioconductor) echo "r/bioconductor bioconductor.packages.txt" ;;
    github)       echo "r/github github.packages.txt" ;;
    python)       echo "python python.packages.txt" ;;
    conda)        echo "conda conda.packages.txt" ;;
    node)         echo "node node.packages.txt" ;;
    *) return 1 ;;
  esac
}

# True when $2 is a whitespace-delimited member of the list $1.
lib_store_list_has() {
  case " $1 " in *" $2 "*) return 0 ;; *) return 1 ;; esac
}

# The two-line header prepended to every assembled packages.txt.
lib_store_packages_header() {
  printf '# Available packages in the sandbox environment.\n'
  printf '# Do NOT attempt to install packages — there is no network access and no build toolchain.\n'
}
