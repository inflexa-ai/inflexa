#!/usr/bin/env bash
# Build the one sandbox runtime image locally, the way CI does. This reproduces
# the CI image build on your own machine for a test — it does NOT assemble a host
# store directory (the provisioner builds the store; see
# .github/workflows/lib-store-provisioner.yml).
#
# Usage:
#   ./scripts/build-libs-local.sh                       # build sandbox-base
#   ./scripts/build-libs-local.sh --platform linux/amd64
#
# After the build, validate a store against the image (the way a user consumes it):
#   scripts/lib-store-validate/run.sh --store /path/to/store

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# shellcheck source=scripts/lib-store-common.sh
source "$SCRIPT_DIR/lib-store-common.sh"

MANIFEST="$PROJECT_ROOT/images/lib-store-manifest.yaml"
PLATFORM="linux/$(uname -m | sed 's/x86_64/amd64/' | sed 's/aarch64/arm64/')"
TAG_BASE="sandbox-base:local"

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { printf "${GREEN}[INFO]${NC} %s\n" "$1"; }
error() { printf "${RED}[ERROR]${NC} %s\n" "$1"; }
step()  { printf "\n${CYAN}--- %s ---${NC}\n" "$1"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform)    PLATFORM="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

command -v docker >/dev/null || { error "Docker is not installed"; exit 1; }
docker info >/dev/null 2>&1 || { error "Docker daemon is not running"; exit 1; }

BASE_IMAGE=$(grep '^base_image:' "$MANIFEST" | awk '{print $2}' | tr -d '"')
info "Base image: $BASE_IMAGE"
info "Platform:   $PLATFORM"

# The one runtime image. The build context is the repo root, because the
# Dockerfile COPYs images/lib-store-manifest.yaml and the inventory producer.
step "Building: sandbox-base"
# TARGETARCH passes explicitly, because not every builder fills the predefined
# value at the final FROM interpolation of the Dockerfile.
docker build \
  --file "$PROJECT_ROOT/images/sandbox-base/Dockerfile" \
  --platform "$PLATFORM" \
  --build-arg "BASE_IMAGE=$BASE_IMAGE" \
  --build-arg "TARGETARCH=${PLATFORM##*/}" \
  -t "$TAG_BASE" \
  "$PROJECT_ROOT"
info "sandbox-base built -> $TAG_BASE"

step "Done"
info "Image: $TAG_BASE"
info "Validate a store against it:  SANDBOX_BASE_IMAGE=$TAG_BASE scripts/lib-store-validate/run.sh --store /path/to/store"
