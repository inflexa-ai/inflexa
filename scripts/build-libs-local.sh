#!/usr/bin/env bash
# Build the three layered sandbox images locally and, optionally, extract the
# per-track library-store tarballs OUT of them the way CI does. This reproduces
# the CI pipeline on your own machine for testing — it does NOT assemble a host
# store directory (the CLI no longer mounts a local store; it pulls an image).
#
# Usage:
#   ./scripts/build-libs-local.sh                       # build base → python → python-r
#   ./scripts/build-libs-local.sh --python-only         # build base → python (skip R)
#   ./scripts/build-libs-local.sh --extract [--dest D]  # also extract tarballs to D (default: ./dist-libs)
#   ./scripts/build-libs-local.sh --platform linux/amd64
#
# After building, validate a baked image directly:
#   scripts/lib-store-validate/run.sh --image sandbox-python-r:local
# or, if you extracted + assembled tarballs, mount them:
#   scripts/lib-store-validate/run.sh --store <assembled-store-dir>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# shellcheck source=scripts/lib-store-common.sh
source "$SCRIPT_DIR/lib-store-common.sh"

MANIFEST="$PROJECT_ROOT/images/lib-store-manifest.yaml"
PLATFORM="linux/$(uname -m | sed 's/x86_64/amd64/' | sed 's/aarch64/arm64/')"
BUILD_R=true
EXTRACT=false
DEST="$PROJECT_ROOT/dist-libs"

TAG_BASE="sandbox-base:local"
TAG_PYTHON="sandbox-python:local"
TAG_PYTHON_R="sandbox-python-r:local"

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { printf "${GREEN}[INFO]${NC} %s\n" "$1"; }
error() { printf "${RED}[ERROR]${NC} %s\n" "$1"; }
step()  { printf "\n${CYAN}--- %s ---${NC}\n" "$1"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --python-only) BUILD_R=false; shift ;;
    --extract)     EXTRACT=true; shift ;;
    --platform)    PLATFORM="$2"; shift 2 ;;
    --dest)        DEST="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

command -v docker >/dev/null || { error "Docker is not installed"; exit 1; }
docker info >/dev/null 2>&1 || { error "Docker daemon is not running"; exit 1; }

BASE_IMAGE=$(grep '^base_image:' "$MANIFEST" | awk '{print $2}' | tr -d '"')
info "Base image: $BASE_IMAGE"
info "Platform:   $PLATFORM"
info "Build R:    $BUILD_R"

build_image() {
  local dockerfile="$1" tag="$2" label="$3"; shift 3
  step "Building: $label"
  docker build \
    --file "$dockerfile" \
    --platform "$PLATFORM" \
    --build-arg "BASE_IMAGE=$BASE_IMAGE" \
    "$@" \
    -t "$tag" \
    "$PROJECT_ROOT"
  info "$label built -> $tag"
}

# sandbox-base — the lean runtime the analysis images layer onto.
build_image "$PROJECT_ROOT/images/sandbox-base/Dockerfile" "$TAG_BASE" "sandbox-base"

# sandbox-python — FROM the local base tag.
build_image "$PROJECT_ROOT/images/sandbox-python/Dockerfile" "$TAG_PYTHON" "sandbox-python" \
  --build-arg "SANDBOX_BASE_IMAGE=$TAG_BASE"

TOP_IMAGE="$TAG_PYTHON"
if $BUILD_R; then
  # sandbox-python-r — FROM the local python tag. GITHUB_TOKEN (if exported) is
  # forwarded as a build secret for the GitHub R stage's API budget.
  SECRET_ARGS=()
  [ -n "${GITHUB_TOKEN:-}" ] && SECRET_ARGS=(--secret "id=github_token,env=GITHUB_TOKEN")
  build_image "$PROJECT_ROOT/images/sandbox-python-r/Dockerfile" "$TAG_PYTHON_R" "sandbox-python-r" \
    --build-arg "SANDBOX_PYTHON_IMAGE=$TAG_PYTHON" "${SECRET_ARGS[@]}"
  TOP_IMAGE="$TAG_PYTHON_R"
fi

if $EXTRACT; then
  step "Extracting per-track tarballs from $TOP_IMAGE"
  command -v zstd >/dev/null || { error "zstd is not installed (needed to pack tarballs)"; exit 1; }
  STAGING=$(mktemp -d)
  trap 'rm -rf "$STAGING"' EXIT
  PLATFORM="$PLATFORM" bash "$SCRIPT_DIR/lib-store-extract-tarballs.sh" "$TOP_IMAGE" "$STAGING"
  mkdir -p "$DEST"
  bash "$SCRIPT_DIR/lib-store-pack.sh" "$STAGING" "$DEST"
  info "Tarballs written to $DEST"
fi

step "Done"
info "Images: $TAG_BASE, $TAG_PYTHON$($BUILD_R && echo ", $TAG_PYTHON_R" || true)"
info "Validate a baked image:  scripts/lib-store-validate/run.sh --image $TOP_IMAGE"
