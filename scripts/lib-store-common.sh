#!/usr/bin/env bash
# Shared metadata for the per-track library store: the track set, each track's
# tarball members (subtree + packages.txt fragment), the arch -> track-set
# map, and the canonical packages.txt concat order + header.
#
# Source this; do not execute it. Consumed by lib-store-pack.sh,
# lib-store-assemble.sh, scripts/build-libs-local.sh, and the CI workflows.
#
# Store layout (relative to a version's <arch> root / the mounted `current/`):
#   r/cran  r/bioconductor  r/github  python/  conda/  node/
#   <track>.packages.txt          (one fragment per track, at the root)
#   packages.txt                  (the concatenation the harness reads)

# All tracks, in canonical order.
LIB_STORE_ALL_TRACKS="cran bioconductor github python conda node"

# packages.txt fragment concat order (R sections, then python, tools, node).
LIB_STORE_CONCAT_ORDER="cran bioconductor github python conda node"

# The tracks each architecture's published store carries. The R triple travels
# all-or-none because cran/bioconductor/github share one .libPaths() and form a
# dependency chain; arm64 builds no R tarballs (r2u is amd64-only), so its
# store is the non-R tracks.
lib_store_arch_tracks() {
  case "$1" in
    amd64) echo "cran bioconductor github python conda node" ;;
    arm64) echo "python conda node" ;;
    *) return 1 ;;
  esac
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
